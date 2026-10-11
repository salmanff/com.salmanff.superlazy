// cleanup.js — the /cleanup PAGE (specs/superlazy-weekly-cleanup.md §7): the experimentation host
// for the weekly clean-up. Loads the stores, lets the user pick a model and tune the windows and
// thresholds, ESTIMATES the size and cost of a run before sending it, runs the clean-up through
// cleanupCore, and mounts the shared review surface (cleanupView) with THE standard task-row
// handlers and modals — so a to-do here behaves exactly as on the Dashboard or Tasks pages.
// Around it: "Under the hood", the free housekeeping passes, the archived-projects list with
// Restore, and past runs. Later the same core + view mount as a Setup tab; the page stays for
// experiments. Not in the nav.

import { createPersistence } from '../jobs/analyze_thread/persist.js'
import { createProjectStore } from '../jobs/analyze_thread/projectStore.js'
import { createProfileStore } from '../jobs/analyze_thread/profiles.js'
import { createInstructionStore } from '../jobs/analyze_thread/instructionStore.js'
import { meSetFromSettingsAndAccounts } from '../jobs/analyze_thread/ingest.js'
import { detectSource, isMessagingAccount } from '../shared/sourceFactory.js'
import { populateModelSelect, selectedModel, selectedPricing } from '../shared/modelPicker.js'
import { renderTopBar } from '../shared/topbar.js'
import { previewEventsPruning, previewInteractionRebuild, previewOrphanThreads, DEFAULT_EVENTS_RETENTION_DAYS } from '../jobs/analyze_thread/maintenance/deterministic.js'
import { GROUPS } from '../jobs/analyze_thread/maintenance/cleanupPrompt.js'
import { createCleanupCore, DEFAULT_KNOBS } from '../jobs/analyze_thread/maintenance/cleanupCore.js'
import { createCleanupView } from './cleanupView.js'
import { agentNameFor } from '../jobs/analyze_thread/config.js'
import { MANUAL_ACCOUNT_ID, NOTE_SOURCE_TAG } from '../jobs/analyze_thread/noteIngest.js'
import { sourceTagFor } from '../jobs/analyze_thread/persist.js'
import * as maintStore from './maintStore.js'
import { div, span, btn, fmtDate } from '../shared/renderUtils.js'
// the shared task / project / person machinery — same wiring as shell.js
import { configureEmailViewer } from '../shared/emailViewer.js'
import { createMailContext } from '../shared/viewerContext.js'
import { openPersonEditor } from '../shared/personEditor.js'
import { openTaskEditor } from '../shared/taskEditor.js'
import {
  taskOps, taskEditOps, openTaskEmail, openProjectModal, setManualEventListener,
  setProjectsProvider, setPeopleProvider, setEventsProvider, setProjectSaver, setProjectCreator,
  setTodoMinter, setHostRepaint, setProjectDeleter, setPersonEditorOpener, setNameLookup, setSelfAddresses, setDraftHandlers
} from '../shared/ui.js'

renderTopBar('cleanup')

const $ = (id) => document.getElementById(id)
const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(3)
const state = { persist: null, store: null, profiles: null, instructions: null, rawProfiles: [], settings: {}, storedAccounts: [], source: null, liveAccounts: [], accountRows: [], core: null, view: null, running: false, thinking: '', lastOutputTokens: null, extraEvents: [] }

function setStatus (text, cls) { const s = $('clStatus'); s.textContent = text; s.className = 'ml-status' + (cls ? ' ' + cls : '') }

const knobs = () => ({
  ...DEFAULT_KNOBS,
  windowDays: Math.max(1, parseInt($('clDays').value, 10) || 7),
  editsWindowDays: Math.max(7, parseInt($('clEditDays').value, 10) || 30),
  focusDays: Math.max(1, parseInt($('clFocusDays').value, 10) || 7),
  inputMode: $('clMode').value === 'full' ? 'full' : 'index',
  minAgeDays: Math.max(1, parseInt($('clAge').value, 10) || 30),
  maxImportance: Math.max(1, Math.min(5, parseInt($('clImp').value, 10) || 3)),
  quietDays: Math.max(1, parseInt($('clQuiet').value, 10) || 21),
  dormantMonths: Math.max(1, parseInt($('clDormant').value, 10) || 3),
  sections: [...document.querySelectorAll('#clSections input:checked')].map(i => i.value),
  ...accountsKnob()
})

// ---- the accounts knob (per run, not saved) ------------------------------------------------------------
// Every account the app knows: the stored accounts rows (one per connection per channel — mail,
// Slack 'messages', agent 'work'), any live mail connection not yet stored, and the 'manual' pseudo
// account local notes are filed under. Labels follow the Status tab's.
function buildAccountRows () {
  const rows = []
  const seen = new Set()
  const kindOf = (a) => a.channel === 'messages' ? 'slack' : a.channel === 'work' ? 'agent' : 'mail'
  for (const a of state.storedAccounts) {
    if (!a || !a.account_id || seen.has(a.account_id)) continue
    seen.add(a.account_id)
    const kind = kindOf(a)
    rows.push({ id: a.account_id, kind, label: kind === 'agent' ? agentNameFor(a.provider) + ' — ' + a.account_id : kind === 'slack' ? 'Slack — ' + (a.account_email || a.account_id) : (a.account_email || a.account_id), tag: sourceTagFor({ channel: a.channel || null, account_id: a.account_id, account_email: a.account_email || a.account_id }) })
  }
  for (const a of state.liveAccounts) {
    if (!a || !a.account_id || seen.has(a.account_id)) continue
    seen.add(a.account_id)
    rows.push({ id: a.account_id, kind: 'mail', label: a.account_email || a.account_id, tag: sourceTagFor({ account_email: a.account_email || a.account_id }) })
  }
  if (!seen.has(MANUAL_ACCOUNT_ID)) rows.push({ id: MANUAL_ACCOUNT_ID, kind: 'local', label: 'Local notes', tag: NOTE_SOURCE_TAG })
  const order = { mail: 0, slack: 1, agent: 2, local: 3 }
  rows.sort((a, b) => (order[a.kind] - order[b.kind]) || a.label.localeCompare(b.label))
  return rows
}
// null when every account is ticked (the default) — the core then applies no filter
function accountsKnob () {
  const boxes = [...document.querySelectorAll('#clAccounts input[type=checkbox]')]
  if (!boxes.length || boxes.every(b => b.checked)) return { accounts: null }
  const labels = {}
  for (const r of state.accountRows) labels[r.id] = r.label
  const ids = boxes.filter(b => b.checked).map(b => b.value).sort()
  // the provenance tags the core scopes the catalog by (projects.sources / profiles.sources)
  const accountTags = state.accountRows.filter(r => ids.includes(r.id) && r.tag).map(r => r.tag).sort()
  return { accounts: ids, accountLabels: labels, accountTags }
}
function paintAccounts () {
  const host = $('clAccounts')
  const prior = new Map([...host.querySelectorAll('input[type=checkbox]')].map(b => [b.value, b.checked]))
  host.textContent = ''
  state.accountRows = buildAccountRows()
  const kindWord = { mail: 'mail', slack: 'slack', agent: 'agent', local: 'local' }
  for (const r of state.accountRows) {
    const l = document.createElement('label')
    const c = document.createElement('input'); c.type = 'checkbox'; c.value = r.id; c.checked = prior.has(r.id) ? prior.get(r.id) : true
    c.addEventListener('change', () => l.classList.toggle('cl-acct-off', !c.checked))
    l.classList.toggle('cl-acct-off', !c.checked)
    l.appendChild(c)
    l.appendChild(span('cl-acct-kind', kindWord[r.kind] || r.kind))
    l.appendChild(document.createTextNode(r.label))
    const n = span('cl-acct-count', ''); n.dataset.acct = r.id; l.appendChild(n)
    host.appendChild(l)
  }
  paintAccountCounts()
}
// after an estimate: how many of the window's items each account contributed (from the unfiltered scan)
function paintAccountCounts () {
  const p = state.core && state.core.prepared
  const counts = {}
  if (p) for (const ev of (state.core.events || [])) {
    if (!ev || !ev.msg_id || (ev.kind !== 'message' && ev.kind !== 'workflow_short_circuit') || (Number(ev.asof) || 0) < p.windowFrom) continue
    const id = ev.account_id == null ? '(none)' : String(ev.account_id)
    counts[id] = (counts[id] || 0) + 1
  }
  for (const el of document.querySelectorAll('#clAccounts .cl-acct-count')) el.textContent = p ? (counts[el.dataset.acct] || 0) + ' item' + (counts[el.dataset.acct] === 1 ? '' : 's') : ''
}

// knobs are the stored preferences: they seed from settings and write back on change
function wireKnobs () {
  const s = state.settings
  $('clDays').value = Number(s.cleanup_window_days) || DEFAULT_KNOBS.windowDays
  $('clEditDays').value = Number(s.cleanup_edits_window_days) || DEFAULT_KNOBS.editsWindowDays
  $('clFocusDays').value = Number(s.cleanup_focus_days) || DEFAULT_KNOBS.focusDays
  $('clMode').value = s.cleanup_input_mode === 'full' ? 'full' : 'index'
  $('clRetention').value = s.events_retention_days == null ? DEFAULT_EVENTS_RETENTION_DAYS : s.events_retention_days
  const save = (fields) => state.persist.stampSettingsFields(fields).then(() => Object.assign(state.settings, fields)).catch(e => setStatus('Could not save the setting: ' + ((e && e.message) || e), 'warn'))
  $('clDays').addEventListener('change', () => save({ cleanup_window_days: knobs().windowDays }))
  $('clEditDays').addEventListener('change', () => save({ cleanup_edits_window_days: knobs().editsWindowDays }))
  $('clFocusDays').addEventListener('change', () => save({ cleanup_focus_days: knobs().focusDays }))
  $('clMode').addEventListener('change', () => save({ cleanup_input_mode: knobs().inputMode }))
  $('clRetention').addEventListener('change', () => save({ events_retention_days: Math.max(0, parseInt($('clRetention').value, 10) || 0) }))
  const host = $('clSections')
  const labels = { period: 'this period', focus: 'focus', attention: 'attention', stale: 'stale', archive: 'archive', merge: 'merge', split: 'split', people: 'people', rules: 'rules', learn: 'learn', questions: 'questions' }
  for (const g of GROUPS) {
    const l = document.createElement('label')
    const c = document.createElement('input'); c.type = 'checkbox'; c.value = g; c.checked = true
    l.appendChild(c); l.appendChild(document.createTextNode(labels[g] || g))
    host.appendChild(l)
  }
  // any knob change invalidates the estimate line
  for (const id of ['clDays', 'clEditDays', 'clFocusDays', 'clMode', 'clAge', 'clImp', 'clQuiet', 'clDormant', 'clModel']) $(id).addEventListener('change', () => { if (id === 'clModel' && state.core && state.core.prepared) paintEstimate(); else $('clEstimateLine').className = 'cl-estimate ml-muted', $('clEstimateLine').textContent = 'Settings changed — press “Estimate” again.' })
  host.addEventListener('change', () => { $('clEstimateLine').className = 'cl-estimate ml-muted'; $('clEstimateLine').textContent = 'Settings changed — press “Estimate” again.' })
  // accounts: per-run, not saved; all / none shortcuts; any change invalidates the estimate
  const invalidate = () => { $('clEstimateLine').className = 'cl-estimate ml-muted'; $('clEstimateLine').textContent = 'Settings changed — press “Estimate” again.' }
  paintAccounts()
  $('clAccounts').addEventListener('change', invalidate)
  const setAll = (on) => { for (const b of document.querySelectorAll('#clAccounts input[type=checkbox]')) { b.checked = on; b.dispatchEvent(new Event('change')) } invalidate() }
  $('clAccountsAll').addEventListener('click', () => setAll(true))
  $('clAccountsNone').addEventListener('click', () => setAll(false))
}

const meSet = () => {
  const s = meSetFromSettingsAndAccounts(state.settings, state.storedAccounts)
  for (const a of state.liveAccounts) if (a.account_email) s.add(String(a.account_email).toLowerCase())
  return s
}
const nameOf = (a) => { const p = state.profiles && state.profiles.get(a); return (p && p.display_name) || null }
const peopleForEditor = () => (state.rawProfiles || []).filter(p => p && p.address).map(p => ({ address: p.address, name: p.display_name || '' }))
const getProject = (id) => (id && state.store ? state.store.get(id) : null)
const projectName = (id) => { const p = getProject(id); return (p && p.name) || id || '' }
const repaint = () => { if (state.view) state.view.paint() }
const allEvents = () => [...state.extraEvents, ...((state.core && state.core.events) || [])]

// ---- the standard task / project / person wiring (shell.js's recipe, one copy here) ---------------
const openPerson = (address) => openPersonEditor(address, { profiles: state.profiles, persist: state.persist, instructions: state.instructions, projects: () => state.store.all(), nameOf, settings: state.settings, onChange: repaint })
const onOpenProject = (project) => openProjectModal(project, { onClose: repaint })
const taskHandlers = {
  nameOf,
  self: [],
  onOpenPerson: openPerson,
  onResolve: (t, p) => { taskOps.toggleResolve(t, p); repaint() },
  onCancel: (t, p) => { taskOps.cancel(t, p); repaint() },
  onImportance: (t, d, p) => { taskOps.setImportance(t, d, p); repaint() },
  onDescChange: (t, p, d) => taskOps.setDescription(t, p, d),
  onEdit: (t, p, extra) => openTaskEditor(t, p, { projects: () => state.store.all(), self: taskHandlers.self, people: peopleForEditor, ops: taskEditOps, onChange: () => { repaint(); if (extra && extra.onChange) extra.onChange() } }),
  openEmailModal: (t, p, msgId) => openTaskEmail(t, p, msgId)
}
function wireShared () {
  const persist = state.persist
  const mailCtx = createMailContext({
    persist, getProjects: () => state.store.all(), getProject, getEvents: allEvents, nameOf, selfAddrs: () => taskHandlers.self, projectName, taskHandlers, onOpenProject, onOpenPerson: openPerson,
    onSent: (ev) => { state.extraEvents.unshift(ev) }, refresh: repaint, getSettings: () => state.settings || null
  })
  configureEmailViewer({ source: state.source, persist, context: mailCtx.context })
  setProjectsProvider(() => state.store.all())
  setPeopleProvider(peopleForEditor)
  setEventsProvider(allEvents)
  setDraftHandlers(mailCtx.draftHandlers)
  setProjectSaver((p) => persist.saveProject(p).catch(e => console.error('project save failed', e)))
  setProjectCreator((name) => state.store.ensureProject({ project_id: state.store.mintUserProjectId(), name, asof: Date.now() }))
  setTodoMinter(() => state.store.mintUserTodoId())
  setHostRepaint(repaint)
  setProjectDeleter(async (p) => { if (!p || !p.project_id) return; state.store.remove(p.project_id); await persist.deleteProject(p.project_id); repaint() })
  setPersonEditorOpener(openPerson)
  setNameLookup(nameOf)
  // hand edits made here persist exactly like on the shell pages: the touched projects + one event
  setManualEventListener((mev) => {
    for (const pid of [mev.project_id, mev.project_id_2]) {
      const p = pid && state.store.get(pid)
      if (p) persist.saveProject(p).catch(e => console.error('manual save failed', e))
    }
    persist.addEvent({ ...mev, kind: 'manual_edit', source_id: 'user' }).catch(e => console.error('manual event save failed', e))
    state.extraEvents.unshift({ ...mev, kind: 'manual_edit', source_id: 'user', _date_created: Date.now() })
    if (mev.target === 'todo' && mev.field === 'description') return
    repaint()
  })
}

// ---- estimate ------------------------------------------------------------------------------------------
function paintEstimate () {
  const line = $('clEstimateLine')
  const p = state.core && state.core.prepared
  if (!p) return
  const { pricing, name } = selectedPricing($('clModel'))
  const est = state.core.estimate(p, pricing, { lastOutputTokens: state.lastOutputTokens })
  const sz = p.sizes
  const st = p.stats || {}
  const chan = st.byChannel ? ' (' + Object.entries(st.byChannel).map(([k, v]) => k + ' ' + v).join(', ') + ')' : ''
  const acct = Array.isArray(p.knobs.accounts) ? ' · restricted to ' + p.knobs.accounts.length + ' of ' + state.accountRows.length + ' accounts' + (p.scope ? ', ' + p.scope.projects + ' of ' + p.scope.of + ' projects in scope' : '') : ''
  paintAccountCounts()
  let text = '≈ ' + est.inputTokens.toLocaleString() + ' tokens to send — system ' + Math.round(sz.system / 4).toLocaleString() + ' · state ' + Math.round(sz.state / 4).toLocaleString() + ' · input ' + Math.round(sz.input / 4).toLocaleString() + ' (' + (st.items || st.messages || 0) + ' items' + chan + acct + ') · closing ' + Math.round(sz.closing / 4).toLocaleString()
  if (est.priceKnown) {
    text += ' → input ≈ ' + fmtMoney(est.inputCost) + ' at ' + name
    text += est.outputCostHint != null ? ' · output unknown until it returns (the last run produced ' + est.outputTokensHint.toLocaleString() + ' tokens ≈ ' + fmtMoney(est.outputCostHint) + ' at this model)' : ' · output unknown until it returns'
    line.className = 'cl-estimate known'
  } else {
    text += ' — no price on file for ' + (name || 'this model') + ', so the cost cannot be estimated (the run will still bill you)'
    line.className = 'cl-estimate'
  }
  line.textContent = text
}
async function estimateNow () {
  if (state.running) return
  state.running = true; $('clRun').disabled = true; $('clEstimate').disabled = true
  try {
    await state.core.prepare({ knobs: knobs(), onStatus: setStatus })
    paintEstimate()
    setStatus('Estimated — nothing was sent. Run when the size looks right.', 'ok')
    paintHood()
  } catch (e) {
    setStatus('Could not build the request: ' + ((e && e.message) || e), 'error')
  } finally { state.running = false; $('clRun').disabled = false; $('clEstimate').disabled = false }
}

// ---- under the hood -----------------------------------------------------------------------------------
let hoodTab = 'state'
function paintHood () {
  const h = state.core ? state.core.hood : null
  const pre = $('clHoodPre')
  if (!h || !h.stateText) { pre.textContent = '(estimate or run the clean-up first)'; return }
  const m = h.meta || {}
  const texts = {
    state: h.stateText || '(not built yet)',
    input: h.inputText || '(not built yet)',
    closing: h.closingText || '(not built yet)',
    raw: h.raw || '(no output yet)',
    thinking: state.thinking || '(no thinking streamed)',
    meta: JSON.stringify({
      sizes_chars: h.sizes, est_tokens_in: h.sizes && h.sizes.estTokens,
      input_stats: h.stats,
      state_blocks: { hand_edits: h.handEdits, stale_rows: h.staleRows, archive_candidates: h.dormantRows, due_within_horizon: h.dueRows, period_counts: h.periodCounts },
      call: { model: m.model, provider: m.provider, turns: m.turns || (m.model ? 1 : 0), cost: m.cost, tokensUsed: m.tokensUsed, need_rounds: h.rounds, needs: h.needs },
      suppressed: state.core.suppressed
    }, null, 2)
  }
  pre.textContent = texts[hoodTab] || ''
  for (const b of document.querySelectorAll('.cl-hood-tab')) b.classList.toggle('sel', b.dataset.tab === hoodTab)
}

// ---- the run ------------------------------------------------------------------------------------------
async function runNow () {
  if (state.running) return
  const k = knobs()
  if (!k.sections.length) { setStatus('Tick at least one section.', 'warn'); return }
  if (Array.isArray(k.accounts) && !k.accounts.length) { setStatus('Tick at least one account (or use “all”).', 'warn'); return }
  state.running = true; state.thinking = ''
  $('clRun').disabled = true; $('clEstimate').disabled = true
  const t0 = Date.now()
  const tick = setInterval(() => { const s = Math.round((Date.now() - t0) / 1000); $('clElapsed').textContent = s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's' }, 1000)
  $('clCost').textContent = ''
  state.view.reset()
  try {
    const info = await state.core.run({
      knobs: k,
      model: selectedModel($('clModel')),
      onStatus: setStatus,
      onItem: (item) => state.view.itemArrived(item),
      onThinking: (t) => { state.thinking += t },
      onRound: (rd) => setStatus(rd.kind === 'need' ? 'The model asked for ' + (rd.items || []).length + ' item(s) of material (round ' + rd.round + ') — fetching and continuing…' : 'The reply was cut off — asking it to continue…', 'busy')
    })
    state.lastOutputTokens = (info.tokens && info.tokens.output) || null
    $('clCost').textContent = fmtMoney(info.cost) + ' (in ' + fmtMoney(info.costIn + (info.costOther || 0)) + ' · out ' + fmtMoney(info.costOut) + ')'
    const n = Object.values(info.counts).reduce((a, b) => a + b, 0)
    setStatus('Done: ' + n + ' item(s) — ' + Object.entries(info.counts).filter(([, v]) => v).map(([g, v]) => g + ' ' + v).join(', ') +
      (info.suppressed ? ' · ' + info.suppressed + ' suppressed (ignored earlier)' : '') + (info.incomplete ? ' · ⚠ the reply was cut off — there may have been more' : '') + '. Nothing is written until you accept and Apply.', info.incomplete ? 'warn' : 'ok')
    paintEstimate()
  } catch (e) {
    setStatus('The clean-up failed: ' + ((e && e.message) || e), 'error')
    if (e && e.meta && e.meta.cost) $('clCost').textContent = fmtMoney(e.meta.cost.totalCost)
  } finally {
    clearInterval(tick)
    state.running = false
    $('clRun').disabled = false; $('clEstimate').disabled = false
    state.view.paint()
    paintHood()
    paintHistory()
  }
}

async function showPending () {
  setStatus('Loading pending items from earlier runs…', 'busy')
  const r = await state.core.loadPending()
  state.view.reset()
  setStatus(r.items.length ? r.items.length + ' pending item(s) from earlier runs — decide them here.' : 'Nothing pending from earlier runs.', 'ok')
}

// ---- housekeeping (free) ---------------------------------------------------------------------------
async function runHousekeeping () {
  if (state.running) return
  state.running = true
  $('clHouseNote').textContent = 'Scanning the events log…'
  try {
    state.core.items = state.core.items.filter(i => i.group !== 'housekeeping')
    const retention = Math.max(0, parseInt($('clRetention').value, 10) || 0)
    const pr = await previewEventsPruning({ freezr, retentionDays: retention, onProgress: (n) => { $('clHouseNote').textContent = 'Scanning… ' + n + ' events' } })
    if (!pr.disabled && pr.total) {
      state.core.addLocal({ section: 'proposal', group: 'housekeeping', title: 'Prune ' + pr.total + ' events older than ' + retention + ' days', description: Object.entries(pr.byKind).map(([k, v]) => k + ': ' + v).join(', ') + ' · ≈' + Math.round(pr.approxChars / 1024) + ' KB · oldest ' + fmtDate(pr.oldest), evidence: [], ops: [{ op: 'prune_events', ids: pr.ids }] })
    }
    const ir = await previewInteractionRebuild({ freezr, profiles: state.profiles, meSet: meSet(), onProgress: (n) => { $('clHouseNote').textContent = 'Recomputing… ' + n + ' events' } })
    for (const row of (ir.rows || [])) {
      state.core.addLocal({ section: 'proposal', group: 'housekeeping', title: 'Rebuild interaction stats for ' + row.address, description: 'fields that differ: ' + (row.fieldsChanged || []).join(', ') + (row.crossChannel ? ' (cross-channel profile — seen-dates kept)' : ''), evidence: [], ops: [{ op: 'rebuild_interaction', address: row.address, rebuilt: row.rebuilt }] })
    }
    // D5 — thread links no to-do cites and no message changed the project on (user, 2026-10-04:
    // unrelated threads kept showing on a project after its to-dos had moved). One proposal per
    // project; Accept → unlink_threads, tombstoned so the save-time merge keeps the removal.
    const ot = await previewOrphanThreads({ freezr, store: state.store, onProgress: (n) => { $('clHouseNote').textContent = 'Checking thread links… ' + n + ' events' } })
    for (const row of (ot.rows || [])) {
      const n = row.orphans.length
      state.core.addLocal({
        section: 'proposal', group: 'housekeeping',
        title: 'Release ' + n + ' orphan thread link' + (n === 1 ? '' : 's') + ' from “' + row.name + '”',
        description: 'Linked threads that no to-do of this project cites and on which no message changed the project' +
          (row.orphanChat ? ' — ' + row.orphanChat + ' of them chat stream' + (row.orphanChat === 1 ? '' : 's') + ' (a whole channel or DM)' : '') +
          ' · keeping ' + (row.keptCited + row.keptTouched) + ' linked thread' + ((row.keptCited + row.keptTouched) === 1 ? '' : 's') +
          ' · e.g. ' + row.orphans.slice(0, 3).join(', ') + (n > 3 ? ', …' : ''),
        evidence: [], ops: [{ op: 'unlink_threads', project_id: row.project_id, thread_ids: row.orphans }]
      })
    }
    $('clHouseNote').textContent = (pr.disabled ? 'Pruning disabled (retention 0). ' : (pr.total + ' prunable event(s). ')) + (ir.rows || []).length + ' profile(s) with drifted stats. ' + (ot.total ? ot.total + ' orphan thread link(s) on ' + ot.rows.length + ' project(s). ' : 'No orphan thread links. ') + 'Rows are in the Housekeeping section of the review.'
    state.view.select('housekeeping')
  } catch (e) {
    $('clHouseNote').textContent = 'Housekeeping preview failed: ' + ((e && e.message) || e)
  } finally { state.running = false }
}

// ---- archived projects ------------------------------------------------------------------------------
async function paintArchive () {
  const host = $('clArchiveBody')
  host.textContent = ''
  let rows = []
  try { rows = await state.core.listArchived() } catch (e) { host.appendChild(div('ml-muted', 'The archive collection is not available yet (re-install pending?): ' + ((e && e.message) || e))); return }
  if (!rows.length) { host.appendChild(div('ml-muted', 'No archived projects.')); return }
  for (const r of rows) {
    const line = div('cl-arch-row')
    line.appendChild(span('', '“' + (r.name || r.project_id) + '” · ' + (r.todos || []).length + ' to-dos · archived ' + fmtDate(r.archived_asof) + (r.archived_reason ? ' — ' + String(r.archived_reason).slice(0, 120) : '')))
    line.appendChild(btn('ml-btn', 'Restore', async () => {
      try { await state.core.restore(r); await reloadStores(); await paintArchive(); setStatus('Restored “' + (r.name || r.project_id) + '”.', 'ok') } catch (e) { setStatus('Restore failed: ' + ((e && e.message) || e), 'error') }
    }))
    host.appendChild(line)
  }
}

async function paintHistory () {
  const host = $('clHistoryBody')
  host.textContent = ''
  const h = await maintStore.loadRecent()
  if (!h.runs.length) { host.appendChild(div('ml-muted', 'no runs recorded yet')); return }
  for (const r of h.runs) {
    const line = div('ml-hist-row')
    line.appendChild(span('ml-hist-id', r.run_id || r._id))
    const counts = r.sections || r.proposal_counts || {}
    const cs = r.cost_split
    line.appendChild(span('ml-hist-meta', fmtDate(r.started_at || r._date_created) + ' · ' + (r.call || (r.passes || []).join('+') || '?') + (r.model ? ' · ' + r.model : '') + (r.input_mode ? ' · ' + r.input_mode : '') + (r.knobs && Array.isArray(r.knobs.accounts) ? ' · ' + r.knobs.accounts.length + ' account(s)' : '') +
      (r.cost ? ' · ' + fmtMoney(r.cost) + (cs ? ' (in ' + fmtMoney((cs.input || 0) + (cs.other || 0)) + ' · out ' + fmtMoney(cs.output) + ')' : '') : '') + (r.tokens && r.tokens.cache_read ? ' · cache read ' + r.tokens.cache_read.toLocaleString() : '') +
      ' · ' + Object.entries(counts).filter(([, v]) => v).map(([k, v]) => k + ':' + v).join(' ') + (r.incomplete ? ' · cut off' : '')))
    host.appendChild(line)
  }
  const last = h.runs.find(r => r.tokens && r.tokens.output)
  if (last && state.lastOutputTokens == null) state.lastOutputTokens = last.tokens.output
}

async function reloadStores () {
  const data = await state.persist.loadAll()
  state.store = createProjectStore(); state.store.hydrate(data.projects)
  state.profiles = createProfileStore(); state.profiles.hydrate(data.profiles)
  state.rawProfiles = data.profiles || []
  state.instructions = createInstructionStore(); state.instructions.hydrate(data.instructions || [])
  state.settings = data.settings || {}
  state.storedAccounts = data.accounts || []
  taskHandlers.self = (state.settings.your_addresses || []).map(a => String(a).toLowerCase())
  setSelfAddresses(state.settings.your_addresses || [])
  if ($('clAccounts').querySelector('input')) paintAccounts()
  const prev = state.core
  state.core = createCleanupCore({ freezr, persist: state.persist, store: state.store, profiles: state.profiles, instructions: state.instructions, settings: state.settings, source: state.source, liveAccounts: state.liveAccounts, meSet: meSet(), nameOf })
  if (prev) { state.core.items = prev.items; state.core.runInfo = prev.runInfo; state.core.hood = prev.hood; state.core.runId = prev.runId; state.core.events = prev.events; state.core.prepared = null }
  state.view = createCleanupView($('clView'), { core: state.core, taskHandlers, onOpenProject, projectName, onStatus: setStatus, onApplied: async () => { await reloadStores(); await paintArchive(); state.view.paint() } })
  state.view.paint()
}

async function init () {
  state.persist = createPersistence(typeof freezr !== 'undefined' ? freezr : null)
  setStatus('Loading stores…', 'busy')
  try {
    state.source = await detectSource()
    const res = await state.source.listAccounts()
    state.liveAccounts = ((res && res.accounts) || []).filter(a => !isMessagingAccount(a))
  } catch (e) { state.liveAccounts = []; console.warn('[superlazy cleanup] mail source unavailable:', e && e.message) }
  try { await reloadStores() } catch (e) { setStatus('Could not load the stores: ' + ((e && e.message) || e), 'error'); return }
  wireShared()
  wireKnobs()
  // the clean-up model is its own preference (settings.cleanup_model — Setup → Prefs), separate
  // from the per-message analysis model (user, 2026-09-26). The picker starts on the stored choice,
  // else "Recommended default" = the review tier (opus on Claude); a change here is saved as that preference.
  await populateModelSelect($('clModel'), { stored: state.settings.cleanup_model || null, tier: 'review', hintEl: $('clModelHint'), onError: (m) => setStatus('No model available: ' + m, 'warn') })
  $('clModel').addEventListener('change', () => { const m = selectedModel($('clModel')); if (m) save({ cleanup_model: m }) })
  $('clEstimate').addEventListener('click', estimateNow)
  $('clRun').addEventListener('click', runNow)
  $('clPending').addEventListener('click', showPending)
  $('clRunHouse').addEventListener('click', runHousekeeping)
  for (const b of document.querySelectorAll('.cl-hood-tab')) b.addEventListener('click', () => { hoodTab = b.dataset.tab; paintHood() })
  $('clHood').addEventListener('toggle', () => { if ($('clHood').open) paintHood() })
  $('clArchive').addEventListener('toggle', () => { if ($('clArchive').open) paintArchive() })
  await paintHistory()
  const nProj = state.store.all().filter(p => p.status === 'active' && !p.merged_into).length
  const last = state.settings.cleanup_last_run_asof ? ' Last run ' + fmtDate(state.settings.cleanup_last_run_asof) + '.' : ''
  setStatus('Ready — ' + nProj + ' active projects, ' + state.profiles.all().length + ' profiles, ' + state.instructions.all().filter(i => i.status === 'active').length + ' standing instruction(s).' + last + ' Everything previews; nothing changes until you accept and Apply.', 'ok')
  // ?run=<id>: arrived from the clean-up results bar on another page — show that run's items and
  // mark it seen (the bar already did on click; this covers a link opened directly)
  const qs = new URLSearchParams(window.location.search)
  const runParam = qs.get('run')
  try {
    // ?run=…&all=1 (Prefs "View the last clean-up"): the whole run, decided items included
    const r = await state.core.loadPending(runParam ? { runId: runParam, includeDecided: qs.get('all') === '1' } : {})
    if (r.items.length) { state.view.paint(); setStatus(r.items.length + ' item(s) ' + (runParam ? 'from the scheduled clean-up' : 'still pending from the run of ' + fmtDate(state.core.runInfo && state.core.runInfo.startedAt)) + ' — decide them, or run again.', 'ok') }
  } catch (e) { /* fine */ }
  const lastRun = state.settings.cleanup_last_run
  if (runParam && lastRun && lastRun.run_id === runParam && lastRun.seen === false) {
    state.persist.stampSettingsFields({ cleanup_last_run: { ...lastRun, seen: true, seen_at: Date.now() } }).catch(() => {})
  }
}

init()
