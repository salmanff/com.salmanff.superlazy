// agentslabRun.js — the ZERO-WRITE chronological run of the AI agents page.
// "Run the sessions through the analysis as if I were training — events, tasks, projects — but
// save nothing" (user, 2026-09-07). This is the REAL pipeline (processor + engine + reconcile,
// the same prompt, the same batching) driven exactly the way the Inspect page drives it, with
// two substitutions that keep the database untouched:
//   1. the SOURCE is in memory — the work source's formation runs as a dry run and its turn items
//      are served from an array (envelopes, threads, bodies), so no pending `inputs` records and
//      no account record are written;
//   2. the PERSISTENCE is a capture layer — every write the processor would make (events,
//      persistStep, account cursors, input status flips) is recorded in `captured` instead of
//      sent to freezr; reads pass through to the real persistence.
// The project / profile stores are hydrated from the real data (so the model sees the real
// catalog and files turns into existing projects) and mutated IN MEMORY only. Discard the run
// object to discard everything.

import { createWorkSource, agentNameFor } from '../jobs/analyze_thread/workSource.js'
import { sessionPrefsFrom, adoptSnapshotPin, meSetFromSettingsAndAccounts } from '../jobs/analyze_thread/ingest.js'
import { createProcessor } from '../jobs/analyze_thread/processor.js'
import { createProfileStore } from '../jobs/analyze_thread/profiles.js'
import { createProjectStore } from '../jobs/analyze_thread/projectStore.js'
import { createInstructionStore } from '../jobs/analyze_thread/instructionStore.js'
import { loadActiveSubscriptions } from '../jobs/analyze_thread/subscriptionsCore.js'
import { DEFAULT_THREAD_CONTEXT_DAYS } from '../jobs/analyze_thread/config.js'
import { DIGEST_TUNING } from '../jobs/analyze_thread/sessionDigest.js'
import { sourceTagFor, addRepoSources } from '../jobs/analyze_thread/persist.js'
import { describeLockHolder } from '../jobs/analyze_thread/lockText.js'

const DAY = 24 * 3600 * 1000
const deep = (o) => JSON.parse(JSON.stringify(o))

/**
 * Build the dry run: forms the turn items in memory and prepares a processor over them.
 * @returns {{ items, formed, processor, store, profiles, captured, source, existingProjectIds, runAll }}
 */
// catalog: 'empty' (default — a BOOTSTRAP: no projects, no profiles, no pinned snapshot; everything
// on the board is born from the sessions) or 'real' (the user's current projects/profiles hydrated
// in memory, so turns are linked to existing to-dos — the steady-state behaviour).
// promptOverride: { text, version } — swap the system prompt for this run only, so two arms can be
// scored on the SAME turns (the A/B the granularity work needs). null = the shipped prompt, which
// is arm A / the control. Nothing else in the run differs, and nothing is written either way.
// analyseDays: null = every turn of every session touched in the window (the original behaviour —
// the plan window is widened to the oldest formed turn). N = analyse only turns from the last N
// days; earlier turns of those sessions are still FORMED and served as thread context (the
// in-memory source keys bodies by thread, not by window) but never queued — which is what the
// live checks do (they keep the floor and store older turns as context-only). User, 2026-09-21:
// "items older than 7 days pop up in the agentlab … we should be able to choose the number of days".
export async function createDryRun ({ freezr, persist, data, workRec, workRecs = null, days = 7, tuning = DIGEST_TUNING, model = null, catalog = 'empty', onFormProgress = null, promptOverride = null, analyseDays = null }) {
  const settings = (data && data.settings) || {}
  const storedAccounts = ((data && data.accounts) || []).filter(r => r && r.account_id)

  // ---- 1. formation, in memory (a fresh first read of the window; the stored high-water marks
  //         are deliberately ignored so the run covers every turn in the window) --------------------
  // ONE RUN, EVERY AGENT (user, 2026-09-10). Each fs connection is one agent's store (~/.claude =
  // Claude Code, ~/.codex/sessions = Codex), so a realistic run forms them ALL and interleaves the
  // turns chronologically — otherwise cross-agent project matching is never exercised. Each store
  // needs its own reader, so formation runs per account and the items are merged afterwards.
  const recs = (Array.isArray(workRecs) && workRecs.length ? workRecs : [workRec]).filter(Boolean).map(deep)
  if (!recs.length) throw new Error('createDryRun needs at least one work account')
  // EACH STORE HAS ITS OWN WINDOW: a rec may carry `_days` (the lab passes each block's own days
  // input); otherwise the run-wide `days` applies. One shared window was the bug where a 1-day
  // Claude setting silently emptied a Codex run (user, 2026-09-10).
  const now0 = Date.now()
  for (const r of recs) {
    const d = Number(r._days) > 0 ? Number(r._days) : days
    r.cursor = 0; r.last_sync_ms = 0; r.sessions = {}; r.backfill_from = now0 - d * DAY
  }
  const from0 = Math.min(...recs.map(r => r.backfill_from))
  const rec = recs[0]   // the primary — used only where a single value is unavoidable (ME address)
  const formed = { items: [], sessions: 0, held: 0, contextOnly: 0, truncated: false, errors: [], by_account: {} }
  const wsByAccount = new Map()
  for (const r of recs) {
    const ws1 = createWorkSource({ freezr, persist: null, accounts: [r], dryRun: true, tuning, contextOnlyBeforeFloor: false })
    wsByAccount.set(r.account_id, ws1)
    try {
      const f = await ws1.formAll({ fromMs: r.backfill_from, onPage: onFormProgress })
      formed.items.push(...(f.items || []))
      formed.sessions += f.sessions || 0
      formed.held += f.held || 0
      formed.contextOnly += f.contextOnly || 0
      formed.truncated = formed.truncated || !!f.truncated
      formed.errors.push(...(f.errors || []))
      Object.assign(formed.by_account, f.by_account || {})
    } catch (e) {
      // one unreadable store must not lose the other agent's turns
      formed.errors.push({ account_id: r.account_id, message: (e && e.message) || String(e) })
    }
  }
  const ws = wsByAccount.get(rec.account_id) || wsByAccount.values().next().value
  // interleave the agents strictly by time — a Claude turn and a Codex turn on the same effort must
  // reach the model in the order they actually happened
  const items = formed.items.slice().sort((a, b) => (a.date - b.date) || ((a.turn_n || 0) - (b.turn_n || 0)))
  // Sessions are picked by when their FILE was touched; their turns can be much older. The plan's
  // window starts at the account's backfill_from and drops older envelopes — so for the dry run the
  // window is widened to the OLDEST formed turn: every turn of every touched session is analysed.
  // (The live checks keep the floor and store older turns as context-only — see workSource.)
  const oldestTs = items.reduce((m, it) => Math.min(m, Number(it.date) || Infinity), Infinity)
  const analyseMs = Number(analyseDays) > 0 ? Number(analyseDays) * DAY : 0
  // with analyseDays the floor is NOT widened: turns before it stay in `items` (so byThread still
  // serves them as context and the thread index still lists them) but fall outside plan()'s window
  const windowFloor = analyseMs
    ? (Date.now() - analyseMs)
    : (Number.isFinite(oldestTs) ? Math.min(from0, oldestTs - 1000) : from0)
  const contextOnly = analyseMs ? items.filter(it => Number(it.date) < windowFloor).length : 0
  for (const r of recs) r.backfill_from = windowFloor
  const windowDays = Math.ceil((Date.now() - windowFloor) / DAY) + 1
  const byThread = new Map()
  const byRef = new Map()
  for (const it of items) {
    if (!byThread.has(it.thread_id)) byThread.set(it.thread_id, [])
    byThread.get(it.thread_id).push(it)
    byRef.set(it.account_id + '|' + it.msg_id, it)
  }
  const envOf = (it) => ({
    msg_id: it.msg_id, thread_id: it.thread_id, date: Number(it.date) || 0,
    from_address: it.author_address || '', from_name: 'ME', subject: it.title || '(session)',
    has_body: true, labels: [], is_draft: false, account_id: it.account_id, channel: 'work'
  })

  // WHICH AGENT each store holds. A stored account may predate the provider field, so read it back
  // off the turns the store actually produced (each item carries its transcript's provider) and
  // fall back to whatever the record already claimed.
  for (const r of recs) {
    const mine = items.find(it => it.account_id === r.account_id)
    if (mine && mine.provider) r.provider = mine.provider
    r.agent_name = agentNameFor(r.provider)
  }
  const accountInfos = recs.map(r => ({ account_id: r.account_id, account_email: r.me_email || '', provider: r.provider || 'claude_code', agent_name: r.agent_name }))
  // ---- 2. the in-memory InputSource ---------------------------------------------------------------
  const source = {
    id: 'dryrun:work',
    channel: 'work',
    async listAccounts () { return { accounts: accountInfos } },
    async listEnvelopes ({ fromMs = 0, beforeMs = 0, limit = 5000, accountIds = null } = {}) {
      let list = items.filter(it => (!fromMs || it.date >= fromMs) && (!beforeMs || it.date < beforeMs) &&
        (!accountIds || !accountIds.length || accountIds.includes(it.account_id)))
      // plan()'s probe (no fromMs) reads the anchor off the LAST envelope — hand it the newest ones
      if (!fromMs && list.length > limit) list = list.slice(list.length - limit)
      return { envelopes: list.slice(0, limit).map(envOf), hitCeiling: false }
    },
    async loadThreadRaw (threadId) {
      const rows = byThread.get(threadId) || []
      // each thread belongs to one account; use that account's work source to shape its raws
      const w = (rows.length && wsByAccount.get(rows[0].account_id)) || ws
      return { messages: rows.map(w.inputToRaw), path: 'dry run (memory)' }
    },
    async getFullBody (msg) {
      const it = msg && byRef.get(msg.source_ref)
      return it ? { from: msg.from, to: msg.to, cc: msg.cc, date: msg.date, subject: msg.subject, fullText: it.body_text || '' } : null
    },
    async getBodyPayload () { return null },
    async loadSentSamples () { return [] },
    handleTokenExpired () { return false }
  }

  // ---- 3. stores: EMPTY (bootstrap) or hydrated from the REAL data — mutated in memory only -----------
  const useReal = catalog === 'real'
  const profiles = createProfileStore(); profiles.hydrate(useReal ? (data.profiles || []) : [])
  const store = createProjectStore(); store.hydrate(useReal ? (data.projects || []) : [])
  if (!useReal) store.seedIds(data.projects || [])   // mint beyond the real catalog's ids — a later save must not collide
  const instructions = createInstructionStore(); instructions.hydrate(data.instructions || [])
  const existingProjectIds = new Set(store.all().map(p => p.project_id))

  // ---- 4. the capture persistence: reads pass through, writes are recorded --------------------------
  const captured = { events: [], stepWrites: [], accountSaves: 0, other: [] }
  // the run LOG: one line per thing that happened (step start/end, engine step_error events, stops)
  const log = []
  const note = (kind, text, extra = {}) => { const row = { at: Date.now(), kind, text, ...extra }; log.push(row); if (kind === 'error') console.error('[agentslab run] ' + text, extra.detail || ''); else console.info('[agentslab run] ' + text); return row }
  note('info', 'formed ' + items.length + ' turn item(s) from ' + formed.sessions + ' session(s)' + (formed.truncated ? ' — TRUNCATED by the per-run caps' : '') + (formed.errors.length ? ' — errors: ' + formed.errors.map(e => e.message).join(' | ') : ''))
  const dryPersist = {
    ...persist,
    // every turn is "fresh" for the run, whatever was analysed for real before
    msgAnalysisStatus: async () => ({ done: new Set(), errored: new Set(), attempts: new Map() }),
    saveAccount: async () => { captured.accountSaves++; return null },
    addEvent: async (ev) => { captured.events.push(ev); return { _id: 'dry_' + captured.events.length } },
    persistStep: async ({ event, touchedProjectIds, touchedAddresses }) => {
      if (event) captured.events.push(event)
      // remember WHICH agent's turn touched these — a save must stamp each project with the
      // provenance of the account(s) that actually fed it, not just the primary one
      const aid = (event && event.account_id) || null
      captured.stepWrites.push({ account_id: aid, touchedProjectIds: touchedProjectIds || [], touchedAddresses: touchedAddresses || [] })
      // Stamp provenance ON THE IN-MEMORY PROJECTS as the real persistStep would. Without this the
      // run's board is missing every 'agents:'/'repo:' tag, so the SAME project component renders
      // without its repo chip here while showing one in production — which is exactly the bug this
      // page exists to catch. Writes still go nowhere; only the in-memory record is tagged.
      const r = aid ? recs.find(x => x.account_id === aid) : null
      const tag = sourceTagFor({ channel: 'work', account_id: aid || rec.account_id, account_email: (r || rec).me_email })
      for (const pid of (touchedProjectIds || [])) {
        const pr = store.get(pid)
        if (!pr) continue
        if (!Array.isArray(pr.sources)) pr.sources = []
        if (tag && !pr.sources.includes(tag)) pr.sources.push(tag)
        addRepoSources(pr)
      }
      return []
    },
    saveEmailBody: async () => null,
    saveInput: async () => null,
    updateInputFields: async (key, fields) => { captured.other.push({ updateInputFields: key, fields }); return null },
    saveSettings: async () => null,
    getInput: async ({ account_id, msg_id } = {}) => byRef.get(account_id + '|' + msg_id) || null
  }


  const processor = createProcessor({
    freezr,
    source,
    persist: dryPersist,
    meSet: meSetFromSettingsAndAccounts(settings, storedAccounts.concat(recs)),
    model: model || settings.default_model || {},
    prefs: sessionPrefsFrom(settings),
    instructions,
    profiles,
    store,
    deferPersist: true,
    promptOverride
  })
  // the stored style guide is reused when fresh (mirrors inspectRunner); otherwise the engine
  // builds one from loadSentSamples, which is empty here — a dry run never pays for a style call
  const refreshDays = Number(settings.style_guide_refresh_days) || 30
  const styleFresh = settings.style_guide != null && (Date.now() - (Number(settings.style_guide_asof) || 0)) < refreshDays * DAY
  processor.session.userStyle = styleFresh ? settings.style_guide : ''
  try { await loadActiveSubscriptions(freezr) } catch (e) { /* read-only; optional */ }
  // the pinned snapshot is the REAL catalog rendered — only valid when the real catalog is in play
  if (useReal) adoptSnapshotPin(processor.session, settings)
  processor.session.exchangeCapture = []

  const plan = await processor.plan({
    accountInfos,
    historyDays: windowDays,
    threadContextDays: settings.thread_context_days != null ? settings.thread_context_days : DEFAULT_THREAD_CONTEXT_DAYS,
    processDays: null,
    existingAccounts: recs
  })
  const fromLabel = new Date(plan.windowStartMs).toISOString().slice(0, 16).replace('T', ' ')
  if (analyseMs) {
    // with an analysis floor a shortfall is the POINT: the turns before it are context, not queue
    const expected = items.length - contextOnly
    note(plan.total === expected ? 'info' : 'error', 'queued ' + plan.total + ' of ' + items.length + ' formed turn item(s) — ' + contextOnly + ' earlier turn(s) of these sessions read as thread context only (analysis floor ' + fromLabel + ', last ' + Number(analyseDays) + ' day' + (Number(analyseDays) === 1 ? '' : 's') + ')' + (plan.total !== expected ? ' — MISMATCH: ' + (expected - plan.total) + ' in-window turn(s) were not queued' : ''))
  } else {
    note(plan.total === items.length ? 'info' : 'error', 'queued ' + plan.total + ' of ' + items.length + ' formed turn item(s) (analysis window from ' + fromLabel + ')' + (plan.total !== items.length ? ' — MISMATCH: some formed turns fell outside the plan window' : ''))
  }

  // ---- 5. stepping: analyse the next item(s) → "commit" through the capture layer -------------------
  // stepOnce returns { done } or { done:false, steps: [{ env, newMsg, res, stepEvent, errorEvent,
  // exchanges, event, cost }] } — one entry per consumed item. runAll loops it.
  const summary = { steps: 0, ok: 0, failed: 0, cost: 0, stopped: false, error: null, stoppedAt: null }
  const handled = new Map()   // msg_id -> 'analysed' | 'error' | 'skipped' (what the commit writes as the item's status)
  async function stepOnce ({ batch = 1, onEvent = null } = {}) {
    processor.session.exchangeCapture.length = 0
    const next = processor.peekNext()
    const started = Date.now()
    note('start', 'turn ' + (processor.session.processed + 1) + ' of ' + items.length + ' — "' + ((next && next.subject) || '?') + '" · ' + (next ? next.msg_id : ''))
    const relay = (ev) => {
      if (ev && ev.type === 'step_error') note('error', 'engine: ' + (ev.message || 'step error') + ' — "' + ((ev.msg && ev.msg.subject) || '?') + '"', { detail: ev.raw || null })
      if (ev && ev.type === 'message_abandoned') note('error', 'abandoned: ' + (ev.message || ''))
      if (ev && ev.type === 'batch_split') note('info', 'batch split — retrying the first turn alone')
      if (onEvent) onEvent(ev)
    }
    let out
    try {
      out = await processor.inspectNext({ count: batch, onEvent: relay })
    } catch (e) {
      // the processor STOPS THE RUN on failures it deems environmental (provider error, timeout,
      // no credit): pos is NOT advanced, so Next retries the same turn; Skip moves past it
      summary.error = (e && e.message) || String(e)
      summary.stoppedAt = next ? { msg_id: next.msg_id, subject: next.subject } : null
      note('error', 'RUN STOPPED after ' + Math.round((Date.now() - started) / 1000) + 's: ' + summary.error, { detail: e && e.stack })
      return { done: true, error: summary.error, steps: [] }
    }
    if (!out || out.done) { note('info', 'queue exhausted'); return { done: true, steps: [] } }
    const pend = (processor.pendingPersist || []).slice()
    const exchanges = processor.session.exchangeCapture.slice()
    const before = captured.events.length
    await processor.commitPending({ onEvent: onEvent || (() => {}) })   // the production persist path, into the capture layer
    const newEvents = captured.events.slice(before)
    const steps = pend.map(p => {
      const ev = newEvents.find(e => e && e.msg_id === (p.env && p.env.msg_id)) || null
      if (p.env && p.env.msg_id) handled.set(p.env.msg_id, (p.res && p.res.ok) ? 'analysed' : 'error')
      const cost = Number((p.stepEvent && p.stepEvent.cost) || (ev && ev.cost) || 0)
      summary.steps++; summary.cost += cost
      if (p.res && p.res.ok) summary.ok++; else summary.failed++
      return { env: p.env, newMsg: p.newMsg, res: p.res, stepEvent: p.stepEvent, errorEvent: p.errorEvent, exchanges, event: ev, cost }
    })
    summary.error = null; summary.stoppedAt = null
    for (const st of steps) note(st.res && st.res.ok ? 'ok' : 'fail', 'turn done in ' + Math.round((Date.now() - started) / 1000) + 's · $' + Number(st.cost || 0).toFixed(4) + ' · ' + ((st.event && st.event.changes && st.event.changes.length) || 0) + ' change(s)' + (st.res && st.res.ok ? '' : ' · FAILED: ' + ((st.errorEvent && st.errorEvent.message) || (st.res && st.res.error) || '?')))
    if (!steps.length) note('info', 'nothing consumed this step (the item was skipped by the engine — see the events)')
    return { done: processor.remaining() <= 0, steps }
  }
  // Skip the turn the run stopped at (a skipped event is captured, pos advances) — the way past a
  // turn that always fails, exactly as on the Inspect page.
  async function skipNext () {
    const next = processor.peekNext()
    if (!next) return { done: true }
    const r = await processor.skipNext({ onEvent: () => {} })
    handled.set(next.msg_id, 'skipped')
    summary.error = null; summary.stoppedAt = null
    note('info', 'skipped "' + (next.subject || next.msg_id) + '"')
    return r
  }
  async function runAll ({ batch = 1, onStep = null, onEvent = null, shouldStop = () => false } = {}) {
    while (!shouldStop()) {
      const r = await stepOnce({ batch, onEvent })
      for (const st of r.steps) if (onStep) onStep(st)
      if (r.done) break
    }
    summary.stopped = shouldStop()
    return summary
  }

  // ---- 6. COMMIT: write what the run holds in memory, exactly once, under the ingestion lock ----------
  // (user, 2026-09-08: "now we can save the to-dos etc to the db"). Writes, in order: the turn items
  // as `inputs` (analysed / error / skipped, with their event back-pointer), every captured event,
  // the projects and profiles the run touched or created (persistStep — sources tagged), and the
  // work account record with per-session high-water marks + cursor so the live checks continue from
  // the last analysed turn instead of re-analysing the run. Items the run never reached are NOT
  // written — the next check forms them again from the transcripts.
  let committed = null
  async function commitRun ({ onProgress = null } = {}) {
    if (committed) return committed
    if (!handled.size) throw new Error('nothing to save — no turn has been analysed yet')
    const owner = 'agentslab-' + Math.random().toString(36).slice(2, 8)
    const got = await persist.acquireRunLock({ owner, kind: 'sessions_commit' })
    if (!got.ok) {
      throw new Error(describeLockHolder(got.holder || null) + ' Then save again.')
    }
    const tally = { inputs: 0, events: 0, projects: 0, profiles: 0, errors: [] }
    const step = (what) => { if (onProgress) onProgress(what) }
    try {
      // 1. items
      const eventByMsg = new Map(captured.events.filter(e => e && e.msg_id).map(e => [e.msg_id, e]))
      for (const it of items) {
        const status = handled.get(it.msg_id)
        if (!status) continue
        const ev = eventByMsg.get(it.msg_id)
        const recIn = { ...it, status, analysis_event_id: ev ? persist.eventIdFor(it.account_id, it.msg_id) : null, attempts: status === 'error' ? 1 : 0, last_error: status === 'error' ? ((ev && ev.error) || 'analysis failed') : null }
        const r = await persist.saveInput(recIn)
        if (r) tally.inputs++; else tally.errors.push('input ' + it.msg_id)
        step('items ' + tally.inputs)
      }
      // 2. events (analysis kinds upsert on their deterministic id — a re-save never duplicates)
      for (const ev of captured.events) {
        try { await persist.addEvent(ev); tally.events++ } catch (e) { tally.errors.push('event ' + (ev.msg_id || ev.kind) + ': ' + (e && e.message)) }
        step('events ' + tally.events)
      }
      // 3. projects + profiles the run touched or created
      // grouped BY ACCOUNT so a project both agents fed carries both provenance tags — persistStep
      // stamps one tag per call, so it is called once per contributing account
      const byAcct = new Map()
      const addresses = new Set()
      for (const w of captured.stepWrites) {
        const aid = w.account_id || rec.account_id
        if (!byAcct.has(aid)) byAcct.set(aid, new Set())
        for (const id of w.touchedProjectIds) byAcct.get(aid).add(id)
        for (const a of w.touchedAddresses) addresses.add(a)
      }
      const claimed = new Set()
      for (const ids of byAcct.values()) for (const id of ids) claimed.add(id)
      // a project created during the run that no step claimed (safety net) goes to the primary
      for (const pr of store.all()) {
        if (existingProjectIds.has(pr.project_id) || claimed.has(pr.project_id)) continue
        if (!byAcct.has(rec.account_id)) byAcct.set(rec.account_id, new Set())
        byAcct.get(rec.account_id).add(pr.project_id)
      }
      const touched = new Set()
      let firstCall = true
      for (const [aid, ids] of byAcct) {
        const r = recs.find(x => x.account_id === aid) || rec
        const tag = sourceTagFor({ channel: 'work', account_id: aid, account_email: r.me_email })
        const errs = await persist.persistStep({
          store, profiles, touchedProjectIds: [...ids],
          touchedAddresses: firstCall ? [...addresses] : [],   // profiles are account-neutral here; save them once
          profileHistory: [], event: null, sourceTag: tag
        })
        tally.errors.push(...(errs || []))
        for (const id of ids) touched.add(id)
        firstCall = false
      }
      tally.projects = touched.size; tally.profiles = addresses.size
      step('projects ' + tally.projects)
      // 4. the accounts: one record PER AGENT STORE, each advanced only by its OWN items
      const savedAccounts = []
      for (const r of recs) {
        const mine = items.filter(it => it.account_id === r.account_id && handled.has(it.msg_id))
        if (!mine.length) continue   // this store contributed nothing to the run — leave it untouched
        const stored = storedAccounts.find(a => a.account_id === r.account_id) || null
        const acct = stored ? { ...stored } : {
          account_id: r.account_id, provider: r.provider || 'claude_code', source_id: 'live:connections.fs', channel: 'work',
          status: 'training', cursor: 0, backfill_from: 0, backfill_done: false, messages_processed: 0, messages_skipped: 0, messages_failed: 0, sessions: {}
        }
        acct.channel = 'work'; acct.source_id = 'live:connections.fs'
        acct.me_email = r.me_email; acct.account_email = r.me_email
        if (r.provider) acct.provider = r.provider
        if (r.agent_name) acct.agent_name = r.agent_name
        acct.repos = { ...(acct.repos || {}), ...(r.repos || {}) }
        acct.sessions = { ...(acct.sessions || {}) }
        let cursor = Number(acct.cursor) || 0
        for (const it of mine) {
          const key = String(it.session_id).replace(/\./g, '_')
          const hw = acct.sessions[key] || { turns_done: 0, last_ts: 0, title: it.title, repo: it.repo_slug }
          if ((it.turn_n || 0) > (hw.turns_done || 0)) { hw.turns_done = it.turn_n; hw.last_ts = it.date }
          hw.title = it.title; hw.repo = it.repo_slug; hw.state = it.session_state || hw.state
          acct.sessions[key] = hw
          cursor = Math.max(cursor, Number(it.date) || 0)
        }
        acct.cursor = cursor
        acct.last_processed_asof = cursor
        acct.backfill_from = Math.min(Number(acct.backfill_from) || windowFloor, windowFloor)
        acct.history_days = Math.max(Number(acct.history_days) || 0, windowDays)
        acct.backfill_done = true
        acct.status = 'trained'
        acct.last_sync_ms = Date.now()
        const statusOf = (v) => mine.filter(it => handled.get(it.msg_id) === v).length
        acct.messages_processed = (Number(acct.messages_processed) || 0) + statusOf('analysed')
        acct.messages_skipped = (Number(acct.messages_skipped) || 0) + statusOf('skipped')
        acct.messages_failed = (Number(acct.messages_failed) || 0) + statusOf('error')
        await persist.saveAccount(acct)
        savedAccounts.push(acct)
      }
      step('account' + (savedAccounts.length === 1 ? '' : 's') + ' saved')
      // `account` (singular) stays for callers that expect one; `accounts` is the full set
      committed = { ...tally, accounts: savedAccounts, account: savedAccounts[0] || null, at: Date.now() }
      note(tally.errors.length ? 'error' : 'ok', 'SAVED to the database: ' + tally.inputs + ' item(s), ' + tally.events + ' event(s), ' + tally.projects + ' project(s), ' + tally.profiles + ' profile(s)' + (tally.errors.length ? ' — ' + tally.errors.length + ' error(s): ' + tally.errors.slice(0, 3).join(' | ') : ''))
      return committed
    } finally {
      await persist.releaseRunLock({ owner }).catch(() => {})
    }
  }

  // ---- 7. what the REAL viewer needs to open a turn from this run: the body view of an item
  //         (persist.getThreadBodies over the in-memory items) + a no-write saveProject -----------------
  const bodyViewOf = (r) => ({
    msg_id: r.msg_id, account_id: r.account_id || null, thread_id: r.thread_id || null,
    from_address: r.author_address || '', from_name: r.author_name || '',
    to_addresses: (r.participants || []).map(p => ({ address: p.address || '', name: p.name || '' })), cc_addresses: [],
    subject: r.title || '', date: r.date || 0, body_html: '', body_text: r.body_text || '',
    has_attachments: false, attachments: [], html_truncated: false, captured_asof: r.captured_asof || null,
    channel: 'work', item_kind: r.item_kind || null, participants_kind: r.participants_kind || null, authority: 'provider', revision: 1, input_status: 'analysed',
    repo_name: r.repo_name || null, branch: r.branch || null, turn_n: r.turn_n || null, turns_total: r.turns_total || null, turn_state: r.turn_state || null, turn_kind: r.turn_kind || null,
    work_stats: r.work_stats || null, files_changed: r.files_changed || [], files_changed_paths: r.files_changed_paths || [], commits: r.commits || [],
    // the viewer's With row and its Plan / Checklist rows — the lab's own body view had neither,
    // so the modal named a generic agent and could never show a plan here (user, 2026-09-10)
    agent_name: r.agent_name || null,
    provider: r.provider || null,
    repo_slug: r.repo_slug || null,
    cwd: r.cwd || null,
    source_path: r.source_path || null,
    agent_work: r.agent_work || null
  })
  const viewerPersist = {
    ...persist,
    getThreadBodies: async (threadId) => (byThread.get(threadId) || []).map(bodyViewOf),
    saveProject: async () => null,
    saveProfile: async () => null,
    addEvent: async () => null
  }

  // which agents this run covers, and how many turns each contributed (the page names them)
  const agents = recs.map(r => ({
    account_id: r.account_id,
    provider: r.provider || null,
    agent_name: r.agent_name || agentNameFor(r.provider),
    days: Number(r._days) > 0 ? Number(r._days) : days,
    tracked: Object.values(r.repos || {}).filter(x => !(x && x.tracked === false)).length,
    items: items.filter(it => it.account_id === r.account_id).length
  }))

  return {
    items, formed, plan, processor, store, profiles, instructions, captured, source, existingProjectIds, agents,
    catalog: useReal ? 'real' : 'empty', me: String(rec.me_email || '').toLowerCase(), settings,
    // the analysis floor, when one was set: turns before it were formed for context but never queued
    analyseDays: analyseMs ? Number(analyseDays) : null, contextOnly, windowFloor,
    stepOnce, runAll, skipNext, summary, log, viewerPersist, remaining: () => processor.remaining(), peekNext: () => processor.peekNext(),
    commitRun, isCommitted: () => !!committed, handledCount: () => handled.size
  }
}
