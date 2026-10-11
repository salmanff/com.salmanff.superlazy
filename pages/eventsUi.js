// eventsUi.js — DOM rendering for the events page: the reverse-chronological feed grouped by day,
// one Mac-Mail-style row per event: bold sender · (mail folders · LLM cost · time · kind icon)
// right-aligned, subject on the second line, the model's one-line summary (or "auto-processed")
// under it, then the live task rows the event raised, in a thin frame. Text-only (textContent) —
// subjects, senders, and task text are untrusted content.

import { eventClock } from './eventsData.js'
import { taskChip, projectChip, doneMark, taskRowEl, kindDisc, renderDraft, chatTitle, repoOfWorkItem, projectWithRepo, parseSearch, repoQueryMatches, reposOfProject } from '../shared/renderUtils.js'
import { effortLine } from '../jobs/analyze_thread/sessionDigest.js'
import { equivalentCost } from '../shared/eqPricing.js'

// HOUSEKEEPING kinds: internal upkeep with no message of their own (a cache write, a project
// coherence flag). They are shown — spend must be auditable — but labelled as internal rather
// than rendered as mail with no sender. Kinds that DO carry a person (reprofile, autofile_*)
// keep that identity; the test below is "no sender at all", so it also covers future kinds.
export const SYSTEM_KINDS = new Set(['cache_refresh'])
// NB the "no sender at all" catch-all must not swallow YOUR OWN edits — a manual_edit record has
// neither from_address nor msg_id either, and it is the opposite of an internal upkeep row.
const isHousekeeping = (ev) => !!ev && ev.kind !== 'manual_edit' &&
  (SYSTEM_KINDS.has(ev.kind) || (!ev.from_address && !ev.msg_id))
// SuperLazy's own actions, whether or not they name a person: housekeeping plus the re-profiles.
// These count as "auto-processed" for the hide filter (user: housekeeping should disappear with
// it) and always rank priority 1 — real and auditable, never urgent.
export const isSystemAction = (ev) => isHousekeeping(ev) || (!!ev && ev.kind === 'reprofile')

// A CLEAN-UP change: the weekly clean-up (jobs/analyze_thread/maintenance/applyProposals.js) records
// every accepted proposal as a manual_edit — same unified history — but stamped source 'maintenance'.
// The model proposed it and the user only accepted, so it is NOT one of the user's own edits: the
// To-dos page's "since last night" digest was listing these as "you resolved …" (user, 2026-10-04).
export const isMaintenanceEdit = (ev) => !!ev && ev.kind === 'manual_edit' &&
  (ev.source === 'maintenance' || ev.source_id === 'maintenance')
// YOUR edit: a manual_edit you made by hand (board, task editor, viewer, clean-up page rows).
export const isManualEdit = (ev) => !!ev && ev.kind === 'manual_edit' && !isMaintenanceEdit(ev)
// WHO did it — the three states an event can be in, exhaustive and mutually exclusive, so three
// filter buttons cover every row (user, 2026-09-12). ONE definition for every page:
//   'manual'    ✍️  YOU edited it by hand
//   'auto'      ⚙  the standing automation filed it without a read, or SuperLazy's housekeeping
//   'superlazy' ⬠  SuperLazy itself: an analysed message, an auto-file decision, a clean-up change
// "Auto" covers housekeeping too (user: those should disappear with that filter). The auto-file
// decisions (autofile_learned / autofile_mismatch) stay OUT of 'auto' — they are the events that
// let the user counter automation, so filtering auto-processed must never swallow them.
export function eventWho (ev) {
  if (isManualEdit(ev)) return 'manual'
  if (isAutoProcessed(ev) || isSystemAction(ev)) return 'auto'
  return 'superlazy'
}

// AUTO-PROCESSED: handled without an LLM read of THIS message. Setup (bootstrap) qualifies — the
// whole window was read in one pass, so its rows carry no per-message analysis.
const AUTO_KINDS = new Set(['workflow_short_circuit', 'mail_action', 'skipped', 'bootstrap'])
export const isAutoProcessed = (ev) => !!ev && (AUTO_KINDS.has(ev.kind) || ev.via_workflow === 'bootstrap')
// The AUTO-FILE family: mail filed WITHOUT being read, plus the standing decisions about it. These
// rank by the PROJECT they were filed into (see eventImportance) — a newsletter landing in
// "Promotions" is a 1 and must vanish under a "4+" filter. NOT part of isAutoProcessed: these are
// the events that let the user counter automation, so "hide auto-processed" must never hide them.
const AUTOFILE_KINDS = new Set(['autofile_learned', 'autofile_mismatch', 'autofile_off'])
export const isAutoFileDecision = (ev) => !!ev && AUTOFILE_KINDS.has(ev.kind)
// ...but autofile_OFF is excluded from the project-priority rule: nothing was filed (the sender's
// mail is being analysed again from now on), so it keeps its own stamped rank.
const FILED_KINDS = new Set(['workflow_short_circuit', 'skipped', 'autofile_learned', 'autofile_mismatch'])

// WHERE this event filed its mail: the event's own project, else the first project its changes
// touched. Auto-processed rows use it for both their priority and their project pill.
export function filedProjectId (ev) {
  if (!ev) return null
  if (ev.project_id) return ev.project_id
  const c = (ev.changes || []).find(c => c.project_id)
  return (c && c.project_id) || null
}

// ---- the event's PRIORITY — what the min-priority filter tests -----------------------------
// EVERY event ranks, so every event can be filtered out. In order:
//   auto-filed mail + the auto-file decisions about it → the priority of the PROJECT it landed in
//     (falling back to the item it filed). These used to default to 3, and an auto-file decision
//     was deliberately stamped 4, so newsletters and admin updates survived every filter.
//   system actions (cache writes, drift notes, re-profiles) → 1.
//   your manual edits → the priority of the task (or project) you edited.
//   analysed mail → the highest-priority task it touched; `ev.importance`, stamped at write time
//     by the job, wins when there is one.
// ctx supplies the live lookups (eventsData): todoImp(project_id, todo_id), projectImp(project_id).
export function eventImportance (ev, ctx) {
  const projImp = (id) => (ctx.projectImp && Number(ctx.projectImp(id))) || 0
  const todoImp = (pid, tid) => (ctx.todoImp && Number(ctx.todoImp(pid, tid))) || 0
  const changeImp = () => (ev.changes || []).reduce((m, c) => Math.max(m, todoImp(c.project_id, c.todo_id)), 0)
  if (isSystemAction(ev)) return 1
  if (FILED_KINDS.has(ev.kind)) return projImp(filedProjectId(ev)) || changeImp() || 1
  if (ev.kind === 'manual_edit') return todoImp(ev.project_id, ev.todo_id) || projImp(ev.project_id) || 1
  if (ev.importance) return Number(ev.importance)
  return changeImp() || 3
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const p2 = (x) => String(x).padStart(2, '0')
const dayKey = (ms) => { const n = Number(ms); if (!n) return ''; try { return new Date(n).toISOString().slice(0, 10) } catch (e) { return '' } }
function dayLabel (ms) {
  const n = Number(ms); if (!n) return 'Unknown date'
  const d = new Date(n)
  return DAYS[d.getUTCDay()] + ' ' + p2(d.getUTCDate()) + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear()
}
const timeOf = (ms) => { const n = Number(ms); if (!n) return '—'; const d = new Date(n); return p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) }

const KIND_META = {
  message: { glyph: '📧', cls: 'ev-kind-message', label: 'analysed' },
  workflow_short_circuit: { glyph: '⚙', cls: 'ev-kind-auto', label: 'auto-processed' },
  mail_action: { glyph: '📮', cls: 'ev-kind-auto', label: 'mail action' },
  skipped: { glyph: '⏭', cls: 'ev-kind-auto', label: 'skipped' },
  manual_edit: { glyph: '✍️', cls: 'ev-kind-manual', label: 'your edit' },
  reprofile: { glyph: '👤', cls: 'ev-kind-auto', label: 're-profiled' },
  autofile_learned: { glyph: '⚙', cls: 'ev-kind-auto', label: 'auto-file set' },
  autofile_mismatch: { glyph: '⚠', cls: 'ev-kind-auto', label: 'auto-file check' },
  autofile_off: { glyph: '⚙', cls: 'ev-kind-auto', label: 'auto-file off' },
  cache_refresh: { glyph: '⚙', cls: 'ev-kind-auto', label: 'housekeeping' },
  bootstrap: { glyph: '⚙', cls: 'ev-kind-auto', label: 'set-up' }
}
const CLEANUP_META = { glyph: '🧹', cls: 'ev-kind-manual', label: 'clean-up change (accepted by you)' }
const kindMeta = (ev) => isMaintenanceEdit(ev) ? CLEANUP_META : (KIND_META[ev.kind] || { glyph: '•', cls: 'ev-kind-message', label: ev.kind || 'event' })
const CHANGE_GLYPH = { created: '＋', status: '→', moved: '⇄', absorbed: '⤵', rejected: '✗' }

// ---- filtering ------------------------------------------------------------------------

// The event search — used by the Events view and the Tasks page's Messages tab. Goes through
// renderUtils.parseSearch like every other page (this was the one matcher that did not, so a
// repo query here fell through to a plain text match and showed unrelated mail — 2026-09-11).
// A repo query matches through the event's OWN repo (an agent turn) or the repos of the project(s)
// it touched — ctx.getProject is optional; without it only the event's own repo counts.
// The repo(s) ONE event belongs to: its own (an agent turn carries repo_name / a cc: thread id)
// plus the repos of every project it touched. Shared by the search and by the filter bar's repo
// cut, so "#freezrPrivate" and the # button agree on what an event's repo is.
export function reposOfEvent (ev, ctx) {
  const own = repoOfWorkItem(ev)
  const pids = [...new Set([ev.project_id, ...((ev.changes || []).map(c => c.project_id))].filter(Boolean))]
  const projRepos = (ctx && typeof ctx.getProject === 'function')
    ? pids.flatMap(pid => reposOfProject(ctx.getProject(pid) || {}))
    : []
  return own ? [own, ...projRepos] : projRepos
}

export function matchesSearch (ev, q, ctx) {
  if (!q) return true
  const sq = parseSearch(q)
  const repos = reposOfEvent(ev, ctx)
  if (sq.repo !== null) return repoQueryMatches(repos, sq.repo)
  const hay = [
    ev.subject, ev.from_address, ev.via_workflow, ev.error, ev.summary, ev.address, ev.category,
    ctx.nameOf(ev.from_address),
    ...((ev.changes || []).map(c => (c.short || '') + ' ' + ctx.projectName(c.project_id))),
    ev.kind === 'manual_edit' ? (ctx.todoShort(ev.project_id, ev.todo_id) + ' ' + ctx.projectName(ev.project_id)) : '',
    ...repos.flatMap(r => [r.name, r.slug])   // the repo is on the card, so it is searchable
  ].filter(Boolean).join(' ').toLowerCase()
  return hay.includes(sq.needle)
}

// ---- one event card -------------------------------------------------------------------

function badge (text, cls) {
  const s = document.createElement('span'); s.className = 'badge ' + (cls || ''); s.textContent = text; return s
}

// one-line clamp with press-to-expand (mobile-friendly; long subjects/summaries stay one row)
function clampable (el, title) {
  el.classList.add('ev-clamp')
  el.title = title || 'Press to expand'
  el.addEventListener('click', () => el.classList.toggle('ev-open'))
  return el
}

function manualSummary (ev, ctx) {
  // who the sentence is about: you, or the clean-up you accepted (isMaintenanceEdit)
  const You = isMaintenanceEdit(ev) ? 'The clean-up' : 'You'
  // bulk "✓ resolve all" — one event carrying the whole list (rendered below the line). ev.direction
  // is set when only ONE bucket was cleared ("resolve all Read")
  if (ev.target === 'bulk' && ev.field === 'status') {
    const n = Number(ev.count) || (ev.changes || []).length
    const DIR = { i_owe_them: 'I owe', they_owe_me: 'owed to me', team_owes: 'team owes', read_only: 'to read' }
    const bucket = ev.direction ? ' “' + (DIR[ev.direction] || ev.direction) + '”' : ''
    return You + ' resolved ' + n + bucket + ' to-do' + (n === 1 ? '' : 's') + ' in “' + ctx.projectName(ev.project_id) + '”'
  }
  if (ev.field === 'merged') {
    const n = Number(ev.count) || (ev.changes || []).length
    return You + ' merged “' + (ev.before || '?') + '” into “' + (ev.after || '?') + '”' + (n ? ' (' + n + ' to-do' + (n === 1 ? '' : 's') + ')' : '')
  }
  const short = ctx.todoShort(ev.project_id, ev.todo_id)
  const what = ev.target === 'project' ? ('project “' + ctx.projectName(ev.project_id) + '”') : ('“' + (short || ev.todo_id || 'item') + '”')
  if (ev.field === 'direction') {
    const DIR = { i_owe_them: 'I owe', they_owe_me: 'Owed to me', team_owes: 'Team owes', read_only: 'To read' }
    return You + ' changed ownership of ' + what + ': ' + (DIR[ev.before] || ev.before || '?') + ' → ' + (DIR[ev.after] || ev.after || '?')
  }
  if (ev.field === 'status') return You + ' set ' + what + ' ' + (ev.before || '?') + ' → ' + (ev.after || '?')
  if (ev.field === 'importance' && ev.auto) return You + ' set the priority of ' + what + ' back to auto (' + (ev.before || '?') + ' → ' + (ev.after || '?') + ')'
  if (ev.field === 'importance') return You + ' set the priority of ' + what + ' ' + (ev.before || '?') + ' → ' + (ev.after || '?')
  return You + ' edited ' + (ev.field || '?') + ' on ' + what + ': ' + (ev.before || '?') + ' → ' + (ev.after || '?')
}

// "· now open" — appended to a manual card's summary line when the edited value has changed AGAIN
// since this edit. The summary line stays the immutable record of what happened then; this whisper
// (and the live row below) shows the present, so old cards never read as lying.
const SINCE_DIR = { i_owe_them: 'I owe', they_owe_me: 'owed to me', team_owes: 'team owes', read_only: 'to read' }
function sinceNote (ev, { onResolveTodo, getProject } = {}) {
  if (ev.after == null || ev.target === 'bulk') return null
  let current
  if (ev.target === 'todo' && ev.todo_id) {
    const ent = onResolveTodo && onResolveTodo(ev.project_id, ev.todo_id)
    if (!ent) return null
    current = { status: ent.todo.status, importance: ent.todo.importance, direction: ent.todo.direction }[ev.field]
  } else if (ev.target === 'project' && ev.project_id) {
    const proj = getProject && getProject(ev.project_id)
    if (!proj) return null
    current = { name: proj.name, importance: proj.importance }[ev.field]
  }
  if (current == null || String(current) === String(ev.after)) return null
  const s = document.createElement('span'); s.className = 'ev-since'
  s.textContent = ' · now ' + (SINCE_DIR[current] || current)
  s.title = 'Changed again after this edit — this is the current value'
  return s
}

// ---- a SINGLE manual edit's target, rendered live (bulk events carry `changes` instead) ----
// todo edits → THE standard task row: its checkbox undoes a resolve, △ opens the task editor,
// and the project pill opens the project modal — acting on the PRESENT, same as bulk cards.
// project edits (rename / priority / created / merge) → the project chip → project modal.
// Falls back to a dead typed chip when the todo no longer exists.
// The repo an EVENT happened in, as a one-item list for projectWithRepo. Agent work only: a mail
// or Slack event has no repo, so the pillbox renders exactly as before.
const evRepos = (ev) => { const r = repoOfWorkItem(ev); return r ? [r] : [] }

function manualEditBlock (ev, ctx, { onResolveTodo, taskHandlers, onOpenProject, getProject } = {}) {
  if (ev.target === 'todo' && ev.todo_id) {
    const ul = document.createElement('ul'); ul.className = 'ev-changes'
    const li = document.createElement('li'); li.className = 'ev-change'
    const ent = onResolveTodo && onResolveTodo(ev.project_id, ev.todo_id)
    if (ent) {
      li.classList.add('ev-change-live')
      li.appendChild(taskRowEl(ent.todo, ent.project, taskHandlers || {}, {
        projectName: ent.project.name,
        onOpenProject,
        showDirection: true // an event's tasks are whatever that email touched — mixed directions
      }))
    } else {
      const short = (ctx.todoShort && ctx.todoShort(ev.project_id, ev.todo_id)) || '(to-do no longer exists)'
      li.appendChild(taskChip(short, (ctx.todoImp && ctx.todoImp(ev.project_id, ev.todo_id)) || 3))
      if (ev.project_id) li.appendChild(projectWithRepo(ctx.projectName(ev.project_id), null, evRepos(ev)))
    }
    ul.appendChild(li)
    return ul
  }
  if (ev.target === 'project' && ev.project_id && onOpenProject) {
    const proj = getProject && getProject(ev.project_id)
    if (!proj) return null
    const wrap = document.createElement('div'); wrap.className = 'ev-manual-target'
    wrap.appendChild(projectChip(proj.name || ev.project_id, () => onOpenProject(proj), { title: 'Open the project to re-edit' }))
    return wrap
  }
  return null
}

// The MAIL CLIENT's own folders/labels for this message (ev.labels, stored at analysis time) —
// NOT the projects it filed into. Gmail system labels are prettified, noise labels hidden, and
// user-created label ids resolved to their names via ctx.labelName (best-effort, from
// listFolders); unresolvable machine ids are skipped rather than shown raw.
const SYS_FOLDER = {
  INBOX: 'Inbox',
  SPAM: 'Spam',
  TRASH: 'Trash',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_FORUMS: 'Forums'
}
const HIDE_LABELS = new Set(['UNREAD', 'IMPORTANT', 'STARRED', 'SENT', 'DRAFT', 'CHAT', 'CATEGORY_PERSONAL'])
function mailFolders (ev, ctx) {
  const out = []
  for (const id of (ev.labels || [])) {
    const key = String(id)
    if (HIDE_LABELS.has(key)) continue
    let name = SYS_FOLDER[key]
    if (!name) name = ctx.labelName && ctx.labelName(ev.account_id, key)
    // future non-Gmail providers may hand us the folder NAME directly — show it as-is; skip
    // anything that still looks like a machine id
    if (!name && !/^Label_/i.test(key) && key !== key.toUpperCase()) name = key
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

// ---- the task changes an event raised — live task rows / inline drafts / typed-chip
// fallbacks, in the thin frame. Shared by message events AND bulk manual events (resolve-all,
// merge — their `changes` list uses the same shape). Returns the <ul> or null when every entry
// was skipped (stale/sent drafts). --------------------------------------------------------
function changesBlock (ev, ctx, { onResolveTodo, drafts, taskHandlers, onOpenProject } = {}) {
  const changes = ev.changes || []
  if (!changes.length) return null
  const ul = document.createElement('ul'); ul.className = 'ev-changes'
  let lastProj = null // one project chip per RUN of changes, not one per line
  let rendered = 0
  for (const c of changes) {
    const li = document.createElement('li'); li.className = 'ev-change ev-change-' + c.type
    // a SUGGESTED-REPLY DRAFT (not a task — the change's "todo_id" is a response_id).
    // A still-RELEVANT draft (nobody replied since, task still open) renders inline with a
    // real Send. Stale / sent / dismissed drafts — and reminders, which already live on their
    // task row's due hint — show nothing at all.
    if (c.type === 'response' || c.type === 'response_updated' || /^reply: /.test(String(c.short || ''))) {
      const ent = drafts && drafts.resolve && c.todo_id && drafts.resolve(c.project_id, c.todo_id)
      const r = ent && ent.response
      if (!r || r.kind === 'reminder' || r.status === 'sent' || r.status === 'dismissed') continue
      if (drafts.isStale && drafts.isStale(ev, r)) continue
      li.className = 'ev-change ev-change-draft'
      li.appendChild(renderDraft(ev, ent, ctx, drafts))
      lastProj = c.project_id || lastProj
      ul.appendChild(li); rendered++
      continue
    }
    // the LIVE todo, when the page provides a resolver: render THE standard task row —
    // resolve / cancel / priority work right here, same as everywhere else
    const ent = onResolveTodo && c.todo_id && onResolveTodo(c.project_id, c.todo_id)
    if (ent) {
      li.classList.add('ev-change-live')
      li.appendChild(taskRowEl(ent.todo, ent.project, taskHandlers || {}, {
        projectName: c.project_id !== lastProj ? ent.project.name : null,
        onOpenProject,
        showDirection: true // an event's tasks are whatever that email touched — mixed directions
      }))
      lastProj = c.project_id || lastProj
      ul.appendChild(li); rendered++
      continue
    }
    const imp = (ctx.todoImp && ctx.todoImp(c.project_id, c.todo_id)) || 3
    const short = c.short || c.todo_id || '(untitled to-do)'
    // leading mark: ＋ created · done-mark resolved · → other transitions · ✗ rejected
    if (c.type === 'status' && c.to === 'resolved') li.appendChild(doneMark('resolved by this message'))
    else li.appendChild(document.createTextNode(CHANGE_GLYPH[c.type] || '•'))
    // the task itself as a typed reference (the todo no longer exists to act on)
    li.appendChild(taskChip(short, imp))
    // any transition detail as plain text after the chip
    if (c.type === 'status' && c.to !== 'resolved') li.appendChild(document.createTextNode((c.from || '?') + ' → ' + (c.to || '?')))
    else if (c.type === 'moved') li.appendChild(document.createTextNode('moved'))
    else if (c.type === 'absorbed') li.appendChild(document.createTextNode('this message was folded into it'))
    else if (c.type === 'rejected') li.appendChild(document.createTextNode('rejected — ' + (c.note || '')))
    if (c.project_id && c.project_id !== lastProj) li.appendChild(projectWithRepo(ctx.projectName(c.project_id), null, evRepos(ev)))
    lastProj = c.project_id || lastProj
    ul.appendChild(li); rendered++
  }
  // every change may have been skipped (stale/sent drafts) — no empty frame then
  if (!rendered) return null
  // show at most 3 up front — "+ N more" reveals the rest in place (no repaint)
  const MAX = 3
  if (rendered > MAX) {
    const items = [...ul.children]
    for (let i = MAX; i < items.length; i++) items[i].style.display = 'none'
    const more = document.createElement('li'); more.className = 'ev-change ev-change-more'
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ev-more-changes'
    b.textContent = '+ ' + (rendered - MAX) + ' more'
    b.addEventListener('click', () => {
      for (let i = MAX; i < items.length; i++) items[i].style.display = ''
      more.remove()
    })
    more.appendChild(b)
    ul.appendChild(more)
  }
  return ul
}

// The "filed to" row an auto-processed event shows INSTEAD of task rows: the same two controls a
// task row carries — the project pill (where this mail landed) and the △ change button. The △ opens
// the sender's person card, which owns BOTH counters ("Off — always analyse every message" and
// picking a different project), so the two one-off buttons it replaces are gone.
// Returns null when there is nothing to point at.
function filedRow (ev, ctx, { getProject, onOpenProject, taskHandlers } = {}) {
  const pid = filedProjectId(ev)
  const proj = (getProject && pid) ? getProject(pid) : null
  const name = (proj && proj.name) || ev.target_name || (pid && ctx.projectName ? ctx.projectName(pid) : null)
  const addr = ev.address || ev.from_address || null
  const canEdit = !!(addr && String(addr).includes('@') && taskHandlers && taskHandlers.onOpenPerson)
  if (!name && !canEdit) return null
  const wrap = document.createElement('div'); wrap.className = 'ev-filed'
  const lbl = document.createElement('span'); lbl.className = 'ev-filed-lbl'; lbl.textContent = 'filed to'
  wrap.appendChild(lbl)
  if (name) {
    wrap.appendChild(projectWithRepo(name, (proj && onOpenProject) ? () => onOpenProject(proj) : null, evRepos(ev)))
  }
  if (canEdit) {
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'task-editbtn'; b.textContent = '✏️'
    b.title = 'Change how mail from ' + addr + ' is handled — file it elsewhere, or stop auto-filing it'
    b.addEventListener('click', (e) => { e.stopPropagation(); taskHandlers.onOpenPerson(addr) })
    wrap.appendChild(b)
  }
  return wrap
}

// opts: { onOpenEmail(ev), onResolveTodo(project_id, todo_id) => { todo, project } | null,
//         drafts (host handlers — see renderUtils.renderDraft),
//         taskHandlers (the standard row handlers), onOpenProject(project),
//         getProject(project_id) => the live project (the auto-filed pill needs it) }
export function renderEventCard (ev, ctx, { onOpenEmail, onResolveTodo, drafts, taskHandlers, onOpenProject, getProject } = {}) {
  const km = kindMeta(ev)
  const manual = ev.kind === 'manual_edit'
  // "auto" = handled without an LLM read of THIS message on its own (see isAutoProcessed) — such
  // rows carry no per-message analysis and must not be shown with the "no to-do changes" line that
  // implies one was made. The auto-file decisions and housekeeping read the same way.
  const auto = isAutoProcessed(ev) || isAutoFileDecision(ev) || isSystemAction(ev)
  const card = document.createElement('div'); card.className = 'ev-card ' + km.cls + (ev.error ? ' ev-card-error' : '')
  // a manual edit made on this page moments ago (events.js stamps _fresh on insertion): flash so
  // the eye finds the new card — its live row is the undo. Time-boxed, so repaints stop replaying.
  if (ev._fresh && Date.now() - ev._fresh < 2500) card.classList.add('ev-card-fresh')
  const main = document.createElement('div'); main.className = 'ev-main'

  // ---- line 1: bold sender left · folders + time + kind icon right ----
  const top = document.createElement('div'); top.className = 'ev-topline'
  const from = document.createElement('span'); from.className = 'ev-from'
  if (manual && isMaintenanceEdit(ev)) {
    // a clean-up change you accepted — SuperLazy's proposal, not your hand (isMaintenanceEdit)
    from.textContent = 'Clean-up on Superlazy'
    from.title = 'Proposed by the weekly clean-up and accepted by you' + (ev.maintenance_run_id ? ' (run ' + ev.maintenance_run_id + ')' : '')
  } else if (manual) {
    from.textContent = 'You on Superlazy'
  } else if (isHousekeeping(ev)) {
    // Housekeeping rows have no sender by nature (a cache write, a profile rewrite, a project
    // coherence flag) — they used to render as "(unknown sender)", which read like a bug.
    from.textContent = 'SuperLazy housekeeping'
    from.title = 'Internal upkeep (' + ev.kind + ') — no email involved'
  } else if (ev.channel === 'notes') {
    // a manual note: the "sender" is the user themselves — say what it is instead
    from.textContent = 'Your note'
    if (ev.from_address) from.title = ev.from_address
  } else if (ev.channel === 'messages') {
    // a chat chunk: the CONVERSATION is the identity, not the (first) author — "Slack DM: A, B"
    // or "#channel" (chatTitle also prettifies machine names on records captured before member
    // resolution). The subject line below is skipped for these — this IS the subject.
    from.textContent = '💬 ' + (chatTitle(ev.subject) || 'Slack')
    if (ev.from_address) from.title = 'chunk starts with ' + ev.from_address
  } else if (ev.channel === 'work') {
    // an agent-session turn: the SESSION (its title) is the identity; the subject line is skipped
    const wRepo = repoOfWorkItem(ev)
    from.textContent = '🤖 ' + (ev.agent_name || 'AI agent') + ' · ' + (ev.subject || 'session')
    from.title = 'a turn of a session with ' + (ev.agent_name || 'an AI agent') + ' (you prompted, the agent answered)' +
      (wRepo ? ' in ' + wRepo.slug + (wRepo.branch ? ' (branch ' + wRepo.branch + ')' : '') : '') +
      (ev.work_stats ? ' — ' + effortLine(ev.work_stats) : '')
  } else {
    const name = ctx.nameOf(ev.from_address)
    from.textContent = name || ev.from_address || '(unknown sender)'
    if (name && ev.from_address) from.title = ev.from_address
  }
  top.appendChild(from)

  const right = document.createElement('span'); right.className = 'ev-topright'
  const folders = manual ? [] : mailFolders(ev, ctx)
  if (folders.length) {
    const fw = document.createElement('span'); fw.className = 'ev-folders'
    for (const nm of folders) {
      const f = document.createElement('span')
      f.className = 'ev-folder'; f.textContent = nm; f.title = 'Mail folder: ' + nm
      fw.appendChild(f)
    }
    right.appendChild(fw)
  }
  // the cost slot: what the LLM run cost — or, for auto-processed mail, the ⚙ mark instead.
  // The tooltip carries the full per-message accounting (engine.js spendSummary, persisted on the
  // event): time, tokens and how many calls it took, so an expensive message can be explained.
  // A $0 event that still spent tokens ran on a local subscription connector (ClaudeLocal / CodexLocal):
  // show what the same tokens would have cost via the API, marked "eq" — never as an actual charge.
  const eq = (!Number(ev.cost) && ev.tokens && ev.model && (Number(ev.tokens.total) || Number(ev.tokens.input) || Number(ev.tokens.cache_read)))
    ? equivalentCost(ev.tokens, { model: ev.model })
    : null
  if (Number(ev.cost) || eq) {
    const actual = Number(ev.cost) || 0
    const c = document.createElement('span'); c.className = 'ev-cost' + (eq ? ' ev-cost-eq' : '')
    c.textContent = '$' + (actual || eq.cost).toFixed(4) + (eq ? ' eq' : '')
    const tk = ev.tokens || null
    const parts = [actual
      ? 'LLM cost of analysing this message: $' + actual.toFixed(4)
      : 'EQUIVALENT cost — this ran on a $0 local connector; the same tokens priced as ' + eq.priced_as + ' via the API: $' + eq.cost.toFixed(4)]
    if (ev.duration_ms != null) parts.push('took ' + (Number(ev.duration_ms) / 1000).toFixed(1) + 's')
    if (tk && tk.total) {
      parts.push((Number(tk.total) || 0).toLocaleString() + ' tokens (' +
        (Number(tk.input) || 0).toLocaleString() + ' in / ' + (Number(tk.output) || 0).toLocaleString() + ' out)')
    }
    if (Number(ev.llm_calls) > 1) parts.push(ev.llm_calls + ' LLM calls')
    if (Number(ev.cost_reprofiles)) parts.push('incl. $' + Number(ev.cost_reprofiles).toFixed(4) + ' re-profiling people')
    if (ev.model) parts.push(ev.model)
    c.title = parts.join(' · ')
    right.appendChild(c)
  } else if (auto) {
    const g = document.createElement('span'); g.className = 'ev-auto-mark'
    g.textContent = '⚙'; g.title = 'auto-processed without the LLM'
    right.appendChild(g)
  }
  const tm = document.createElement('span'); tm.className = 'ev-time'; tm.textContent = timeOf(eventClock(ev))
  right.appendChild(tm)
  // rightmost: the email icon (manual items get the hand; only failure keeps a tint)
  const disc = kindDisc(manual ? 'manual' : (ev.error ? 'error' : 'message'))
  if (!manual && onOpenEmail && ev.msg_id && ev.thread_id) {
    disc.classList.add('ev-disc-btn')
    disc.title = ev.channel === 'messages' ? 'Open the conversation' : ev.channel === 'work' ? 'Open the session dialogue' : 'Open the full email and its thread'
    disc.addEventListener('click', () => onOpenEmail(ev))
  }
  right.appendChild(disc)
  top.appendChild(right)
  main.appendChild(top)

  if (manual) {
    // ---- line 2 (manual): what you did (immutable record, with a "· now …" whisper when the
    // value changed again since), then the live target: bulk events (resolve-all, merge) carry
    // the affected-task list; single edits render the SAME live task row / project chip — its
    // controls (checkbox, △, pill) are how you undo or re-edit from here ----
    const line = document.createElement('div'); line.className = 'ev-manual-line'; line.textContent = manualSummary(ev, ctx)
    const since = sinceNote(ev, { onResolveTodo, getProject })
    if (since) line.appendChild(since)
    main.appendChild(clampable(line))
    const mcb = changesBlock(ev, ctx, { onResolveTodo, drafts, taskHandlers, onOpenProject }) ||
      manualEditBlock(ev, ctx, { onResolveTodo, taskHandlers, onOpenProject, getProject })
    if (mcb) main.appendChild(mcb)
    card.appendChild(main)
    return card
  }

  // ---- line 2: the subject — one line, press to expand (the ✉ icon opens the email).
  // Chat chunks SKIP it: their conversation title already fills line 1, and a chunk has no
  // subject of its own — repeating the title read as a bug (user, 2026-08-30).
  const titledByFrom = ev.channel === 'messages' || ev.channel === 'work'
  if (!titledByFrom || ev.error) {
    const subjLine = document.createElement('div'); subjLine.className = 'ev-subjline'
    if (!titledByFrom) {
      const subj = document.createElement('span'); subj.className = 'ev-subj'
      subj.textContent = (ev.channel === 'notes' ? '📝 ' : '') + (ev.subject || (ev.channel === 'notes' ? '(untitled note)' : '(no subject)'))
      clampable(subj, 'Press to expand — the ✉ icon opens the email')
      subjLine.appendChild(subj)
    }
    // one pill only: failure. Everything else the row already says — the change lines show what
    // landed on whom (an ☑️-direction taskChip IS "new for me").
    if (ev.error) subjLine.appendChild(badge('FAILED', 'badge-error'))
    // …and one exception: a standing instruction that actually shaped this analysis. The whole
    // point of asking the model to cite them is that the user can SEE which of their instructions
    // are doing work, so it has to show up where they read what happened.
    for (const rid of (ev.rules_applied || [])) {
      const b = badge('instruction ' + rid, 'badge-rule')
      b.title = 'A standing instruction the model says changed this analysis'
      subjLine.appendChild(b)
    }
    main.appendChild(subjLine)
  }

  // ---- line 3: the model's one-sentence summary (auto-processed mail has none — its ⚙ sits in
  // the top line's cost slot instead) ----
  if (ev.summary) {
    const sm = document.createElement('div'); sm.className = 'ev-summary'; sm.textContent = ev.summary
    main.appendChild(clampable(sm))
  }

  // the live task rows this event raised — built up front because an auto-processed row shows its
  // own "filed to" line only when there are none (a task row already carries a pill and a △)
  const cb = changesBlock(ev, ctx, { onResolveTodo, drafts, taskHandlers, onOpenProject })

  // ---- auto-processed: WHERE it was filed, and the △ that changes that ---------------------
  // Putting a sender on autopilot is otherwise the one decision the user never sees, so the row
  // must both say where the mail went and be one tap from overruling it.
  if (auto && !cb) {
    const fr = filedRow(ev, ctx, { getProject, onOpenProject, taskHandlers })
    if (fr) main.appendChild(fr)
  }

  // this sender carries an auto-process yet the message was LLM-analysed — say exactly why
  // (autofile_blocked is the field's pre-rename name on older stored events)
  const apBlocked = ev.autoprocess_blocked || ev.autofile_blocked
  if (apBlocked) {
    const ab = document.createElement('div'); ab.className = 'ev-afblocked'
    ab.textContent = '⚙⚠ auto-process skipped: ' + apBlocked
    main.appendChild(ab)
  }

  if (ev.error) {
    const er = document.createElement('div'); er.className = 'ev-error-line'; er.textContent = '✗ ' + ev.error
    main.appendChild(er)
  }

  if (cb) {
    main.appendChild(cb)
  } else if (!(ev.changes || []).length && !ev.error && !auto) {
    // (auto-processed rows already say it all — no second line needed)
    const none = document.createElement('div'); none.className = 'ev-none'
    none.textContent = 'no to-do changes'
    main.appendChild(none)
  }

  if ((ev.role_changes || []).length) {
    const rc = document.createElement('div'); rc.className = 'ev-roles'
    rc.textContent = '👤 ' + ev.role_changes.map(r => (r.address || '?') + (r.role ? ' → ' + r.role : '')).join(' · ')
    main.appendChild(rc)
  }

  card.appendChild(main)
  return card
}

// ---- the feed ---------------------------------------------------------------------------

// Render the (already filtered) events into host, grouped by day, up to `limit` cards.
export function renderFeed (host, events, ctx, { limit = 100, onOpenEmail, onResolveTodo, drafts, taskHandlers, onOpenProject, getProject } = {}) {
  host.textContent = ''
  if (!events.length) {
    const e = document.createElement('div'); e.className = 'ev-empty'
    e.textContent = 'No events match. Process some messages on the Setup & Prefs page first, or clear the filter.'
    host.appendChild(e)
    return { shown: 0, total: 0 }
  }
  let currentDay = null
  let dayHost = null
  const shownList = events.slice(0, limit)
  for (const ev of shownList) {
    const k = dayKey(eventClock(ev))
    if (k !== currentDay) {
      currentDay = k
      const dh = document.createElement('div'); dh.className = 'ev-day-head'
      const lbl = document.createElement('span'); lbl.textContent = dayLabel(eventClock(ev)); dh.appendChild(lbl)
      const dayEvents = events.filter(e2 => dayKey(eventClock(e2)) === k)
      const cost = dayEvents.reduce((s, e2) => s + (Number(e2.cost) || 0), 0)
      // eq: the day's $0 local-connector events priced as the API would have (see the cost slot)
      const eqCost = dayEvents.reduce((s, e2) => {
        if (Number(e2.cost) || !e2.tokens || !e2.model) return s
        const q = equivalentCost(e2.tokens, { model: e2.model })
        return s + (q ? q.cost : 0)
      }, 0)
      const n = document.createElement('span'); n.className = 'ev-day-meta'
      n.textContent = dayEvents.length + ' event' + (dayEvents.length === 1 ? '' : 's') + (cost ? ' · $' + cost.toFixed(4) : '') + (eqCost ? ' · $' + eqCost.toFixed(4) + ' eq' : '')
      dh.appendChild(n)
      host.appendChild(dh)
      dayHost = document.createElement('div'); dayHost.className = 'ev-day'
      host.appendChild(dayHost)
    }
    dayHost.appendChild(renderEventCard(ev, ctx, { onOpenEmail, onResolveTodo, drafts, taskHandlers, onOpenProject, getProject }))
  }
  return { shown: shownList.length, total: events.length }
}
