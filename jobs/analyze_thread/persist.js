// persist.js — the durable-storage layer over the app's freezr collections (projects, profiles,
// instructions, events, accounts, settings — schemas in manifest.json app_tables). The in-memory
// stores remain the working set; this layer hydrates them at startup and upserts touched records
// after each processed message (and on manual edits). Natural keys (project_id, address,
// instruction_id, account_id) map to freezr record _ids held here — the in-memory objects stay
// clean of storage bookkeeping.

import { recomputeImportance } from './projectStore.js'
import { htmlToText } from './htmlToText.js'
import { projectBaseline, mergeStored, healDuplicateProjects } from './projectMerge.js'

const SYSTEM_FIELDS = ['_id', '_date_created', '_date_modified', '_owner', '_app_name', '_accessible', '_accessibles', '_date_published']

// Body-store caps (email_bodies is a prunable cache, not a source of truth).
export const BODY_SNIPPET_CAP = 800        // chars of clean_text denormalised onto the event
const BODY_HTML_CAP = 256 * 1024           // drop body_html over this (keep body_text) — marketing mail can be huge

// Short plain-text extract for the event's body_snippet (instant-read teaser in the feed).
export function bodySnippetOf (cleanText) {
  const t = String(cleanText || '').replace(/\r/g, '').trim()
  return t.length > BODY_SNIPPET_CAP ? t.slice(0, BODY_SNIPPET_CAP) : t
}

// ---- canonical RECORD ids for natural-key collections -----------------------------------------
// A project_id / profile address is already a unique key, so the freezr record _id is DERIVED from
// it (like the events collection's deterministic ids). Creating is then idempotent — two writers
// racing to create the same project upsert onto ONE row instead of leaving duplicates behind, and
// nothing can silently fork a record into two versions again. Records written before this (random
// _ids) keep theirs: the loaded project_id -> _id map still points at them, so no migration.
const idSafe = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
export const projectRecIdFor = (projectId) => 'proj_' + idSafe(projectId)
export const profileRecIdFor = (address) => 'prof_' + idSafe(String(address || '').toLowerCase())

function strip (rec) {
  const out = { ...rec }
  for (const f of SYSTEM_FIELDS) delete out[f]
  return out
}

// ---- auth-expiry detection ----------------------------------------------------------------------
// On servers behind an extra identity layer (e.g. Azure Easy Auth in front of freezr) the upstream
// session times out independently of freezr's, and from then on EVERY api call returns a bare 401
// with an empty body — freezrApiV2 surfaces that as Error('Unknown error') with status 401. Without
// this check those 401s get misread as whatever the caller was doing (a background-job refusal, a
// mail-token problem), sending the user to fix grants that are fine. A 401 here means ONE thing:
// the sign-in is gone and the page must be reloaded to log in again (upstream AND freezr).
export function isAuthExpiredError (e) {
  if (!e || Number(e.status) !== 401) return false
  if (e.data && e.data.error === 'token_expired') return false // mail-connector re-auth — its own flow
  if (/no related records/i.test(String(e.message || ''))) return false // a read-by-id miss, not auth
  return true
}

// ---- source provenance ------------------------------------------------------------------------
// Every derived record (projects, profiles) carries the source(s) it was learned from, so data can
// be removed one account at a time instead of all-or-nothing. The tag is the mail account's ADDRESS
// rather than its connection name — 'email:me@example.com' survives renaming or reconnecting
// the connection, and it is the identifier the user recognises. The 'email:' prefix leaves room for
// other kinds of source later (an imported archive, a calendar).
export const sourceTagFor = (account) => {
  // Messaging accounts tag by CONNECTION NAME — 'slack:<connectionName>' — never by address: the
  // workspace login email is usually the same address as a mail account, and per-account removal
  // must be able to tell the two apart (settles the inputs spec's old open question about the source tag).
  if (account && account.channel === 'messages') {
    const id = String(account.account_id || account.account_email || '').trim()
    return id ? 'slack:' + id : null
  }
  // AI-agent accounts likewise tag by the fs CONNECTION NAME ('agents:<connectionName>') — their
  // me_email is a mail address and would collide with the mail account's tag.
  if (account && account.channel === 'work') {
    const id = String(account.account_id || '').trim()
    return id ? 'agents:' + id : null
  }
  const addr = String((account && (account.account_email || account.address)) || '').trim().toLowerCase()
  return addr ? 'email:' + addr : null
}

// Union-add. Records written before tagging existed have no sources array; they stay untagged (and
// are therefore never deleted by a per-account removal) until a new message touches them.
function addSource (rec, tag) {
  if (!rec || !tag) return
  if (!Array.isArray(rec.sources)) rec.sources = []
  if (!rec.sources.includes(tag)) rec.sources.push(tag)
}

// A source tag naming an ACCOUNT the user can remove ('email:', 'slack:', 'agents:', 'note:').
// Tags that describe a PLACE rather than a feed ('repo:') deliberately do NOT count: a project
// left with only place tags after its last account is forgotten must still be deleted.
export const isAccountTag = (s) => /^(email|slack|agents|note):/.test(String(s || ''))

// WHICH REPOS feed this project — derived, never authored. An agent-session thread id is
// 'cc:<repoSlug>:<sessionId>' (sessionDigest.threadIdFor), so the repos a project touches are
// already implied by its thread_ids; this just makes them filterable and visible. Idempotent, so
// it is safe to call on every save and it is the same function the one-off backfill uses.
const CC_THREAD = /^cc:(.+):[^:]+$/
export function addRepoSources (rec) {
  if (!rec || !Array.isArray(rec.thread_ids)) return rec
  for (const tid of rec.thread_ids) {
    const m = CC_THREAD.exec(String(tid || ''))
    if (m && m[1]) addSource(rec, 'repo:' + m[1])
  }
  return rec
}

// Mongo-compatible backends forbid '.' in FIELD NAMES, and project.participants is keyed by
// email addresses ("alice@ext.com" → invalid). Stored form: an ARRAY of { address, ...role };
// in-memory form: the keyed object the engine uses. Convert on save/load.
function serializeProject (p) {
  const out = strip(p)
  out.participants = Object.entries(p.participants || {}).map(([address, v]) => ({ address, ...(v || {}) }))
  return out
}
function deserializeProject (rec) {
  const out = { ...rec }
  if (Array.isArray(out.participants)) {
    const obj = {}
    for (const x of out.participants) {
      if (!x || !x.address) continue
      const { address, ...rest } = x
      obj[String(address).toLowerCase()] = rest
    }
    out.participants = obj
  }
  return out
}

// Newest-first by the one field every storage backend indexes. SINGLE key on purpose: Cosmos DB
// rejects a multi-field ORDER BY without a composite index ("does not have a corresponding composite
// index"), so never add _id (or anything else) to a sort. Also used by the maintenance modules.
export const NEWEST_FIRST = { _date_modified: -1 }

export function createPersistence (freezrRef) {
  const F = freezrRef || (typeof freezr !== 'undefined' ? freezr : null)
  const recIds = {
    projects: new Map(),      // project_id -> _id
    profiles: new Map(),      // address -> _id
    instructions: new Map(),  // instruction_id -> _id
    accounts: new Map()       // account_id -> _id
  }
  let settingsRecId = null
  // BASELINES: what this process last loaded/wrote for each project (ids + scalars). The write
  // path merges the stored record against it, so a long-open tab folds in what another writer
  // added instead of overwriting it. See projectMerge.js for the incident this comes from.
  const baselines = new Map() // project_id -> baseline

  // Per-key WRITE QUEUE. Every write of one natural key runs strictly after the previous one, so
  // concurrent saves of the same record can never both see "no record yet" and both create.
  const chains = new Map() // 'collection|key' -> promise gate
  function queued (key, fn) {
    const prev = chains.get(key) || Promise.resolve()
    const run = prev.then(fn, fn) // run whatever happened to the previous write
    const gate = run.then(() => {}, () => {})
    chains.set(key, gate)
    gate.then(() => { if (chains.get(key) === gate) chains.delete(key) })
    return run
  }

  async function queryAll (collection) {
    // paged pulls so a long test history still loads fully
    const out = []
    let skip = 0
    while (true) {
      const rows = await F.query(collection, {}, { count: 500, skip, sort: NEWEST_FIRST })
      if (!rows || !rows.length) break
      out.push(...rows)
      if (rows.length < 500) break
      skip += 500
    }
    return out
  }

  // Write one natural-key record. Serialised per key, and a NEW record is created on its
  // canonical _id with upsert:true when the collection has one — so a create that races another
  // writer's create lands on the SAME row instead of duplicating the key.
  function upsert (collection, keyMap, key, data, canonicalId = null) {
    return queued(collection + '|' + key, async () => {
      const existing = keyMap.get(key)
      if (existing) { await F.update(collection, existing, strip(data)); return existing }
      if (canonicalId) {
        await F.create(collection, strip(data), { data_object_id: canonicalId, upsert: true })
        keyMap.set(key, canonicalId)
        return canonicalId
      }
      const res = await F.create(collection, strip(data))
      if (res && res._id) keyMap.set(key, res._id)
      return res && res._id
    })
  }

  // ---- hydrate --------------------------------------------------------------------------

  // Retire a duplicate row: tag it so it never loads again (the bytes stay for forensics — a
  // duplicate is a storage artifact, but it is still the user's data, so nothing is deleted).
  async function retireDuplicate (collection, recId, winnerId) {
    await F.updateFields(collection, recId, { dup_retired: true, dup_winner_id: winnerId || null, dup_retired_asof: Date.now() })
      .catch(e => console.warn('[superlazy] could not retire duplicate ' + collection + '/' + recId + ':', e && e.message))
  }

  // Duplicate ADDRESSES in profiles: same storage hazard, but a profile is regenerated from mail
  // rather than hand-edited into a unique state, so the newest row simply wins (no content merge).
  function dedupeProfiles (rows) {
    const groups = new Map()
    for (const r of rows) {
      if (!r || !r.address) continue
      const k = String(r.address).toLowerCase()
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(r)
    }
    const out = []
    const retire = []
    for (const [addr, group] of groups) {
      if (group.length === 1) { out.push(group[0]); continue }
      const canonical = profileRecIdFor(addr)
      const ranked = group.slice().sort((a, b) => {
        if (a._id === canonical && b._id !== canonical) return -1
        if (b._id === canonical && a._id !== canonical) return 1
        return (Number(b._date_modified) || 0) - (Number(a._date_modified) || 0)
      })
      out.push(ranked[0])
      for (const loser of ranked.slice(1)) retire.push({ _id: loser._id, winner_id: ranked[0]._id, address: addr })
    }
    return { rows: out, retire }
  }

  // Load everything; returns plain records ready for the stores' hydrate() functions.
  // Duplicate natural keys (see projectMerge.js) are healed HERE, before anything hydrates: one
  // row per project_id / address, the extras' content folded in and the extras retired. Without
  // this, hydrate() would keep whichever row happened to come last and the board would flip
  // between versions as the rows' modification order changed.
  async function loadAll () {
    const [projectRows, profileRows, instructions, accounts, settingsRows] = await Promise.all([
      queryAll('projects'), queryAll('profiles'), queryAll('instructions'),
      queryAll('accounts'), F.query('settings', {}, { count: 1 })
    ])

    // projects: deserialize first (participants array -> object), then heal by project_id
    const prepared = projectRows.filter(r => r && !r.dup_retired).map(r => {
      const o = deserializeProject(strip(r))
      o._id = r._id
      o._date_modified = Number(r._date_modified) || 0
      return o
    })
    const { rows: keptProjects, healed, retire } = healDuplicateProjects(prepared, projectRecIdFor)
    const projects = keptProjects.map(r => {
      const out = { ...r }
      delete out._id // the ranking/heal helpers needed these; the stores must stay storage-clean
      delete out._date_modified
      return out
    })
    keptProjects.forEach((r, i) => {
      if (!r.project_id) return
      recIds.projects.set(r.project_id, r._id)
      baselines.set(r.project_id, projectBaseline(projects[i]))
    })

    const { rows: keptProfiles, retire: profileRetire } = dedupeProfiles(profileRows.filter(r => r && !r.dup_retired))
    keptProfiles.forEach(r => r.address && recIds.profiles.set(String(r.address).toLowerCase(), r._id))
    instructions.forEach(r => r.instruction_id && recIds.instructions.set(r.instruction_id, r._id))
    accounts.forEach(r => r.account_id && recIds.accounts.set(r.account_id, r._id))
    const settings = (settingsRows && settingsRows[0]) || null
    if (settings) settingsRecId = settings._id

    if (healed.length || profileRetire.length) {
      console.warn('[superlazy] duplicate records healed on load: ' +
        healed.map(h => h.project_id + ' (' + h.retired.length + ' extra row(s) folded in, ' + h.todos + ' to-dos kept)').join('; ') +
        (profileRetire.length ? ' · ' + profileRetire.length + ' duplicate profile row(s) retired' : ''))
      // write the merged winners, then retire the extras (order matters: never retire a row whose
      // content has not landed on the winner yet)
      for (const h of healed) {
        const p = projects.find(x => x.project_id === h.project_id)
        if (p) await saveProject(p).catch(e => console.warn('[superlazy] healed project save failed:', e && e.message))
      }
      for (const r of retire) await retireDuplicate('projects', r._id, r.winner_id)
      for (const r of profileRetire) await retireDuplicate('profiles', r._id, r.winner_id)
    }

    return {
      projects,
      profiles: keptProfiles.map(strip),
      instructions: instructions.map(strip),
      accounts: accounts.map(strip),
      settings: settings ? strip(settings) : null
    }
  }

  // Cheap first-run check for the index page: is any mail account set up?
  async function hasAccounts () {
    const rows = await F.query('accounts', {}, { count: 1 })
    return !!(rows && rows.length)
  }

  // The most recently WRITTEN event — lets a fresh page load show what training did last.
  async function latestEvent () {
    const rows = await F.query('events', {}, { count: 1, sort: NEWEST_FIRST })
    return (rows && rows[0]) ? strip(rows[0]) : null
  }

  // ---- saves ----------------------------------------------------------------------------

  // Save ONE project. Serialised per project_id, and — for a record we have already seen — the
  // stored row is READ and 3-way merged into the live object first (projectMerge.js), so writing
  // never silently drops what another writer (another tab, the analyzer, the background job)
  // added since this process loaded it. The merge result is folded back into the LIVE object, so
  // the UI shows the adopted work on its next repaint instead of re-clobbering it next save.
  function saveProject (p) {
    if (!p || !p.project_id) return Promise.resolve(null)
    const pid = p.project_id
    return queued('projects|' + pid, async () => {
      const known = recIds.projects.get(pid)
      const base = baselines.get(pid) || null
      if (known && base) {
        const stored = await F.read('projects', known).catch(() => null)
        if (stored && stored.project_id === pid) {
          const { project, report } = mergeStored(p, deserializeProject(strip(stored)), base)
          if (report.changed) {
            Object.assign(p, project) // the live store object gains what the other writer added
            console.warn('[superlazy] project "' + (p.name || pid) + '" merged with a concurrent write:' +
              (report.adoptedTodos.length ? ' adopted ' + report.adoptedTodos.length + ' to-do(s)' : '') +
              (report.adoptedResponses.length ? ' adopted ' + report.adoptedResponses.length + ' draft(s)' : '') +
              (report.droppedTodos.length ? ' left out ' + report.droppedTodos.length + ' to-do(s) we had moved away' : '') +
              (report.scalarsTaken.length ? ' took ' + report.scalarsTaken.join('/') + ' from storage' : '') +
              (report.conflictTodos.length ? ' · kept OUR version of ' + report.conflictTodos.length + ' to-do(s) edited on both sides' : ''))
          }
        }
      }
      recomputeImportance(p)
      const data = strip(serializeProject(p))
      let recId = known
      if (recId) {
        await F.update('projects', recId, data)
      } else {
        // new to us: create on the canonical id with upsert, so a racing writer's create for the
        // same project_id lands on the SAME row instead of forking it into two
        recId = projectRecIdFor(pid)
        await F.create('projects', data, { data_object_id: recId, upsert: true })
        recIds.projects.set(pid, recId)
      }
      baselines.set(pid, projectBaseline(p))
      return recId
    })
  }
  // Delete ONE project outright (the Edit-project modal's "Delete project"). Serialised on the
  // same queue as saveProject so it can never race a concurrent save of the same record, and the
  // cached record id + merge baseline go with it — a project_id re-created later starts clean.
  // Its events are deliberately LEFT in the log: they are the history of what happened, and the
  // feeds already tolerate events whose project is gone.
  function deleteProject (projectId) {
    const pid = projectId && String(projectId)
    if (!pid) return Promise.resolve(false)
    return queued('projects|' + pid, async () => {
      const known = recIds.projects.get(pid)
      let recId = known
      if (!recId) {
        // never saved by THIS session — find the stored row by project_id
        const rows = (await queryAll('projects')).filter(r => r.project_id === pid)
        recId = rows[0] && rows[0]._id
      }
      recIds.projects.delete(pid)
      baselines.delete(pid)
      if (!recId) return false // nothing stored — an unsaved, in-memory-only project
      await F.delete('projects', recId)
      return true
    })
  }

  const saveProfile = (p) => upsert('profiles', recIds.profiles, String(p.address || '').toLowerCase(), p, profileRecIdFor(p.address))

  // ---- profile history: an append-only archive of REPLACED profiles ------------------------
  // Written whenever a solidified (or user-edited) profile's text / tone / priority is replaced
  // — by a re-profile, a manual edit, or a rank change. Provisional churn (the first few
  // pre-solidification refinements) is deliberately NOT archived; the caller enforces that by
  // only snapshotting when the replaced version was solidified or user-edited.
  const saveProfileHistory = (entry) => F.create('profile_history', strip(entry))
  const saveInstruction = (r) => upsert('instructions', recIds.instructions, r.instruction_id, r)
  const saveAccount = (a) => upsert('accounts', recIds.accounts, a.account_id, a)

  // ---- events: deterministic ids (idempotency) --------------------------------------------
  // TWO id families (see specs/pipeline-walkthrough.md §11):
  //  - ANALYSIS events ('message'/'workflow_short_circuit'/'skipped', incl. errors): exactly ONE
  //    per (account, message) — id ev_<msgid>_<hash> — written AFTER analysis, so re-processing
  //    upserts instead of duplicating. Its mere existence marks the message handled (see
  //    processedMsgSet). Concurrency is prevented up front by the single run lock (below), not by a
  //    per-message claim — so there is no pre-LLM stub.
  //  - MAIL-ACTION events (phase 2: mark-read / move / delete notifications): many per message —
  //    id evact_… including the action + the provider's change id, so replayed deltas dedupe
  //    without colliding with the analysis event.

  // tiny FNV-1a 32-bit — msg_ids are only unique per account, and sanitisation can collide,
  // so the hash covers the raw account|msg pair
  function hash32 (str) {
    let h = 0x811c9dc5
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
    return (h >>> 0).toString(36)
  }
  // record ids travel un-encoded in URL paths (archive msg_ids are RFC Message-ID headers)
  const sanitizeId = (s) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '_')
  const eventIdFor = (accountId, msgId) =>
    'ev_' + sanitizeId(msgId).slice(0, 60) + '_' + hash32(String(accountId || '') + '|' + String(msgId || ''))
  const actionEventIdFor = (accountId, msgId, action, changeId) =>
    'evact_' + sanitizeId(msgId).slice(0, 40) + '_' + sanitizeId(action) + '_' +
    hash32([accountId, msgId, action, changeId].map(x => String(x || '')).join('|'))
  // Same (account|msg) identity as the event, distinct prefix — one body snapshot per message,
  // read by _id (always indexed) so the reader's first paint never depends on a field query.
  const bodyIdFor = (accountId, msgId) =>
    'body_' + sanitizeId(msgId).slice(0, 60) + '_' + hash32(String(accountId || '') + '|' + String(msgId || ''))
  // One record per INPUT ITEM across all channels (specs/superlazy-inputs.md §5) — same
  // (account|msg) identity as the event, distinct prefix.
  const inputIdFor = (accountId, msgId) =>
    'in_' + sanitizeId(msgId).slice(0, 60) + '_' + hash32(String(accountId || '') + '|' + String(msgId || ''))

  const ANALYSIS_KINDS = ['message', 'workflow_short_circuit', 'skipped']

  async function addEvent (ev) {
    const rec = strip(ev)
    if (rec.msg_id && rec.account_id && ANALYSIS_KINDS.includes(rec.kind)) {
      // upsert onto the deterministic id: a re-processed message (e.g. after a stale-lock
      // takeover) overwrites its earlier record instead of duplicating
      return F.create('events', rec, { data_object_id: eventIdFor(rec.account_id, rec.msg_id), upsert: true })
    }
    if (rec.manual_id) {
      // MANUAL edits carry their own stable id so a burst of fiddling on one field within the
      // coalesce window (ui.js COALESCE_MS) UPSERTS one record instead of piling up ten. The id
      // is minted per (todo, field, burst) by ui.js — see recordTodoChange.
      return F.create('events', rec, { data_object_id: 'mev_' + sanitizeId(rec.manual_id).slice(0, 80), upsert: true })
    }
    return F.create('events', rec) // manual_edit etc — no message identity
  }

  // What has already happened to each of these msg_ids? Chunked $in on the msg_id FIELD (never on
  // _id — the adapter treats _id queries as findOne). Returns two Sets of 'account|msg' keys
  // ('*|msg' for legacy events stored before account_id existed):
  //   done    — analysed successfully, or deliberately skipped by the user. Never process again.
  //   errored — an analysis event EXISTS but records a failure (no credit left, mail token expired,
  //             a network drop mid-analysis…). Emphatically NOT done: the message has no to-dos and
  //             no profile updates, so it must be RETRIED — and retried before fresh mail, since it
  //             is older. processor.plan puts these at the head of the queue.
  // An event only exists once analysis has finished (there is no pre-LLM stub), and the run lock
  // means the planner never races a live run over the same message.
  async function msgAnalysisStatus (msgIds) {
    const done = new Set()
    const errored = new Set()
    // attempts: key -> how many analysis attempts the error event records (the message event is
    // idempotent-upserted, so the count lives ON it rather than as extra rows). Old error events
    // predating the counter have no field and read as 1.
    const attempts = new Map()
    for (let i = 0; i < msgIds.length; i += 100) {
      const chunk = msgIds.slice(i, i + 100)
      const rows = await F.query('events', { msg_id: { $in: chunk }, kind: { $in: ANALYSIS_KINDS } }, { count: 500 })
      for (const r of (rows || [])) {
        const target = r.error ? errored : done
        const key = (r.account_id || '*') + '|' + r.msg_id
        target.add(key)
        if (!r.account_id) target.add('*|' + r.msg_id)
        if (r.error) attempts.set(key, Number(r.attempts) || 1)
      }
    }
    return { done, errored, attempts }
  }

  // Back-compat wrapper: the set of msg keys that need no further work.
  const processedMsgSet = async (msgIds) => (await msgAnalysisStatus(msgIds)).done

  // The message events behind ONE PROJECT, fetched by identity rather than scanned from a loaded
  // window: the events on its MAIL threads (by thread_id — a chat stream id is a whole channel, so
  // chat items come only through the other two keys), the events of the messages its to-dos cite
  // as evidence (by msg_id), and the events whose recorded changes touched it. The project card's
  // Messages tab used to walk only the shell's newest-1,000 slice, so an older thread simply fell
  // off the tab as the log grew (user, 2026-10-04: "the correct thread was not there any more").
  // Each query is best-effort — a backend that cannot serve one of them just contributes nothing.
  async function loadEventsForProject ({ threadIds = [], msgIds = [], projectId = null } = {}) {
    const out = new Map() // _id -> row
    const take = (rows) => { for (const r of (rows || [])) if (r && r._id && !out.has(r._id)) out.set(r._id, r) }
    const q = async (filter) => { try { take(await F.query('events', filter, { count: 500, sort: NEWEST_FIRST })) } catch (e) { console.warn('[superlazy] project events query failed:', e && e.message) } }
    const tids = [...new Set(threadIds.filter(Boolean))]
    for (let i = 0; i < tids.length; i += 50) await q({ thread_id: { $in: tids.slice(i, i + 50) }, kind: { $in: ANALYSIS_KINDS } })
    const mids = [...new Set(msgIds.filter(Boolean))]
    for (let i = 0; i < mids.length; i += 50) await q({ msg_id: { $in: mids.slice(i, i + 50) }, kind: { $in: ANALYSIS_KINDS } })
    if (projectId) await q({ 'changes.project_id': projectId, kind: { $in: ANALYSIS_KINDS } })
    return [...out.values()]
  }

  // ---- email bodies: the stored full-message snapshot (prunable cache) ----------------------
  // Written best-effort during ingestion (the analyser already has the bytes). Keyed by the same
  // (account|msg) identity as the event. body_html is dropped when oversized — body_text always
  // survives so the reader has something. Attachments are a manifest only (no bytes).
  // ---- the inputs collection (specs/superlazy-inputs.md §5) -----------------------------------
  // One record per input item, ALL channels. Triple role: canonical store for items that exist
  // nowhere else (typed notes — authority 'canonical', archived never deleted), body cache for
  // provider-backed items (mail — authority 'provider', prunable; supersedes email_bodies), and
  // the pending-analysis queue (status 'pending' | 'analysed' | 'error').
  async function saveInput (rec) {
    if (!rec || !rec.msg_id) return null
    const id = inputIdFor(rec.account_id, rec.msg_id)
    return F.create('inputs', strip(rec), { data_object_id: id, upsert: true })
      .then(r => ({ ...(r || {}), _id: id }))
      .catch(e => { console.warn('[superlazy] input save failed', rec.msg_id, e && e.message); return null })
  }

  async function getInput ({ account_id, msg_id } = {}) {
    if (!msg_id) return null
    try {
      const rows = await F.query('inputs', { _id: inputIdFor(account_id, msg_id) }, { count: 1 })
      const rec = rows && rows[0]
      return (rec && rec._id) ? rec : null
    } catch (e) { return null }
  }

  async function updateInputFields ({ account_id, msg_id } = {}, fields) {
    if (!msg_id) return null
    return F.updateFields('inputs', inputIdFor(account_id, msg_id), fields)
      .catch(e => { console.warn('[superlazy] input update failed', msg_id, e && e.message); return null })
  }

  // Items awaiting analysis (a note typed while a run held the lock, or whose save-time analysis
  // failed). Status is a non-indexed field, so this scans the NEWEST records by _date_modified
  // (always indexed) and filters client-side — pending items are by construction recent.
  async function pendingInputs ({ scan = 100, maxAttempts = 3 } = {}) {
    try {
      const rows = await F.query('inputs', {}, { count: scan, sort: NEWEST_FIRST })
      // 'error' items ARE retryable (the flash message promises a retry on the next mail check) —
      // up to maxAttempts, so a permanently-failing note retires instead of burning every run.
      return (rows || []).filter(r => r && !r.archived &&
        (r.status === 'pending' || (r.status === 'error' && (Number(r.attempts) || 0) < maxAttempts)))
    } catch (e) { return [] }
  }

  // DEEP pending scan (2026-10-04, pendingScan.js has the story). Same indexed sort, paged until the
  // page's oldest record is older than floorMs — on a normal day the first page reaches it; during a
  // mail backlog a few more. Returns { rows, complete, pages }: complete=false means the page cap
  // (or a query error) stopped the walk BEFORE the floor, so the caller must not treat the result
  // as everything pending.
  //
  // HISTORY: the freezr server's "Recent" cache once answered a { _date_modified: -1 } page with the
  // ~100 rows it held whatever `count` asked for (one wrongly-stamped watermark, 2026-10-04). That
  // is fixed server-side (appTableCache._recentCanServe falls through to the DB when the page
  // reaches beyond the cache); the two-key sort we used meanwhile broke Cosmos (see NEWEST_FIRST).
  // The end of the collection is still treated as an EMPTY page, never a short one.
  const PENDING_SCAN_PAGE = 300
  const PENDING_SCAN_MAX_PAGES = 40
  async function scanPendingInputs ({ floorMs = 0, pageSize = PENDING_SCAN_PAGE, maxPages = PENDING_SCAN_MAX_PAGES, maxAttempts = 3 } = {}) {
    const rows = []
    let pages = 0
    let skip = 0
    let complete = false
    try {
      while (pages < maxPages) {
        const page = (await F.query('inputs', {}, { count: pageSize, skip, sort: NEWEST_FIRST })) || []
        pages++
        if (!page.length) { complete = true; break }                                   // end of the collection
        skip += page.length
        for (const r of page) {
          if (!r || r.archived) continue
          if (floorMs > 0 && (Number(r._date_modified) || 0) < floorMs) continue   // older than the floor: stale by definition
          if (r.status === 'pending' || (r.status === 'error' && (Number(r.attempts) || 0) < maxAttempts)) rows.push(r)
        }
        const oldest = Number(page[page.length - 1]._date_modified) || 0
        if (floorMs > 0 && oldest < floorMs) { complete = true; break }                // past the floor
      }
    } catch (e) { console.warn('[superlazy] pending scan failed after ' + pages + ' page(s):', e && e.message) }
    return { rows, complete, pages }
  }

  // inputs record -> the legacy body-view shape every reader already consumes (emailViewer,
  // reprofiler). Keeps the blast radius of the storage switch at zero for consumers.
  const inputToBodyView = (r) => ({
    msg_id: r.msg_id,
    account_id: r.account_id || null,
    thread_id: r.thread_id || null,
    from_address: r.author_address || '',
    from_name: r.author_name || '',
    to_addresses: (r.participants || []).filter(p => p.kind !== 'cc').map(p => ({ address: p.address || '', name: p.name || '' })),
    cc_addresses: (r.participants || []).filter(p => p.kind === 'cc').map(p => ({ address: p.address || '', name: p.name || '' })),
    subject: r.title || '',
    date: r.date || 0,
    body_html: r.body_html || '',
    // an HTML-only mail stores body_text '' — give readers (the clean-up's need line, the thread
    // view) the converted text rather than nothing (2026-09-26)
    body_text: r.body_text || (r.body_html ? htmlToText(r.body_html) : ''),
    has_attachments: !!(r.attachments && r.attachments.length),
    attachments: r.attachments || [],
    html_truncated: !!r.html_truncated,
    captured_asof: r.captured_asof || null,
    // channel extras — the viewer branches its header/actions on these
    channel: r.channel || 'mail',
    item_kind: r.item_kind || null,
    participants_kind: r.participants_kind || null,
    authority: r.authority || 'provider',
    revision: r.revision || 1,
    input_status: r.status || null,
    // work (agent session) extras for the viewer header
    repo_name: r.repo_name || null,
    branch: r.branch || null,
    turn_n: r.turn_n || null,
    turns_total: r.turns_total || null,
    turn_state: r.turn_state || null,
    turn_kind: r.turn_kind || null,
    work_stats: r.work_stats || null,
    files_changed: r.files_changed || [],
    files_changed_paths: r.files_changed_paths || [],
    commits: r.commits || [],
    repo_state: r.repo_state || null,
    agent_name: r.agent_name || null,
    provider: r.provider || null,
    cwd: r.cwd || null,                 // resolves Codex's relative file paths; names the home folder
    source_path: r.source_path || null, // the transcript inside its store → "open the session" link
    agent_work: r.agent_work || null   // plans (full text), checklist, latest_plan — the viewer shows them
  })

  // Mail body capture — the name and call shape predate the inputs collection; since Phase 2
  // (specs/pipeline-walkthrough.md §11) it writes an `inputs` record (channel mail, authority
  // provider, born analysed). email_bodies is LEGACY-EMAIL_BODIES: read-fallback only, dropped
  // at the full reset.
  async function saveEmailBody (payload) {
    if (!payload || !payload.msg_id) return null
    const html = String(payload.body_html || payload.html || '')
    const tooBig = html.length > BODY_HTML_CAP
    let text = String(payload.body_text || payload.text || '')
    // HTML-ONLY mail (Outlook/Exchange commonly sends no text part): dropping oversized html
    // used to leave these records with NO body at all — the reader and any bulk export saw
    // "(empty body)". Derive the text from the html BEFORE dropping it, capped generously.
    if (tooBig && text.trim().length < 20) text = htmlToText(html).slice(0, BODY_HTML_CAP)
    const toP = (list, kind) => (list || []).map(x => ({
      address: String((x && x.address) || '').toLowerCase(), name: (x && x.name) || '', kind
    }))
    return saveInput({
      channel: 'mail',
      item_kind: null,
      provider: payload.provider || null,
      account_id: payload.account_id || null,
      msg_id: payload.msg_id,
      thread_id: payload.thread_id || null,
      date: payload.date || 0,
      author_address: String((payload.from && payload.from.address) || payload.from_address || '').toLowerCase(),
      author_name: (payload.from && payload.from.name) || payload.from_name || '',
      participants: [...toP(payload.to_addresses || payload.to, 'to'), ...toP(payload.cc_addresses || payload.cc, 'cc')],
      participants_kind: 'recipients',
      title: payload.subject || '',
      body_html: tooBig ? '' : html,
      body_text: text,
      labels: payload.labels || [],
      attachments: (payload.attachments || []).map(a => ({
        id: a.id, filename: a.filename || '', mimeType: a.mimeType || '', sizeBytes: Number(a.sizeBytes) || 0
      })),
      html_truncated: tooBig,
      authority: 'provider',
      archived: false,
      status: 'analysed',           // captured AFTER analysis — never queued
      analysis_event_id: null,
      revision: 1,
      content_hash: null,
      edited_asof: null,
      captured_asof: Date.now(),
      sources: []
    })
  }

  // Read ONE stored body by (account, msg) — an _id lookup, always indexed, so the reader's first
  // paint is reliable on every backend. QUERY, not read-by-id: bodies are best-effort snapshots
  // (older messages may have none), and a read of a missing id returns a 401 that freezrApiV2
  // logs to the console — a reprofile over 20 old messages would print 20 scary errors for a
  // perfectly normal "no snapshot, use the snippet" answer. A query just returns [].
  async function getEmailBody ({ account_id, msg_id } = {}) {
    if (!msg_id) return null
    const input = await getInput({ account_id, msg_id })
    if (input) return inputToBodyView(input)
    // LEGACY-EMAIL_BODIES — delete at reset (specs/pipeline-backlog.md, The full reset — checklist)
    try {
      const rows = await F.query('email_bodies', { _id: bodyIdFor(account_id, msg_id) }, { count: 1 })
      const rec = rows && rows[0]
      return (rec && rec._id) ? strip(rec) : null
    } catch (e) { return null }
  }

  // Rebuild a thread from stored bodies — a FIELD query on thread_id (best-effort: works where the
  // backend indexes it, or where the user created the index; the reader degrades gracefully if it
  // returns nothing). Oldest-first.
  async function getThreadBodies (threadId) {
    if (!threadId) return []
    const byMsg = new Map()
    // LEGACY-EMAIL_BODIES — delete at reset (specs/pipeline-backlog.md, The full reset — checklist)
    try {
      const rows = await F.query('email_bodies', { thread_id: threadId }, { count: 200 })
      for (const r of (rows || [])) byMsg.set(r.msg_id, strip(r))
    } catch (e) { /* inputs below */ }
    try {
      const rows = await F.query('inputs', { thread_id: threadId }, { count: 200 })
      for (const r of (rows || [])) if (r && !r.archived) byMsg.set(r.msg_id, inputToBodyView(r)) // inputs win over legacy
    } catch (e) { /* legacy result stands */ }
    return [...byMsg.values()].sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0))
  }

  async function saveSettings (s) {
    if (settingsRecId) { await F.update('settings', settingsRecId, strip(s)); return settingsRecId }
    const res = await F.create('settings', strip(s))
    settingsRecId = res && res._id
    return settingsRecId
  }

  // Persist everything one processed message touched: the touched projects, the participants'
  // profiles, any archived profile versions, and the event record. Best-effort per record —
  // one failure never loses the rest.
  // sourceTag: which source this step's data came from — 'email:<mail account address>'. Stamped on
  // every project and profile the step touched (union, so a record fed by two accounts carries both),
  // which is what lets deleteAccountData tell "only this account knows about it" from "shared".
  async function persistStep ({ store, profiles, touchedProjectIds, touchedAddresses, profileHistory, event, sourceTag = null }) {
    const errors = []
    for (const pid of (touchedProjectIds || [])) {
      const p = store.get(pid)
      if (!p) continue
      addSource(p, sourceTag)
      addRepoSources(p)
      await saveProject(p).catch(e => errors.push('project ' + pid + ': ' + e.message))
    }
    for (const addr of (touchedAddresses || [])) {
      const p = profiles.get(addr)
      if (!p) continue
      addSource(p, sourceTag)
      await saveProfile(p).catch(e => errors.push('profile ' + addr + ': ' + e.message))
    }
    for (const h of (profileHistory || [])) {
      await saveProfileHistory(h).catch(e => errors.push('profile_history ' + h.address + ': ' + e.message))
    }
    if (event) await addEvent(event).catch(e => errors.push('event: ' + e.message))
    return errors
  }

  // ---- the run lock (the SINGLE concurrency guard: atomic, timer-free) ----------------------
  // ONE record ('ingestion_lock' in the locks collection) gates ALL processing — training and
  // new-mail, any tab, later the background job. Acquisition is ATOMIC: create-with-fixed-id
  // fails if the record exists, so exactly one contender ever wins. There are NO wall-clock timers:
  // the holder renews the lock on every work beat (message start, each LLM round, completion), so a
  // live run never lets it lapse; a lock untouched for staleMs is therefore a genuinely dead holder
  // (e.g. the tab was closed) and may be taken over. Because a stuck message is killed by
  // STEP_TIMEOUT_MS (< staleMs) — releasing the lock — a takeover never races a message still in
  // flight, so this lock alone is sufficient (no per-message claim). Recovery from a dead holder is
  // either this stale-takeover or a manual "Force resync".
  const LOCK_ID = 'ingestion_lock'

  async function readRunLock () {
    try {
      // query, NOT read-by-id: an absent lock (the normal idle state) returns [] rather than a
      // 401 "no related records exist" that freezrApiV2 logs to the console on every idle poll
      // (processingNotice ~12s + startLockPoll ~5s). The locks collection only ever holds this one
      // record, so count:1 is exact.
      const rows = await F.query('locks', {}, { count: 1 })
      const rec = rows && rows[0]
      return (rec && rec._id) ? rec : null
    } catch (e) {
      // An expired sign-in must NOT be swallowed into "no lock" — the status poller would then
      // fire a job run that fails with the same 401 and gets misreported as a permission problem.
      if (isAuthExpiredError(e)) throw e
      return null
    }
  }

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

  // force: steal the lock even if it looks fresh (the "Force resync" recovery button). The old
  // holder — if actually alive — sees the changed owner at its next per-message renewal and
  // stands down; the per-message claims make any straggler LLM response harmless.
  // Returned holder records keep _date_modified so the UI can show "last update Xs ago".
  async function acquireRunLock ({ owner, kind, staleMs = 5 * 60 * 1000, progress = null, force = false }) {
    const rec = { owner, kind, started_at: Date.now(), expires_at: Date.now() + staleMs, progress }
    // read first: the common "someone else is working" case answers WITHOUT a failed create
    // (quieter console); the create below remains the atomic arbiter for true races
    const holder = await readRunLock()
    if (holder && !force && Number(holder.expires_at) > Date.now()) return { ok: false, holder }
    if (holder) await F.delete('locks', LOCK_ID).catch(() => {})
    try {
      await F.create('locks', rec, { data_object_id: LOCK_ID })
    } catch (e) {
      // a true race — the other contender's create won
      const h = await readRunLock()
      return { ok: false, holder: h || null }
    }
    if (holder) {
      // TAKEOVER SETTLE: delete+create is NOT atomic — a second taker that read the OLD stale
      // record moments ago can delete OUR fresh lock and install its own (e.g. Force resync vs
      // the dashboard's self-heal). Wait out that window and re-verify ownership BEFORE any
      // tokens are spent, so contending takers agree on ONE winner up front instead of one of
      // them dying after its first message.
      await sleep(2000)
      const check = await readRunLock()
      if (!check || check.owner !== owner) return { ok: false, holder: check || null }
    }
    return { ok: true, takeover: !!holder }
  }

  // Called once per processed message (no timer). Verifies we still own the lock — a taken-over
  // holder sees another name and must stop before its next message. Returns the usurper so the
  // caller can say WHO took over (and console-log it for debugging).
  async function renewRunLock ({ owner, progress, staleMs = 5 * 60 * 1000 }) {
    const rec = await readRunLock()
    if (!rec || rec.owner !== owner) return { lost: true, holder: rec || null }
    await F.updateFields('locks', LOCK_ID, { expires_at: Date.now() + staleMs, progress: progress || rec.progress || null }).catch(() => {})
    return { lost: false }
  }

  async function releaseRunLock ({ owner }) {
    const rec = await readRunLock()
    if (!rec || rec.owner !== owner) return // never delete someone else's lock
    await F.delete('locks', LOCK_ID).catch(() => {})
  }

  // ---- settings side-writes (updateFields, NEVER a full save) -------------------------------
  // The background job and the pages both write to the ONE settings record, so a full
  // update() from either side would clobber whatever the other just changed (the job would
  // overwrite a pref the user just edited, and vice versa). Every write from a non-owning
  // context therefore goes through updateFields, touching only the named keys.
  async function stampSettingsFields (fields) {
    if (!fields || !Object.keys(fields).length) return false
    const rows = await F.query('settings', {}, { count: 1 }).catch(() => null)
    const s = rows && rows[0]
    if (!s) {
      // No settings record yet. Mail setup creates one at adopt time, but a SLACK-ONLY install
      // reaches its first check without one — refusing to stamp left newmail_last_check unset
      // forever ("SuperLazy last checked your mail NEVER", 2026-08-30). Create it with just the
      // stamped fields; later pref saves merge in on top. (A create/create race with a
      // simultaneous first prefs-save is theoretically possible and harmless in practice —
      // readers take the first record.)
      await F.create('settings', strip(fields)).catch(() => {})
      return true
    }
    await F.updateFields('settings', s._id, fields).catch(() => {})
    return true
  }

  // Stamp when new mail was last checked (informational, shown on every page).
  const stampNewMailCheck = () => stampSettingsFields({ newmail_last_check: Date.now() })

  // Record how the last background run went. Read by every page's status strip (see
  // backgroundMode.js) — this is the ONLY way a page learns the outcome of a run it did not
  // itself watch, because freezr's POST /jobs/run response is unusable as a signal: it blocks
  // for the whole run, so a page fires runs without awaiting them.
  const stampBackgroundRun = (summary) => stampSettingsFields({ bg_last_run: summary || null })

  // The pending-scan watermark (config.js PENDING_*): the start of the last run that scanned the
  // pending queue to its floor AND drained it. ingest.js is the only writer.
  const stampPendingScanWatermark = (ms) => stampSettingsFields({ pending_scan_watermark: Number(ms) || 0 })

  // ---- request audit (dev tool — jobs/analyze_thread/llmAudit.js, page requestauditlab) --------
  // Two record kinds in ONE collection: 'exchange' (one per LLM call, volatile turns inline) and
  // 'blob' (the cached durable turn, stored once per distinct content on a deterministic id).
  const AUDIT = 'llm_audit'
  const saveAuditExchange = (rec) => F.create(AUDIT, strip(rec))
  const saveAuditBlob = ({ hash, text, prompt_version }) =>
    F.create(AUDIT, { kind: 'blob', hash, text: String(text || ''), chars: String(text || '').length, prompt_version: prompt_version || null },
      { data_object_id: 'blob_' + idSafe(hash), upsert: true })
  async function listAuditExchanges ({ sinceMs = 0, count = 400 } = {}) {
    const q = { kind: 'exchange' }
    if (sinceMs) q._date_modified = { $gt: Number(sinceMs) }
    const rows = await F.query(AUDIT, q, { count, sort: NEWEST_FIRST })
    return Array.isArray(rows) ? rows : []
  }
  const readAuditBlob = (hash) => F.read(AUDIT, 'blob_' + idSafe(hash)).catch(() => null)
  // retention: everything (exchanges AND blobs) older than the window goes; a blob still in use is
  // re-created by the next audited run that sends that durable turn
  async function pruneAudit (days) {
    const cutoff = Date.now() - (Number(days) > 0 ? Number(days) : 3) * 24 * 3600e3
    let n = 0
    while (true) {
      const rows = await F.query(AUDIT, { _date_modified: { $lt: cutoff } }, { count: 200, sort: { _date_modified: 1 } }).catch(() => [])
      if (!rows || !rows.length) break
      for (const r of rows) { await F.delete(AUDIT, r._id).catch(() => {}); n++ }
      if (rows.length < 200) break
    }
    return n
  }
  async function clearAudit () {
    let n = 0
    while (true) {
      const rows = await F.query(AUDIT, {}, { count: 200 }).catch(() => [])
      if (!rows || !rows.length) break
      for (const r of rows) { await F.delete(AUDIT, r._id).catch(() => {}); n++ }
      if (rows.length < 200) break
    }
    return n
  }

  // The settings record on its own — the cheap read the status poll makes alongside the run lock.
  async function readSettings () {
    try {
      const rows = await F.query('settings', {}, { count: 1 })
      const s = rows && rows[0]
      return (s && s._id) ? strip(s) : null
    } catch (e) {
      if (isAuthExpiredError(e)) throw e // see readRunLock — the poller must learn the sign-in died
      return null
    }
  }

  // ---- reset (testing: delete processed data & start over) --------------------------------

  // keepLearnedSenders (default true): profiles carrying a learned CATEGORY (a file_to_project
  // auto-process with a disposition — newsletter / admin / social / promotions; legacy records
  // hold it as a flat profile.disposition) survive the wipe — re-classifying them would waste
  // tokens. Their target project_id is cleared (the bucket projects are deleted); the automated
  // workflow recreates the bucket by name on the next matching message, still without the LLM.
  async function deleteAllData ({ onProgress, keepLearnedSenders = true } = {}) {
    const collections = ['projects', 'profiles', 'profile_history', 'instructions', 'events', 'email_bodies', 'inputs', 'accounts', 'settings', 'locks']
    const keptProfiles = new Map() // address -> _id (survivors)
    for (const c of collections) {
      const rows = await queryAll(c)
      let i = 0
      for (const r of rows) {
        if (keepLearnedSenders && c === 'profiles' && learnedCategoryOf(r.profile)) {
          // keep the learned sender; clear the dangling bucket pointers (full replace — no dotted paths)
          const kept = strip(r)
          kept.profile = { ...kept.profile }
          if (kept.profile.auto_file_project_id) kept.profile.auto_file_project_id = null // legacy
          if (Array.isArray(kept.profile.auto_processes)) {
            kept.profile.auto_processes = kept.profile.auto_processes.map(a =>
              (a && a.type === 'file_to_project' && a.details)
                ? { ...a, details: { ...a.details, project_id: null } }
                : a)
          }
          await F.update(c, r._id, kept).catch(() => {})
          if (r.address) keptProfiles.set(String(r.address).toLowerCase(), r._id)
          if (onProgress) onProgress(c, ++i, rows.length)
          continue
        }
        await F.delete(c, r._id)
        if (onProgress) onProgress(c, ++i, rows.length)
      }
    }
    for (const m of Object.values(recIds)) m.clear()
    baselines.clear() // nothing is "what we last wrote" any more
    for (const [addr, id] of keptProfiles) recIds.profiles.set(addr, id)
    settingsRecId = null
  }

  // A profile carrying a learned CATEGORY (newsletter / admin / social …) — expensive to re-learn,
  // so both the global wipe and the per-account one keep it.
  const learnedCategoryOf = (profile) => {
    if (!profile) return false
    if (profile.disposition) return true // legacy flat field
    const fileEntry = (Array.isArray(profile.auto_processes) ? profile.auto_processes : [])
      .find(a => a && a.type === 'file_to_project')
    return !!(fileEntry && fileEntry.details && fileEntry.details.disposition)
  }

  // ---- forget ONE source (per-account delete) ---------------------------------------------
  //
  // Removes everything attributable to a single mail account, leaving the other accounts intact.
  // Three classes of record, three rules:
  //   directly owned (events, email_bodies, the accounts row) — carry account_id, deleted outright.
  //   derived (projects, profiles)                            — carry sources[]; the tag is removed
  //       and the record is deleted ONLY if that leaves it with no source at all. A project or
  //       person the other account also knows about therefore SURVIVES, minus this account's claim.
  //   untagged (written before source tagging existed)        — left strictly alone and COUNTED, so
  //       the caller can tell the user what could not be attributed rather than guessing.
  // Settings, instructions (user-authored) and the run lock are never touched.
  //
  // Filtering is done in memory after queryAll rather than with a query on account_id / sources:
  // only _id and _date_modified are reliably indexed across freezr backends, so a field query would
  // work on some and fail on others.
  async function deleteAccountData ({ accountId, sourceTag, keepLearnedSenders = true, onProgress } = {}) {
    if (!accountId && !sourceTag) throw new Error('deleteAccountData needs an accountId or a sourceTag')
    const tally = {
      events: 0, email_bodies: 0, inputs: 0, accounts: 0,
      projects_deleted: 0, projects_kept: 0, projects_untagged: 0,
      profiles_deleted: 0, profiles_kept: 0, profiles_untagged: 0, profile_history: 0
    }
    const step = (what, i, n) => { if (onProgress) onProgress(what, i, n) }

    // 1. directly-owned rows
    for (const c of ['events', 'email_bodies', 'inputs']) {
      const rows = (await queryAll(c)).filter(r => r.account_id === accountId)
      let i = 0
      for (const r of rows) {
        await F.delete(c, r._id).catch(() => {})
        tally[c]++
        step(c, ++i, rows.length)
      }
    }

    // 2. derived rows — drop the tag, delete only when nothing else claims the record
    const droppedAddresses = []
    const projects = await queryAll('projects')
    let i = 0
    for (const r of projects) {
      i++
      const sources = Array.isArray(r.sources) ? r.sources : []
      if (!sources.length) { tally.projects_untagged++; continue }
      // not this account's at all — nothing to do, and NOT counted as "kept" (that count means
      // "this account knew about it but someone else does too", which is what the user is told)
      if (!sources.includes(sourceTag)) continue
      const left = sources.filter(s => s !== sourceTag)
      // only ACCOUNT tags keep a record alive: a project left with nothing but place tags
      // ('repo:<slug>') is no longer fed by anything and must still be deleted (isAccountTag)
      if (left.some(isAccountTag)) {
        await F.update('projects', r._id, { ...strip(r), sources: left }).catch(() => {})
        tally.projects_kept++
      } else {
        await F.delete('projects', r._id).catch(() => {})
        if (r.project_id) { recIds.projects.delete(r.project_id); baselines.delete(r.project_id) }
        tally.projects_deleted++
      }
      step('projects', i, projects.length)
    }

    const profiles = await queryAll('profiles')
    i = 0
    for (const r of profiles) {
      i++
      const sources = Array.isArray(r.sources) ? r.sources : []
      if (!sources.length) { tally.profiles_untagged++; continue }
      if (!sources.includes(sourceTag)) continue // see the projects loop
      const left = sources.filter(s => s !== sourceTag)
      if (left.some(isAccountTag) || (keepLearnedSenders && learnedCategoryOf(r.profile))) {
        await F.update('profiles', r._id, { ...strip(r), sources: left }).catch(() => {})
        tally.profiles_kept++
      } else {
        await F.delete('profiles', r._id).catch(() => {})
        if (r.address) { recIds.profiles.delete(String(r.address).toLowerCase()); droppedAddresses.push(r.address) }
        tally.profiles_deleted++
      }
      step('profiles', i, profiles.length)
    }

    // 3. archived profile versions follow the profile they belong to
    if (droppedAddresses.length) {
      const gone = new Set(droppedAddresses)
      const rows = (await queryAll('profile_history')).filter(r => gone.has(r.address))
      let j = 0
      for (const r of rows) {
        await F.delete('profile_history', r._id).catch(() => {})
        tally.profile_history++
        step('profile_history', ++j, rows.length)
      }
    }

    // 4. the account record itself — LAST, so a failure part-way through leaves the account visible
    // (and this action repeatable) instead of orphaning whatever remains
    const acctRows = (await queryAll('accounts')).filter(r => r.account_id === accountId)
    for (const r of acctRows) {
      await F.delete('accounts', r._id).catch(() => {})
      recIds.accounts.delete(accountId)
      tally.accounts++
    }
    return tally
  }

  return {
    loadAll,
    hasAccounts,
    latestEvent,
    saveProject,
    deleteProject,
    saveProfile,
    saveProfileHistory,
    saveInstruction,
    saveAccount,
    readAccountWarnings: async () => (await queryAll('accounts')).filter(a => a.sync_error).map(a => ({ account_id: a.account_id, message: a.sync_error, token_expired: !!a.token_expired })),
    saveSettings,
    addEvent,
    loadEventsForProject,
    saveEmailBody,
    getEmailBody,
    getThreadBodies,
    saveInput,
    getInput,
    updateInputFields,
    pendingInputs,
    scanPendingInputs,
    processedMsgSet,
    msgAnalysisStatus,
    eventIdFor,       // deterministic analysis-event id — noteIngest back-points inputs to it
    actionEventIdFor, // phase 2 (mail_action events) — exported so the shape is fixed now
    persistStep,
    acquireRunLock,
    renewRunLock,
    releaseRunLock,
    readRunLock,
    readSettings,
    stampSettingsFields,
    stampNewMailCheck,
    stampBackgroundRun,
    stampPendingScanWatermark,
    saveAuditExchange,   // dev request audit (llmAudit.js / requestauditlab)
    saveAuditBlob,
    listAuditExchanges,
    readAuditBlob,
    pruneAudit,
    clearAudit,
    deleteAllData,
    deleteAccountData
  }
}

// Build one profile_history record from a REPLACED profile version (the "before" object).
// Archive-worthiness is the CALLER's decision — the rule everywhere is: snapshot only when the
// replaced version was solidified or user-edited (never the provisional first-pass churn).
// beforeProfile = the profile sub-object as it was; manualRank = the person's rank at that time.
export function profileHistorySnapshot (address, beforeProfile, { manualRank = null, source, reason, asof } = {}) {
  const pr = beforeProfile || {}
  return {
    address: String(address || '').toLowerCase(),
    summary: pr.summary || '',
    relationship: pr.relationship || null,
    responsibilities: Array.isArray(pr.responsibilities) ? pr.responsibilities.map(e => ({ ...e })) : (pr.responsibilities || null),
    user_tone: pr.user_tone || null,
    llm_importance: pr.llm_importance != null ? pr.llm_importance : null,
    manual_rank: manualRank,
    user_edited: !!pr.user_edited,
    profiled_asof: pr.last_profiled_asof || null,   // when the archived version was written
    solidified_asof: pr.solidified_asof || null,
    source: source || 'unknown',                    // 'reprofile:graduation|drift|user_request' | 'manual_edit' | 'manual_rank'
    reason: reason || null,
    replaced_asof: asof                             // when this version stopped being current
  }
}

// Build the compact `events` record for one processed message from the engine's step event
// (see manifest app_tables.events). Change entries are slimmed — full todo bodies live on the
// project; the event keeps enough to explain "what happened here". env (the source envelope)
// carries account_id — part of the event's deterministic identity.
export function eventFromStep (ev, sourceId, env) {
  const changes = ((ev.applied && ev.applied.changes) || []).map(c => ({
    type: c.type,
    project_id: c.project_id,
    todo_id: c.todo ? c.todo.todo_id : (c.response ? c.response.response_id : null),
    short: c.todo ? (c.todo.short_description || '') : (c.response ? ('reply: ' + (c.response.kind || '')) : ''),
    from: c.from || null,
    to: c.to || null,
    note: c.note || null
  }))
  // Field-level diffs (reconcile.diffTodo) — kept OFF `changes` so a priority nudge adds no row
  // to the Recent/Events feeds, but ON the record so "what did the LLM set, and what did the user
  // change afterwards" is answerable later. Text values are capped: an event is not a body store.
  const EDIT_TEXT_CAP = 300
  const capEdit = (v) => (typeof v === 'string' && v.length > EDIT_TEXT_CAP) ? v.slice(0, EDIT_TEXT_CAP) : v
  const todoEdits = ((ev.applied && ev.applied.todo_edits) || []).map(e => ({
    project_id: e.project_id || null, todo_id: e.todo_id || null, field: e.field, from: capEdit(e.from), to: capEdit(e.to)
  }))
  return {
    msg_id: ev.msg && ev.msg.msg_id,
    account_id: (env && env.account_id) || null,
    thread_id: ev.thread_id || null,
    channel: (ev.msg && ev.msg.channel) || 'mail', // the item's channel (specs/superlazy-inputs.md); absent on pre-0.29 records = mail
    // work items: the turn's effort record (duration, tokens, files/lines, tool calls) rides on the
    // event too, so the feed can say how much work a turn was without opening the item
    ...(ev.msg && ev.msg.channel_data && ev.msg.channel_data.work_stats ? { work_stats: ev.msg.channel_data.work_stats } : {}),
    ...(ev.msg && ev.msg.channel_data && ev.msg.channel_data.agent_name ? { agent_name: ev.msg.channel_data.agent_name } : {}),
    // WHERE the work happened. Older events have no such field, but the slug is inside their
    // thread id ('cc:<repoSlug>:<sessionId>'), so renderUtils.repoOfWorkItem can still show one.
    ...(ev.msg && ev.msg.channel_data && ev.msg.channel_data.repo_name ? { repo_name: ev.msg.channel_data.repo_name } : {}),
    ...(ev.msg && ev.msg.channel_data && ev.msg.channel_data.branch ? { branch: ev.msg.channel_data.branch } : {}),
    source_id: sourceId || null,
    asof: ev.asof,
    kind: ev.via_workflow ? 'workflow_short_circuit' : 'message',
    latest_delta: (ev.applied && ev.applied.latest_delta) || {},
    changes,
    todo_edits: todoEdits,
    role_changes: (ev.applied && ev.applied.role_changes) || [],
    via_workflow: ev.via_workflow || null,
    // profile lifecycle audit: inline (provisional) profile updates, drift decrements this
    // message caused, and any re-profiles it triggered. Full replaced VERSIONS live in the
    // profile_history collection (never pruned); these are the feed-visible signals.
    profile_updates: (ev.profUpdates || []).map(u => ({ address: u.address, summary: (u.after && u.after.summary) || null, reason: u.reason || null })),
    reprofiles: (ev.reprofiles || []).map(r => ({ address: r.address, trigger: r.trigger, outcome: r.outcome, reason: r.reason || null, cost: r.cost || 0 })),
    fetch_rounds: ev.fetchRounds || 0,
    request_profile: ev.request_profile || null,
    // What this ONE email consumed. cost is the message TOTAL (every request_more round plus any
    // re-profile it triggered), not the last call's — see engine.js spendSummary.
    cost: ev.cost || 0,
    cost_analysis: ev.cost_analysis != null ? ev.cost_analysis : null,
    cost_reprofiles: ev.cost_reprofiles != null ? ev.cost_reprofiles : null,
    duration_ms: ev.duration_ms != null ? ev.duration_ms : null,
    llm_calls: ev.llm_calls != null ? ev.llm_calls : null,
    tokens: ev.tokens || null,       // { input, output, other, total }
    model: (ev.meta && ev.meta.model) || null,
    prompt_version: (ev.meta && ev.meta.prompt_version) || null,
    subject: (ev.msg && ev.msg.subject) || '',
    labels: (ev.msg && ev.msg.labels) || [], // the mail client's own folders/labels at analysis time
    summary: (ev.output && typeof ev.output.message_summary === 'string' && ev.output.message_summary.trim()) || null,
    autoprocess_blocked: ev.autoprocess_blocked || null,
    // standing-instruction metrics (prompt 0.54): which ids this request offered the model, and
    // which of them it says changed the outcome. Both, or the cited count means nothing. Null when
    // the user has no instructions, so events cost nothing extra until the feature is in use.
    rules_offered: (ev.rules_offered && ev.rules_offered.length) ? ev.rules_offered : null,
    rules_applied: (ev.rules_applied && ev.rules_applied.length) ? ev.rules_applied : null,
    from_address: (ev.msg && ev.msg.from && ev.msg.from.address) || '',
    to_addresses: [...((ev.msg && ev.msg.to) || []), ...((ev.msg && ev.msg.cc) || [])]
      .map(r => String((r && r.address) || '').toLowerCase()).filter(Boolean),
    body_snippet: bodySnippetOf(ev.msg && ev.msg.clean_text),
    error: null
  }
}
