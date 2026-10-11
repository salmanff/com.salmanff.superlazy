// cleanupCore.js — the MEAT of the weekly clean-up, host-agnostic (specs/superlazy-weekly-cleanup.md
// §0.1): gather the stores and the window → build the CURRENT STATE and INPUT blocks (prepare — no
// model, so the cost can be estimated first) → one streamed call → validated ITEMS (proposals with
// ops, attention cards, the period summary, the focus list, questions with options) → decisions →
// apply under the audit lock. The /cleanup page mounts it today; the Setup tab and a background job
// mount the same object later. Knows nothing about the DOM.

import { previewForgottenItems, previewDormantProjects } from './deterministic.js'
import { CLEANUP_SYSTEM_PROMPT, CLEANUP_PROMPT_VERSION, GROUPS, buildStateBlock, buildInputIndex, buildClosingTurn, bucketIdsOf, periodCountsOf, dueWithinHorizon } from './cleanupPrompt.js'
import { gradeHandEdits, instructionUsage, scopeOverlaps } from './rulesInput.js'
import { validateProposal, describeOps, fingerprint } from './ops.js'
import { runCleanup } from './cleanupCall.js'
import { applyAccepted } from './applyProposals.js'
import { renderProjectDetail } from './reorgCall.js'
import { listArchived, restoreProject } from './archive.js'
import { createAuditSink } from '../llmAudit.js'
import { createProjectStore } from '../projectStore.js'
import { createProfileStore } from '../profiles.js'
import { createMaintStore, newRunId, newProposalKey, decisionsFrom } from './maintStore.js'
import { describeLockHolder } from '../lockText.js'
import { resolveDefaultModel, isPicked } from '../modelDefaults.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
// the shared run lock (persist.acquireRunLock — the ONE lock mail checks take): a clean-up holds it
// for its whole call, so no mail check starts under it; a mail check already running is waited for
const LOCK_STALE_MS = 5 * 60e3
const LOCK_BEAT_MS = 60e3
const LOCK_WAIT_MS = 3 * 60e3

const DAY = 24 * 3600e3
// accounts: null = every account (the default, and what the background job always uses); an array of
// account_ids restricts the INPUT WINDOW to items from those accounts (mail connection, Slack
// workspace, agent store, or 'manual' for local notes). Hand edits are never filtered — they are the
// user's own, not a channel. accountLabels: optional { account_id: label } so the closing turn can
// name the accounts for the model.
export const DEFAULT_KNOBS = { windowDays: 7, editsWindowDays: 30, focusDays: 7, inputMode: 'index', minAgeDays: 30, maxImportance: 3, quietDays: 21, dormantMonths: 3, sections: GROUPS.slice(), accounts: null }
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t }
const iso = (ms) => { try { return new Date(Number(ms)).toISOString().replace(/\.\d{3}Z$/, 'Z') } catch (e) { return String(ms) } }
const estTokens = (chars) => Math.round(chars / 4)

/**
 * @param {Object} o
 * @param {Object} o.freezr
 * @param {Object} o.persist        createPersistence()
 * @param {Object} o.store          hydrated project store
 * @param {Object} o.profiles       hydrated profile store
 * @param {Object} o.instructions   hydrated instruction store
 * @param {Object} o.settings
 * @param {Object} [o.source]       a MailSource (full-dump mode)
 * @param {Array}  [o.liveAccounts] mail accounts reachable through the source
 * @param {Set}    o.meSet
 * @param {Function} [o.nameOf]
 */
export function createCleanupCore ({ freezr, persist, store, profiles, instructions, settings = {}, source = null, liveAccounts = [], meSet = new Set(), nameOf = null }) {
  const core = {
    items: [],
    suppressed: 0,
    runId: null,
    runInfo: null,
    prepared: null,   // the last prepare() result (blocks + sizes), reused by run() when the knobs match
    events: [],       // the events scanned for the last prepare — the page's events provider reads these
    hood: { stateText: '', inputText: '', closingText: '', raw: '', needs: [], stats: null, meta: null, rounds: [], maps: null },
    lastResult: null
  }
  let decided = []
  const maintStore = { ...createMaintStore(freezr), newRunId, newProposalKey, decisionsFrom }
  let bucketIds = bucketIdsOf(profiles)

  core.knobsFromSettings = () => ({
    ...DEFAULT_KNOBS,
    windowDays: Number(settings.cleanup_window_days) || DEFAULT_KNOBS.windowDays,
    editsWindowDays: Number(settings.cleanup_edits_window_days) || DEFAULT_KNOBS.editsWindowDays,
    focusDays: Number(settings.cleanup_focus_days) || DEFAULT_KNOBS.focusDays,
    inputMode: settings.cleanup_input_mode === 'full' ? 'full' : 'index'
  })

  // ---- events over a window (newest-modified first is the only reliably indexed order) ----------
  async function scanWindow (fromMs, onProgress) {
    const out = []
    let skip = 0
    for (let page = 0; page < 40; page++) {
      const rows = await freezr.query('events', {}, { count: 500, skip, sort: { _date_modified: -1 } })
      if (!rows || !rows.length) break
      let anyRecent = false
      for (const r of rows) {
        const touched = Number(r._date_modified) || Number(r._date_created) || 0
        if (touched >= fromMs) anyRecent = true
        const asof = Number(r.asof) || Number(r._date_created) || 0
        if (asof >= fromMs) out.push(r)
      }
      if (onProgress) onProgress(out.length)
      if (rows.length < 500 || !anyRecent) break
      skip += rows.length
    }
    return out
  }

  const findTodo = (pid, tid) => {
    let p = pid && store.get(pid); let t = p && (p.todos || []).find(x => x.todo_id === tid)
    if (!t) for (const q of store.all()) { const f = (q.todos || []).find(x => x.todo_id === tid); if (f) { p = q; t = f; break } }
    return t ? { project: p, todo: t } : null
  }

  // ---- turn a raw section into a view ITEM (validated against the live stores) ---------------------
  const claimed = new Set()
  function makeItem (s, { persistIt = true, status = 'proposed' } = {}) {
    const item = {
      key: maintStore.newProposalKey(), recId: null, section: s.section, group: s.group || (s.section === 'attention' ? 'attention' : s.section === 'focus' ? 'focus' : s.section === 'summary' ? 'period' : 'questions'),
      title: s.title || s.headline || s.question || '', description: s.description || s.situation || s.why || '',
      evidence: Array.isArray(s.evidence) ? s.evidence : [], evidenceLabels: [],
      ops: [], rows: [], flags: [], problems: [], appliable: false, isNote: false, todoRefs: [],
      status, applyNote: null, data: s
    }
    const surOf = core.hood.maps && core.hood.maps.surrogateMsgId
    item.evidenceLabels = item.evidence.map(id => (surOf && surOf[id]) || clip(id, 14))
    const refsOf = (todoIds, pid) => todoIds.map(tid => { const f = findTodo(pid, tid); return f ? { todo_id: tid, project: f.project, todo: f.todo } : { todo_id: tid, missing: true } })
    if (s.section === 'proposal') {
      if (!GROUPS.includes(item.group) || ['attention', 'questions', 'period', 'focus'].includes(item.group)) { item.problems.push('unknown group ' + item.group); item.group = 'learn' }
      const v = validateProposal(s, { store, profiles, instructions: instructions.all(), bucketIds, claimed })
      item.ops = v.ops; item.problems = item.problems.concat(v.problems); item.flags = v.flags; item.isNote = v.isNote
      item.appliable = v.ok && !v.isNote
      try { item.rows = describeOps(v.ops, { store, profiles, instructions: instructions.all() }) } catch (e) { item.rows = [] }
      item.todoRefs = refsOf([...v.touches.todos], null)
    } else if (s.section === 'attention') {
      item.kind = s.kind || 'stalled'; item.headline = s.headline || ''; item.situation = s.situation || ''; item.recommendation = s.recommendation || ''
      item.project_id = s.project_id || null
      item.todoRefs = refsOf(Array.isArray(s.todo_ids) ? s.todo_ids : [], item.project_id)
      item.people = Array.isArray(s.people) ? s.people : []
    } else if (s.section === 'focus') {
      item.markdown = s.markdown || ''
      item.focusItems = (Array.isArray(s.items) ? s.items : []).map(fi => { const f = findTodo(fi.project_id, fi.todo_id); return { todo_id: fi.todo_id, when: ['today', 'this_period', 'later'].includes(fi.when) ? fi.when : 'this_period', why: fi.why || '', project: f && f.project, todo: f && f.todo, missing: !f } })
      item.title = 'Focus'
    } else if (s.section === 'summary') {
      item.markdown = s.markdown || ''
      item.title = 'This period'
    } else if (s.section === 'question') {
      item.question = s.question || ''; item.why = s.why || ''
      item.group = 'questions'; item.forGroup = s.group || null
      // options are ALTERNATIVES — validated against a throwaway claim set, never against each other
      item.options = (Array.isArray(s.options) ? s.options : []).map(o => {
        const v = validateProposal({ group: item.forGroup && GROUPS.includes(item.forGroup) && !['attention', 'questions', 'period', 'focus'].includes(item.forGroup) ? item.forGroup : 'learn', ops: Array.isArray(o.ops) ? o.ops : [] }, { store, profiles, instructions: instructions.all(), bucketIds, claimed: new Set() })
        let rows = []
        try { rows = describeOps(v.ops, { store, profiles, instructions: instructions.all() }) } catch (e) { rows = [] }
        return { label: o.label || '(option)', ops: v.ops, ok: v.ok, problems: v.problems, flags: v.flags, rows }
      })
      item.chosen = null
    }
    item.fingerprint = fingerprint({ ...s, group: item.group })
    if (decided.some(d => d.fingerprint && d.fingerprint === item.fingerprint)) { item.suppressed = true; core.suppressed++; return item }
    core.items.push(item)
    if (persistIt) {
      maintStore.saveProposal({
        proposal_key: item.key, run_id: core.runId, section: item.section, group: item.group, kind: item.ops[0] ? item.ops[0].op : item.section,
        title: item.title, description: clip(item.description, 2000), question: item.question || null, headline: item.headline || null,
        data: s, fingerprint: item.fingerprint, flags: item.flags, evidence: item.evidence, status: item.status,
        prompt_version: CLEANUP_PROMPT_VERSION, created_asof: Date.now()
      }).then(id => { item.recId = id })
    }
    return item
  }

  // ---- PREPARE: everything except the model call — so the size (and cost) is known first ---------
  // knobs.projectId (2026-09-26): review ONE project — the project editor's button. Same prompt,
  // same operations, same review surface and apply path as the weekly run; the state block holds
  // only that project (its participants' profiles, its own stale/due rows), the input index only
  // the window's items that touched it, the rules/people/learn sections are off, and the closing
  // turn says so (cleanupPrompt.buildClosingTurn projectFocus). Replaces the separate R1 prompt.
  core.prepare = async function prepare ({ knobs = core.knobsFromSettings(), onStatus = () => {} } = {}) {
    const now = Date.now()
    bucketIds = bucketIdsOf(profiles)
    const windowFrom = now - knobs.windowDays * DAY
    const editsFrom = now - Math.max(knobs.windowDays, knobs.editsWindowDays) * DAY
    const focus = knobs.projectId ? store.get(knobs.projectId) : null
    if (knobs.projectId && !focus) throw new Error('project not found: ' + knobs.projectId)
    // the VIEW the model reads: one project, or the whole store. Applying always acts on the real store.
    let viewStore = store; let viewProfiles = profiles
    if (focus) {
      viewStore = createProjectStore(); viewStore.hydrate([focus])
      viewProfiles = createProfileStore()
      const addrs = focus.participant_emails || Object.keys(focus.participants || {})
      viewProfiles.hydrate(addrs.map(a => profiles.get(String(a || '').toLowerCase())).filter(Boolean))
    }
    const touchesFocus = (e) => !!focus && (e.project_id === focus.project_id || (e.changes || []).some(c => c && c.project_id === focus.project_id) || (e.thread_id && (focus.thread_ids || []).includes(e.thread_id)))

    onStatus('Reading the events log…', 'busy')
    const recent = await maintStore.loadRecent()
    decided = maintStore.decisionsFrom(recent.decided)
    const allEvents = await scanWindow(editsFrom, (n) => onStatus('Reading the events log… ' + n + ' events', 'busy'))
    const events = focus ? allEvents.filter(touchesFocus) : allEvents
    core.events = events
    // the accounts filter (page knob, per run): drops the window's channel items whose account is not
    // selected; manual edits pass; legacy events with no account_id are dropped when a filter is on
    const accountSet = Array.isArray(knobs.accounts) && !focus ? new Set(knobs.accounts.map(String)) : null
    const accountOk = (e) => !accountSet || e.kind === 'manual_edit' || (e.account_id != null && accountSet.has(String(e.account_id)))
    const windowEvents = events.filter(e => (Number(e.asof) || 0) >= windowFrom && accountOk(e))
    // projects the window's items touched — their open to-dos carry the last analyst note each
    const touchedProjectIds = new Set(focus ? [focus.project_id] : [])
    for (const ev of windowEvents) for (const c of (ev.changes || [])) if (c && c.project_id) touchedProjectIds.add(c.project_id)
    // SCOPE (user, 2026-10-04): with an accounts restriction the model must not touch projects and
    // to-dos the chosen accounts never fed — so the catalog it reads holds only the projects whose
    // `sources` provenance carries one of those accounts' tags (persist.sourceTagFor: email:<addr>,
    // slack:<conn>, agents:<conn>, note:manual), plus any project a selected-account item touched in
    // the window (covers records written before tagging). People: those learned from the accounts,
    // plus the participants of the projects kept. Hand edits and earlier decisions follow the same set.
    let scope = null
    if (accountSet) {
      const tags = new Set((knobs.accountTags || []).map(String))
      const inScope = (pr) => touchedProjectIds.has(pr.project_id) || (pr.sources || []).some(t => tags.has(String(t)))
      const kept = store.all().filter(inScope)
      viewStore = createProjectStore(); viewStore.hydrate(kept)
      const keptIds = new Set(kept.map(pr => pr.project_id))
      const addrs = new Set()
      for (const pr of kept) for (const a of (pr.participant_emails || Object.keys(pr.participants || {}))) addrs.add(String(a || '').toLowerCase())
      viewProfiles = createProfileStore()
      viewProfiles.hydrate(profiles.all().filter(pf => pf && pf.address && (addrs.has(String(pf.address).toLowerCase()) || (pf.sources || []).some(t => tags.has(String(t))))))
      scope = { projects: kept.length, of: store.all().length, people: viewProfiles.all().length, ids: keptIds }
    }
    const inScopeEdit = (e) => !scope || (!e.project_id && !e.project_id_2) || scope.ids.has(e.project_id) || scope.ids.has(e.project_id_2)
    const editEvents = events.filter(e => e.kind === 'manual_edit' && (e.source_id === 'user' || e.source === 'manual') && inScopeEdit(e))
    const handEdits = gradeHandEdits(editEvents, { store, profiles, nameOf })
    const instrRecords = focus ? [] : instructions.all()
    const rulesUsage = focus ? [] : instructionUsage(instrRecords, events, handEdits, { nowMs: now })
    const overlaps = focus ? [] : scopeOverlaps(instrRecords)
    const stale = previewForgottenItems({ store: viewStore, minAgeDays: knobs.minAgeDays, maxImportance: knobs.maxImportance, quietDays: knobs.quietDays })
    const dormant = previewDormantProjects({ store: viewStore, dormantMonths: knobs.dormantMonths })
    const decisionInScope = (d) => {
      if (focus) return d.fingerprint && d.fingerprint.includes(focus.project_id)
      if (!scope) return true
      const pids = String(d.fingerprint || '').match(/p_[a-z0-9_]+/gi) || []
      return !pids.length || pids.some(id => scope.ids.has(id))
    }
    const earlierDecisions = decided.filter(decisionInScope).map(d => ({ kind: d.kind, asof: d.asof, text: d.text }))
    const periodCounts = periodCountsOf(windowEvents, handEdits.filter(e => e.asof >= windowFrom))
    const dueRows = dueWithinHorizon(viewStore, { nowMs: now, focusDays: knobs.focusDays })

    onStatus('Building the current state…', 'busy')
    const stateText = buildStateBlock({ settings, store: viewStore, profiles: viewProfiles, instructions: instrRecords, rulesUsage, overlaps, handEdits, staleRows: stale.rows, dormantRows: dormant.rows, earlierDecisions, meSet, periodCounts, dueRows, focusDays: knobs.focusDays, touchedProjectIds })

    let inputText = ''; let maps = null; let stats = null; let fullBodies = null
    if (knobs.inputMode === 'full' && !focus) {
      const dumpAccounts = accountSet ? liveAccounts.filter(a => accountSet.has(String(a.account_id))) : liveAccounts
      if (!source || !liveAccounts.length) throw new Error('full-mail mode needs a reachable mail account — switch the input to "index"')
      if (!dumpAccounts.length) throw new Error('full-mail mode: none of the selected accounts is a reachable mail account — tick a mail account or switch the input to "index"')
      onStatus('Fetching ' + knobs.windowDays + ' days of mail…', 'busy')
      const { buildDump } = await import('../../bootstrap/dumpBuilder.js')
      const dump = await buildDump({ source, accountInfos: dumpAccounts, historyDays: knobs.windowDays, meSet, currentState: '(see the CURRENT STATE block above)', onProgress: (p) => onStatus('Fetching mail… ' + (p.total ? p.stage + ' — ' + p.done + ' of ' + p.total : p.stage), 'busy') })
      inputText = '# INPUT WINDOW — full mail threads\n' + dump.text.replace(/^# MAILBOX DUMP[^\n]*\n/, '')
      maps = dump.maps; stats = { ...dump.stats, mode: 'full' }; fullBodies = dump.fullBodies
    } else {
      const idx = buildInputIndex(windowEvents, { store, nameOf, meSet, fromMs: windowFrom, toMs: now })
      inputText = idx.text; maps = idx.maps; stats = idx.stats
    }
    const closingText = buildClosingTurn({ today: new Date(now), windowDays: knobs.windowDays, editsWindowDays: knobs.editsWindowDays, focusDays: knobs.focusDays, stale: knobs, dormantMonths: knobs.dormantMonths, inputMode: knobs.inputMode, sections: knobs.sections, projectFocus: focus ? { project_id: focus.project_id, name: focus.name } : null,
      accounts: accountSet ? knobs.accounts.map(id => (knobs.accountLabels && knobs.accountLabels[id]) || id) : null, scope })
    const sizes = {
      system: CLEANUP_SYSTEM_PROMPT.length, state: stateText.length, input: inputText.length, closing: closingText.length
    }
    sizes.totalChars = sizes.system + sizes.state + sizes.input + sizes.closing
    sizes.estTokens = estTokens(sizes.totalChars)
    const prepared = { knobs: { ...knobs, sections: knobs.sections.slice(), accounts: accountSet ? knobs.accounts.slice() : null }, preparedAt: now, windowFrom, scope: scope ? { projects: scope.projects, of: scope.of, people: scope.people } : null, stateText, inputText, closingText, maps, stats, sizes, fullBodies, events, handEdits, stale: stale.rows, dormant: dormant.rows, periodCounts, dueRows }
    core.prepared = prepared
    core.hood = { ...core.hood, stateText, inputText, closingText, stats, maps, sizes, scope: prepared.scope, handEdits: handEdits.length, staleRows: stale.rows.length, dormantRows: dormant.rows.length, periodCounts, dueRows: dueRows.length }
    return prepared
  }

  // Rough cost of sending the prepared request: input tokens × the model's input price. Output is
  // unknown until it comes back; the last run's output tokens (if any) give a hint.
  core.estimate = function estimate (prepared, pricing, { lastOutputTokens = null } = {}) {
    const p = prepared || core.prepared
    if (!p) return null
    const inTok = p.sizes.estTokens
    const priceIn = pricing && Number(pricing.input) ? Number(pricing.input) : null
    const priceOut = pricing && Number(pricing.output) ? Number(pricing.output) : null
    return {
      inputTokens: inTok, inputCost: priceIn != null ? inTok * priceIn / 1e6 : null,
      outputTokensHint: lastOutputTokens, outputCostHint: (priceOut != null && lastOutputTokens) ? lastOutputTokens * priceOut / 1e6 : null,
      priceKnown: priceIn != null
    }
  }

  const sameKnobs = (a, b) => a && b && JSON.stringify({ ...a, sections: a.sections.slice().sort() }) === JSON.stringify({ ...b, sections: b.sections.slice().sort() })

  // ---- the run --------------------------------------------------------------------------------------
  // lock: take the shared run lock for the call (default). source: 'page' | 'job' — a JOB run's
  // result is stamped unseen (settings.cleanup_last_run) so every page shows the results bar until
  // the user opens it; a page run is seen by definition. deadlineMs: the job's wall clock — no new
  // model round is started past it (cleanupCall), so the job always returns before it is killed.
  core.run = async function run (args = {}) {
    const { lock = true, knobs = core.knobsFromSettings(), onStatus = () => {} } = args
    if (!lock || !persist || typeof persist.acquireRunLock !== 'function') return runInner(args)
    const kind = knobs.projectId ? 'project_review' : 'cleanup'
    const owner = (args.source === 'job' ? 'job:' : 'tab:') + kind + ':' + Date.now().toString(36)
    const stage = knobs.projectId ? 'reviewing one project' : 'weekly clean-up'
    const waitUntil = Date.now() + LOCK_WAIT_MS
    for (;;) {
      const got = await persist.acquireRunLock({ owner, kind, staleMs: LOCK_STALE_MS, progress: { stage } })
      if (got.ok) break
      const h = got.holder || {}
      if (h.kind === 'newmail' && Date.now() < waitUntil) { onStatus('Waiting for the mail check that is running to finish…', 'busy'); await sleep(10e3); continue }
      // say WHO holds it, when it last showed life and when a DEAD holder frees it (2026-10-04: a
      // server restart mid-job left an orphan lock and the bare message read like a failure)
      throw new Error(describeLockHolder(got.holder || null))
    }
    const beat = setInterval(() => { persist.renewRunLock({ owner, staleMs: LOCK_STALE_MS, progress: { stage } }).catch(() => {}) }, LOCK_BEAT_MS)
    try { return await runInner(args) } finally {
      clearInterval(beat)
      await persist.releaseRunLock({ owner }).catch(() => {})
    }
  }

  async function runInner ({ knobs = core.knobsFromSettings(), model = null, onStatus = () => {}, onItem = null, onDelta = null, onThinking = null, onRound = null, source = 'page', deadlineMs = null } = {}) {
    const startedAt = Date.now()
    core.items = []; core.suppressed = 0; claimed.clear()
    core.runId = maintStore.newRunId()
    core.hood = { ...core.hood, raw: '', needs: [], meta: null, rounds: [] }
    // reuse a fresh preparation of the same knobs (the page estimates first, then runs)
    const p = (core.prepared && sameKnobs(core.prepared.knobs, knobs) && (startedAt - core.prepared.preparedAt) < 10 * 60e3) ? core.prepared : await core.prepare({ knobs, onStatus })
    const { stateText, inputText, closingText, maps, stats, fullBodies, events } = p

    const resolveNeed = async (items) => {
      const parts = []
      for (const it of (items || []).slice(0, 12)) {
        if (it.kind === 'project_detail') {
          const pr = store.get(it.project_id)
          parts.push(pr ? renderProjectDetail(pr, { nameOf }) : '(unknown project ' + it.project_id + ')')
        } else if (it.kind === 'message_body') {
          parts.push(await renderBody(it.msg_id))
        } else if (it.kind === 'thread') {
          const tid = it.thread_id
          const inWindow = events.filter(e => (e.thread_id || e.msg_id) === tid && e.msg_id).sort((a, b) => (Number(a.asof) || 0) - (Number(b.asof) || 0))
          const sur = (maps.surrogateThreadId && maps.surrogateThreadId[tid]) || tid
          parts.push('=== THREAD ' + sur + ' · ' + inWindow.length + ' item(s) ===')
          let n = 0
          for (const e of inWindow.slice(0, 15)) { parts.push(await renderBody(e.msg_id)); n++ }
          if (!n) {
            try { const rows = await persist.getThreadBodies(tid); for (const b of rows.slice(-15)) parts.push(fmtBody(b, (maps.surrogateMsgId && maps.surrogateMsgId[b.msg_id]) || b.msg_id)) } catch (e) { parts.push('(thread not stored)') }
          }
        }
      }
      return parts.join('\n\n')
    }
    async function renderBody (realId) {
      const sur = (maps.surrogateMsgId && maps.surrogateMsgId[realId]) || realId
      if (fullBodies && fullBodies[realId] != null) return '--- msg ' + sur + '\n' + fullBodies[realId]
      const meta = (maps.msgMeta && maps.msgMeta[realId]) || {}
      try {
        const b = await persist.getEmailBody({ account_id: meta.account_id || null, msg_id: realId })
        if (b) return fmtBody(b, sur)
      } catch (e) { /* fall through */ }
      return '--- msg ' + sur + '\n(full text not stored — only the analyst\'s summary in the index is available)'
    }
    const fmtBody = (b, sur) => '--- msg ' + sur + ' · ' + iso(b.date) + '\nFrom: ' + (b.from_address || '') + (b.from_name ? ' (' + b.from_name + ')' : '') +
      ((b.to_addresses || []).length ? '  To: ' + b.to_addresses.map(x => x.address).join(', ') : '') + '\nSubject: ' + (b.subject || '') + '\n' + clip(b.body_text || '', 6000)

    // no model chosen (settings.cleanup_model unset, or the picker on "Recommended default"): the
    // review tier within the user's own provider — opus on Claude (modelDefaults.js)
    if (!isPicked(model)) model = await resolveDefaultModel(freezr, 'review')
    onStatus('Sending ≈' + Math.round(p.sizes.estTokens / 1000) + 'k tokens (state ' + Math.round(stateText.length / 1000) + 'k chars · input ' + Math.round(inputText.length / 1000) + 'k chars, ' + (stats.items || stats.messages || 0) + ' items) — asking the model…', 'busy')
    // the request audit (same table and shape as the analysis calls) — when the Setup console has it on
    const auditSink = (settings.llm_audit && persist && typeof persist.saveAuditExchange === 'function')
      ? createAuditSink({ persist, runId: core.runId, driver: knobs.projectId ? 'project_review' : 'cleanup' })
      : null
    const r = await runCleanup({
      freezr, systemPrompt: CLEANUP_SYSTEM_PROMPT, stateText, inputText, closingText, maps, model, resolveNeed,
      onExchange: auditSink, promptVersion: CLEANUP_PROMPT_VERSION, deadlineMs,
      onSection: (s) => {
        if (s.section === 'need') { core.hood.needs.push(s); return }
        if (s.section === 'done') return
        const item = makeItem(s)
        if (!item.suppressed && onItem) onItem(item)
      },
      onDelta, onThinking,
      onRound: (rd) => { core.hood.rounds.push(rd); if (onRound) onRound(rd) }
    })
    core.hood.raw = r.raw; core.hood.meta = r.meta
    core.lastResult = r
    if (auditSink) await auditSink.flush().catch(() => {})
    const c = (r.meta && r.meta.cost) || {}
    const cost = Number(c.totalCost) || 0
    const counts = {}
    for (const g of GROUPS) counts[g] = core.items.filter(i => i.group === g).length
    const tu = (r.meta && r.meta.tokensUsed) || {}
    const tokens = { input: (tu.input && tu.input.qtty) || 0, output: (tu.output && tu.output.qtty) || 0, cache_read: (tu.other && tu.other.qtty) || 0 }
    core.runInfo = { runId: core.runId, startedAt, finishedAt: Date.now(), cost, costIn: Number(c.inputCost) || 0, costOut: Number(c.outputCost) || 0, costOther: Number(c.otherCost) || 0, tokens, estTokens: p.sizes.estTokens, counts, incomplete: r.incomplete, needRounds: r.needRounds, model: (r.meta && r.meta.model) || null, stats, suppressed: core.suppressed }
    maintStore.saveRun({
      run_id: core.runId, call: knobs.projectId ? 'project_review' : 'cleanup', project_id: knobs.projectId || null, prompt_version: CLEANUP_PROMPT_VERSION, knobs: { ...knobs }, input_mode: knobs.inputMode,
      window: { days: knobs.windowDays, from: p.windowFrom, to: startedAt }, dump_stats: stats, sizes: p.sizes, model: core.runInfo.model,
      cost, cost_split: { input: core.runInfo.costIn, output: core.runInfo.costOut, other: core.runInfo.costOther }, tokens,
      sections: counts, suppressed: core.suppressed, need_rounds: r.needRounds, incomplete: !!r.incomplete, failure: r.failure || null,
      started_at: startedAt, finished_at: Date.now()
    })
    // the last FULL run, as every page's results bar reads it (one-project reviews are shown in place)
    const stamp = { cleanup_last_run_asof: Date.now() }
    if (!knobs.projectId) {
      const suggestions = core.items.filter(i => !i.suppressed && i.section !== 'summary' && i.section !== 'focus').length
      stamp.cleanup_last_run = {
        run_id: core.runId, source, started_at: startedAt, finished_at: Date.now(), cost, model: core.runInfo.model,
        counts, suggestions, attention: counts.attention || 0, incomplete: !!r.incomplete, failure: r.failure || null,
        seen: source !== 'job'
      }
    }
    await persist.stampSettingsFields(stamp).catch(() => {})
    return core.runInfo
  }

  // ---- pending items from earlier runs (the "stranded proposals" fix) ----------------------------
  // runId: only that run's items (the results bar, "View the last clean-up"); omitted: every pending
  // item. includeDecided (with runId): VIEW the whole run — applied, ignored and answered items too,
  // each shown with its status, and nothing suppressed as "ignored before"
  core.loadPending = async function loadPending ({ runId = null, includeDecided = false } = {}) {
    const recent = await maintStore.loadRecent()
    const viewAll = !!(runId && includeDecided)
    decided = viewAll ? [] : maintStore.decisionsFrom(recent.decided)
    core.items = []; core.suppressed = 0; claimed.clear()
    // items of any ops-shaped version (0.3+) — the shape is compatible; older records are not re-shown
    const pool = viewAll ? (recent.all || recent.pending) : recent.pending
    const rows = pool.filter(r => r.data && r.data.section && String(r.prompt_version || '') >= '0.3' && (!runId || r.run_id === runId))
    rows.sort((a, b) => (Number(a.created_asof) || 0) - (Number(b.created_asof) || 0))
    for (const r of rows) {
      const item = makeItem(r.data, { persistIt: false, status: r.status || 'proposed' })
      item.recId = r._id; item.key = r.proposal_key || item.key; item.fromRun = r.run_id; item.createdAsof = Number(r.created_asof) || 0
    }
    const runIds = [...new Set(rows.map(r => r.run_id))]
    core.runId = runIds[runIds.length - 1] || null
    const lastRun = recent.runs.find(r => r.run_id === core.runId)
    core.runInfo = lastRun ? { runId: lastRun.run_id, startedAt: lastRun.started_at, finishedAt: lastRun.finished_at, cost: lastRun.cost || 0, costIn: lastRun.cost_split && lastRun.cost_split.input, costOut: lastRun.cost_split && lastRun.cost_split.output, costOther: lastRun.cost_split && lastRun.cost_split.other, tokens: lastRun.tokens, counts: lastRun.sections || {}, model: lastRun.model, stats: lastRun.dump_stats, pending: true } : null
    return { items: core.items, runs: recent.runs }
  }

  core.setStatus = function setStatus (item, status) {
    item.status = status
    if (item.recId) maintStore.updateProposal(item.recId, { status, status_asof: Date.now() })
  }

  // choosing a question's option: the option's ops become a pre-accepted proposal in the section the question serves
  core.questionOption = function questionOption (q, idx) {
    const opt = q.options && q.options[idx]
    if (!opt) return null
    q.chosen = idx
    q.status = 'answered'
    if (q.recId) maintStore.updateProposal(q.recId, { status: 'answered', answer: { label: opt.label, index: idx, asof: Date.now() }, status_asof: Date.now() })
    if (!opt.ops.length) return null
    const group = q.forGroup && GROUPS.includes(q.forGroup) && !['attention', 'questions', 'period', 'focus'].includes(q.forGroup) ? q.forGroup : 'learn'
    const item = makeItem({ section: 'proposal', group, title: opt.label, description: 'your answer to: ' + (q.question || ''), evidence: q.evidence || [], ops: opt.ops }, { status: 'accepted' })
    item.derivedFrom = q.key
    q.derived = q.derived || []
    q.derived.push(item)
    return item
  }

  core.apply = async function apply ({ onProgress } = {}) {
    const accepted = core.items.filter(i => i.status === 'accepted' && i.appliable && !i.suppressed)
    if (!accepted.length) return { results: [] }
    const { results } = await applyAccepted({ freezr, persist, store, profiles, instructions, items: accepted, runId: core.runId, onProgress })
    const byKey = new Map(results.map(r => [r.key, r]))
    for (const it of accepted) {
      const r = byKey.get(it.key)
      if (!r) continue
      it.status = r.ok ? 'applied' : 'failed'; it.applyNote = r.ok ? r.note : r.error
      if (it.recId) maintStore.updateProposal(it.recId, r.ok ? { status: 'applied', applied_asof: Date.now(), apply_note: r.note } : { status: 'accepted', apply_error: r.error })
    }
    bucketIds = bucketIdsOf(profiles)
    return { results }
  }

  // a locally-made item (housekeeping previews) — rendered like any proposal, never persisted
  core.addLocal = (s) => makeItem(s, { persistIt: false })
  // the live project record by id — the view's Source filter reads its `sources` tags
  core.projectOf = (id) => (id && store.get(id)) || null
  core.listArchived = () => listArchived(freezr)
  core.restore = (rec) => restoreProject({ freezr, persist, rec })
  core.tally = () => {
    const live = core.items.filter(i => !i.suppressed && !i.derivedFrom)
    return {
      accepted: core.items.filter(i => i.status === 'accepted' && i.appliable).length,
      ignored: live.filter(i => i.status === 'ignored').length,
      undecided: live.filter(i => i.status === 'proposed' && i.section !== 'summary' && i.section !== 'focus').length,
      applied: core.items.filter(i => i.status === 'applied').length
    }
  }
  return core
}
