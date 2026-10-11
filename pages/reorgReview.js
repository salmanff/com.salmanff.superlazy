// reorgReview.js — "Review this project": the WEEKLY CLEAN-UP restricted to ONE project, opened from
// the project editor (2026-09-26, replacing the separate R1 re-organization prompt of 2026-08-31).
// Same prompt, same operations vocabulary, same review surface (cleanupView) and the same apply path
// (applyProposals, under the audit lock, every change a manual_edit event) as the /cleanup page —
// so the button gains what R1 could not do by design: resolve and cancel to-dos with evidence, from
// the last 30 days of what touched the project. cleanupCore.prepare({ projectId }) does the
// narrowing; this file only hosts it in a modal. Runs on the clean-up model (an advanced model —
// settings.cleanup_model, else the review tier — opus on Claude), never on the per-message analysis model.

import { openModalShell } from '../shared/modalStack.js'
import { div, btn } from '../shared/renderUtils.js'
import { createPersistence } from '../jobs/analyze_thread/persist.js'
import { createProjectStore } from '../jobs/analyze_thread/projectStore.js'
import { createProfileStore } from '../jobs/analyze_thread/profiles.js'
import { createInstructionStore } from '../jobs/analyze_thread/instructionStore.js'
import { createCleanupCore } from '../jobs/analyze_thread/maintenance/cleanupCore.js'
import { createCleanupView } from './cleanupView.js'

// the sections that make sense for one project: no rules / people / learn (they need the whole
// state), no period summary or focus list (they are about the week)
export const PROJECT_REVIEW_SECTIONS = ['attention', 'stale', 'archive', 'split', 'questions']
export const PROJECT_REVIEW_WINDOW_DAYS = 30
// the clean-up model when the user has not chosen one (Setup → Prefs "Clean-up & review model"):
// cleanupCore resolves the review tier (opus on Claude, modelDefaults.js) — the per-message analysis
// model (settings.default_model) is never used here (user, 2026-09-26).
import { resolveDefaultModel, isPicked } from '../jobs/analyze_thread/modelDefaults.js'
const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(3)

/**
 * @param {Object} project        the live project record (the editor's)
 * @param {Object} [o]
 * @param {Function} [o.nameOf]   address → display name
 * @param {Object} [o.taskHandlers]  the page's standard task-row handlers (rows in cards stay live)
 * @param {Function} [o.onChange] called when the modal closes and after an Apply — the page reloads
 * @param {Object} [o.model]      { provider, family } override
 */
export function openProjectReview (project, { nameOf = null, taskHandlers = {}, onChange = null, model = null } = {}) {
  const { modal, close } = openModalShell({ className: 'epv-modal-wide rg-modal', onClose: onChange, guardOutsideClick: true })
  const body = div('rg-body')
  modal.appendChild(body)
  body.appendChild(div('epv-modal-title', 'Review — “' + (project.name || '') + '”'))
  const status = div('rg-status')
  body.appendChild(status)
  const host = div('rg-review')
  body.appendChild(host)
  const foot = div('rg-foot')
  const done = btn('pe-tbtn', 'Done', () => close())
  body.appendChild(foot)
  foot.appendChild(done)
  // busy: a spinner beside the text, the Done button disabled, and a standing warning — the call
  // takes a minute or two on an advanced model and closing the window would lose the run
  const setStatus = (text, cls = 'info') => {
    status.textContent = ''
    if (cls === 'busy') { const sp = document.createElement('span'); sp.className = 'freezr-spinner rg-spinner'; status.appendChild(sp) }
    status.appendChild(document.createTextNode(text))
    if (cls === 'busy') status.appendChild(div('rg-status-note', 'This can take a minute or two — please keep this window open until it finishes.'))
    status.className = 'rg-status rg-status-' + cls
    done.disabled = cls === 'busy'
  }
  setStatus('Loading the project and its last ' + PROJECT_REVIEW_WINDOW_DAYS + ' days…', 'busy')

  run().catch(e => setStatus('The review failed: ' + ((e && e.message) || e), 'error'))

  async function run () {
    const F = typeof freezr !== 'undefined' ? freezr : null
    const persist = createPersistence(F)
    const data = await persist.loadAll()
    const store = createProjectStore(); store.hydrate(data.projects || [])
    const profiles = createProfileStore(); profiles.hydrate(data.profiles || [])
    const instructions = createInstructionStore(); instructions.hydrate(data.instructions || [])
    const settings = data.settings || {}
    const meSet = new Set((settings.your_addresses || []).map(a => String(a).toLowerCase()))
    const nm = nameOf || ((a) => { const p = profiles.get(String(a || '').toLowerCase()); return (p && p.display_name) || null })
    if (!store.get(project.project_id)) throw new Error('this project is not in the store any more')

    const core = createCleanupCore({ freezr: F, persist, store, profiles, instructions, settings, meSet, nameOf: nm })
    const view = createCleanupView(host, {
      core,
      taskHandlers,
      projectName: (id) => { const p = store.get(id); return p ? p.name : id },
      onStatus: setStatus,
      onApplied: () => { if (onChange) onChange() }
    })
    const knobs = { ...core.knobsFromSettings(), windowDays: PROJECT_REVIEW_WINDOW_DAYS, inputMode: 'index', projectId: project.project_id, sections: PROJECT_REVIEW_SECTIONS.slice() }
    const prepared = await core.prepare({ knobs, onStatus: setStatus })
    const picked = [model, settings.cleanup_model].find(isPicked)
    const chosen = picked || await resolveDefaultModel(F, 'review')
    setStatus('Asking ' + (chosen.family || chosen.provider || 'the model') + ' (≈' + Math.round(prepared.sizes.estTokens / 1000) + 'k tokens)… nothing changes until you accept and Apply.', 'busy')
    view.reset()
    const info = await core.run({
      knobs,
      model: chosen,
      onStatus: setStatus,
      onItem: (item) => view.itemArrived(item)
    })
    const n = Object.values(info.counts || {}).reduce((a, b) => a + b, 0)
    view.paint()
    const first = PROJECT_REVIEW_SECTIONS.find(g => core.items.some(i => !i.suppressed && i.group === g))
    if (first && typeof view.select === 'function') view.select(first)
    setStatus(n
      ? n + ' item(s) · ' + fmtMoney(info.cost) + (info.suppressed ? ' · ' + info.suppressed + ' suppressed (ignored earlier)' : '') + ' — accept what you agree with, then Apply.'
      : 'Nothing to propose for this project · ' + fmtMoney(info.cost), info.incomplete ? 'warn' : 'ok')
  }
}

/**
 * The RESULTS of a finished clean-up run, by run id (2026-09-27) — what the results bar opens after a
 * scheduled run. Same review surface and apply path as a live run; the items are the run's pending
 * proposals as stored (decided ones are not re-shown).
 * @param {Object} run   settings.cleanup_last_run — { run_id, finished_at, cost, … }
 * @param {Object} [o]   { taskHandlers, onChange }
 */
export function openCleanupResults (run, { taskHandlers = {}, onChange = null } = {}) {
  const { modal, close } = openModalShell({ className: 'epv-modal-wide rg-modal', onClose: onChange, guardOutsideClick: true })
  const body = div('rg-body')
  modal.appendChild(body)
  const when = (() => { try { return new Date(Number(run.finished_at)).toLocaleString() } catch (e) { return '' } })()
  body.appendChild(div('epv-modal-title', 'Clean-up — ' + when + (Number(run.cost) ? ' · $' + Number(run.cost).toFixed(2) : '')))
  const status = div('rg-status')
  body.appendChild(status)
  const host = div('rg-review')
  body.appendChild(host)
  const foot = div('rg-foot')
  const done = btn('pe-tbtn', 'Done', () => close())
  foot.appendChild(done)
  body.appendChild(foot)
  const setStatus = (text, cls = 'info') => {
    status.textContent = ''
    if (cls === 'busy') { const sp = document.createElement('span'); sp.className = 'freezr-spinner rg-spinner'; status.appendChild(sp) }
    status.appendChild(document.createTextNode(text))
    status.className = 'rg-status rg-status-' + cls
  }
  setStatus('Loading the results…', 'busy')
  ;(async () => {
    const F = typeof freezr !== 'undefined' ? freezr : null
    const persist = createPersistence(F)
    const data = await persist.loadAll()
    const store = createProjectStore(); store.hydrate(data.projects || [])
    const profiles = createProfileStore(); profiles.hydrate(data.profiles || [])
    const instructions = createInstructionStore(); instructions.hydrate(data.instructions || [])
    const settings = data.settings || {}
    const meSet = new Set((settings.your_addresses || []).map(a => String(a).toLowerCase()))
    const nameOf = (a) => { const p = profiles.get(String(a || '').toLowerCase()); return (p && p.display_name) || null }
    const core = createCleanupCore({ freezr: F, persist, store, profiles, instructions, settings, meSet, nameOf })
    const view = createCleanupView(host, {
      core, taskHandlers,
      projectName: (id) => { const p = store.get(id); return p ? p.name : id },
      onStatus: setStatus,
      onApplied: () => { if (onChange) onChange() }
    })
    const r = await core.loadPending({ runId: run.run_id, includeDecided: true })
    view.paint()
    const first = ['attention', 'stale', 'archive', 'merge', 'split', 'people', 'rules', 'learn', 'questions', 'period', 'focus'].find(g => core.items.some(i => !i.suppressed && i.group === g))
    if (first && typeof view.select === 'function') view.select(first)
    setStatus(r.items.length
      ? r.items.length + ' item(s) from this run — accept what you agree with, then Apply. Anything left undecided stays on the Clean-up page.'
      : 'Nothing left to decide from this run.', 'ok')
  })().catch(e => setStatus('Could not load the results: ' + ((e && e.message) || e), 'error'))
}
