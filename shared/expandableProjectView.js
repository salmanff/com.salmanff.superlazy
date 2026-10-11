// expandableProjectView.js — ONE way to depict a project (others may follow). A self-contained,
// reusable renderer with three depths:
//   1. base        — top line (name + per-direction counts, colour-coded by priority + overall
//                    dots) and a people/last-active line. Stands alone (renderProjectBase).
//   2. summary     — base + a horizontal tab bar (I owe / Team / Owed / Read / All); the selected
//                    tab shows up to 5 short_description rows, each with a resolve checkbox + a
//                    right-aligned cancel, and a "N resolved" note. Clicking a row opens the email
//                    modal (a function PASSED IN, so different views open it their own way).
//   3. all (5th tab) — every direction, every item incl. resolved, with dates + cancel.
// Text-only (textContent), no innerHTML of untrusted content. freezr-/DOM-safe.

try { console.debug('[superlazy] expandableProjectView v0.7 loaded') } catch (e) {}

// Importance colours, date formatters and entity components live in renderUtils.js.
import { impColor, impClassBl, fmtDate, fmtDateTime, fmtAgo, addrLine, dirDisc, kindDisc, projectChip, impBadge, taskRowEl, reposOfProject, repoChip, renderDraft } from './renderUtils.js'
import { wireBulletContinuation } from './subTasks.js'
import { resolveDueRange, isDueDated, effImportance, todayIso } from '../jobs/analyze_thread/dueDates.js'
import { createDueField } from './dueField.js'
import { sortImportanceOf, sortTouchOf, isSortHeld, releaseSortHold } from './taskSort.js'
import { openModalShell } from './modalStack.js'
import { DRAFT_MAX_AGE_DAYS } from '../jobs/analyze_thread/config.js'
import { groupByThread, projectHistoryEntries, renderThreadHistory } from './messageHistory.js'

const DIRS = [
  { key: 'i_owe_them', label: 'I owe', tab: 'I owe' },
  { key: 'team_owes', label: 'Team', tab: 'Team' },
  { key: 'they_owe_me', label: 'Owed', tab: 'Owed' },
  { key: 'read_only', label: 'Read', tab: 'Read' }
]
const DIR_BY_KEY = Object.fromEntries(DIRS.map(d => [d.key, d]))

const isOpen = (t) => t.status === 'open' || t.status === 'in_progress'
const dayOf = (ms) => { const n = Number(ms); if (!n) return ''; try { return new Date(n).toISOString().slice(0, 10) } catch (e) { return '' } }
const sameDay = (a, b) => !!a && !!b && dayOf(a) === dayOf(b)
// the people on a project = everyone who RAISED (sender) or must ACT (owner/owners) on its to-dos
function projectPeople (project) {
  const set = new Set()
  for (const t of (project.todos || [])) {
    if (t.sender) set.add(t.sender)
    if (t.owner) set.add(t.owner);
    (t.owners || []).forEach(o => o && set.add(o))
  }
  if (!set.size) (project.participant_emails || Object.keys(project.participants || {})).forEach(e => set.add(e))
  return [...set]
}
const openOf = (p, key) => (p.todos || []).filter(t => t.direction === key && isOpen(t))
const doneOf = (p, key) => (p.todos || []).filter(t => t.direction === key && !isOpen(t))
const maxImp = (todos) => todos.reduce((m, t) => Math.max(m, effImportance(t)), 0) || 3
// when the task was last touched — EXACTLY the date its row displays (created / resolved /
// latest evidence), so the sort below is legible from the rows themselves. (lastTouchOf now
// lives in taskSort.js, where the sort keys and their hold are defined together.)
// Both orders read their keys through taskSort's sortImportanceOf / sortTouchOf, so a row being
// re-priced keeps its place instead of jumping out from under the cursor (user, 2026-08-31).
// open tasks list newest-first by that date (user, 2026-08-20 — was priority, which made the
// shown dates look shuffled); priority breaks ties and still colours every row
const byLastTouch = (a, b) => sortTouchOf(b) - sortTouchOf(a) || sortImportanceOf(b) - sortImportanceOf(a)
// the OTHER order, one click away on the bucket bar's sort toggle: priority first, date tiebreak
const byPriority = (a, b) => sortImportanceOf(b) - sortImportanceOf(a) || sortTouchOf(b) - sortTouchOf(a)
const sorterOf = (sortBy) => (sortBy === 'priority' ? byPriority : byLastTouch)

// ---- WHICH suggested replies are still worth showing --------------------------------------
// A draft is TIED TO ITS TASK (user, 2026-08-17): the reason to reply is the open item, so when
// that item is resolved / cancelled / gone the draft goes with it. Without this the board kept
// accumulating replies to things already dealt with — a project can carry several live threads,
// so "only the latest thread" was the wrong cut; "only while the to-do is open" is the right one.
// A draft with no task at all (or pointing at a task that no longer exists) is unanchored and
// therefore not shown. THE one rule — the card, its draft pill and the email viewer share it.
// SUPERSEDED (user, 2026-09-27: "old suggested replies should disappear when there is a new email
// or action on the thread"): a draft is written against the conversation as it stood — once a
// LATER message lands on its task or on any thread its task came from, it answers a conversation
// that has moved on. The evidence trail on the project record is enough to see that on every
// surface, with no events log (the analyzer also retires these durably — reconcile.js
// retireSupersededDrafts — and viewerContext catches messages that touched no task).
// An EDITED draft is the user's own work in progress and is never retired this way.
export function isSupersededResponse (r, project) {
  if (!r || r.status !== 'suggested' || !project) return false
  const t = (project.todos || []).find(t => t.todo_id === r.todo_id)
  if (!t) return false
  const created = Number(r.created_asof) || 0
  const threads = new Set((t.evidence || []).filter(e => e.msg_id && e.thread_id).map(e => e.thread_id))
  for (const tt of (project.todos || [])) {
    for (const e of (tt.evidence || [])) {
      if (!e.msg_id || (Number(e.asof) || 0) <= created) continue
      if (tt === t || threads.has(e.thread_id)) return true
    }
  }
  return false
}
// AGED OUT: an unedited suggestion older than DRAFT_MAX_AGE_DAYS (config.js) answers a moment
// long gone even when the thread went quiet — the user's cut, 2026-09-27. Edited drafts stay.
export function isAgedOutResponse (r, now = Date.now()) {
  if (!r || r.status !== 'suggested') return false
  const created = Number(r.created_asof) || 0
  return !!created && now - created > DRAFT_MAX_AGE_DAYS * 86400000
}
export function isLiveResponse (r, project) {
  if (!r || r.status === 'sent' || r.status === 'dismissed') return false
  if (!r.todo_id) return false
  const t = (project && (project.todos || []).find(t => t.todo_id === r.todo_id)) || null
  return !!t && isOpen(t) && !isSupersededResponse(r, project) && !isAgedOutResponse(r)
}
const liveResponses = (p) => (p.responses || []).filter(r => isLiveResponse(r, p))

// WHICH TAB a draft belongs to. Its own `direction` is a copy taken when the model drafted it —
// change the task's ownership afterwards and that copy goes stale, so the pill counted a draft
// that the tab holding its task never showed (and the tab that would show it often had no open
// tasks, so nothing ever opened there). The draft is tied to its TASK, so the task's direction
// decides; the response's copy is only a fallback, and anything unrecognised lands in "I owe"
// rather than nowhere. Total by construction: pill count == what the tabs render. (user, 2026-08-21)
function dirOfResponse (p, r) {
  const t = (p.todos || []).find(x => x.todo_id === r.todo_id)
  const d = (t && t.direction) || r.direction
  return DIR_BY_KEY[d] ? d : 'i_owe_them'
}

// THE draft buckets — one home per live draft, every bucket a real tab. The card's pill counts
// these and its tabs render these, so the two cannot disagree: the pill promising a draft that
// no tab would show was exactly the bug (user, 2026-08-21).
export function draftsByDirection (project) {
  const out = {}
  for (const d of DIRS) out[d.key] = []
  for (const r of liveResponses(project)) out[dirOfResponse(project, r)].push(r)
  return out
}
export const draftCountOf = (project) => {
  const b = draftsByDirection(project)
  return DIRS.reduce((n, d) => n + b[d.key].length, 0)
}

// Five circles: FILL = effective importance (fillN), RIM = computed importance (rimColor).
// When the user hasn't overridden, rim == fill (looks like plain filled dots). When they have,
// the rim quietly shows what the model computed — both data points, one widget.
function dotsEl (fillN, rimColor) {
  const w = document.createElement('span'); w.className = 'epv-dots'
  const v = Math.max(1, Math.min(5, Math.round(fillN || 3)))
  const fill = impColor(fillN)
  for (let i = 1; i <= 5; i++) {
    const d = document.createElement('span'); d.className = 'epv-dot'
    d.style.borderColor = rimColor || fill
    d.style.background = i <= v ? fill : 'transparent'
    w.appendChild(d)
  }
  const lbl = document.createElement('span'); lbl.className = 'epv-dots-lbl'; lbl.textContent = v + '/5'
  w.appendChild(lbl); return w
}

// importance display with optional ▲/▼ controls. onDelta(+1|-1) fires a user change; if absent,
// just the read-only display. `dots` = use the 5-dot display (for a project) instead of the badge.
function impControl (value, onDelta, { dots = false, locked = false, rimColor = null } = {}) {
  const wrap = document.createElement('span'); wrap.className = 'epv-impctl'
  const mkArrow = (glyph, delta, title) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'epv-imp-arrow'; b.textContent = glyph; b.title = title
    b.addEventListener('click', (e) => { e.stopPropagation(); onDelta(delta) })
    return b
  }
  if (onDelta) wrap.appendChild(mkArrow('▾', -1, 'Lower priority'))
  // the "set by you" dot rides on the display's OWN corner (absolute, zero width) — as a sibling
  // it widened the control, stepping the arrows out of line whenever a priority was user-set.
  // Same rule as renderUtils.impCtl; both must stay in step. (user, 2026-08-21)
  const display = dots ? dotsEl(value, rimColor) : impBadge(value)
  if (locked) {
    display.classList.add('imp-badge-locked')
    const l = document.createElement('span'); l.className = 'epv-imp-lock'
    l.title = 'priority set by you — the model may not override it'
    display.appendChild(l)
  }
  wrap.appendChild(display)
  if (onDelta) wrap.appendChild(mkArrow('▴', +1, 'Raise priority'))
  return wrap
}

// ---- 1. BASE (standalone, reusable) -------------------------------------------------
// opts: { now, self:[myEmails], nameOf:(email)=>name } — self is hidden from the people line;
// names are shown when nameOf resolves one, else the email.
// NB "Hide not mine" is a PROJECT-level filter only (ui.js projectStillVisible): it drops projects
// where you owe nothing, but a project that survives shows ALL of its buckets. The Team / Owed /
// Read items on such a project are usually the context for the thing you owe — hiding them
// (which this used to do) removed exactly the information you need to act (user, 2026-08-17).
export function renderProjectBase (project, { now, self, nameOf, onImportance, onEdit, onOpenPerson, hideNotDue } = {}) {
  const base = document.createElement('div'); base.className = 'epv-base'

  const top = document.createElement('div'); top.className = 'epv-top'
  // TITLE GROUP — the name, its ✏️ and the draft pill are one block of inline flow, so a long
  // name WRAPS instead of being ellipsised and the ✏️ still trails its last word. It is a single
  // flex item next to .epv-tail (counts + priority), which is what lets the tail drop to a row of
  // its own the moment the name wants the width — no breakpoint, it happens when it must.
  const titlewrap = document.createElement('div'); titlewrap.className = 'epv-titlewrap'
  const name = document.createElement('span'); name.className = 'epv-name'; name.textContent = project.name || '(untitled project)'
  titlewrap.appendChild(name)

  // ✏️ change button (was △ — read as nerd notation; user, 2026-08-25) — same language as the
  // task rows, and in the same place: at the END OF THE TEXT it acts on, not stranded among the
  // right-hand controls (user, 2026-08-21). It took over the slot the TODAY tag used to occupy.
  if (onEdit) {
    const eb = document.createElement('button'); eb.type = 'button'; eb.className = 'task-editbtn epv-projedit'
    eb.textContent = '✏️'
    eb.title = 'Edit this project — rename, set priority, or merge it into another project'
    eb.addEventListener('click', (e) => { e.stopPropagation(); onEdit() })
    titlewrap.appendChild(eb)
  }

  // count the buckets the card will actually RENDER, never the raw list — see draftsByDirection
  const draftCount = draftCountOf(project)
  if (draftCount) {
    const d = document.createElement('span'); d.className = 'epv-draft-pill'
    // ↩ = the draft-reply mark (✍ was too close to the ✍️ manual-edit disc — user, 2026-08-19)
    d.textContent = draftCount > 1 ? '↩ ' + draftCount + ' drafts' : '↩ draft reply'
    d.title = 'A suggested reply is ready'
    titlewrap.appendChild(d)
  }

  top.appendChild(titlewrap)

  // THE TAIL — everything that hangs off the right of the title band (the open-item counts and
  // the priority dial). One element so the pair wraps together, right-aligned, rather than the
  // counts and the dial breaking to separate lines.
  const tail = document.createElement('span'); tail.className = 'epv-tail'

  const counts = document.createElement('span'); counts.className = 'epv-counts'
  let any = false
  for (const d of DIRS) {
    let open = openOf(project, d.key)
    if (hideNotDue) open = open.filter(isDueDated)
    if (!open.length) continue
    any = true
    const b = document.createElement('span'); b.className = 'epv-count'
    b.appendChild(dirDisc(d.key, maxImp(open)))
    b.appendChild(document.createTextNode(String(open.length)))
    b.title = d.label + ': ' + open.length + ' open (top priority ' + maxImp(open) + '/5)'
    counts.appendChild(b)
  }
  if (!any) { const n = document.createElement('span'); n.className = 'epv-count epv-count-none'; n.textContent = 'no open items'; counts.appendChild(n) }
  tail.appendChild(counts)

  // (the whole-project "✓ resolve all" is gone from the band — each TAB carries its own
  //  resolve-all / cancel-all for its own bucket, which is the scope people actually mean)

  const computed = project.computed_importance != null ? project.computed_importance : project.importance
  const ctl = impControl(project.importance,
    onImportance ? (delta) => onImportance(project, delta) : null,
    { dots: true, locked: !!project.importance_locked, rimColor: impColor(computed) })
  if (project.importance_locked && computed !== project.importance) ctl.title = 'priority ' + project.importance + ' (you) · computed ' + computed
  tail.appendChild(ctl)
  top.appendChild(tail)
  base.appendChild(top)

  // THE one place a project's people are listed (user, 2026-08-18: the expanded card's duplicate
  // pill row is gone). Plain comma-separated names — not pills — but each name IS the button that
  // opens that person's modal, so nothing was lost by dropping the chips.
  const sub = document.createElement('div'); sub.className = 'epv-subline'
  const people = document.createElement('span'); people.className = 'epv-people'
  const selfSet = new Set((self || []).map(a => String(a).toLowerCase()))
  const nm = (a) => { const n = nameOf && nameOf(a); return (n && n !== a) ? n : a }
  const others = projectPeople(project).filter(a => !selfSet.has(String(a).toLowerCase()))
  if (!others.length) {
    people.textContent = '—'
  } else {
    others.forEach((a, i) => {
      if (i) people.appendChild(document.createTextNode(', '))
      if (!onOpenPerson) {
        const s = document.createElement('span'); s.textContent = nm(a); s.title = a
        people.appendChild(s)
        return
      }
      const b = document.createElement('button'); b.type = 'button'; b.className = 'epv-person-link'
      b.textContent = nm(a)
      b.title = a + ' — edit profile & special instructions'
      // stopPropagation: the base row itself is the card's expand/collapse toggle
      b.addEventListener('click', (e) => { e.stopPropagation(); onOpenPerson(a) })
      people.appendChild(b)
    })
  }
  const date = document.createElement('span'); date.className = 'epv-date'; date.textContent = fmtAgo(project.last_active_asof)
  date.title = 'last active ' + fmtDateTime(project.last_active_asof)
  // WHERE the work lives, on the line UNDER the project name, with the people pushed to its right
  // (user, 2026-09-10 — it fits better here than as a prefix to the name). A repo is a PLACE, like
  // a Slack channel, so it reads as context for the project rather than part of its identity.
  const repos = reposOfProject(project)
  if (repos.length) {
    const rw = document.createElement('span'); rw.className = 'epv-repos'
    for (const r of repos.slice(0, 3)) rw.appendChild(repoChip(r))
    if (repos.length > 3) {
      const more = document.createElement('span'); more.className = 'epv-repos-more'
      more.textContent = '+' + (repos.length - 3)
      more.title = repos.slice(3).map(r => r.slug).join('\n')
      rw.appendChild(more)
    }
    sub.appendChild(rw)
  }
  sub.appendChild(people); sub.appendChild(date)
  base.appendChild(sub)

  return base
}

// ---- a single to-do row — THE shared task row (renderUtils.taskRowEl), rendered WITHOUT a
// project pill because we are already inside the project.
function todoRow (todo, project, handlers, { now = 0, showDirection = false } = {}) {
  return taskRowEl(todo, project, handlers, { now, showDirection })
}

// suggested replies for a direction (answers / delegations / reminders) — only the LIVE ones,
// i.e. those whose task is still open (isLiveResponse)
const respOf = (p, key) => draftsByDirection(p)[key] || []
const KIND_LABEL = { answer: '↩ reply', delegate: '➜ delegate', reminder: '⏰ reminder' }

function responseCard (r, project, handlers) {
  // THE draft block (renderUtils.renderDraft) whenever the page supplies the sending handlers:
  // Send right here, and Edit opens the reply composer with the thread quoted underneath — the
  // same block the email viewer and the events feed show (user, 2026-09-27: "what would be
  // helpful is for the user to be able to send emails"). Reminders keep the simple card.
  const d = handlers.drafts
  if (d && d.evLikeFor && r.kind !== 'reminder') {
    const card = document.createElement('div'); card.className = 'epv-resp epv-resp-live kind-' + r.kind
    const evLike = d.evLikeFor(r, project)
    const wrapped = {
      ...d,
      onSend: async (ev, ent, payload) => { await d.onSend(ev, ent, payload); handlers.onChange && handlers.onChange() },
      onDismiss: (ent) => { d.onDismiss(ent); card.remove(); handlers.onChange && handlers.onChange() }
    }
    card.appendChild(renderDraft(evLike, { response: r, project }, { nameOf: handlers.nameOf }, wrapped, {
      compact: true,
      onFullView: handlers.openResponseView ? () => handlers.openResponseView(r, project) : null
    }))
    return card
  }
  const card = document.createElement('div'); card.className = 'epv-resp kind-' + r.kind + (r.status === 'sent' ? ' sent' : '')
  const head = document.createElement('div'); head.className = 'epv-resp-head'
  const kind = document.createElement('span'); kind.className = 'epv-resp-kind'; kind.textContent = KIND_LABEL[r.kind] || r.kind
  head.appendChild(kind)
  const to = document.createElement('span'); to.className = 'epv-resp-to'
  to.textContent = 'to: ' + ((r.to || []).join(', ') || '—') + ((r.cc || []).length ? '  cc: ' + r.cc.join(', ') : '')
  head.appendChild(to)
  if (r.kind === 'reminder' && r.reminder_at) { const w = document.createElement('span'); w.className = 'epv-resp-when'; w.textContent = '⏰ ' + fmtDateTime(r.reminder_at); head.appendChild(w) }
  card.appendChild(head)

  const body = document.createElement('textarea'); body.className = 'epv-resp-body'; body.rows = 2; body.value = r.body || ''
  body.readOnly = true
  card.appendChild(body)

  const actions = document.createElement('div'); actions.className = 'epv-resp-actions'
  const mk = (label, cls, fn, title) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'epv-resp-btn ' + cls; b.textContent = label; b.title = title || ''; b.addEventListener('click', (e) => { e.stopPropagation(); fn() }); return b }
  // "Full view" opens THE standard email modal (emailViewer) on the thread this draft answers —
  // the draft is pinned and selected there, with the real Send. The old bespoke composer
  // (responseFullView) is gone (user, 2026-08-17).
  if (handlers.openResponseView) {
    actions.appendChild(mk('Full view ↗', 'full', () => handlers.openResponseView(r, project),
      'Open the email + its thread — the draft opens there, where it can actually be sent'))
  }
  // inline body edit, saved through the page (persisted) so it survives a reload
  actions.appendChild(mk('Edit', 'edit', () => {
    body.readOnly = !body.readOnly
    if (!body.readOnly) { body.focus(); return }
    if (body.value === r.body) return
    r.body = body.value
    r.status = 'edited'
    r.edited_asof = Date.now()
    handlers.onSaveResponse && handlers.onSaveResponse(r, project)
    handlers.onChange && handlers.onChange()
  }, 'Edit the draft — press Edit again to save it'))
  actions.appendChild(mk('Remove', 'remove', () => {
    r.status = 'dismissed'
    r.dismissed_asof = Date.now()
    handlers.onDismissResponse && handlers.onDismissResponse(r, project)
    handlers.onChange && handlers.onChange()
    card.remove()
  }, 'Dismiss this suggestion for good'))
  card.appendChild(actions)
  return card
}

// always visible — suggested replies are the app's highest-value output, keep them one glance
// (not one click) away
function responsesBlock (wrap, list, project, handlers) {
  if (!list.length) return
  const h = document.createElement('div'); h.className = 'epv-resp-headline'; h.textContent = '↩ Suggested replies (' + list.length + ')'; wrap.appendChild(h)
  for (const r of list) wrap.appendChild(responseCard(r, project, handlers))
}

// ---- 2/3. tab content ---------------------------------------------------------------
function resolvedBlock (wrap, done, project, handlers, now, showResolved, onExpandResolved) {
  if (!done.length) return
  const h = document.createElement('div'); h.className = 'epv-resolved-head'; h.textContent = 'Resolved (' + done.length + ')'; wrap.appendChild(h)
  const shown = showResolved ? done : done.slice(0, 2)
  for (const t of shown) wrap.appendChild(todoRow(t, project, handlers, { now }))
  if (!showResolved && done.length > 2) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'epv-more-btn'; b.textContent = '+ ' + (done.length - 2) + ' more resolved'
    b.addEventListener('click', (e) => { e.stopPropagation(); onExpandResolved && onExpandResolved() })
    wrap.appendChild(b)
  }
}

// the project's own activity timeline, reconstructed from embedded todo evidence — needs no
// events log, so the Recent tab works identically wherever the card renders
function projectTimeline (project) {
  const out = []
  for (const t of (project.todos || [])) {
    for (const e of (t.evidence || [])) {
      out.push({
        asof: Number(e.asof) || 0,
        reason: e.reason || 'updated',
        msg_id: e.msg_id || null,
        who: e.who || null, // the actor (stamped by the analyzer / manual edits going forward)
        summary: e.summary || null, // the model's one-sentence message summary (going forward)
        manual: e.source === 'manual' || e.type === 'manual',
        todo: t
      })
    }
    if (t.resolved_asof && !(t.evidence || []).some(e => /resolv/.test(e.reason || ''))) {
      out.push({ asof: Number(t.resolved_asof) || 0, reason: 'resolved', todo: t, manual: false })
    }
  }
  return out.filter(x => x.asof).sort((a, b) => b.asof - a.asof)
}

// ---- the "+ Add" tab: create a task by hand (direction defaults to the LAST direction tab the
// user had open on this card — reading the Owed pile then adding usually means adding an Owed
// item (user, 2026-08-24); priority / who / due are all settable — the same fields, and now the
// same CONTROLS, the editor edits: the shared due field with its quick-fills and the ⏲
// lower-until-due hold beside the priority numbers). Saved via handlers.onAddTask.
function renderAddTab (project, handlers, { onSaved, defaultDir }) {
  const wrap = document.createElement('div'); wrap.className = 'epv-tabcontent'
  const form = document.createElement('div'); form.className = 'pe-editform epv-addform'
  const field = (lbl, node) => {
    const r = document.createElement('div'); r.className = 'pe-frow'
    const k = document.createElement('span'); k.className = 'pe-lbl'; k.textContent = lbl
    r.appendChild(k); r.appendChild(node); return r
  }
  // MULTI-LINE by design: one task per line, so a pasted list becomes a pile of tasks in one go.
  // The box grows to fit whatever lands in it and the warning below counts what will be created.
  const shortIn = document.createElement('textarea'); shortIn.className = 'epv-addshort'; shortIn.rows = 1
  shortIn.placeholder = 'What needs doing? (one per line)'
  const descIn = document.createElement('textarea'); descIn.rows = 2
  descIn.placeholder = 'Detail (optional) — start a line with "- " for checklist lines'
  wireBulletContinuation(descIn) // Enter continues a "- [ ]" list; Enter on an empty bullet exits it
  const dirSel = document.createElement('select')
  for (const d of [
    { key: 'i_owe_them', label: 'I owe — my to-dos' },
    { key: 'they_owe_me', label: '📥 Owed to me' },
    { key: 'team_owes', label: '👥 Team owes' },
    { key: 'read_only', label: '📖 To read / FYI' }
  ]) {
    const o = document.createElement('option'); o.value = d.key; o.textContent = d.label
    if (d.key === (DIR_BY_KEY[defaultDir] ? defaultDir : 'i_owe_them')) o.selected = true
    dirSel.appendChild(o)
  }

  // WHO — same known-people autocomplete as the task editor (te-who-*): suggest once the current
  // comma-separated token has 2+ letters; picking a row replaces just that token with the address
  const whoIn = document.createElement('input'); whoIn.type = 'text'; whoIn.placeholder = 'email or name (optional)'
  whoIn.autocomplete = 'off'
  const whoWrap = document.createElement('span'); whoWrap.className = 'te-who-wrap'
  const whoSug = document.createElement('div'); whoSug.className = 'te-who-sug'
  whoSug.style.display = 'none'
  const closeSug = () => { whoSug.style.display = 'none'; whoSug.textContent = '' }
  const paintSug = () => {
    const all = (handlers.people ? handlers.people() : []) || []
    const parts = whoIn.value.split(',')
    const token = parts[parts.length - 1].trim().toLowerCase()
    if (token.length < 2 || !all.length) { closeSug(); return }
    const already = new Set(parts.slice(0, -1).map(s => s.trim().toLowerCase()).filter(Boolean))
    const hits = all.filter(p => p && p.address && !already.has(String(p.address).toLowerCase()) &&
      ((String(p.name || '').toLowerCase().includes(token)) || String(p.address).toLowerCase().includes(token)))
      .slice(0, 6)
    if (!hits.length) { closeSug(); return }
    whoSug.textContent = ''
    for (const p of hits) {
      const row = document.createElement('button'); row.type = 'button'; row.className = 'te-who-sugrow'
      row.addEventListener('click', () => {
        parts[parts.length - 1] = ' ' + p.address
        whoIn.value = parts.join(',').replace(/^\s+/, '')
        closeSug()
        whoIn.focus()
      })
      if (p.name) { const n = document.createElement('span'); n.className = 'te-who-sugname'; n.textContent = p.name; row.appendChild(n) }
      const a = document.createElement('span'); a.className = 'te-who-sugaddr'; a.textContent = p.address; row.appendChild(a)
      // mousedown fires before the input's blur — without this the row dies under the click
      row.addEventListener('mousedown', (e) => e.preventDefault())
      whoSug.appendChild(row)
    }
    whoSug.style.display = ''
  }
  whoIn.addEventListener('input', paintSug)
  whoIn.addEventListener('blur', () => setTimeout(closeSug, 150))
  whoIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSug(); e.stopPropagation() } })
  whoWrap.appendChild(whoIn); whoWrap.appendChild(whoSug)

  // DUE — the SAME control the task editor uses (dueField.js): text box + asap / today /
  // tomorrow / next wk quick-fills + the interpreted window underneath. Adding a task and
  // editing one were two different due-date experiences before (user, 2026-08-31).
  const dueField = createDueField({
    placeholder: 'e.g. this week (optional)',
    onRangeChange: () => paintPrio() // the until-due hold goes live/inert with the date
  })

  // priority — clickable 1…5 number buttons (the dropdown read as a form chore; user, 2026-08-24),
  // filled up to the chosen value in that value's colour, like the dot language everywhere else.
  // Beside them, the task editor's ⏲ "lower until due" hold: cycles −1 / −2 / −3 / off, and the
  // held-back numbers render half-tone so "a 4 that acts as a 3" reads at a glance.
  let imp = 3
  let demote = 0
  const prio = document.createElement('span'); prio.className = 'pe-prio'
  const prioWrap = document.createElement('span'); prioWrap.className = 'te-prio-wrap'
  const dmB = document.createElement('button'); dmB.type = 'button'
  const notYetDue = () => { const r = dueField.getRange(); const ref = r.earliest || r.latest; return !!ref && ref > todayIso() }
  dmB.addEventListener('click', () => { demote = (demote + 1) % 4; paintPrio() })
  const paintPrio = () => {
    prio.textContent = ''
    const effN = Math.max(1, imp - ((demote && notYetDue()) ? demote : 0))
    for (let n = 1; n <= 5; n++) {
      const b = document.createElement('button'); b.type = 'button'
      const half = n > effN && n <= imp
      b.className = 'epv-prio-num' + (n <= imp ? ' on' : '') + (half ? ' pe-prio-half' : '')
      b.textContent = String(n)
      if (n <= imp) b.style.background = impColor(imp)
      b.title = half ? ('Set priority ' + n + '/5 — currently held down until due') : ('Set priority ' + n + '/5')
      b.addEventListener('click', () => { imp = n; paintPrio() })
      prio.appendChild(b)
    }
    dmB.className = 'te-demote' + (demote ? ' on' : '') + (demote && !notYetDue() ? ' inert' : '')
    dmB.textContent = '⏲ ' + (demote ? '−' + demote + ' until due' : 'lower until due')
    dmB.title = 'Treat this to-do as ' + (demote ? (demote + ' lower') : 'lower priority') +
      ' until its due date arrives — click to cycle −1 / −2 / −3 / off' +
      (notYetDue() ? '' : ' (takes effect only while a future due date is set)')
  }
  prioWrap.appendChild(prio)
  prioWrap.appendChild(dmB)
  paintPrio()

  form.appendChild(field('To-do', shortIn))
  form.appendChild(field('Detail', descIn))
  form.appendChild(field('Direction', dirSel))
  form.appendChild(field('Who', whoWrap))
  form.appendChild(field('Priority', prioWrap))
  form.appendChild(field('Due', dueField.wrap))
  form.appendChild(dueField.note)
  const acts = document.createElement('div'); acts.className = 'pe-factions'
  const warn = document.createElement('span'); warn.className = 'epv-addwarn'; warn.style.display = 'none'
  const save = document.createElement('button'); save.type = 'button'; save.className = 'pe-tbtn pe-tbtn-save'; save.textContent = 'Add to-do'
  // the typed/pasted lines, blanks dropped — each one becomes its own task
  const taskLines = () => shortIn.value.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const growAndCount = () => {
    shortIn.style.height = 'auto'
    shortIn.style.height = Math.min(shortIn.scrollHeight + 2, 420) + 'px'
    const n = taskLines().length
    warn.textContent = n > 1
      ? '⚠ each line will be treated as a new to-do (' + n + ' to-dos) — all with this Detail, Direction, Who, Priority and Due'
      : ''
    warn.style.display = n > 1 ? '' : 'none'
    save.textContent = n > 1 ? 'Add ' + n + ' to-dos' : 'Add to-do'
  }
  shortIn.addEventListener('input', growAndCount)
  save.addEventListener('click', async () => {
    const lines = taskLines()
    if (!lines.length) { shortIn.focus(); return }
    save.disabled = true; save.textContent = lines.length > 1 ? 'Adding ' + lines.length + '…' : 'Adding…'
    // the due text's machine window — the control usually resolved it live (and always has it
    // instantly for the quick-fill phrases); only a save caught mid-debounce resolves again.
    // ONE resolution for the whole batch, since every line shares the same due text.
    const dueText = dueField.getText() || null
    const due = (!dueText || dueField.isResolved())
      ? dueField.getRange()
      : await resolveDueRange(dueText)
    for (const short of lines) {
      handlers.onAddTask(project, {
        short_description: short,
        description: descIn.value.trim(),
        direction: dirSel.value,
        who: whoIn.value.trim() || null,
        importance: imp,
        due_demote: demote || null,
        due_hint: dueText,
        due_earliest: due.earliest,
        due_latest: due.latest
      })
    }
    onSaved(dirSel.value)
  })
  acts.appendChild(warn)
  acts.appendChild(save)
  form.appendChild(acts)
  wrap.appendChild(form)
  setTimeout(() => { shortIn.focus(); growAndCount() }, 0)
  return wrap
}

// "✓ resolve all" for ONE bucket (user, 2026-08-17: the project-wide one is too blunt when you
// just want the whole Read pile gone). Same glyph and hover-reveal language as the title-bar one.
// The bulk bar for ONE bucket: clear it as done, or write it off. Both need at least two open
// items to be worth offering — for one task the row's own checkbox / ✕ is right there. The sort
// toggle rides on the bar's right for the same reason: order only matters from two rows up.
function bucketBulkBar (dirKey, count, onResolveBucket, sort) {
  if ((!onResolveBucket && !sort) || count < 2) return null
  const label = (DIR_BY_KEY[dirKey] || {}).label || dirKey
  const bar = document.createElement('div'); bar.className = 'epv-bucket-bar'
  const mk = (cls, text, title, status) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = cls
    b.textContent = text
    b.title = title
    b.addEventListener('click', (e) => { e.stopPropagation(); onResolveBucket(dirKey, status) })
    return b
  }
  if (onResolveBucket) {
    bar.appendChild(mk('epv-allres epv-allres-bucket', '✓ resolve all ' + count,
      'Mark all ' + count + ' open “' + label + '” to-dos in this project as resolved', 'resolved'))
    bar.appendChild(mk('epv-allres epv-allres-bucket epv-allcancel', '✕ cancel all ' + count,
      'Cancel all ' + count + ' open “' + label + '” to-dos in this project — they are not going to happen', 'cancelled'))
  }
  // ONE toggle pill, not a dropdown (too heavy) or checkboxes: it names the current order and a
  // click flips to the only other one. Card-wide state, so every tab shows the same order.
  if (sort) {
    // while a priority edit is holding the order still (taskSort.js), the pill flags that the
    // list is knowingly out of order — clicking it lets go and re-sorts
    const held = isSortHeld()
    const b = document.createElement('button'); b.type = 'button'
    b.className = 'epv-allres epv-allres-bucket epv-sortbtn' + (held ? ' epv-sortbtn-held' : '')
    b.textContent = '⇅ ' + (sort.by === 'priority' ? 'priority' : 'date') + (held ? ' ⚠' : '')
    b.title = (held ? 'Order held where it was while you changed priorities — click to re-sort.\n' : '') +
      (sort.by === 'priority'
        ? 'Sorted by priority — click to sort by date, newest first'
        : 'Sorted by date, newest first — click to sort by priority')
    b.addEventListener('click', (e) => { e.stopPropagation(); releaseSortHold(); sort.onToggle() })
    bar.appendChild(b)
  }
  return bar
}

function renderTabContent (project, tabKey, handlers, { now, showResolved, onExpandResolved, showOpen, onExpandOpen, onResolveBucket, sort }) {
  const wrap = document.createElement('div'); wrap.className = 'epv-tabcontent'
  const hideDone = !!handlers.hideResolved

  // ---- Recent: what happened on this project, newest first ----
  if (tabKey === 'recent') {
    const acts = projectTimeline(project).slice(0, 12)
    if (!acts.length) { const e = document.createElement('div'); e.className = 'epv-empty'; e.textContent = 'No recorded activity yet.'; wrap.appendChild(e) }
    for (const a of acts) {
      const li = document.createElement('div'); li.className = 'epv-act'
      // the LEFT kind disc IS the email button (opens the exact message behind this line);
      // the redundant right-side ✉ chip is gone
      const disc = kindDisc(a.manual ? 'manual' : 'message')
      if (a.msg_id && handlers.openEmailModal) {
        disc.classList.add('epv-act-disc-btn')
        disc.title = 'Open the email behind this'
        disc.addEventListener('click', (e) => { e.stopPropagation(); handlers.openEmailModal(a.todo, project, a.msg_id) })
      }
      li.appendChild(disc)
      const when = document.createElement('span'); when.className = 'epv-act-when'; when.textContent = fmtAgo(a.asof)
      when.title = fmtDateTime(a.asof)
      li.appendChild(when)
      if (a.who) {
        const nice = a.who === 'you' ? 'you' : ((handlers.nameOf && handlers.nameOf(a.who)) || a.who)
        const w = document.createElement('b'); w.className = 'epv-act-who'; w.textContent = nice
        if (nice !== a.who) w.title = a.who
        li.appendChild(w)
      }
      const what = document.createElement('span'); what.className = 'epv-act-what ' + impClassBl(effImportance(a.todo))
      what.textContent = a.todo.short_description || a.todo.description || '(untitled)'
      li.appendChild(what)
      const rs = document.createElement('span'); rs.className = 'epv-act-reason'; rs.textContent = a.reason
      rs.title = a.reason
      li.appendChild(rs)
      if (a.summary) {
        // one line by default (CSS ellipsis); CLICK toggles the full summary in place. The row
        // itself has no click handler (only the disc opens the email), so no collision — the
        // stopPropagation is belt-and-braces for a future one. (user, 2026-09-21)
        const sm = document.createElement('div'); sm.className = 'epv-act-sum'; sm.textContent = a.summary
        const OPEN = 'epv-act-sum--open'
        const retitle = () => { sm.title = sm.classList.contains(OPEN) ? 'Click to collapse' : 'Click to read the full summary' }
        sm.addEventListener('click', (e) => { e.stopPropagation(); sm.classList.toggle(OPEN); retitle() })
        retitle()
        li.appendChild(sm)
      }
      wrap.appendChild(li)
    }
    return wrap
  }

  // ---- Messages: the mail behind this project, thread-grouped SUMMARY rows (the People page's
  // message-history language — subject + what-it-changed, not the task rows). Needs the events
  // log, which the page injects (ui.js setEventsProvider); rows open the full email + thread.
  if (tabKey === 'messages') {
    const paintHistory = (events, { pending = false } = {}) => {
      wrap.textContent = ''
      const entries = projectHistoryEntries(project, events, handlers.self)
      wrap.appendChild(renderThreadHistory(groupByThread(entries), {
        onOpenEmail: handlers.onOpenEmailEvent || null,
        emptyText: pending ? 'Looking up this project’s messages…' : 'No analysed messages for this project in the events log.'
      }))
      if (pending) { const l = document.createElement('div'); l.className = 'pp-empty'; l.textContent = 'checking the database for older messages…'; wrap.appendChild(l) }
    }
    // paint what is loaded NOW, then — when the page provides the deep fetch — replace it with the
    // project's full history from the database. The loaded log is the newest ~1,000 events, so
    // without this an older thread simply vanished from the tab as the log grew (2026-10-04).
    const loaded = (handlers.getEvents && handlers.getEvents()) || []
    const deep = handlers.loadProjectEvents
    paintHistory(loaded, { pending: !!deep })
    if (deep) {
      Promise.resolve().then(() => deep(project)).then((events) => {
        if (!wrap.isConnected) return // the card re-painted or the tab changed meanwhile
        paintHistory(events || loaded)
      }).catch((e) => {
        console.warn('[superlazy] project messages fetch failed:', e && e.message)
        if (wrap.isConnected) paintHistory(loaded)
      })
    }
    return wrap
  }

  if (tabKey === 'all') {
    // the All tab is the ARCHIVE view: resolved tasks ALWAYS show here, newest-resolved first,
    // regardless of the board's Hide-resolved toggle — fully interactive rows (untick the green
    // check to reopen, ✉ / meta opens the emails behind them)
    let printed = false
    for (const d of DIRS) {
      let open = openOf(project, d.key)
      if (handlers.hideNotDue) open = open.filter(isDueDated)
      const done = doneOf(project, d.key)
        .sort((a, b) => (Number(b.resolved_asof) || 0) - (Number(a.resolved_asof) || 0))
      if (!open.length && !done.length) continue
      printed = true
      const h = document.createElement('div'); h.className = 'epv-all-head'
      h.appendChild(document.createTextNode(d.tab + ' · ' + open.length + ' open' + (done.length ? ' · ' + done.length + ' resolved' : '')))
      const rb = bucketBulkBar(d.key, open.length, onResolveBucket, sort)
      if (rb) h.appendChild(rb)
      wrap.appendChild(h)
      // the All tab pools every direction — each row carries its own mark, so a row read on
      // its own still says whose obligation it is (user, 2026-08-21)
      for (const t of open.sort(sorterOf(sort && sort.by))) wrap.appendChild(todoRow(t, project, handlers, { now, showDirection: true }))
      for (const t of done) wrap.appendChild(todoRow(t, project, handlers, { now, showDirection: true }))
      responsesBlock(wrap, respOf(project, d.key), project, handlers)
    }
    if (!printed) { const e = document.createElement('div'); e.className = 'epv-empty'; e.textContent = 'No to-dos.'; wrap.appendChild(e) }
    return wrap
  }

  let open = openOf(project, tabKey).sort(sorterOf(sort && sort.by))
  if (handlers.hideNotDue) open = open.filter(isDueDated)
  // resolved rows in TIME order, newest resolution first (same as the All tab / Tasks page) —
  // they used to render in storage order (user, 2026-08-19)
  const done = hideDone
    ? []
    : doneOf(project, tabKey).sort((a, b) => (Number(b.resolved_asof) || 0) - (Number(a.resolved_asof) || 0))
  if (!open.length) { const e = document.createElement('div'); e.className = 'epv-empty'; e.textContent = 'Nothing outstanding here.'; wrap.appendChild(e) }
  // clear this ONE bucket in one go — resolved, or cancelled — plus the date/priority sort toggle
  const bucketBar = bucketBulkBar(tabKey, open.length, onResolveBucket, sort)
  if (bucketBar) wrap.appendChild(bucketBar)
  // 5 rows up front, then "+ N more" expands IN PLACE (same behaviour as the resolved list —
  // it used to point at the All tab instead of expanding; user, 2026-08-20)
  const OPEN_CAP = 5
  const openShown = showOpen ? open : open.slice(0, OPEN_CAP)
  for (const t of openShown) wrap.appendChild(todoRow(t, project, handlers, { now }))
  if (open.length > openShown.length) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'epv-more-btn'
    b.textContent = '+ ' + (open.length - openShown.length) + ' more open'
    b.addEventListener('click', (e) => { e.stopPropagation(); onExpandOpen && onExpandOpen() })
    wrap.appendChild(b)
  }
  responsesBlock(wrap, respOf(project, tabKey), project, handlers)
  resolvedBlock(wrap, done, project, handlers, now, showResolved, onExpandResolved)
  return wrap
}

function defaultTab (project, onlyMine) {
  if (onlyMine) return 'i_owe_them'
  for (const k of ['i_owe_them', 'team_owes', 'they_owe_me', 'read_only']) if (openOf(project, k).length) return k
  return 'all'
}

// ---- view-state registry: what survives a re-render ----------------------------------
// The board is rebuilt wholesale whenever data changes — which now includes BACKGROUND runs
// landing while the user is mid-read. Card view state (expanded, active tab, resolved shown)
// therefore lives here, keyed by project_id, so a data refresh repaints the same view instead of
// collapsing everything the user had open. Board cards only — the project MODAL (noCollapse) is
// its own transient view and must not disturb the board's memory of the same project.
const cardStates = new Map() // project_id -> { expanded, tab, showResolved }

// The page's expand-all / collapse-all: an explicit user command overrides every remembered state.
export function setAllCardStates (expanded) {
  for (const s of cardStates.values()) s.expanded = !!expanded
}

// ---- the full expandable card -------------------------------------------------------
// handlers: { openEmailModal(todo, project), onResolve(todo, project), onCancel(todo, project), onChange() }
export function renderExpandableProject (project, handlers = {}) {
  const card = document.createElement('div'); card.className = 'epv-card'
  // noCollapse (the project MODAL) and transient (frozen snapshots on the training view) are
  // their own throwaway views — they never touch the board's remembered states
  const keyed = !handlers.noCollapse && !handlers.transient && project.project_id
  let state = keyed ? cardStates.get(project.project_id) : null
  if (!state) {
    // handlers.startTab forces the opening tab (the project MODAL uses it: a just-created
    // project opens on "+ Add" so the first thing you do is type a task)
    state = { expanded: !!handlers.startExpanded || !!handlers.noCollapse, tab: handlers.startTab || defaultTab(project, handlers.onlyMine), showResolved: false, showOpen: false }
    // the last DIRECTION tab the user looked at — "+ Add" defaults its Direction to it
    state.lastDirTab = DIR_BY_KEY[state.tab] ? state.tab : 'i_owe_them'
    state.sortBy = 'date' // open rows: 'date' (newest first, the default) or 'priority'
    if (keyed) cardStates.set(project.project_id, state)
  }
  const now = handlers.now || 0

  // the card leaves the board with a collapse+fade when an edit drops the project below the
  // active filters (e.g. its last open task resolved while Hide-resolved is on) — so the user
  // sees THIS project go, rather than the next one silently taking its place
  function animateOut () {
    if (!card.isConnected) { handlers.onChange && handlers.onChange(); return }
    card.style.maxHeight = card.scrollHeight + 'px'
    card.classList.add('epv-card-leaving')
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('epv-card-gone')))
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      card.remove()
      handlers.onChange && handlers.onChange()
    }
    card.addEventListener('transitionend', finish, { once: true })
    setTimeout(finish, 700) // safety net if transitions are disabled
  }

  const after = () => {
    if (handlers.stillVisible && !handlers.stillVisible(project)) { animateOut(); return }
    paint(); handlers.onChange && handlers.onChange()
  }

  // BULK on ONE bucket (the per-tab bar: "I owe" alone, "Read" alone…) — resolved (done) or
  // cancelled (never going to happen). One bulk event either way when the page provides
  // onResolveAll; else per-task through the normal handlers. The whole-project variant is gone
  // with the title-bar button — a tab is the scope people actually mean (user, 2026-08-21).
  const canResolveAll = !!(handlers.onResolveAll || handlers.onResolve)
  function resolveAll (dirKey, status = 'resolved') {
    const cancelling = status === 'cancelled'
    const open = (project.todos || []).filter(isOpen).filter(t => !dirKey || t.direction === dirKey)
    if (!open.length) return
    const what = dirKey
      ? open.length + ' open “' + ((DIR_BY_KEY[dirKey] || {}).label || dirKey) + '” to-do(s)'
      : 'all ' + open.length + ' open to-do(s)'
    const asks = cancelling
      ? 'Cancel ' + what + ' in “' + (project.name || 'this project') + '”? They will show as cancelled, not done.'
      : 'Mark ' + what + ' in “' + (project.name || 'this project') + '” as resolved?'
    if (!window.confirm(asks)) return
    if (handlers.onResolveAll) handlers.onResolveAll(project, { direction: dirKey || null, status })
    else for (const t of open) (cancelling ? handlers.onCancel : handlers.onResolve)(t, project)
    after()
  }

  const baseOpts = {
    now,
    self: handlers.self,
    nameOf: handlers.nameOf,
    onOpenPerson: handlers.onOpenPerson,
    hideNotDue: handlers.hideNotDue,
    onImportance: handlers.onProjectImportance ? (p, d) => { handlers.onProjectImportance(p, d); after() } : null,
    // △ at the end of the project's name → the project editor (rename / priority / merge)
    onEdit: handlers.onEditProject ? () => handlers.onEditProject(project, after) : null
  }

  // pass EVERYTHING through to the shared task rows (nameOf / self / onEdit / onOpenPerson…),
  // wrapping the three mutating ops so the card reflects the change immediately
  const h = {
    ...handlers,
    onResolve: (t, p) => { handlers.onResolve && handlers.onResolve(t, p); after() },
    onCancel: (t, p) => { handlers.onCancel && handlers.onCancel(t, p); after() },
    onImportance: handlers.onImportance ? (t, d, p) => { handlers.onImportance(t, d, p); after() } : null,
    // △ the task editor: rename / due / OWNERSHIP / move project all change what this card should
    // show, so the editor's save must repaint it. The page's own onChange is not enough — it
    // refreshes the page's side panels, not this card (user, 2026-08-17: "we need to refresh the
    // project ui to reflect that change").
    onEdit: handlers.onEdit ? (t, p) => handlers.onEdit(t, p, { onChange: after }) : null,
    // a draft edited / dismissed / sent from a response card also changes what belongs on the card
    onChange: after
  }
  const selectTab = (key) => {
    if (DIR_BY_KEY[key]) state.lastDirTab = key // "+ Add" defaults its Direction to this
    state.tab = key; state.showResolved = false; state.showOpen = false; paint()
  }

  function paint () {
    card.textContent = ''
    card.classList.toggle('expanded', state.expanded)

    const head = document.createElement('div'); head.className = 'epv-headrow'
    // the logo pentagon IS the expand control: points right collapsed, inverts down expanded.
    // In noCollapse mode (project modal) it is a fixed, inert mark — collapsing is page-only.
    if (handlers.noCollapse) {
      const mark = document.createElement('span'); mark.className = 'epv-toggle epv-toggle-fixed'
      const tri = document.createElement('span'); tri.className = 'proj-mark proj-mark-toggle'
      mark.appendChild(tri)
      head.appendChild(mark)
    } else {
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'epv-toggle'
      const tri = document.createElement('span'); tri.className = 'proj-mark proj-mark-toggle'
      toggle.appendChild(tri)
      toggle.title = state.expanded ? 'Collapse' : 'Expand'
      toggle.addEventListener('click', () => { state.expanded = !state.expanded; paint() })
      head.appendChild(toggle)
    }
    const base = renderProjectBase(project, baseOpts)
    base.style.flex = '1 1 auto'
    if (!handlers.noCollapse) {
      base.addEventListener('click', (e) => { if (e.target.closest('.epv-row, .epv-tabs')) return; state.expanded = !state.expanded; paint() })
    } else {
      base.style.cursor = 'default'
    }
    head.appendChild(base)
    card.appendChild(head)

    if (!state.expanded) return

    // the brief description under the pentagon (the △ on the title band opens the editor)
    if (project.summary) {
      const edrow = document.createElement('div'); edrow.className = 'epv-editrow'
      const s = document.createElement('div'); s.className = 'epv-summary'; s.textContent = project.summary; edrow.appendChild(s)
      card.appendChild(edrow)
    }

    const tabs = document.createElement('div'); tabs.className = 'epv-tabs'
    // The bar scrolls sideways when the tabs outgrow it (index.css). No browser turns a VERTICAL
    // wheel into horizontal scroll on its own — Shift+wheel and a trackpad swipe do, a plain mouse
    // does not — so on a narrow desktop window an overflowing bar looks stuck. Translate the wheel
    // here, and only swallow the event while the bar can actually take the delta: at either end it
    // goes back to the page, so scrolling past a card never traps the pointer.
    tabs.addEventListener('wheel', (e) => {
      if (e.shiftKey || e.ctrlKey || !e.deltaY) return
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return // a real sideways swipe — leave it be
      const max = tabs.scrollWidth - tabs.clientWidth
      if (max <= 0) return
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * tabs.clientWidth : e.deltaY
      const next = Math.max(0, Math.min(max, tabs.scrollLeft + px))
      if (next === tabs.scrollLeft) return // already at that end — the page takes the scroll
      tabs.scrollLeft = next
      e.preventDefault()
    }, { passive: false })
    // every bucket always gets its tab — Hide-not-mine only decides whether the PROJECT shows
    for (const d of DIRS) {
      let open = openOf(project, d.key); const done = doneOf(project, d.key)
      if (handlers.hideNotDue) open = open.filter(isDueDated)
      const t = document.createElement('button'); t.type = 'button'
      t.className = 'epv-tab' + (state.tab === d.key ? ' active' : '') + (open.length ? '' : ' empty')
      t.appendChild(dirDisc(d.key, open.length ? maxImp(open) : null))
      t.appendChild(document.createTextNode(' ' + d.tab + (open.length ? ' ' + open.length : '') +
        (done.length && !handlers.hideResolved ? ' ·' + done.length + '✓' : '')))
      t.addEventListener('click', () => selectTab(d.key))
      tabs.appendChild(t)
    }
    const all = document.createElement('button'); all.type = 'button'
    all.className = 'epv-tab epv-tab-all' + (state.tab === 'all' ? ' active' : '')
    all.textContent = 'All To-dos'
    all.addEventListener('click', () => selectTab('all'))
    tabs.appendChild(all)
    // Messages — only where the page injects the events log (ui.js setEventsProvider); the
    // test pages render cards without one and simply don't get the tab
    if (handlers.getEvents) {
      const msgs = document.createElement('button'); msgs.type = 'button'
      msgs.className = 'epv-tab' + (state.tab === 'messages' ? ' active' : '')
      msgs.textContent = 'Messages'
      msgs.title = 'The analysed emails behind this project, thread-grouped, newest first'
      msgs.addEventListener('click', () => selectTab('messages'))
      tabs.appendChild(msgs)
    }
    const recent = document.createElement('button'); recent.type = 'button'
    recent.className = 'epv-tab' + (state.tab === 'recent' ? ' active' : '')
    recent.textContent = 'Events'
    recent.title = 'What happened on this project, newest first'
    recent.addEventListener('click', () => selectTab('recent'))
    tabs.appendChild(recent)
    if (handlers.onAddTask) {
      const add = document.createElement('button'); add.type = 'button'
      add.className = 'epv-tab epv-tab-add' + (state.tab === 'add' ? ' active' : '')
      add.textContent = '+ Add'
      add.title = 'Add a to-do to this project by hand'
      add.addEventListener('click', () => selectTab('add'))
      tabs.appendChild(add)
    }
    card.appendChild(tabs)

    if (state.tab === 'add' && handlers.onAddTask) {
      card.appendChild(renderAddTab(project, handlers, {
        defaultDir: state.lastDirTab, // the direction tab the user was just looking at
        onSaved: (direction) => { state.tab = direction; state.lastDirTab = direction; after() } // land on the new task's tab
      }))
      return
    }

    card.appendChild(renderTabContent(project, state.tab, h, {
      now,
      showResolved: state.showResolved,
      onExpandResolved: () => { state.showResolved = true; paint() },
      showOpen: state.showOpen,
      onExpandOpen: () => { state.showOpen = true; paint() },
      onResolveBucket: canResolveAll ? resolveAll : null,
      sort: { by: state.sortBy, onToggle: () => { state.sortBy = state.sortBy === 'priority' ? 'date' : 'priority'; paint() } }
    }))
    const active = tabs.querySelector('.epv-tab.active')
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  paint()
  return card
}

// ---- a default email modal — an EVENT rendering of the to-do's emails ----------------
// Two panes: LEFT = the events (the messages where this to-do was created/changed), each with
// its date + what it did to this item; RIGHT = the selected event. If a message lookup is
// available (opts.lookupMessage(msg_id) → { from, to, cc, date, subject, clean_text }) the right
// pane shows sender / recipients / date / text; otherwise it shows what the evidence carries.
// When opts.openFullEmail(evidenceEvent) is provided (e.g. the shared emailViewer), the footer
// offers "Open full email + thread". Hosts may pass their own openEmailModal entirely; this is
// the default.
export function defaultEmailModal (todo, project, opts = {}) {
  const lookup = opts.lookupMessage || (() => null)
  const events = (todo.evidence || []).slice()

  // stacked shell — this modal may itself open the full email viewer on top of it
  const { overlay, modal } = openModalShell({ className: 'epv-modal-wide' })

  const title = document.createElement('div'); title.className = 'epv-modal-title'; title.textContent = todo.short_description || '(to-do)'
  modal.appendChild(title)
  const meta = document.createElement('div'); meta.className = 'epv-modal-meta'
  meta.textContent = (DIR_BY_KEY[todo.direction] ? DIR_BY_KEY[todo.direction].label : todo.direction) +
    ' · importance ' + (todo.importance || '?') + '/5' +
    (todo.sender ? ' · raised by ' + todo.sender : '') + (todo.owner ? ' · owner ' + todo.owner : '')
  if (project && project.name) meta.appendChild(projectChip(project.name))
  modal.appendChild(meta)
  if (todo.description) { const d = document.createElement('div'); d.className = 'epv-modal-desc'; d.textContent = todo.description; modal.appendChild(d) }

  const body = document.createElement('div'); body.className = 'epv-modal-body'
  const left = document.createElement('div'); left.className = 'epv-modal-events'
  const lh = document.createElement('div'); lh.className = 'epv-modal-head'; lh.textContent = 'Emails (' + events.length + ')'; left.appendChild(lh)
  const right = document.createElement('div'); right.className = 'epv-modal-detail'

  function showEvent (ev) {
    right.textContent = ''
    if (ev && ev.summary) {
      const s = document.createElement('div'); s.className = 'epv-eml-sum'; s.textContent = ev.summary
      s.title = 'the model’s one-sentence summary of this message'
      right.appendChild(s)
    }
    const msg = ev && lookup(ev.msg_id)
    if (msg) {
      const tbl = document.createElement('div'); tbl.className = 'epv-eml-head'
      const from = msg.from ? (msg.from.name ? msg.from.name + ' <' + msg.from.address + '>' : msg.from.address) : '?'
      const lines = [['From', from], ['To', addrLine(msg.to)], (msg.cc && msg.cc.length ? ['Cc', addrLine(msg.cc)] : null), ['Date', fmtDate(msg.date || ev.asof)], ['Subject', msg.subject || '']]
      for (const ln of lines) { if (!ln) continue; const r = document.createElement('div'); const k = document.createElement('b'); k.textContent = ln[0] + ': '; r.appendChild(k); r.appendChild(document.createTextNode(ln[1] || '—')); tbl.appendChild(r) }
      right.appendChild(tbl)
      const pre = document.createElement('pre'); pre.className = 'epv-eml-body'; pre.textContent = msg.clean_text || '(no body)'; right.appendChild(pre)
    } else {
      const note = document.createElement('div'); note.className = 'epv-modal-meta'
      note.textContent = ev ? ('📧 ' + fmtDate(ev.asof) + ' · ' + (ev.msg_id || '?') + (ev.reason ? ' — ' + ev.reason : '')) : 'No event selected.'
      right.appendChild(note)
      const stub = document.createElement('div'); stub.className = 'epv-empty'; stub.textContent = 'Message body not available in this view.'; right.appendChild(stub)
    }
    const foot = document.createElement('div'); foot.className = 'epv-modal-foot'
    if (opts.openFullEmail && ev && ev.msg_id && ev.thread_id) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'epv-resp-btn full'
      b.textContent = 'Open full email + thread ↗'; b.title = 'Read the complete email (with its whole thread)'
      b.addEventListener('click', () => opts.openFullEmail(ev))
      foot.appendChild(b)
    } else {
      foot.textContent = 'The full email is not available for this item.'
    }
    right.appendChild(foot)
  }

  events.forEach((ev, i) => {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'epv-modal-event' + (i === 0 ? ' active' : '')
    row.appendChild(kindDisc(ev.source === 'manual' ? 'manual' : 'message'))
    const body = document.createElement('div'); body.className = 'epv-ev-body'
    const d = document.createElement('div'); d.className = 'epv-ev-date'; d.textContent = fmtDate(ev.asof)
    const r = document.createElement('div'); r.className = 'epv-ev-what'
    r.textContent = (ev.who ? ev.who + ' — ' : '') + (ev.reason || (i === 0 ? 'created' : 'updated'))
    body.appendChild(d); body.appendChild(r)
    row.appendChild(body)
    row.addEventListener('click', () => { left.querySelectorAll('.epv-modal-event').forEach(b => b.classList.remove('active')); row.classList.add('active'); showEvent(ev) })
    left.appendChild(row)
  })
  if (!events.length) { const n = document.createElement('div'); n.className = 'epv-empty'; n.textContent = 'No linked emails yet.'; left.appendChild(n) }

  body.appendChild(left); body.appendChild(right); modal.appendChild(body)
  showEvent(events[0] || null)
  return overlay
}
