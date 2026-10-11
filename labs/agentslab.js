// agentslab.js — the WORK SESSIONS page (specs/superlazy-sessions.md): channel setup for Claude
// Code sessions read through a granted use_file_sys connection. Three steps: pick the file store,
// tick the repos to read and SAVE (seeds the `channel:'work'` account record — from then on the
// normal checks form one input item per finished request-and-answer turn), and optionally PREVIEW
// what a run would queue (formation dry run: nothing written). Analysis itself is NOT here — the
// items ride the normal pipeline, and the Inspect page is the stepping harness (Save / Ignore per
// item, full wire visibility), exactly as for mail and Slack.

import { createPersistence } from '../jobs/analyze_thread/persist.js'
import { explainFsError } from '../jobs/analyze_thread/sessionsSource.js'
import { renderWorkSessions } from '../pages/workSessionsUi.js'
import { createWorkSource } from '../jobs/analyze_thread/workSource.js'
import { splitTurnBody, sessionFromText, DIGEST_TUNING } from '../jobs/analyze_thread/sessionDigest.js'
import { openTurnModal } from './agentslabInspect.js'
import { createDryRun } from './agentslabRun.js'
import { buildVariant, VARIANT_LIST } from './promptVariants.js'
import { setRunProgress, setRunCost, resetRunPanels, createRunView, paintRunLog, paintStopBanner } from './agentslabRunUi.js'
import { populateModelSelect, selectedModel } from '../shared/modelPicker.js'
import { renderTopBar } from '../shared/topbar.js'
import { setStatus, setElapsed, renderPreview, renderProjection } from './agentslabUi.js'
import { agentNameFor } from '../jobs/analyze_thread/config.js'

renderTopBar('agentslab')

const $ = (id) => document.getElementById(id)
const F = typeof freezr !== 'undefined' ? freezr : null
const persist = createPersistence(F)
const deep = (o) => JSON.parse(JSON.stringify(o))
const DAY = 24 * 3600 * 1000

const state = {
  settings: {},
  storedAccounts: [],
  setup: null,         // the shared setup module (workSessionsUi.renderWorkSessions) — owns connection, roster, ME, days
  reader: null,        // sessionsSource for the picked connection (from the module)
  workRec: null,       // the module's working copy of the account record (ticks land on it)
  preview: [],         // dry-run inputs records
  parsed: new Map(),   // sessionId -> parsed session WITH raw records (the inspection modal)
  openIdx: null,
  busy: false,
  run: null,           // the current dry run (createDryRun result) — discarded on Reset / a new run
  view: null,          // createRunView(run): the real components bound to the run
  stopRequested: false
}

const days = () => (state.setup ? state.setup.days() : 7)
const meAddr = () => (state.setup ? state.setup.me() : '')
const quietMs = () => Math.max(1, parseInt($('wlQuiet').value, 10) || 30) * 60000
const trained = () => !!(state.workRec && (Number(state.workRec.last_sync_ms) > 0 || Number(state.workRec.cursor) > 0))

// ---- channel setup: the shared module ---------------------------------------------------------------
// The module owns the connection pick, the ME address, the roster and Save (the production path);
// the dev tools below read its current working record and reader.

function onConnectionLoaded ({ connectionName, workRec, reader }) {
  paintStores()
  // one block per store on the setup module; the dev tools below follow the block LAST loaded or
  // clicked (click a store's block to make it the active one)
  state.workRec = workRec; state.reader = reader; state.activeStore = connectionName
  state.preview = []; state.parsed.clear(); renderPreview([], {}); renderProjection(null, [])
  const stored = state.storedAccounts.find(r => r.account_id === workRec.account_id && r.channel === 'work')
  $('wlInspect').hidden = !stored
  $('wlPreview').disabled = false; $('wlRun').disabled = false; $('wlNext').disabled = false
}
function onSaved (rec) {
  const i = state.storedAccounts.findIndex(a => a.account_id === rec.account_id)
  if (i >= 0) state.storedAccounts[i] = rec; else state.storedAccounts.push(rec)
  state.workRec = deep(rec)
  $('wlInspect').hidden = false
  setStatus('Saved — the normal checks read these repos from now on (same as saving on the Setup page). The tools below stay available for previews and dry runs.', 'ok')
}

// ---- preview (formation dry run) ---------------------------------------------------------------

// the dev tools act on the store the user touched last in the setup module
// ---- which stores the run covers: one checkbox per file store, LIVE from the setup module ------
// Unticked = excluded. Defaults to every loaded store. The row shows the store's OWN days and repo
// ticks as they stand above, so what you see is exactly what the run forms.
const runOff = new Set()   // connectionNames the user unticked
function runBlocks () {
  return (state.setup ? state.setup.blocks() : []).filter(b => b.loaded && !runOff.has(b.connectionName))
}
function paintStores () {
  const host = $('wlStores'); if (!host) return
  const blocks = state.setup ? state.setup.blocks() : []
  host.textContent = ''
  if (!blocks.length) { host.appendChild(Object.assign(document.createElement('span'), { className: 'wl-muted', textContent: 'no file stores visible — set one up above' })); return }
  for (const b of blocks) {
    const lab = document.createElement('label')
    const cb = document.createElement('input'); cb.type = 'checkbox'
    cb.checked = b.loaded && !runOff.has(b.connectionName); cb.disabled = !b.loaded || !!state.run
    cb.addEventListener('change', () => { if (cb.checked) runOff.delete(b.connectionName); else runOff.add(b.connectionName); paintStores() })
    lab.appendChild(cb)
    const name = document.createElement('span'); name.textContent = '🤖 ' + agentNameFor(b.provider) + ' — ' + b.connectionName
    lab.appendChild(name)
    const sub = document.createElement('span'); sub.className = 'wl-store-sub'
    sub.textContent = !b.loaded ? 'loading…' : (b.days + ' day' + (b.days === 1 ? '' : 's') + ' · ' + b.trackedCount + ' of ' + b.repoCount + ' repo' + (b.repoCount === 1 ? '' : 's') + ' ticked')
    lab.appendChild(sub)
    if (!cb.checked) lab.className = 'wl-store-off'
    host.appendChild(lab)
  }
}

function syncActive () {
  const cur = state.setup && state.setup.current()
  if (cur && cur.workRec) { state.workRec = cur.workRec; state.reader = cur.reader; state.activeStore = cur.connectionName }
}

async function preview () {
  syncActive()
  if (!state.workRec || state.busy) return
  state.busy = true
  $('wlPreview').disabled = true
  const t0 = Date.now()
  try {
    setStatus('Reading sessions (dry run)…', 'busy')
    const rec = deep(state.workRec)
    rec.me_email = meAddr() || rec.me_email || ''
    if (!(Number(rec.last_sync_ms) > 0)) rec.backfill_from = Date.now() - days() * DAY
    const tuning = { ...DIGEST_TUNING, QUIET_MS: quietMs() }
    const src = createWorkSource({ freezr: F, persist: null, accounts: [rec], dryRun: true, tuning })
    const summary = await src.formAll({
      fromMs: rec.backfill_from || (Date.now() - days() * DAY),
      onPage: (p) => setStatus('Reading sessions (dry run)… ' + p.pages + ' session(s) read', 'busy')
    })
    state.preview = summary.items.map(it => ({ ...it, _parts: splitTurnBody(it.body_text) }))
      .sort((a, b) => a.date - b.date)
    state.openIdx = null
    renderPreview(state.preview, { openIdx: null, onOpen: openItem })
    renderProjection(summary, state.preview)
    state.parsed.clear()
    setElapsed(Date.now() - t0)
    setStatus(state.preview.length
      ? 'Dry run: ' + state.preview.length + ' turn item(s) would be queued. Click a row to open it as the viewer will show it, with the turn\'s facts and raw records underneath. Nothing was written.'
      : 'Dry run: nothing to queue' + (summary.errors.length ? ' — ' + summary.errors.map(e => e.message).join(' | ') : ' (no tracked repos with sessions in the window, or every turn is already read).'),
    summary.errors.length ? 'warn' : 'ok')
  } catch (e) {
    setStatus(explainFsError(e), 'error')
  } finally {
    state.busy = false
    $('wlPreview').disabled = false
  }
}

// Re-read the session file (with raw records kept) and open the inspection modal for one item.
async function parsedSessionFor (item) {
  if (state.parsed.has(item.session_id)) return state.parsed.get(item.session_id)
  const layout = state.reader.layout || await state.reader.detectLayout()
  const path = item.source_path || ((layout.projectsPath ? layout.projectsPath + '/' : '') + item.repo_slug + '/' + item.session_id + '.jsonl')
  const text = await state.reader.readText(path)
  const session = sessionFromText(text, { sessionId: item.session_id, repoSlug: item.repo_slug, path }, { keepRaw: true })
  state.parsed.set(item.session_id, session)
  return session
}

async function openItem (i) {
  const item = state.preview[i]
  if (!item) return
  state.openIdx = i
  renderPreview(state.preview, { openIdx: i, onOpen: openItem })
  let session = null; let turn = null
  try {
    session = await parsedSessionFor(item)
    turn = session.turns.find(t => t.n === item.turn_n) || null
  } catch (e) {
    setStatus('Could not re-read the session for the raw view: ' + explainFsError(e), 'warn')
  }
  openTurnModal({ item, turn, session })
}

// ---- the chronological dry run (LLM; nothing saved) ---------------------------------------------
// ensureRun builds the run once (formation in memory + processor over it); Next steps one item,
// Run all loops; Reset discards everything. The real components paint after every step.

async function ensureRun () {
  if (state.run) return state.run
  syncActive()
  const me = meAddr()
  if (!me) { setStatus('Enter your own address (ME) in the channel setup first — every prompt is authored by you.', 'warn'); return null }
  setStatus('Forming turn items in memory…', 'busy')
  const data = await persist.loadAll()
  // EVERY AGENT STORE IN ONE RUN (user, 2026-09-10). Each fs connection is one agent (~/.claude =
  // Claude Code, ~/.codex/sessions = Codex). Run them together so their turns interleave by time
  // and cross-agent project matching is actually exercised. Scope 'this' falls back to the store
  // the setup module currently has open.
  // FROM WHAT IS ON SCREEN: every ticked store, with ITS OWN repo ticks and ITS OWN days as shown
  // in the setup module — saved or not. (Was: the last-touched block's days for everyone plus the
  // other stores from the SAVED accounts, so unticking Claude and dropping its days emptied a
  // Codex run — user, 2026-09-10.)
  const chosen = runBlocks()
  if (!chosen.length) { setStatus('Tick at least one store under “Stores in this run”.', 'warn'); return null }
  const workRecs = chosen.map(b => { const r = deep(b.workRec); r.me_email = me; r.account_email = me; r._days = b.days; return r })
  const run = await createDryRun({
    freezr: F, persist, data, workRecs, days: Math.max(...chosen.map(b => b.days)),
    tuning: { ...DIGEST_TUNING, QUIET_MS: quietMs() },
    model: selectedModel($('wlModel')),
    catalog: $('wlCatalog').value === 'real' ? 'real' : 'empty',
    // buildVariant returns null for the control, so the shipped prompt stays the literal shipped
    // path rather than a rebuilt copy of it (see promptVariants.js)
    promptOverride: buildVariant(($('wlPrompt') && $('wlPrompt').value) || 'control'),
    // blank = every turn of every touched session (the original behaviour); N = only turns from the
    // last N days are analysed, earlier turns of those sessions serve as thread context
    analyseDays: analyseDaysValue(),
    onFormProgress: (p) => setRunProgress('reading sessions… ' + p.pages)
  })
  state.run = run
  state.view = createRunView(run)
  resetRunPanels(); setRunCost(null)
  $('wlReset').hidden = false
  $('wlCopy').hidden = false
  // knobs that shape the run are frozen while it lives
  for (const id of ['wlCatalog', 'wlModel', 'wlQuiet', 'wlPrompt', 'wlAnalyseDays']) { const e = $(id); if (e) e.disabled = true }
  for (const cb of document.querySelectorAll('#wlStores input')) cb.disabled = true
  if (state.setup) state.setup.setBusy(true)
  const perStore = (a) => (a.agent_name || a.account_id) + ' (' + a.days + 'd, ' + a.tracked + ' repo' + (a.tracked === 1 ? '' : 's') + ' → ' + a.items + ' turn' + (a.items === 1 ? '' : 's') + ')'
  const agentsRun = run.agents && run.agents.length ? run.agents.map(a => a.agent_name || a.account_id).join(' + ') : ''
  if (!run.items.length) setStatus('Nothing to run — no turns in the window for the ticked repos: ' + (run.agents || []).map(perStore).join(' · ') + '. Widen the days or tick more repos above.', 'warn')
  else if (run.analyseDays) setStatus(run.plan.total + ' of ' + run.items.length + ' formed turn item(s) queued oldest-first' + (agentsRun ? ' across ' + agentsRun : '') + ' — only turns from the last ' + run.analyseDays + ' day' + (run.analyseDays === 1 ? '' : 's') + ' are analysed; the ' + run.contextOnly + ' earlier turn(s) of these sessions are read as thread context only, ' + (run.catalog === 'real' ? 'against your real catalog (in memory)' : 'from an EMPTY catalog — a bootstrap: whatever is already in the database is ignored') + '. Nothing is saved.', run.plan.total + run.contextOnly === run.items.length ? 'ok' : 'warn')
  else setStatus(run.plan.total + ' of ' + run.items.length + ' formed turn item(s) queued oldest-first' + (agentsRun ? ' across ' + agentsRun : '') + ' (every turn of every session touched in the window), ' + (run.catalog === 'real' ? 'against your real catalog (in memory)' : 'from an EMPTY catalog — a bootstrap: whatever is already in the database is ignored') + '. Nothing is saved.', run.plan.total === run.items.length ? 'ok' : 'warn')
  paintRunLog(run)
  return run
}

const progressFor = (run) => (ev) => {
  const n = run.processor.session.processed + 1
  if (ev.type === 'llm_waiting') setRunProgress('turn ' + n + ' of ' + run.items.length + ' — waiting on the model… ' + Math.round((ev.elapsedMs || 0) / 1000) + 's')
  else if (ev.type === 'loading') setRunProgress('turn ' + n + ' of ' + run.items.length + ' — loading its thread…')
  else if (ev.type === 'step_pending' || ev.type === 'batch_formed') setRunProgress('turn ' + n + ' of ' + run.items.length + ' — request assembled, calling the model')
}

function afterStep (run, step) {
  setRunCost(run.summary.cost, run.summary.steps)
  // a rendering bug must never kill the run — log it and carry on
  try { state.view.prependEvent(step) } catch (e) { console.error('[agentslab] event render failed', e); run.log.push({ at: Date.now(), kind: 'error', text: 'page: event render failed — ' + (e && e.message), detail: e && e.stack }) }
  try { state.view.paintBoard() } catch (e) { console.error('[agentslab] board render failed', e); run.log.push({ at: Date.now(), kind: 'error', text: 'page: board render failed — ' + (e && e.message), detail: e && e.stack }) }
  setRunProgress('turn ' + run.processor.session.processed + ' of ' + run.items.length + ' done' + (run.remaining() ? '' : ' — window complete'))
}

// after every step or stop: the log, the stop banner, the summary, the Skip button
function afterRound (run) {
  paintRunLog(run)
  paintStopBanner(run)
  state.view.summaryLine(run.summary)
  $('wlSkip').hidden = !run.summary.error || run.remaining() <= 0
}

function lockRun (on) {
  state.busy = on
  $('wlNext').disabled = on; $('wlRun').disabled = on; $('wlPreview').disabled = on
  $('wlStop').hidden = !on
  $('wlCommit').hidden = on || !state.run || !state.run.handledCount() || state.run.isCommitted()
  $('wlCommit').disabled = on
}

// ---- save the run: everything in memory → the database, once ---------------------------------------
async function commitRun () {
  if (state.busy || !state.run || state.run.isCommitted()) return
  const run = state.run
  lockRun(true); $('wlStop').hidden = true
  setStatus('Saving the run to the database…', 'busy')
  try {
    const res = await run.commitRun({ onProgress: (w) => setRunProgress('saving… ' + w) })
    // the page's stored-accounts view catches up so a reload shows the account as trained
    for (const acct of (res.accounts || (res.account ? [res.account] : []))) {
      const i = state.storedAccounts.findIndex(a => a.account_id === acct.account_id)
      if (i >= 0) state.storedAccounts[i] = acct; else state.storedAccounts.push(acct)
      if (acct.account_id === (state.workRec && state.workRec.account_id)) state.workRec = deep(acct)
    }
    $('wlInspect').hidden = false
    paintRunLog(run)
    setRunProgress('')
    setStatus('SAVED — ' + res.inputs + ' turn item(s), ' + res.events + ' event(s), ' + res.projects + ' project(s), ' + res.profiles + ' profile(s) written' +
      (res.errors.length ? ' with ' + res.errors.length + ' error(s) (see the run log)' : '') +
      '. The live checks continue from the last analysed turn. Open the Projects / To-dos / Events pages to see it all in place.', res.errors.length ? 'warn' : 'ok')
  } catch (e) {
    console.error('[agentslab] save failed', e)
    setStatus('Save failed: ' + ((e && e.message) || e), 'error')
  } finally { lockRun(false) }
}

async function stepOne () {
  if (state.busy) return
  const run = await ensureRun(); if (!run || !run.items.length) return
  if (run.remaining() <= 0) { setStatus('The window is complete — every turn item was analysed. Reset to start over.', 'ok'); return }
  lockRun(true); $('wlStop').hidden = true
  try {
    const r = await run.stepOnce({ batch: Math.max(1, parseInt($('wlBatch').value, 10) || 1), onEvent: progressFor(run) })
    for (const st of r.steps) afterStep(run, st)
    afterRound(run)
    if (r.error) setStatus('The run STOPPED on this turn — see the red banner and the run log below. Retry with "Analyse next turn" or skip it.', 'error')
    else if (run.remaining() <= 0) setStatus('The window is complete — every turn item was analysed. Nothing was saved.', 'ok')
  } catch (e) {
    setStatus('Step failed: ' + ((e && e.message) || e), 'error')
  } finally { lockRun(false) }
}

async function runAllTurns () {
  if (state.busy) return
  const run = await ensureRun(); if (!run || !run.items.length) return
  state.stopRequested = false
  lockRun(true); $('wlStop').disabled = false
  const t0 = Date.now()
  const tick = setInterval(() => setElapsed(Date.now() - t0), 1000)
  try {
    const summary = await run.runAll({
      batch: Math.max(1, parseInt($('wlBatch').value, 10) || 1),
      shouldStop: () => state.stopRequested,
      onEvent: progressFor(run),
      onStep: (st) => { afterStep(run, st); afterRound(run) }
    })
    afterRound(run)
    if (summary.error) setStatus('The run STOPPED after ' + summary.steps + ' turn(s) — see the red banner and the run log below. Retry with "Analyse next turn" or skip the turn.', 'error')
    else setStatus('Run ' + (summary.stopped ? 'stopped by you' : 'finished') + ' — ' + summary.steps + ' turn(s) analysed, $' + summary.cost.toFixed(4) + '. Nothing was saved.', 'ok')
  } catch (e) {
    console.error('[agentslab] dry run failed', e)
    setStatus('Dry run failed: ' + ((e && e.message) || e), 'error')
  } finally {
    clearInterval(tick); setElapsed(Date.now() - t0)
    lockRun(false)
  }
}

async function skipTurn () {
  if (state.busy || !state.run) return
  lockRun(true); $('wlStop').hidden = true
  try {
    await state.run.skipNext()
    afterRound(state.run)
    setStatus('Skipped. Continue with "Analyse next turn" or "Run all".', 'ok')
  } catch (e) {
    setStatus('Skip failed: ' + ((e && e.message) || e), 'error')
  } finally { lockRun(false) }
}

function resetRun () {
  if (state.busy) return
  state.run = null; state.view = null
  resetRunPanels(); setRunCost(null); setRunProgress('')
  $('wlReset').hidden = true; $('wlSkip').hidden = true; $('wlCommit').hidden = true; $('wlCopy').hidden = true
  for (const id of ['wlCatalog', 'wlModel', 'wlQuiet', 'wlPrompt', 'wlAnalyseDays']) { const e = $(id); if (e) e.disabled = false }
  for (const cb of document.querySelectorAll('#wlStores input')) cb.disabled = false
  if (state.setup) state.setup.setBusy(false)
  setStatus('Run discarded — nothing had been saved anyway. Change the knobs and start again.', 'ok')
}

// ---- analysis floor -------------------------------------------------------------------------------

// Blank = every turn of every touched session (the plan window is widened to the oldest formed
// turn). N = only turns from the last N days are queued; earlier turns still serve as thread
// context. Clamped to the same 1–120 range as the per-store days.
function analyseDaysValue () {
  const el = $('wlAnalyseDays')
  const n = el ? parseInt(el.value, 10) : NaN
  return Number.isFinite(n) && n > 0 ? Math.min(120, n) : null
}
function paintAnalyseHint () {
  const el = $('wlAnalyseHint')
  if (!el) return
  const n = analyseDaysValue()
  el.textContent = n
    ? 'Turns older than ' + n + ' day' + (n === 1 ? '' : 's') + ' are read for context but not analysed — what the live checks do. A save writes only the analysed turns.'
    : 'Every turn of every session touched in the per-store window is analysed, however old — a session that started weeks ago brings all its turns.'
}

// ---- prompt arm + board export -------------------------------------------------------------------

// The arm selector. The control is the shipped prompt; any other arm is built by promptVariants.js
// as exact edits against it, so the two differ by precisely those edits and nothing else.
function paintPromptArms () {
  const sel = $('wlPrompt')
  if (!sel) return
  sel.innerHTML = ''
  for (const v of VARIANT_LIST) {
    const o = document.createElement('option')
    o.value = v.id; o.textContent = v.label + (v.edits ? ' — ' + v.edits + ' edit' + (v.edits === 1 ? '' : 's') : '')
    sel.appendChild(o)
  }
  const hint = () => {
    const el = $('wlPromptHint')
    if (!el) return
    try {
      const b = buildVariant(sel.value)
      el.textContent = b
        ? b.applied.map(a => a.id).join(', ') + ' · ' + b.baseChars.toLocaleString() + ' → ' + b.chars.toLocaleString() + ' chars (version ' + b.version + ')'
        : 'The prompt exactly as it ships — no edits applied.'
    } catch (e) { el.textContent = 'This arm no longer applies: ' + e.message }
  }
  sel.addEventListener('change', hint)
  hint()
}

// The board as JSON — every project with its to-dos, plus the run's counts. Read-only: this writes
// nothing (that is what "Save this run to the database" is for), it just makes the result readable
// and shareable. Follows the clipboard pattern already used by setup.js.
function boardJson () {
  const run = state.run
  if (!run) return null
  const projects = run.store.all().map(p => ({
    project_id: p.project_id,
    name: p.name,
    summary: p.summary || '',
    importance: p.importance,
    todos: (p.todos || []).map(t => ({
      todo_id: t.todo_id,
      short_description: t.short_description,
      description: t.description || '',
      status: t.status,
      direction: t.direction,
      who: t.who || t.owners || t.owner || null,
      importance: t.importance
    }))
  }))
  const todos = projects.reduce((n, p) => n + p.todos.length, 0)
  return {
    arm: ($('wlPrompt') && $('wlPrompt').value) || 'control',
    catalog: run.catalog,
    turns_queued: run.plan && run.plan.total,
    turns_analysed: run.summary.steps,
    cost: run.summary.cost,
    projects_created: projects.length,
    todos_created: todos,
    projects
  }
}

async function copyBoard () {
  const board = boardJson()
  if (!board) { setStatus('No run to copy yet.', 'warn'); return }
  try {
    await navigator.clipboard.writeText(JSON.stringify(board, null, 1))
    setStatus('Board copied — ' + board.projects_created + ' project(s), ' + board.todos_created + ' to-do(s) from ' + board.turns_analysed + ' analysed turn(s). Nothing was saved.', 'ok')
  } catch (e) { setStatus('Could not copy: ' + (e.message || e), 'error') }
}

// ---- init --------------------------------------------------------------------------------------

async function init () {
  if (!F) { setStatus('freezr is not available on this page.', 'error'); return }
  try {
    const data = await persist.loadAll()
    state.settings = data.settings || {}
    state.storedAccounts = (data.accounts || []).filter(r => r && r.account_id)
  } catch (e) { /* fresh install */ }
  populateModelSelect($('wlModel'), { stored: state.settings.default_model || null, hintEl: $('wlModelHint'), onError: (m) => { $('wlModelHint').textContent = 'No model available for the dry run: ' + m } }).catch(() => {})
  paintPromptArms()
  paintAnalyseHint()
  const ad = $('wlAnalyseDays'); if (ad) ad.addEventListener('input', paintAnalyseHint)
  $('wlPreview').disabled = true; $('wlRun').disabled = true; $('wlNext').disabled = true
  // the store rows mirror the setup module LIVE: any tick or days change above repaints them
  // (the module has no change hook; a delegated listener on its host is enough)
  $('wlSetupHost').addEventListener('change', () => paintStores())
  $('wlSetupHost').addEventListener('input', () => paintStores())
  state.setup = renderWorkSessions($('wlSetupHost'), {
    freezr: F, persist, storedAccounts: state.storedAccounts, settings: state.settings, onSaved, onConnectionLoaded,
    // this page SAVES only; the run buttons below are the read — no onReadAll, so the module
    // shows no Read button here
  })
  paintStores()   // rows appear now (as "loading…") and fill in as each store's onConnectionLoaded fires
  setStatus('Pick the repos above per store (that is the production setup); tick the stores to include below; then preview or dry-run.', 'ok')
}

$('wlNext').addEventListener('click', stepOne)
$('wlRun').addEventListener('click', runAllTurns)
$('wlStop').addEventListener('click', () => { state.stopRequested = true; $('wlStop').disabled = true; setRunProgress('stopping after the current turn…') })
$('wlReset').addEventListener('click', resetRun)
$('wlCopy').addEventListener('click', copyBoard)
$('wlCommit').addEventListener('click', commitRun)
$('wlSkip').addEventListener('click', skipTurn)
$('wlShowAll').addEventListener('change', () => { if (state.view) state.view.paintBoard({ showAll: $('wlShowAll').checked }) })

init()
