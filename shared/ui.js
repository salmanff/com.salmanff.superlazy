// ui.js — DOM rendering for the Part-1 sandbox (v0.3 / item 4). Renders the chronological
// multi-thread replay: a live per-message log, a cumulative PROJECT BOARD (projects own the
// to-dos), and three views — New / needs attention, Projects, To-read. Email content is rendered
// with textContent only (never innerHTML) — bodies are untrusted external content.

import { recomputeImportance as recomputeProjectImp, linkThreadOnRecord, unlinkThreadOnRecord, releaseTodoThreadsOnRecord, threadsOfTodo } from '../jobs/analyze_thread/projectStore.js'
import { renderExpandableProject, defaultEmailModal } from './expandableProjectView.js'
import { openEmailViewer, emailViewerReady } from './emailViewer.js'
import { openModalShell } from './modalStack.js'
import { openProjectEditor } from './projectEditor.js'
import { openProjectReview } from '../pages/reorgReview.js'

// what the one-project review modal needs from the page (2026-09-26): the standard task-row
// handlers, so the rows inside its cards stay live. The shell installs them after load.
let maintenanceContext = {}
export function setMaintenanceContext (ctx) { maintenanceContext = ctx || {} }
import { openTaskEditor } from './taskEditor.js'
import { isDueDated } from '../jobs/analyze_thread/dueDates.js'
import { holdSortKeys } from './taskSort.js'

export const el = (id) => document.getElementById(id)

// keep the latest project snapshot so manual resolve/cancel can re-render the panels
let lastProjects = []
// ...but only renderProjectBoard fills it, and People / Events never call that — they render project
// cards and the project modal directly. So those pages inject their live store instead; without it
// the "move to another project" pickers in the task / project editors opened EMPTY there
// (user, 2026-08-18 — same report as the silently-failing ownership change).
let projectsProvider = null
export function setProjectsProvider (fn) { projectsProvider = fn || null }
const allProjects = () => (projectsProvider ? (projectsProvider() || []) : lastProjects)

export function setStatus (msg, kind = 'info') {
  const s = el('status'); if (!s) return
  s.textContent = msg; s.className = 'status ' + kind
  s.style.display = msg ? '' : 'none' // empty message = no banner
}
export function setCost (total, calls) {
  const c = el('cost'); if (!c) return
  c.textContent = '$' + (total || 0).toFixed(4) + ' · ' + (calls || 0) + ' call' + (calls === 1 ? '' : 's')
}

// ---- live log -----------------------------------------------------------------------
// The RUN LOG only exists on the pages that run the analyser (the shell keeps a hidden #log).
// People, Events and Startup have no #log element, so EVERY log helper must tolerate its absence:
// recordManualEvent logs BEFORE it notifies the page's persistence listener, so one throw here used
// to abort the whole edit — resolving a task on the People page crashed, and a task-editor change
// (e.g. I owe → They owe) failed silently, never saved and never repainted (user, 2026-08-18).
const logHost = () => el('log')
// append to the log if this page has one; otherwise do nothing. Returns whether it landed.
const logAppend = (node, scroll) => {
  const host = logHost()
  if (!host) return false
  host.appendChild(node)
  if (scroll && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' })
  return true
}
export function showPending (text) {
  clearPending()
  const d = document.createElement('div'); d.id = 'pending'; d.className = 'log-pending'
  const sp = document.createElement('span'); sp.className = 'freezr-spinner'; d.appendChild(sp)
  const t = document.createElement('span'); t.textContent = ' ' + text; d.appendChild(t)
  logAppend(d, true)
}
export function clearPending () { const p = el('pending'); if (p) p.remove() }
export function logLine (text, cls) {
  const d = document.createElement('div'); d.className = 'log-line ' + (cls || ''); d.textContent = text
  logAppend(d)
}

// ---- project board (cumulative state) -----------------------------------------------
const DIR_LABEL = { i_owe_them: 'I owe', they_owe_me: 'owed to me', team_owes: 'team owes', read_only: 'to read' }

// Every user change is recorded as a `manual_edit` event — the same unified history the LLM's
// analysis events go in: the `events` collection (manifest app_tables) plus a muted log line. Context (sender/owner/direction) is
// denormalised so future learning ("user always downgrades Joe") needs no state reconstruction.
const manualEvents = []
export function getManualEvents () { return manualEvents.slice() }
// A page can subscribe to manual edits (e.g. to persist the touched project + the event).
let manualEventListener = null
export function setManualEventListener (fn) { manualEventListener = fn || null }
function recordManualEvent (ev, label) {
  // A coalesced burst re-fires per keystroke-batch so the persisted record (upserted on
  // manual_id) always reflects the LATEST values — but there is only ever ONE decision, so the
  // in-memory mirror replaces rather than appends. Listeners that keep their own copy must do
  // the same (see events.js's live feed).
  const at = ev.manual_id ? manualEvents.findIndex(e => e.manual_id === ev.manual_id) : -1
  if (at >= 0) manualEvents[at] = ev; else manualEvents.push(ev)
  logLine('✍️ ' + label + '  (recorded)', 'muted')
  if (manualEventListener) { try { manualEventListener(ev) } catch (e) { console.error('manual-event listener failed', e) } }
}
const clampImp = (n) => Math.max(1, Math.min(5, Math.round(n)))

// ---- MANUAL EDIT COALESCING ----------------------------------------------------------------
// A person rephrasing a description ten times, or nudging a priority 3→4→5, made ONE decision,
// not ten. Within COALESCE_MS of the last manual change to a to-do, further changes fold into
// the SAME evidence entry and — per field — the SAME event record (upserted on the stable
// manual_id that persist.addEvent honours), so `before` stays the value the burst STARTED from
// and `after` tracks the latest. The window slides off the last edit, so one long bout of
// fiddling is one record; coming back an hour later is a new one.
const COALESCE_MS = 60000
const manualWindows = new Map() // todo_id -> { at, seq, net: Map<field, {before, after}>, ev }

function todoWindow (todo) {
  const now = Date.now()
  let w = manualWindows.get(todo.todo_id)
  if (!w || now - w.at > COALESCE_MS) {
    w = { at: now, seq: now.toString(36) + Math.random().toString(36).slice(2, 5), net: new Map(), ev: null }
    manualWindows.set(todo.todo_id, w)
  }
  w.at = now
  return w
}

// How each field reads in a history line. `c` is the NET change of the burst, so a 3→4→5 nudge
// says "priority 3→5" — what the user actually did, not how many keystrokes it took.
const EDIT_VERB = {
  short_description: () => 'renamed it',
  description: () => 'edited the details',
  importance: (c) => 'priority ' + (c.before || '?') + '→' + (c.after || '?'),
  due_hint: (c) => (c.after ? 'set due “' + c.after + '”' : 'cleared the due date'),
  due_demote: (c) => (c.after ? 'set it to run −' + c.after + ' priority until due' : 'removed the until-due priority hold'),
  direction: (c) => 'set it to “' + (DIR_LABEL[c.after] || c.after) + '”',
  owner: (c) => (c.after ? 'set owner to ' + c.after : 'cleared the owner'),
  counterparty: (c) => (c.after ? 'set it as for ' + c.after : 'cleared who it is for'),
  status: (c) => (c.after === 'open' ? 'reopened it' : (c.after === 'cancelled' ? 'cancelled it' : 'resolved it')),
  importance_locked: (c) => (String(c.after) === 'true' ? 'locked the priority' : 'handed the priority back to SuperLazy')
}
const sameVal = (a, b) => String(a == null ? '' : a) === String(b == null ? '' : b)

// ONE manual change to ONE field of a to-do: folded into the burst's single evidence entry and
// its own upserted event. Every manual to-do mutation that is a FIELD edit goes through here
// (status / priority / text / due / direction / who); one-shot ACTIONS with their own story
// (bulk resolve, move, merge, add) keep their bespoke records below.
function recordTodoChange (project, todo, field, before, after) {
  const w = todoWindow(todo)
  const now = w.at
  const prev = w.net.get(field)
  w.net.set(field, { before: prev ? prev.before : (before != null ? before : null), after: after != null ? after : null })

  const parts = []
  for (const [f, c] of w.net) {
    if (sameVal(c.before, c.after)) continue // nudged and put back — nothing to say about it
    parts.push((EDIT_VERB[f] || (() => 'edited ' + f))(c))
  }
  const reason = 'you ' + (parts.length ? parts.join(', ') : 'changed it back to how it was')
  const changed = [...w.net].map(([f, c]) => ({ field: f, from: c.before, to: c.after }))

  if (!Array.isArray(todo.evidence)) todo.evidence = []
  if (!w.ev || !todo.evidence.includes(w.ev)) {
    // first change of the burst — or the todo object was replaced under us by a page reload
    w.ev = { type: 'manual', source: 'manual', thread_id: null, msg_id: null, asof: now, reason, who: 'you', changed }
    todo.evidence.push(w.ev)
  } else {
    w.ev.asof = now
    w.ev.reason = reason
    w.ev.changed = changed
  }
  // the to-do's comparable version across writers (projectMerge.touchOf reads both)
  todo.edited_asof = now

  const net = w.net.get(field)
  recordManualEvent({
    type: 'manual_edit',
    source: 'manual',
    asof: now,
    field,
    target: 'todo',
    todo_id: todo.todo_id,
    project_id: project && project.project_id,
    before: net.before,
    after: net.after,
    // stable within the burst — persist.addEvent upserts on it, so ten edits are one record
    manual_id: todo.todo_id + '_' + w.seq + '_' + field,
    context: { sender: todo.sender, owner: todo.owner, direction: todo.direction }
  }, reason + ' on “' + (todo.short_description || '') + '”')
}

// Manual user action on a to-do (checkbox / cancel). Mutates the live store object; the evidence
// entry + event come from recordTodoChange, so a resolve→reopen→resolve fiddle is one record.
// read_only "resolves" when read.
function manualSetStatus (todo, status, project) {
  const reopening = status === 'open'
  const before = todo.status
  todo.status = reopening ? 'open' : status
  todo.resolved_asof = reopening ? null : Date.now()
  recomputeProjectImp(project)
  recordTodoChange(project, todo, 'status', before, todo.status)
}

// "✓ resolve all" / "✕ cancel all": every open task at once — or, with opts.direction, just one
// bucket's ("resolve all Read"). Recorded as ONE manual event carrying the list of changes, so the
// events feed shows a single "You resolved N to-dos" entry with the tasks, not N separate events.
// opts.status picks the outcome: 'resolved' (done) or 'cancelled' (never going to happen).
const BULK_VERB = { resolved: 'resolved', cancelled: 'cancelled' }
function resolveAllTodos (project, { direction = null, status = 'resolved' } = {}) {
  const to = BULK_VERB[status] ? status : 'resolved'
  const verb = BULK_VERB[to]
  const now = Date.now()
  const open = (project.todos || [])
    .filter(t => t.status === 'open' || t.status === 'in_progress')
    .filter(t => !direction || t.direction === direction)
  if (!open.length) return
  const changes = []
  for (const t of open) {
    changes.push({ type: 'status', project_id: project.project_id, todo_id: t.todo_id, short: t.short_description || t.description || '', from: t.status, to })
    t.status = to
    t.resolved_asof = now
    t.evidence = Array.isArray(t.evidence) ? t.evidence.slice() : []
    t.evidence.push({ type: 'manual', source: 'manual', thread_id: null, msg_id: null, asof: now, reason: 'user ' + verb + ' (' + verb + ' all' + (direction ? ': ' + direction : '') + ')', who: 'you', changed: [{ field: 'status', from: 'open', to }] })
  }
  recomputeProjectImp(project)
  const bucket = direction ? (DIR_LABEL[direction] || direction) : null
  recordManualEvent(
    { type: 'manual_edit', source: 'manual', asof: now, field: 'status', target: 'bulk', project_id: project.project_id, direction: direction || null, before: 'open', after: to, count: changes.length, changes },
    verb + ' all ' + changes.length + (bucket ? ' “' + bucket + '”' : '') + ' open to-do(s) in “' + (project.name || '') + '”')
}

// DELETE a project outright, tasks and all — the one destructive action in the app, and the only
// one with no undo, so the modal that offers it asks first. The page's injected deleter does the
// removing (it owns the store + the durable record); we record the manual_edit event AFTER, so
// the event listener finds no project to re-save behind us. The project's EVENTS stay in the log:
// they are the history of what happened, which deleting the project does not un-happen.
async function deleteProjectOutright (project) {
  if (!project || !projectDeleter) return false
  const name = project.name || project.project_id
  const n = (project.todos || []).length
  await projectDeleter(project)
  const openCard = openProjectModals.get(project.project_id)
  if (openCard) openCard() // the card behind the editor is about a project that no longer exists
  recordManualEvent(
    { type: 'manual_edit', source: 'manual', asof: Date.now(), field: 'deleted', target: 'project', project_id: project.project_id, before: name, after: null, count: n },
    'deleted the project “' + name + '”' + (n ? ' and its ' + n + ' to-do(s)' : ''))
  return true
}

// Merge one project into another: every task and draft moves to the target; the source is
// tagged merged_into (hidden from boards and pickers, kept as history) and ONE manual event
// carries the moved-task list. The listener saves BOTH projects (project_id + project_id_2).
function mergeProject (source, target) {
  if (!source || !target || source === target || source.project_id === target.project_id) return
  const now = Date.now()
  const changes = []
  target.todos = target.todos || []
  for (const t of (source.todos || [])) {
    t.project_id = target.project_id
    t.evidence = Array.isArray(t.evidence) ? t.evidence.slice() : []
    t.evidence.push({ type: 'manual', source: 'manual', thread_id: null, msg_id: null, asof: now, action: 'project_merge', reason: 'merged from “' + (source.name || '') + '” into “' + (target.name || '') + '”', who: 'you' })
    target.todos.push(t)
    changes.push({ type: 'moved', project_id: target.project_id, todo_id: t.todo_id, short: t.short_description || t.description || '' })
  }
  source.todos = []
  target.responses = target.responses || []
  for (const r of (source.responses || [])) { r.project_id = target.project_id; target.responses.push(r) }
  source.responses = []
  // the threads move too: linked on the target, tombstoned on the retired source (projectStore)
  for (const tid of (source.thread_ids || []).slice()) { linkThreadOnRecord(target, tid); unlinkThreadOnRecord(source, tid) }
  source.merged_into = target.project_id
  recomputeProjectImp(source); recomputeProjectImp(target)
  target.last_active_asof = Math.max(Number(target.last_active_asof) || 0, now)
  recordManualEvent(
    { type: 'manual_edit', source: 'manual', asof: now, field: 'merged', target: 'project', project_id: target.project_id, project_id_2: source.project_id, before: source.name || source.project_id, after: target.name || target.project_id, count: changes.length, changes },
    'merged “' + (source.name || '') + '” into “' + (target.name || '') + '” (' + changes.length + ' to-do(s))')
}

// User bumped a to-do's priority. Sets it, LOCKS it (so the model won't silently override next
// step), re-derives the project's importance, and records the manual_edit event.
function setTodoImportance (todo, delta, project) {
  const before = todo.importance || 3
  const after = clampImp(before + delta)
  if (after === before) return
  // FREEZE this row's sort keys first (taskSort.js): re-pricing a task must not make it jump
  // out from under the cursor. Every list keeps the order it had until the user asks for a new
  // one from the sort control (user, 2026-08-31).
  holdSortKeys(todo)
  todo.importance = after
  todo.importance_locked = true
  recomputeProjectImp(project)
  recordTodoChange(project, todo, 'importance', before, after)
}

// Hand the priority back to the model. ALWAYS unlocks (that is the substance of it — the model
// may set this field again); and where we have the model's own last value it restores that too.
// A to-do the analyzer hasn't touched since llm_importance existed has nothing to restore TO, so
// the number stays and only the lock goes — without that case the offer would be invisible on
// every pre-existing task, which is not a feature (user, 2026-08-21).
// Returns the priority now in force, or null when the task was never user-locked.
function revertTodoImportance (project, todo) {
  if (!todo || !todo.importance_locked) return null
  holdSortKeys(todo) // same rule as every other priority change: don't re-sort under the user
  const target = Number(todo.llm_importance) || null
  const before = todo.importance
  todo.importance_locked = false
  // both changes land in ONE evidence entry (recordTodoChange coalesces), reading e.g.
  // "you handed the priority back to SuperLazy, priority 5→3"
  recordTodoChange(project, todo, 'importance_locked', true, false)
  if (target && target !== before) {
    todo.importance = target
    recomputeProjectImp(project)
    recordTodoChange(project, todo, 'importance', before, target)
    return target
  }
  return before
}

// User bumped a project's priority. Sets + LOCKS it (recompute won't clobber) and records it.
function setProjectImportance (project, delta) {
  setProjectImportanceTo(project, (project.importance || 3) + delta)
}

// Absolute variant (the project editor's 1–5 buttons).
function setProjectImportanceTo (project, value) {
  const before = project.importance || 3
  const after = clampImp(value)
  if (after === before) return
  project.importance = after
  project.importance_locked = true
  recordManualEvent(
    { type: 'manual_edit', source: 'manual', asof: Date.now(), field: 'importance', target: 'project', project_id: project.project_id, before, after },
    'project “' + project.name + '” importance ' + before + ' → ' + after)
}

// Project editor's "Auto": unlock the project priority so it follows its open to-dos again.
// Recorded as an importance edit (before → the computed value) flagged auto: true.
function revertProjectImportance (project) {
  if (!project || !project.importance_locked) return
  const before = project.importance || 3
  project.importance_locked = false
  recomputeProjectImp(project)
  const after = project.importance
  recordManualEvent(
    { type: 'manual_edit', source: 'manual', asof: Date.now(), field: 'importance', auto: true, target: 'project', project_id: project.project_id, before, after },
    'project “' + project.name + '” importance back to auto (' + before + ' → ' + after + ')')
}

// User renamed a project (project editor).
function renameProject (project, name) {
  const before = project.name || ''
  const after = String(name || '').trim()
  if (!after || after === before) return
  project.name = after
  recordManualEvent(
    { type: 'manual_edit', source: 'manual', asof: Date.now(), field: 'name', target: 'project', project_id: project.project_id, before, after },
    'renamed project “' + before + '” → “' + after + '”')
}

// User edited the project's description (the summary — the project's memory). Same contract as
// renameProject: apply in place, record ONE manual_edit event (before/after travel on it).
function editProjectSummary (project, text) {
  const before = project.summary || ''
  const after = String(text || '').trim()
  if (after === before) return
  project.summary = after
  recordManualEvent(
    { type: 'manual_edit', source: 'manual', asof: Date.now(), field: 'summary', target: 'project', project_id: project.project_id, before, after },
    'edited the description of “' + (project.name || project.project_id) + '”')
}

// User edited a task's fields (project / task editor): one manual_edit event per changed field.
// direction = the "who owes" bucket; owner (they_owe_me / team_owes) and counterparty
// (i_owe_them) are the person slots the task editor's Who field writes.
const TODO_EDITABLE = ['short_description', 'description', 'importance', 'due_hint', 'due_demote', 'direction', 'owner', 'counterparty']
// machine companions of due_hint (ISO due window) — updated silently, no event noise; they
// always travel with a due_hint change, whose event drives persistence. `owners` (the joint-
// owner list behind a comma-separated Who) travels the same way with its `owner` change.
const TODO_SILENT = ['due_earliest', 'due_latest', 'owners']
function editTodo (project, todo, fields) {
  for (const k of TODO_SILENT) if (k in fields) todo[k] = fields[k] || null
  let reRate = false // the project's auto priority reads each to-do's EFFECTIVE priority
  for (const k of TODO_EDITABLE) {
    if (!(k in fields)) continue
    let after = fields[k]
    if (k === 'importance') after = clampImp(after)
    const before = todo[k] != null ? todo[k] : null
    if (sameVal(after, before)) continue
    // priority (and the until-due hold that scales it) changes the row's SORT KEY — freeze it
    // first so the list behind the editor keeps its order (taskSort.js; same rule as the row's
    // ▴/▾ arrows)
    if (k === 'importance' || k === 'due_demote') holdSortKeys(todo)
    todo[k] = after
    if (k === 'importance') todo.importance_locked = true
    // priority, the until-due hold, and the due window (which switches the hold on/off) all move it
    if (k === 'importance' || k === 'due_demote' || k === 'due_hint') reRate = true
    // text / due / direction / who edits now leave the same evidence trail priorities always
    // did — without it a rename was invisible in the task's own history (and, worse, left the
    // record looking OLDER than it was to projectMerge.touchOf)
    recordTodoChange(project, todo, k, before, after)
  }
  if (reRate) recomputeProjectImp(project)
}

// User moved a task to another project (project editor). Mutates BOTH live projects; the
// manual_edit event carries project_id (target) AND project_id_2 (source) so the page's
// listener persists both records.
function moveTodo (source, target, todo) {
  if (!source || !target || source === target) return
  const i = (source.todos || []).indexOf(todo)
  if (i < 0) return
  const now = Date.now()
  source.todos.splice(i, 1)
  // its threads go with it: released from the source unless another to-do there still cites
  // them, linked on the target (projectStore record helpers — the same rule the job applies)
  releaseTodoThreadsOnRecord(source, todo)
  for (const tid of threadsOfTodo(todo)) linkThreadOnRecord(target, tid)
  target.todos = target.todos || []
  target.todos.push(todo)
  todo.project_id = target.project_id
  todo.evidence = Array.isArray(todo.evidence) ? todo.evidence.slice() : []
  todo.evidence.push({ type: 'manual', source: 'manual', thread_id: null, msg_id: null, asof: now, reason: 'moved from “' + (source.name || '') + '” to “' + (target.name || '') + '”', who: 'you' })
  recomputeProjectImp(source)
  recomputeProjectImp(target)
  target.last_active_asof = Math.max(Number(target.last_active_asof) || 0, now)
  recordManualEvent(
    { type: 'manual_edit', source: 'manual', asof: now, field: 'project', target: 'todo', todo_id: todo.todo_id, project_id: target.project_id, project_id_2: source.project_id, before: source.project_id, after: target.project_id, context: { sender: todo.sender, owner: todo.owner, direction: todo.direction } },
    'moved “' + (todo.short_description || '') + '” to “' + (target.name || '') + '”')
}

// The shared task ops for pages that render task rows OUTSIDE the board (Recent / People):
// the exact same mutations + manual_edit recording the dashboard rows use — persistence flows
// through the page's manual-event listener either way.
export const taskOps = {
  toggleResolve: (todo, project) => manualSetStatus(todo, (todo.status === 'open' || todo.status === 'in_progress') ? 'resolved' : 'open', project),
  cancel: (todo, project) => manualSetStatus(todo, 'cancelled', project),
  setImportance: (todo, delta, project) => setTodoImportance(todo, delta, project),
  // ticking a sub-task checkbox rewrites ONE checklist line of the description (subTasks.js) —
  // same editTodo path as the editor, so it records a manual_edit and persists like any edit
  setDescription: (todo, project, description) => editTodo(project, todo, { description })
}

// The ops behind the task editor (rename / due / move-or-create-project / revert-to-the-model's
// -priority) — same manual_edit
// recording as everything else; pages pass these to openTaskEditor along with their live
// projects list. createProject needs the page's setProjectCreator to be wired.
export const taskEditOps = {
  editTodo: (project, todo, fields) => editTodo(project, todo, fields),
  moveTodo: (source, target, todo) => moveTodo(source, target, todo),
  createProject: (name) => createProjectManually(name),
  revertImportance: (project, todo) => revertTodoImportance(project, todo)
}

// The per-bucket bulk ops behind a tab's "✓ resolve all N" / "✕ cancel all N".
// opts: { direction — the bucket, or null for the whole project; status — 'resolved' | 'cancelled' }
export const projectBulkOps = {
  setAll: (project, opts) => resolveAllTodos(project, opts)
}

// PROJECT-level ops for hosts that create a project outright ("+ Add Project" on the dashboard),
// rather than as a side effect of moving a task. Same manual_edit recording as everything else,
// plus a direct save so the record lands even on pages with no manual-event listener.
export const projectOps = {
  create: (name, importance) => {
    const p = createProjectManually(name)
    if (!p) return null
    if (importance) setProjectImportanceTo(p, importance)
    saveProjectRecord(p)
    return p
  }
}

// A page injects how to open the PERSON editor (it owns the profile store + persistence).
let personEditorOpener = null
export function setPersonEditorOpener (fn) { personEditorOpener = fn || null }

// A page injects how to CREATE a project (it owns the project store) — used by the editor's
// "move to a new project". Returns the live project object.
let projectCreator = null
export function setProjectCreator (fn) { projectCreator = fn || null }

// A page injects HOW TO REPAINT ITSELF. Every card edit already repaints the CARD, and most also
// raise a manual_edit event the page listens for — but the card lives in a modal over a page whose
// own lists must not go stale behind it, and several card actions (adding a task, dismissing or
// editing a suggested reply) are not a to-do FIELD edit and so raise no such event at all. Adding
// a task in a project modal opened from the Tasks page left the list behind it stale for exactly
// that reason (user, 2026-09-01). boardHandlers.onChange calls this.
let hostRepaint = null
export function setHostRepaint (fn) { hostRepaint = fn || null }
const repaintHost = () => { if (hostRepaint) { try { hostRepaint() } catch (e) { console.error('host repaint failed', e) } } }

// A page injects how to DELETE a project (it owns the store and the durable record) — used by
// the project editor's "Delete project". Async: it removes the record as well as the object.
let projectDeleter = null
export function setProjectDeleter (fn) { projectDeleter = fn || null }

// A page injects how to mint a todo id (the store owns the counter) — used by "+ Add" on cards.
let todoMinter = null
export function setTodoMinter (fn) { todoMinter = fn || null }

// The "+ Add" tab on a project card: build a hand-made todo, wire the who-field to the right
// slot for the direction, and record the manual_edit event (the listener persists the project).
function addTaskManually (project, fields) {
  const now = Date.now()
  const dir = ['i_owe_them', 'they_owe_me', 'team_owes', 'read_only'].includes(fields.direction) ? fields.direction : 'i_owe_them'
  const todo = {
    // a USER-minted id (unique by construction) — never the analyzer's per-store sequence, which
    // two writers can hand to two different tasks (see projectMerge.js)
    todo_id: (todoMinter && todoMinter()) || ('t_u_' + now.toString(36) + Math.random().toString(36).slice(2, 5)),
    project_id: project.project_id,
    direction: dir,
    short_description: fields.short_description || '',
    description: fields.description || '',
    sender: null,
    owner: (dir === 'they_owe_me' || dir === 'team_owes') ? (fields.who || null) : null,
    owners: [],
    counterparty: dir === 'i_owe_them' ? (fields.who || null) : null,
    importance: clampImp(fields.importance || 3),
    importance_locked: true, // you set it — the model may not override
    status: 'open',
    evidence: [{ type: 'manual', source: 'manual', thread_id: null, msg_id: null, asof: now, reason: 'added by you', who: 'you' }],
    evidence_msg_id: null,
    due_hint: fields.due_hint || null,
    change_reason: 'added by hand',
    due_earliest: fields.due_earliest || null,
    due_latest: fields.due_latest || null,
    // the ⏲ "lower until due" hold, if the add form set one — user-only, the model never sets it
    due_demote: fields.due_demote || null,
    created_asof: now,
    resolved_asof: null
  }
  project.todos = project.todos || []
  project.todos.push(todo)
  recomputeProjectImp(project)
  project.last_active_asof = Math.max(Number(project.last_active_asof) || 0, now)
  recordManualEvent(
    { type: 'manual_edit', source: 'manual', asof: now, field: 'created', target: 'todo', todo_id: todo.todo_id, project_id: project.project_id, before: null, after: todo.short_description, context: { direction: dir, owner: todo.owner } },
    'added “' + todo.short_description + '”')
  return todo
}
function createProjectManually (name) {
  if (!projectCreator) return null
  const p = projectCreator(String(name || '').trim() || 'Untitled project')
  if (p) {
    if (!lastProjects.includes(p)) lastProjects.push(p)
    recordManualEvent(
      { type: 'manual_edit', source: 'manual', asof: Date.now(), field: 'created', target: 'project', project_id: p.project_id, before: null, after: p.name },
      'created project “' + p.name + '”')
  }
  return p
}

// (setFullEmailFetcher / fetchFullEmail are gone with responseFullView — the standard email
// viewer does its own stored-first body loading, with the live mail source as fallback.)

// the user's own address(es) — hidden from a project's people line
let selfAddrs = []
export function setSelfAddresses (arr) { selfAddrs = (arr || []).map(a => String(a).toLowerCase()) }
// hide resolved/cancelled items on the board (the shared filter-bar toggle)
let hideResolvedFlag = false
export function setHideResolved (v) { hideResolvedFlag = !!v }
// hide OTHERS' tasks: only your I-owe items show, and projects where you owe nothing are hidden
let onlyMineFlag = false
export function setOnlyMine (v) { onlyMineFlag = !!v }
// hide NOT-DUE tasks: tasks whose due window clearly starts in the future are hidden; a task
// with NO due date counts as due and stays (nothing says it can wait)
let hideNotDueFlag = false
export function setHideNotDue (v) { hideNotDueFlag = !!v }
// address → display name (from the profile store), so the people line can show names
let nameLookup = null
export function setNameLookup (fn) { nameLookup = fn || null }
// the known-people list ([{ address, name }]) — the task editor's Who autocomplete. Injected by
// the page (it owns the profile records), like the projects provider.
let peopleProvider = null
export function setPeopleProvider (fn) { peopleProvider = fn || null }
const knownPeople = () => (peopleProvider ? peopleProvider() : []) || []
// the events log (newest first) — the project card's Messages tab reads the mail behind the
// project from it. Injected by the page (each page loads/windows its own copy); cards rendered
// without one (the test pages) simply don't show the tab.
let eventsProvider = null
export function setEventsProvider (fn) { eventsProvider = fn || null }
// the project card's Messages tab's DEEP fetch: (project) => Promise<events[]> — the loaded log
// plus the project's own older message events from the database (appStore.loadProjectEvents).
// Optional: without it the tab shows the loaded log only.
let projectEventsLoader = null
export function setProjectEventsLoader (fn) { projectEventsLoader = fn || null }
// the page's draft handlers (viewerContext draftHandlers: evLikeFor / sendState / onSend / onEdit /
// onDismiss) — with them, a card's suggested reply is the full draft block with Send + composer
let draftHandlersRef = null
export function setDraftHandlers (h) { draftHandlersRef = h || null }
// persist ONE project record. Needed for changes that are not to-do edits and so raise no manual
// event: dismissing or editing a suggested reply. Without it those changes lived in memory only
// and every dismissed draft came back on the next load (user, 2026-08-17).
let projectSaver = null
export function setProjectSaver (fn) { projectSaver = fn || null }
const saveProjectRecord = (p) => { if (projectSaver && p) projectSaver(p) }

// opts for the to-do email modal: (when a mail source is configured via
// emailViewer.configureEmailViewer) opening the FULL email + thread.
const todoModalOpts = () => ({
  openFullEmail: emailViewerReady()
    ? (ev) => openEmailViewer({ msg_id: ev.msg_id, thread_id: ev.thread_id })
    : null
})

// ✉ on a task row — THE one behavior, everywhere: straight into the full email viewer on the
// task's latest email evidence (or the SPECIFIC message when the caller names one — e.g. a
// project-card Events line). The old intermediary defaultEmailModal survives only as the
// fallback when a page has no viewer configured (or the task has no email at all).
export function openTaskEmail (todo, project, msgId) {
  const evs = (todo.evidence || []).filter(e => e.msg_id)
  const evd = (msgId && evs.find(e => e.msg_id === msgId)) ||
    evs.reduce((best, e) => (!best || (Number(e.asof) || 0) >= (Number(best.asof) || 0)) ? e : best, null)
  if (evd && emailViewerReady()) {
    // opened FROM this project: the viewer's sidebar shows only its items (a chat chunk can
    // touch several projects — the header still names them all)
    // no specific message asked for → land on the NEWEST message of that thread, even one that
    // touched no task (the ✉ beside a task's ✏️ — user, 2026-09-27: "go to the latest message")
    openEmailViewer({ msg_id: evd.msg_id, thread_id: evd.thread_id, project_id: project && project.project_id, prefer_latest: !msgId })
    return
  }
  defaultEmailModal(todo, project, todoModalOpts())
}

const boardHandlers = {
  now: 0,
  openEmailModal: (todo, project, msgId) => openTaskEmail(todo, project, msgId),
  // △ on a task row → the task editor (rename / due / ownership / move project). `extra.onChange`
  // is the CARD's repaint (epv wires it): an ownership or project change must show immediately.
  onEdit: (todo, project, extra) => openTaskEditor(todo, project, {
    projects: () => allProjects(),
    self: selfAddrs,
    people: knownPeople,
    ops: taskEditOps,
    onChange: () => { if (extra && extra.onChange) extra.onChange() }
  }),
  // "Full view" on a suggested reply → THE standard email modal on the thread it answers. The
  // draft is pinned and pre-selected there (emailViewer showDraft), with the real Send.
  openResponseView: (r, project) => {
    const t = r && r.todo_id && (project.todos || []).find(x => x.todo_id === r.todo_id)
    if (t) openTaskEmail(t, project)
  },
  // a draft dismissed / edited on a card: no to-do changed, so persist the project directly
  onDismissResponse: (r, project) => saveProjectRecord(project),
  onSaveResponse: (r, project) => saveProjectRecord(project),
  onResolve: (todo, project) => manualSetStatus(todo, (todo.status === 'open' || todo.status === 'in_progress') ? 'resolved' : 'open', project),
  onCancel: (todo, project) => manualSetStatus(todo, 'cancelled', project),
  onImportance: (todo, delta, project) => setTodoImportance(todo, delta, project),
  // a sub-task checkbox ticked on a row (taskRowEl slide-open description) — persists but does
  // NOT repaint: the row updates itself in place so the open panel survives the tick
  onDescChange: (todo, project, description) => editTodo(project, todo, { description }),
  onProjectImportance: (project, delta) => setProjectImportance(project, delta),
  // "✓ resolve all" (whole project, or one bucket via opts.direction) — ONE bulk event carrying
  // the resolved-task list, not N separate events
  onResolveAll: (project, opts) => resolveAllTodos(project, opts),
  // △ at the end of the project name → the project editor modal (rename / priority / merge).
  // `after` repaints the card behind the modal on every change. It no longer lists the project's
  // tasks: the card behind it already does, better (user, 2026-08-21).
  onEditProject: (project, after) => openProjectEditor(project, {
    projects: () => allProjects(),
    nameOf: (a) => nameLookup && nameLookup(a),
    onOpenPerson: (address) => personEditorOpener && personEditorOpener(address),
    // deleteProject is offered ONLY when the page wired a deleter — on pages that did not, the
    // modal simply shows no Delete button rather than a button that quietly does nothing
    ops: {
      renameProject,
      editProjectSummary,
      setProjectImportanceTo,
      revertProjectImportance,
      mergeProject,
      deleteProject: projectDeleter ? deleteProjectOutright : null,
      // The one-project review (specs/superlazy-weekly-cleanup.md §10.2): the re-org review modal applies through the
      // SAME ops user edits use, so every accepted proposal records a manual_edit event and
      // persists via the page's manual-event listener. createProject needs the page's
      // projectCreator (the shell wires it) — the modal degrades honestly without it.
      // "Review this project": the weekly clean-up restricted to this project (reorgReview.js) —
      // its proposals apply through applyProposals under the audit lock, like the /cleanup page
      proposeReorg: (p) => openProjectReview(p, {
        nameOf: (a) => nameLookup && nameLookup(a),
        taskHandlers: maintenanceContext.taskHandlers || {},
        onChange: () => { if (after) after() }
      })
    },
    onChange: () => { if (after) after() }
  }),
  // person chips on an expanded card → the person editor (page injects the opener: it owns
  // the profile store + persistence)
  onOpenPerson: (address) => personEditorOpener && personEditorOpener(address),
  // the "+ Add" tab on the card
  onAddTask: (project, fields) => addTaskManually(project, fields),
  // known people ([{ address, name }]) — the add tab's Who autocomplete (same source as the
  // task editor's)
  people: knownPeople,
  // ANY change made on a card: refresh the host page's own lists (setHostRepaint) — a card in a
  // modal must never leave the page behind it stale
  onChange: () => { repaintHost() }
}

// Does a project still pass the board-level hide filters? Used at render time AND by live
// cards after an edit — a resolve that empties the project animates the card away.
const isLiveTodo = (t) => t.status === 'open' || t.status === 'in_progress'
function projectStillVisible (p) {
  if (!p || p.merged_into) return false
  if (!hideResolvedFlag && !onlyMineFlag && !hideNotDueFlag) return true
  // ONE task must pass ALL the active filters TOGETHER — testing each filter against a
  // different task kept ghost projects alive with zero visible rows
  return (p.todos || []).some(t => isLiveTodo(t) &&
    (!onlyMineFlag || t.direction === 'i_owe_them') &&
    (!hideNotDueFlag || isDueDated(t)))
}

// Render the expandable project cards (collapsed base by default) into a host element.
// Merged-away projects never render; with Hide-resolved on, fully-resolved projects (no open
// tasks) drop off the board; with Hide-not-mine on, projects where YOU owe nothing drop off —
// the explicit project MODAL (noCollapse) always shows its one.
// Hide-not-mine is a PROJECT-level cut and nothing more: a project that survives it renders every
// bucket (Team / Owed / Read included — they are the context for what you owe). `onlyMine` reaches
// the card only so it opens on YOUR bucket first (epv defaultTab).
export function renderExpandableInto (host, projects, handlers, now) {
  const sorted = [...(projects || [])]
    .filter(p => p && (handlers.noCollapse ? !p.merged_into : projectStillVisible(p)))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0))
  if (!sorted.length) { const e = document.createElement('div'); e.className = 'tb-empty'; e.textContent = 'No projects yet.'; host.appendChild(e); return }
  for (const p of sorted) {
    host.appendChild(renderExpandableProject(p, {
      ...handlers,
      now,
      self: selfAddrs,
      nameOf: nameLookup,
      hideResolved: hideResolvedFlag,
      onlyMine: onlyMineFlag,
      hideNotDue: hideNotDueFlag,
      // the Messages tab: the mail behind the project, from the page-injected events log; its
      // rows open the full email + thread in the shared viewer
      getEvents: eventsProvider,
      loadProjectEvents: projectEventsLoader,
      // frozen snapshot cards (transient) never send
      drafts: handlers.transient ? null : draftHandlersRef,
      onOpenEmailEvent: (ev) => {
        if (!emailViewerReady()) return
        openEmailViewer({ msg_id: ev.msg_id, thread_id: ev.thread_id, account_id: ev.account_id, subject: ev.subject, snippet: ev.body_snippet })
      },
      // board cards animate away when an edit drops them below the filters; the modal never does
      stillVisible: handlers.noCollapse ? null : projectStillVisible
    }))
  }
}

// Render full LIVE project cards into any host (e.g. the People page's shared-projects panel) —
// the exact dashboard element, wired to the same board handlers.
export function renderProjectCardsInto (host, projects, { startExpanded = false } = {}) {
  host.textContent = ''
  const now = (projects || []).reduce((m, p) => Math.max(m, Number(p.last_active_asof) || 0), 0)
  renderExpandableInto(host, projects || [], startExpanded ? { ...boardHandlers, startExpanded: true } : boardHandlers, now)
}

export function renderProjectBoard (projects, applied, { startExpanded = false } = {}) {
  lastProjects = projects || []
  const host = el('board'); if (!host) return
  host.textContent = ''
  // "today" in a replay = the frontier of processed activity (the most recent last_active_asof)
  const now = lastProjects.reduce((m, p) => Math.max(m, Number(p.last_active_asof) || 0), 0)
  renderExpandableInto(host, lastProjects, startExpanded ? { ...boardHandlers, startExpanded: true } : boardHandlers, now)
}

// project_id -> close(), for every project modal currently on screen (see openProjectModal)
const openProjectModals = new Map()

// Open ONE project in a full-screen modal — the same LIVE interactive card as the board
// (resolve, priorities, suggested replies, emails). Uses the stacked modal shell, so the email
// viewer / task modal / reply view open ON TOP of it. onClose lets the host page repaint its
// lists to reflect edits made inside.
export function openProjectModal (project, { onClose = null, startTab = null } = {}) {
  if (!project) return
  const { modal, close } = openModalShell({
    className: 'epv-modal-proj',
    onClose: () => { openProjectModals.delete(project.project_id); if (onClose) onClose() }
  })
  // remembered so a project DELETED from the editor stacked on top of this card takes the card
  // with it, instead of leaving a live-looking modal for a project that no longer exists
  openProjectModals.set(project.project_id, close)
  const host = document.createElement('div'); host.className = 'epv-modal-proj-host'
  modal.appendChild(host)
  // startTab: which tab the card opens on ('add' for a freshly created project)
  renderExpandableInto(host, [project], { ...boardHandlers, noCollapse: true, startTab }, Number(project.last_active_asof) || 0)
}
