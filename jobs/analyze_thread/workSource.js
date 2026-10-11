// workSource.js — the WORK-channel InputSource (Claude Code sessions first) — specs/superlazy-sessions.md.
// Same interface as liveMailSource.js / slackSource.js — the engine and the pages can't tell them
// apart. Needs the use_file_sys permission (read_work_sessions) granted AND a local file store at
// /account/resources rooted at ~/.claude (or ~/.claude/projects).
//
// THE MODEL (user, 2026-09-07): a session is a THREAD; each request-and-answer TURN is one input
// item — exactly like one email in a thread. Turn n's item has in_reply_to = turn n-1's item, so
// the engine inlines the previous turn in full (the "replied-to email") and lists the earlier ones
// as index rows. The agent is a TEAM MEMBER: a name-only participant ("Claude Code") and the owner of
// work owed to the user. Events, projects, to-dos and the viewer all work unchanged.
//
// THE SHAPE OF INGESTION (the Slack pattern, pipeline-walkthrough §14):
//   fs list (sessions touched since the cursor) → read + parse (sessionDigest.js, pure) → for every
//   turn beyond the session's stored high-water mark: PERSIST an `inputs` record (status 'pending')
//   → listEnvelopes returns the pending inputs as envelopes → the normal queue analyses them.
// A turn is queued when it ENDED (the agent's closing text arrived) — the last, still-open turn of
// a session is HELD until the session has been quiet for QUIET_MS (then it is queued as-is: "left
// mid-turn" is itself the information). Items are persisted at formation, before analysis, so
// retries re-read the stored turn, never re-parse the transcript.
//
// ACCOUNT RECORD (one per fs connection, channel:'work'). Extra fields owned here:
//   me_email                                   — the user's address (ME) for the item author
//   repos: { <slug>: { tracked, name, first_seen, last_seen_ms } }   (slugs are dot-free; tracked === false = EXCLUDED, everything else is read)
//   sessions: { <sessionId>: { turns_done, last_ts, title, repo } }  — per-session high-water marks
//   last_sync_ms                               — steady-state re-list floor (minus an overlap)

import { createPendingReader } from './pendingScan.js'
import { createSessionsSource } from './sessionsSource.js'
import { AGENT_NAMES, agentNameFor, agentNameOfAccount } from './config.js'
import {
  sessionFromText, classifySession, renderTurnBody, turnStats, turnMsgIdFor, threadIdFor, DIGEST_TUNING
} from './sessionDigest.js'

const FORM_DEADLINE_MS = 60 * 1000
const SESSIONS_PER_RUN_CAP = 40
const TURNS_PER_RUN_CAP = 300
const RELIST_OVERLAP_MS = 6 * 3600 * 1000  // steady state: re-list sessions modified since last_sync - overlap

export const WORK_SOURCE_ID = 'live:connections.fs'
// The agent's display name per provider now lives in config.js, so the UI can read it without
// importing this whole InputSource. IMPORTED (not just re-exported) because this module calls
// agentNameFor itself — a bare `export … from` would re-export without binding it locally.
export { AGENT_NAMES, agentNameFor, agentNameOfAccount }
export const isWorkAccount = (rec) => !!rec && (rec.channel === 'work' || String(rec.source_id || '').startsWith(WORK_SOURCE_ID))

const safeKey = (s) => String(s || '').replace(/\./g, '_')

// contextOnlyBeforeFloor: in a HISTORY read, a turn OLDER than the account's first-read floor is
// stored with status 'skipped' + context_only:true — it rides in the thread as context (loadThreadRaw
// returns it) but is never queued, because the plan's window would drop its envelope anyway and a
// pending record it could never analyse would sit in the queue forever. The lab's dry run passes
// false (it analyses every formed turn).
// pendingFloorMs: how far back to page for pending turns (ingest.js computes it from the watermark);
// null = the legacy newest-300 read (labs, Inspect) — see pendingScan.js.
export function createWorkSource ({ freezr: fz, persist = null, accounts = [], dryRun = false, tuning = DIGEST_TUNING, contextOnlyBeforeFloor = true, pendingFloorMs = null } = {}) {
  const F = fz || (typeof freezr !== 'undefined' ? freezr : null)
  const recs = (accounts || []).filter(r => r && r.account_id)
  const readers = new Map()   // account_id -> sessionsSource
  let formedPromise = null
  let lastFormation = null
  const pending = createPendingReader({ persist, floorMs: pendingFloorMs })

  const readerFor = (rec) => {
    if (!readers.has(rec.account_id)) readers.set(rec.account_id, createSessionsSource({ freezr: F, connectionName: rec.account_id }))
    return readers.get(rec.account_id)
  }

  async function listAccounts () {
    const res = await F.apiRequest('GET', '/feps/connections/accounts')
    const rows = ((res && res.accounts) || []).filter(a => Array.isArray(a.services) && a.services.includes('fs'))
    return {
      accounts: rows.map(a => ({
        account_id: a.connectionName,
        account_email: a.account_email || a.connectionName,
        provider: 'claude_code',
        access: (a.access && a.access.fs) || 'read',
        status: a.status || 'ok',
        message_count: null,
        last_received: null
      }))
    }
  }

  // ---- inputs record for one turn -----------------------------------------------------------

  function inputRecordFor (rec, session, turn, verdict) {
    const n = turn.n
    const prev = n > 1 ? turnMsgIdFor(session.sessionId, n - 1) : null
    const me = String(rec.me_email || rec.account_email || '').toLowerCase()
    const provider = session.provider || rec.provider || 'claude_code'   // the transcript says which agent
    const agent = agentNameFor(provider)
    return {
      channel: 'work',
      item_kind: 'agent_turn',
      provider,
      agent_name: agent,
      source_path: session.path || null,
      account_id: rec.account_id,
      msg_id: turnMsgIdFor(session.sessionId, n),
      thread_id: threadIdFor(session.repoSlug, session.sessionId),
      session_id: session.sessionId,
      repo_slug: session.repoSlug,
      repo_name: session.repoName || null,
      branch: session.gitBranch || null,
      cwd: session.cwd || null,
      turn_n: n,
      turns_total: session.turns.length,
      date: Number(turn.ts) || Number(session.lastTs) || Date.now(),
      in_reply_to: prev,
      author_address: me,
      author_name: 'ME',
      participants: [{ address: '', name: agent, kind: 'agent' }],
      participants_kind: 'agent_dialogue',
      title: session.title || '(untitled session)',
      body_text: renderTurnBody(turn, { agentName: agent }),
      body_html: null,
      labels: [],
      attachments: [],
      turn_state: turn.interrupt || (turn.ended ? 'ended' : 'open'),
      turn_kind: turn.askedQuestion ? 'question' : 'ask',   // question: the agent ended by asking the user
      files_changed: (turn.files || []).map(p => String(p).split('/').pop()),
      files_changed_paths: (turn.files || []).slice(0, 40),
      // git snapshot at session start (branch, uncommitted files, recent commits) — first turn only;
      // stored for later use, NOT shown to the model (channel_data leaves it out on purpose)
      repo_state: n === 1 ? (session.repoState || null) : null,
      commits: (turn.commits || []).map(c => ({ hash: c.hash, branch: c.branch, message: c.message, files: c.files, insertions: c.insertions, deletions: c.deletions })),
      tools: turn.tools || {},
      plan: turn.plan || null,   // legacy title — agent_work.plans holds the text
      // What the agent PLANNED and TICKED OFF, kept whole (specs/superlazy-sessions.md §6.3):
      //   plans      — the plan-mode plan and any markdown document written this turn, full text
      //   checklist  — the agent's own TodoWrite list as it stood at the end of the turn
      //   latest_plan — the newest plan the session knows AS OF this turn (hot on its own turn,
      //                 a one-line reference on every later one)
      agent_work: {
        plans: (turn.planDocs || []).map(d => ({ ...d })),
        checklist: Array.isArray(turn.todos) ? turn.todos.map(t => ({ content: String(t.content || ''), status: String(t.status || 'pending') })) : null,
        latest_plan: turn.planRef ? { ...turn.planRef } : null
      },
      // the EFFORT record — what survives of the dropped tool use / intermediate answers / usage
      work_stats: turnStats(turn),
      session_state: verdict.state,
      session_flags: verdict.flags,
      authority: 'provider',
      archived: false,
      status: 'pending',
      analysis_event_id: null,
      revision: turn._reformed ? 2 : 1,   // 2 = re-formed after its open version was analysed (REVISED to the model)
      content_hash: null,
      edited_asof: null,
      captured_asof: Date.now(),
      sources: ['agents:' + rec.account_id]
    }
  }

  // ---- formation ---------------------------------------------------------------------------------

  // Which turns of a parsed session are ready to become items, given the stored high-water mark.
  // Exported logic (pure) so the lab can preview exactly what a run would queue.
  function readyTurns (session, hw, { now = Date.now() } = {}) {
    const done = Number((hw && hw.turns_done) || 0)
    const out = []
    const quiet = now - Number(session.lastTs || 0)
    const openTurn = Number((hw && hw.open_turn) || 0)   // the turn analysed while still OPEN, if any
    for (const t of session.turns) {
      // A turn analysed while unfinished (after the quiet window, or a manual check) is queued
      // AGAIN once its closing answer has arrived — as revision 2 — otherwise the answer is never
      // analysed and the task it opened is only ever closed by the next prompt's verdict, without
      // the recap (pre-existing gap, found 2026-09-11: "this is no different from me stopping
      // work for 30 minutes and resuming, which happens all the time").
      if (t.n === openTurn && t.n <= done && t.ended) { t._reformed = true; out.push(t); continue }
      if (t.n <= done) continue
      const isLast = t.n === session.turns.length
      if (t.ended) { out.push(t); continue }
      // an unfinished turn (unanswered / mid-tool) is queued only once the session has gone quiet;
      // while the session is live it is held (it may still complete)
      if (isLast && quiet >= tuning.QUIET_MS) { out.push(t); continue }
      if (!isLast) { out.push(t); continue }   // an unfinished turn FOLLOWED by another turn is history
    }
    return out
  }

  async function formAll ({ fromMs = 0, onPage = null } = {}) {
    const deadline = Date.now() + FORM_DEADLINE_MS
    const summary = { items: [], sessions: 0, held: 0, truncated: false, errors: [], by_account: {} }
    const now = Date.now()
    for (const rec of recs) {
      try {
        const reader = readerFor(rec)
        const isHistory = !(Number(rec.cursor) > 0) && !(Number(rec.last_sync_ms) > 0)
        const histFrom = Math.max(Number(fromMs) || 0, Number(rec.backfill_from) || 0)
        if (isHistory && !(histFrom > 0)) { summary.by_account[rec.account_id] = 'probe'; continue } // probe: never unbounded
        const since = isHistory ? histFrom : Math.max(0, Number(rec.last_sync_ms) - RELIST_OVERLAP_MS)
        // every repo is read unless EXPLICITLY excluded (repos[slug].tracked === false) — the date
        // window is the only cut, and a repo that appears later is read automatically (user, 2026-09-09)
        rec.repos = rec.repos || {}
        const excluded = new Set(Object.entries(rec.repos).filter(([, r]) => r && r.tracked === false).map(([slug]) => slug))
        summary.by_account[rec.account_id] = isHistory ? 'history' : 'steady'
        const listed = (await reader.listSessionFiles({ sinceMs: since })).filter(f => !excluded.has(f.repoSlug))
        for (const f of listed) {
          if (!rec.repos[f.repoSlug]) rec.repos[f.repoSlug] = { tracked: true, name: String(f.cwd || f.repoSlug).split(/[\\/]/).filter(Boolean).pop(), first_seen: now }
        }
        const files = listed.slice(0, SESSIONS_PER_RUN_CAP)
        if (files.length === SESSIONS_PER_RUN_CAP) summary.truncated = true
        rec.sessions = rec.sessions || {}
        let visited = 0
        for (const f of files) {
          if (Date.now() > deadline || summary.items.length >= TURNS_PER_RUN_CAP) { summary.truncated = true; break }
          const hw = rec.sessions[safeKey(f.sessionId)] || null
          // cheap skip: the file did not grow since we last read it
          if (hw && Number(hw.bytes) === Number(f.size) && Number(hw.mtime) === Number(f.mtimeMs)) continue
          const text = await (reader.readSessionText ? reader.readSessionText(f) : reader.readText(f.path))
          const session = sessionFromText(text, f)
          if (!session.turns.length) continue
          const verdict = classifySession(session, { now, tuning })
          const ready = readyTurns(session, hw, { now })
          const held = session.turns.length - Number((hw && hw.turns_done) || 0) - ready.length
          summary.held += Math.max(0, held)
          visited++
          if (onPage) onPage({ connectionName: rec.account_id, rows: ready.length, pages: visited })
          for (const t of ready) {
            const inputRec = inputRecordFor(rec, session, t, verdict)
            if (contextOnlyBeforeFloor && isHistory && Number(t.ts) && Number(t.ts) < histFrom) {
              inputRec.status = 'skipped'
              inputRec.context_only = true
              summary.contextOnly = (summary.contextOnly || 0) + 1
            }
            if (!dryRun && persist) await persist.saveInput(inputRec)
            summary.items.push(inputRec)
          }
          if (!dryRun) {
            const turnsDone = Math.max(Number((hw && hw.turns_done) || 0), ready.length ? ready[ready.length - 1].n : 0)
            // remember the turn that went out UNFINISHED so its completion can be re-formed (readyTurns);
            // once the ended version has gone out, forget it
            const lastOut = ready.length ? ready[ready.length - 1] : null
            const openTurn = (lastOut && !lastOut.ended) ? lastOut.n : ((hw && hw.open_turn && !ready.some(t => t.n === hw.open_turn && t.ended)) ? hw.open_turn : null)
            rec.sessions[safeKey(f.sessionId)] = {
              turns_done: turnsDone, last_ts: session.lastTs || f.mtimeMs, title: session.title || null,
              repo: session.repoSlug, bytes: f.size, mtime: f.mtimeMs, state: verdict.state,
              ...(openTurn ? { open_turn: openTurn } : {})
            }
            const r = rec.repos[f.repoSlug]
            if (r) { r.last_seen_ms = Math.max(Number(r.last_seen_ms) || 0, f.mtimeMs); r.name = r.name || session.repoName }
          }
          summary.sessions++
        }
        if (!dryRun) {
          // a TRUNCATED history pass keeps the account in history mode so the next run resumes the
          // backfill (already-read sessions are skipped cheaply by the bytes/mtime check)
          if (!summary.truncated) rec.last_sync_ms = now
          rec.channel = 'work'
          rec.source_id = WORK_SOURCE_ID
          // WHICH AGENT this store belongs to — one store is one agent by construction (the setup
          // page tells the user to mount ~/.claude for Claude Code and ~/.codex/sessions for
          // Codex), and the layout detection already knows which. Stored so the account picker can
          // say "Claude Code" instead of a mail address that has nothing to do with the agent.
          const detected = (reader.layout && reader.layout.provider) || null
          if (detected) { rec.provider = detected; rec.agent_name = agentNameFor(detected) }
          if (persist) await persist.saveAccount(rec).catch(e => console.error('[superlazy] work account save failed', e && e.message))
        }
      } catch (e) {
        summary.errors.push({ account_id: rec.account_id, message: (e && e.message) || String(e) })
        console.error('[superlazy] work formation failed for ' + rec.account_id + ':', (e && e.message) || e)
      }
    }
    lastFormation = summary
    return summary
  }

  // ---- InputSource interface -------------------------------------------------------------------

  const inputToEnvelope = (r) => ({
    msg_id: r.msg_id,
    thread_id: r.thread_id,
    date: Number(r.date) || 0,
    from_address: r.author_address || '',
    from_name: r.author_name || 'ME',
    subject: r.title || '(session)',
    has_body: true,
    labels: [],
    is_draft: false,
    account_id: r.account_id,
    channel: 'work',
    // revision 2 = re-formed after its OPEN version was analysed: the plan must re-queue it even
    // though an analysis event exists (processor: `revised`), and the renderer marks it REVISED
    revised: (Number(r.revision) || 1) > 1 && r.status !== 'analysed'
  })

  async function listEnvelopes ({ fromMs = 0, beforeMs = 0, limit = 300, accountIds = null, onPage = null } = {}) {
    if (fromMs > 0) {
      if (!formedPromise) formedPromise = formAll({ fromMs, onPage })
      await formedPromise
    }
    const ours = new Set((accountIds && accountIds.length ? accountIds : recs.map(r => r.account_id)))
    const pend = await pending.read()
    const mine = pend.filter(r => r.channel === 'work' && ours.has(r.account_id))
    const envelopes = mine
      .map(inputToEnvelope)
      .filter(e => (!beforeMs || e.date < beforeMs))
      .sort((a, b) => (a.date - b.date) || (a.msg_id < b.msg_id ? -1 : 1))
      .slice(0, limit)
    if (fromMs > 0 && lastFormation) {
      const f = lastFormation
      console.info('[superlazy] work: formed ' + f.items.length + ' turn item(s) from ' + f.sessions + ' session(s) this pass' +
        (f.contextOnly ? ' (' + f.contextOnly + ' older than the first-read floor — kept as thread context only)' : '') +
        (f.held ? ' (' + f.held + ' open turn(s) held — sessions still live)' : '') +
        ' · pending queue now ' + mine.length + ' · mode ' + JSON.stringify(f.by_account) +
        (f.truncated ? ' · TRUNCATED (deadline/caps — continues next run)' : '') +
        (f.errors.length ? ' · ERRORS: ' + f.errors.map(e => e.account_id + ': ' + e.message).join(' | ') : ''))
      if (!persist) console.warn('[superlazy] work: NO persistence wired — formed items were not stored (source created without { persist })')
    }
    return { envelopes, hitCeiling: !!(lastFormation && lastFormation.truncated) }
  }

  const inputToRaw = (r) => ({
    channel: 'work',
    item_kind: r.item_kind || 'agent_turn',
    msg_id: r.msg_id,
    thread_id: r.thread_id,
    date: Number(r.date) || 0,
    from: { address: r.author_address || '', name: r.author_name || 'ME' },
    to: (r.participants || []).map(p => ({ address: p.address || '', name: p.name || agentNameFor(r.provider) })),
    cc: [],
    subject: r.title || '',
    labels: [],
    is_draft: false,
    source_ref: r.account_id + '|' + r.msg_id,
    message_id_header: '',
    in_reply_to: r.in_reply_to || null,
    references: [],
    text: r.body_text || '',
    html: '',
    revised: (Number(r.revision) || 1) > 1 && r.status !== 'analysed',
    channel_data: {
      agent_name: r.agent_name || agentNameFor(r.provider),
      turn_n: r.turn_n || null,
      turns_total: r.turns_total || null,
      repo_name: r.repo_name || null,
      branch: r.branch || null,
      turn_state: r.turn_state || null,
      turn_kind: r.turn_kind || null,
      session_state: r.session_state || null,
      files_changed: r.files_changed || [],
      files_changed_paths: r.files_changed_paths || [],
      commits: r.commits || [],
      plan: r.plan || null,
      agent_work: r.agent_work || null,
      work_stats: r.work_stats || null
    }
  })

  async function loadThreadRaw (threadId) {
    let rows = []
    try { rows = await F.query('inputs', { thread_id: threadId }, { count: 200 }) } catch (e) { rows = [] }
    const messages = (rows || [])
      .filter(r => r && r.channel === 'work' && !r.archived)
      .sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0) || (Number(a.turn_n) || 0) - (Number(b.turn_n) || 0))
      .map(inputToRaw)
    return { messages, path: 'inputs turn ledger' }
  }

  async function getFullBody (msg) {
    if (!msg || !msg.source_ref || !persist) return null
    const i = String(msg.source_ref).indexOf('|')
    if (i < 0) return null
    const rec = await persist.getInput({ account_id: msg.source_ref.slice(0, i), msg_id: msg.source_ref.slice(i + 1) })
    if (!rec) return null
    return { from: msg.from, to: msg.to, cc: msg.cc, date: msg.date, subject: msg.subject, fullText: rec.body_text || '' }
  }

  return {
    id: WORK_SOURCE_ID,
    channel: 'work',
    listAccounts,
    listEnvelopes,
    loadThreadRaw,
    getFullBody,
    getBodyPayload: async () => null,       // the item already lives in `inputs`
    loadSentSamples: async () => [],        // style guide is mail-only
    handleTokenExpired: () => false,
    // Per-account formation failures of the LAST pass (e.g. the store could not be read). The run
    // summary carries these so a job that formed nothing says why instead of "No new mail."
    formationErrors: () => (lastFormation ? lastFormation.errors : []),
    // did the LAST pending read reach its floor? (ingest.js advances the scan watermark only then)
    pendingScanComplete: () => pending.lastScan().complete,
    lastPendingScan: () => pending.lastScan(),
    // formation surface for the lab page
    formAll,
    readyTurns,
    inputRecordFor,
    inputToRaw,
    readerFor,
    lastFormation: () => lastFormation
  }
}
