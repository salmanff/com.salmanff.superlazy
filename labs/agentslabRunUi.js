// agentslabRunUi.js — the zero-write run painted with the app's REAL components (user, 2026-09-07:
// "use the existing UI elements to show me the events and the tasks and the projects as you analyse
// each session input"): eventsUi.renderEventCard for the Events feed, expandableProjectView's
// renderExpandableProject for the projects with their task rows, and the real thread viewer
// (emailViewer) opened over the run's in-memory items. Edits made on these live cards (resolve,
// priority…) mutate the run's in-memory stores only — nothing here writes.

import { renderEventCard } from '../pages/eventsUi.js'
import { renderExpandableProject } from '../shared/expandableProjectView.js'
import { configureEmailViewer, openEmailViewer, clearEmailViewerCache } from '../shared/emailViewer.js'
import { createMailContext } from '../shared/viewerContext.js'
import { effImportance } from '../jobs/analyze_thread/dueDates.js'
import { el } from './agentslabUi.js'

const $ = (id) => document.getElementById(id)
const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…' }

export function setRunProgress (text) { $('wlRunProgress').textContent = text || '' }
export function setRunCost (usd, steps) { $('wlRunCost').textContent = usd != null ? '$' + Number(usd).toFixed(4) + (steps ? ' · ' + steps + ' turn' + (steps === 1 ? '' : 's') : '') : '' }

// JSON with long strings cut — for the per-turn "what the model saw / said" details
function jsonBlock (v, cap = 4000) {
  const walk = (x) => {
    if (typeof x === 'string') return x.length > cap ? x.slice(0, cap) + ' …[' + (x.length - cap).toLocaleString() + ' more chars]' : x
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = walk(x[k]); return o }
    return x
  }
  return el('pre', 'wl-pre', JSON.stringify(walk(v), null, 2))
}
const detailsBlock = (label, node) => { const d = el('details', 'wl-run-details'); d.appendChild(el('summary', null, label)); d.appendChild(node); return d }

// ---- the run VIEW: binds the real components to one dry run -------------------------------------------

export function createRunView (run) {
  const store = run.store
  const profiles = run.profiles
  const me = run.me
  const getProject = (id) => store.all().find(p => p.project_id === id) || null
  const projectName = (id) => { const p = getProject(id); return (p && p.name) || id || '' }
  const nameOf = (addr) => {
    const a = String(addr || '').toLowerCase()
    if (!a) return ''
    if (a === me) return 'you'
    const pr = profiles.get && profiles.get(a)
    return (pr && pr.display_name) || addr
  }
  const touched = new Set()
  const now = () => run.items.length ? run.items[Math.min(run.processor.session.processed, run.items.length) - 1]?.date || Date.now() : Date.now()

  // in-memory task handlers: the same buttons work, nothing is written
  const repaint = () => paintBoard()
  const taskHandlers = {
    self: [me],
    nameOf,
    onResolve: (t, p) => { t.status = (t.status === 'open' || t.status === 'in_progress') ? 'resolved' : 'open'; t.resolved_asof = t.status === 'resolved' ? Date.now() : null; touched.add(p.project_id); repaint() },
    onCancel: (t, p) => { t.status = 'cancelled'; touched.add(p.project_id); repaint() },
    onImportance: (t, d, p) => { t.importance = Math.max(1, Math.min(5, (Number(t.importance) || 3) + d)); t.importance_locked = true; touched.add(p.project_id); repaint() },
    onDescChange: (t, p, d) => { t.description = d },
    onEdit: () => {},
    openEmailModal: (t, p, msgId) => {
      const evs = (t.evidence || []).filter(e => e.msg_id)
      const evd = (msgId && evs.find(e => e.msg_id === msgId)) || evs[evs.length - 1]
      if (evd) openEmailViewer({ msg_id: evd.msg_id, thread_id: evd.thread_id, project_id: p && p.project_id })
    },
    onOpenPerson: null
  }

  // the REAL viewer, over the run's memory: bodies from the in-memory items, related items from the
  // run's captured events and in-memory projects
  const mailCtx = createMailContext({
    persist: run.viewerPersist,
    getProjects: () => store.all(),
    getProject,
    getEvents: () => run.captured.events,
    nameOf,
    selfAddrs: () => [me],
    projectName,
    taskHandlers,
    onOpenProject: null,
    onOpenPerson: null,
    onSent: null,
    refresh: repaint,
    getSettings: () => run.settings || null   // so "open in editor" uses the same template here
  })
  clearEmailViewerCache()
  configureEmailViewer({ source: null, persist: run.viewerPersist, context: mailCtx.context })

  const evCtx = {
    nameOf,
    projectName,
    todoShort: (pid, tid) => { const p = getProject(pid); const t = p && (p.todos || []).find(x => x.todo_id === tid); return (t && (t.short_description || t.description)) || '' },
    todoImp: (pid, tid) => { const p = getProject(pid); const t = p && (p.todos || []).find(x => x.todo_id === tid); return t ? effImportance(t) : 0 },
    projectImp: (pid) => { const p = getProject(pid); return (p && Number(p.importance)) || 0 },
    labelName: () => null
  }
  const openFromEvent = (ev) => openEmailViewer({ msg_id: ev.msg_id, thread_id: ev.thread_id, account_id: ev.account_id, subject: ev.subject, snippet: ev.body_snippet })
  const resolveTodo = (pid, tid) => { const p = getProject(pid); const t = p && (p.todos || []).find(x => x.todo_id === tid); return (p && t) ? { todo: t, project: p } : null }

  // ---- events feed: newest first, the real card + a lab-only details row under it ---------------------
  function prependEvent (step) {
    const ev = step.event
    const feed = $('wlFeed')
    const wrap = el('div', 'wl-feed-item')
    if (ev) {
      wrap.appendChild(renderEventCard(ev, evCtx, { onOpenEmail: openFromEvent, onResolveTodo: resolveTodo, drafts: { resolve: () => null }, taskHandlers, onOpenProject: null, getProject }))
    } else {
      wrap.appendChild(el('div', 'wl-card abandoned', 'No event was produced for "' + clip(step.env.subject, 60) + '" — ' + ((step.errorEvent && step.errorEvent.message) || (step.res && step.res.error) || 'analysis failed')))
    }
    const lab = el('div', 'wl-feed-lab')
    lab.appendChild(el('span', 'wl-muted', 'lab: ' + (step.cost ? '$' + Number(step.cost).toFixed(4) : 'no cost') + ' · '))
    if (step.stepEvent && step.stepEvent.output) lab.appendChild(detailsBlock('model output', jsonBlock(step.stepEvent.output)))
    if (step.exchanges && step.exchanges.length) lab.appendChild(detailsBlock('LLM exchange (request as sent, raw reply)', jsonBlock(step.exchanges, 6000)))
    wrap.appendChild(lab)
    feed.insertBefore(wrap, feed.firstChild)
    $('wlRunOut').hidden = false
    for (const c of ((ev && ev.changes) || [])) if (c.project_id) touched.add(c.project_id)
    for (const e of ((ev && ev.todo_edits) || [])) if (e.project_id) touched.add(e.project_id)
  }

  // ---- projects board: the real expandable cards, touched-this-run first and expanded ----------------
  function paintBoard ({ showAll = $('wlShowAll') && $('wlShowAll').checked } = {}) {
    const host = $('wlBoard')
    host.textContent = ''
    const all = store.all().filter(p => !p.merged_into && p.status !== 'archived')
    const list = (showAll ? all : all.filter(p => touched.has(p.project_id) || !run.existingProjectIds.has(p.project_id)))
      .sort((a, b) => (Number(touched.has(b.project_id)) - Number(touched.has(a.project_id))) || ((b.importance || 0) - (a.importance || 0)))
    if (!list.length) { host.appendChild(el('div', 'wl-muted', 'No project touched yet.')); return }
    const asof = now()
    for (const p of list) {
      const isNew = !run.existingProjectIds.has(p.project_id)
      const wrap = el('div', 'wl-board-item' + (isNew ? ' new' : ''))
      if (isNew) wrap.appendChild(el('div', 'wl-board-tag', 'NEW this run'))
      wrap.appendChild(renderExpandableProject(p, {
        ...taskHandlers,
        now: asof,
        startExpanded: true,
        getEvents: () => run.captured.events,
        onOpenEmailEvent: openFromEvent,
        onProjectImportance: (proj, d) => { proj.importance = Math.max(1, Math.min(5, (Number(proj.importance) || 3) + d)); proj.importance_locked = true; repaint() },
        onResolveAll: (proj, opts) => { for (const t of (proj.todos || [])) if ((t.status === 'open' || t.status === 'in_progress') && (!opts || !opts.direction || t.direction === opts.direction)) t.status = 'resolved'; repaint() },
        onEditProject: null,
        onAddTask: null,
        openResponseView: null,
        onDismissResponse: () => {},
        onSaveResponse: () => {},
        onChange: () => {},
        people: () => []
      }))
      host.appendChild(wrap)
    }
  }

  function summaryLine (summary) {
    const events = run.captured.events
    const newProjects = store.all().filter(p => !run.existingProjectIds.has(p.project_id)).length
    const created = events.reduce((n, e) => n + ((e.changes || []).filter(c => c.type === 'created').length), 0)
    const resolved = events.reduce((n, e) => n + ((e.changes || []).filter(c => c.type === 'status' && c.to === 'resolved').length), 0)
    $('wlRunSummary').textContent =
      summary.steps + ' of ' + run.items.length + ' turn item(s) analysed (' + summary.ok + ' ok, ' + summary.failed + ' failed' + (summary.stopped ? ', stopped by you' : '') + (summary.error ? ', run stopped: ' + summary.error : '') + ')' +
      ' · $' + summary.cost.toFixed(4) + ' · ' + created + ' to-do(s) created, ' + resolved + ' resolved · ' + touched.size + ' project(s) touched, ' + newProjects + ' new · ' + events.length + ' event(s) would be written. NOTHING WAS SAVED.'
  }

  return { prependEvent, paintBoard, summaryLine, touched }
}

const clock = (ms) => { try { return new Date(ms).toTimeString().slice(0, 8) } catch (e) { return '' } }
export function paintRunLog (run) {
  const host = $('wlRunLog'); if (!host) return
  host.textContent = ''
  for (const row of run.log) {
    const d = el('div', 'k-' + row.kind, clock(row.at) + '  ' + row.text)
    if (row.detail) d.title = String(row.detail).slice(0, 2000)
    host.appendChild(d)
  }
  $('wlRunLogCount').textContent = '(' + run.log.length + ' line' + (run.log.length === 1 ? '' : 's') + (run.log.some(r => r.kind === 'error') ? ' · has errors' : '') + ')'
  $('wlRunLogBox').hidden = !run.log.length
  host.scrollTop = host.scrollHeight
}
export function paintStopBanner (run) {
  const b = $('wlRunStop'); if (!b) return
  if (!run.summary.error) { b.hidden = true; return }
  b.hidden = false
  b.textContent = 'The run STOPPED' + (run.summary.stoppedAt ? ' at "' + (run.summary.stoppedAt.subject || run.summary.stoppedAt.msg_id) + '"' : '') + ': ' + run.summary.error +
    ' — the pipeline stops the whole run on failures it treats as environmental (provider error, timeout, no credit) so one dead call cannot burn through the queue. "Analyse next turn" retries this turn; "Skip this turn" moves past it; the run log below has the detail.'
}

export function resetRunPanels () {
  $('wlFeed').innerHTML = ''
  $('wlBoard').innerHTML = ''
  $('wlRunSummary').textContent = ''
  $('wlRunOut').hidden = true
  $('wlRunStop').hidden = true
  $('wlRunLog').textContent = ''
  $('wlRunLogBox').hidden = true
}
