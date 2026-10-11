// recentUi.js — DOM rendering for the TASKS page: the page-wide tab bar (the project card's tab
// language across ALL projects — I owe / Team / Owed / Read / People / All Tasks / Events), the
// flat cross-project task lists (real task rows with working resolve checkboxes, each carrying
// its project pill), the per-person grouping, the All-Tasks archive view, and the Events tab's
// "Resolved" list, automation decisions, and per-project activity cards whose narrative lines
// read like a story ("Bob added X · Alice resolved Y"). Clicking a project opens the live card
// in a full-screen modal (ui.js openProjectModal — wired by recent.js through onSelect).
// Text-only rendering — all content is untrusted. Entity components come from renderUtils.js.

import {
  fmtAgo, impBadge, impClassBl, span, div,
  taskChip, projectChip, eventChip, kindDisc, dirDisc, taskRowEl
} from '../shared/renderUtils.js'

export { fmtAgo } // recent.js reads it from here

// The section head IS the page's title row — so it is also where the page's sort control lives:
// right-aligned on the same line as "I owe" / "Team owes" / …, in the project card's pill
// language, instead of buried in the filter bar (user, 2026-08-31). `tools` is any node the
// caller wants parked on the right of that line.
function sectionHead (host, title, count, hint, tools) {
  const h = div('rc-sec-head')
  h.appendChild(span('rc-sec-title', title))
  h.appendChild(span('rc-sec-count', String(count)))
  if (hint) h.appendChild(span('rc-sec-hint', hint))
  if (tools) { tools.classList.add('rc-sec-tools'); h.appendChild(tools) }
  host.appendChild(h)
}

function emptyLine (host, text) {
  host.appendChild(div('rc-empty', text))
}

// ---- one action as THE standard task row (identical to the project-card rows) --------------
// a: an action from recentData ({ project_id, todo_id, ... }); handlers from recent.js:
//   { resolveEntry(a) => { todo, project } | null,   — the LIVE store objects
//     taskHandlers,                                  — same shape as the board's handlers
//     onOpenProject(project) }                       — opens the project modal
function actionTaskRow (a, { resolveEntry, taskHandlers, onOpenProject } = {}) {
  const ent = resolveEntry && resolveEntry(a)
  if (ent) {
    return taskRowEl(ent.todo, ent.project, taskHandlers || {}, {
      projectName: ent.project.name,
      onOpenProject
    })
  }
  // the todo no longer exists in its project (moved / deleted) — a plain, read-only remnant,
  // laid out like a real row so the date column lines up
  const row = div('epv-row task-row' + (a.done ? ' done' : ''))
  const short = span('epv-short ' + impClassBl(a.imp), a.short)
  short.title = 'this to-do is no longer in its project (moved or deleted)'
  row.appendChild(short)
  const tail = span('task-tail')
  tail.appendChild(span('epv-rowdate', fmtAgo(a.msgDate || a.when)))
  row.appendChild(tail)
  return row
}

// ---- "Automation decisions" — a sender put on autopilot, or a straddle flagged --------------
// Its own section because these are the events the user must be able to OVERRULE: once a sender is
// learned, their mail is filed with no LLM read at all, so this row is the only warning they get.
// handlers.onStopAutofile(address) turns it off for good; onOpenPerson opens the tri-state control.
export function renderDecisions (host, items, { onStopAutofile, onOpenPerson } = {}) {
  host.textContent = ''
  if (!items.length) { host.style.display = 'none'; return }
  host.style.display = ''
  sectionHead(host, 'Automation decisions', items.length, 'mail now handled without the AI — overrule here')
  const list = div('rc-tasklist')
  for (const a of items) {
    const row = div('epv-row rc-decision')
    row.appendChild(span('rc-dec-who', a.who))
    row.appendChild(span('rc-dec-verb', a.verb))
    row.appendChild(span('epv-short ' + impClassBl(a.imp), a.short))
    if (a.summary) {
      const why = div('rc-dec-why', a.summary)
      why.title = a.summary
      row.appendChild(why)
    }
    const tail = span('task-tail')
    const addr = a.autofile && a.autofile.address
    if (addr && onStopAutofile) {
      const b = document.createElement('button')
      b.className = 'rc-dec-stop'
      b.textContent = 'Don’t auto-file'
      b.title = 'Analyse every message from ' + addr + ' from now on'
      b.addEventListener('click', async () => { b.disabled = true; await onStopAutofile(addr) })
      tail.appendChild(b)
    }
    if (addr && onOpenPerson) {
      const b2 = document.createElement('button')
      b2.className = 'rc-dec-edit'
      b2.textContent = 'Change'
      b2.title = 'Choose where their mail files, or reset it'
      b2.addEventListener('click', () => onOpenPerson(addr))
      tail.appendChild(b2)
    }
    tail.appendChild(span('epv-rowdate', fmtAgo(a.msgDate || a.when)))
    row.appendChild(tail)
    list.appendChild(row)
  }
  host.appendChild(list)
}

// ---- the page tab bar — the project card's tabs, page-wide across all projects --------------

export const PAGE_DIRS = [
  { key: 'i_owe_them', tab: 'I owe' },
  { key: 'team_owes', tab: 'Team' },
  { key: 'they_owe_me', tab: 'Owed' },
  { key: 'read_only', tab: 'Read' }
]

// counts/maxImps are keyed by tab key; direction tabs show their open count + a dir disc tinted
// by the bucket's top importance, exactly like the card's tabs.
export function renderPageTabs (host, { active, counts = {}, maxImps = {}, onSelect }) {
  host.textContent = ''
  const bar = div('rc-tabs')
  const mk = (key, label, { disc = null, title = '', cls = '' } = {}) => {
    const b = document.createElement('button'); b.type = 'button'
    b.className = 'epv-tab rc-tab' + cls + (active === key ? ' active' : '')
    if (disc) b.appendChild(disc)
    b.appendChild(document.createTextNode(label))
    if (title) b.title = title
    b.addEventListener('click', () => onSelect(key))
    bar.appendChild(b)
  }
  for (const d of PAGE_DIRS) {
    const n = counts[d.key] || 0
    mk(d.key, ' ' + d.tab + (n ? ' ' + n : ''), {
      disc: dirDisc(d.key, n ? maxImps[d.key] : null),
      cls: n ? '' : ' empty'
    })
  }
  // the page-wide views sit RIGHT-aligned, apart from the direction tabs (same split as the
  // project card's tab bar — rc-tab-gap carries the margin-left:auto)
  mk('people', 'People' + (counts.people ? ' ' + counts.people : ''),
    { title: 'Open items grouped by the person who owes them', cls: (counts.people ? '' : ' empty') + ' rc-tab-gap' })
  mk('all', 'All To-dos', { title: 'Every direction, including resolved — the archive view' })
  mk('messages', 'Messages' + (counts.messages ? ' ' + counts.messages : ''),
    { title: 'The message history behind the to-dos: every analysed email in this window, newest first' })
  mk('events', 'Events' + (counts.events ? ' ' + counts.events : ''),
    { title: 'What happened in this window: resolutions, automation decisions and project activity' })
  host.appendChild(bar)
}

// ---- a direction tab: one flat cross-project list of LIVE task rows -------------------------
// entries: [{ todo, project }] — already filtered/sorted by recent.js.
export function renderTaskEntries (host, entries, { taskHandlers, onOpenProject } = {}, { title, hint, empty, tools } = {}) {
  host.textContent = ''
  sectionHead(host, title, entries.length, hint, tools)
  if (!entries.length) { emptyLine(host, empty || 'Nothing here — widen the timeframe to see more.'); return }
  const list = div('rc-tasklist')
  for (const e of entries) {
    list.appendChild(taskRowEl(e.todo, e.project, taskHandlers, { projectName: e.project.name, onOpenProject }))
  }
  host.appendChild(list)
}

// ---- the People tab: the same open items, grouped by WHO owes them --------------------------
// Master-detail like the People page: a sortable person list on the left (priority or name),
// the selected person's owed/team items on the right. people: [{ name, address, rank,
// owedEntries, teamEntries }] precomputed by recent.js; `selected` is the resolved person object.
export function renderPeopleTab (host, people, {
  taskHandlers, onOpenProject, onOpenPerson,
  selected, sort, onSelectPerson, onSortChange, tools
} = {}) {
  host.textContent = ''
  sectionHead(host, 'People', people.length, 'who owes what — pick a person to see their items', tools)
  if (!people.length) { emptyLine(host, 'No open items owed by anyone match the current filters.'); return }

  const cols = div('rc-people-cols')

  // ---- left: the person list, with the sort toggle on top ----
  const list = div('rc-people-list')
  const sortRow = div('rc-people-sort')
  sortRow.appendChild(span('rc-people-sortlbl', 'sort:'))
  for (const [key, label] of [['rank', 'priority'], ['name', 'name']]) {
    const b = document.createElement('button'); b.type = 'button'
    b.className = 'rc-people-sortbtn' + (sort === key ? ' active' : '')
    b.textContent = label
    b.addEventListener('click', () => onSortChange && onSortChange(key))
    sortRow.appendChild(b)
  }
  list.appendChild(sortRow)
  for (const person of people) {
    const row = document.createElement('button'); row.type = 'button'
    row.className = 'rc-people-row' + (selected && selected.address === person.address ? ' active' : '')
    const top = div('rc-people-row-top')
    top.appendChild(span('rc-people-row-name', person.name))
    top.appendChild(impBadge(person.rank))
    row.appendChild(top)
    const bits = []
    if (person.owedEntries.length) bits.push(person.owedEntries.length + ' owed to you')
    if (person.teamEntries.length) bits.push(person.teamEntries.length + ' team')
    row.appendChild(div('rc-people-row-sub', bits.join(' · ')))
    row.title = person.address
    row.addEventListener('click', () => onSelectPerson && onSelectPerson(person.address))
    list.appendChild(row)
  }
  cols.appendChild(list)

  // ---- right: the selected person's items ----
  const detail = div('rc-person-detail')
  if (selected) {
    const card = div('rc-person')
    const head = div('rc-person-head')
    const nameBtn = document.createElement('button'); nameBtn.type = 'button'; nameBtn.className = 'rc-person-name'
    nameBtn.textContent = selected.name
    nameBtn.title = selected.address + ' — edit profile & special instructions'
    nameBtn.addEventListener('click', () => onOpenPerson && onOpenPerson(selected.address))
    head.appendChild(nameBtn)
    head.appendChild(span('rc-person-meta', selected.address))
    card.appendChild(head)
    const addGroup = (dirKey, label, entries) => {
      if (!entries.length) return
      const gh = div('rc-person-dir')
      gh.appendChild(dirDisc(dirKey, entries.reduce((m, e) => Math.max(m, e.todo.importance || 0), 0) || 3))
      gh.appendChild(span('rc-person-dirlbl', label + ' (' + entries.length + ')'))
      card.appendChild(gh)
      const tl = div('rc-tasklist')
      for (const e of entries) tl.appendChild(taskRowEl(e.todo, e.project, taskHandlers, { projectName: e.project.name, onOpenProject }))
      card.appendChild(tl)
    }
    addGroup('they_owe_me', 'They owe you', selected.owedEntries)
    addGroup('team_owes', 'Team items', selected.teamEntries)
    detail.appendChild(card)
  }
  cols.appendChild(detail)
  host.appendChild(cols)
}

// ---- the All Tasks tab: the archive view — every direction, open then resolved --------------
// groups: [{ key, tab, open: entries[], done: entries[] }]. Resolved rows are capped per
// direction until onExpandResolved (a single page-level "show every resolved row" state).
export function renderAllTasksTab (host, groups, { taskHandlers, onOpenProject, showAllResolved, onExpandResolved, tools } = {}) {
  host.textContent = ''
  const total = groups.reduce((s, g) => s + g.open.length + g.done.length, 0)
  sectionHead(host, 'All to-dos', total, 'every direction across every project — resolved included', tools)
  const DONE_CAP = 10
  let printed = false
  for (const g of groups) {
    if (!g.open.length && !g.done.length) continue
    printed = true
    const h = div('epv-all-head rc-all-head')
    h.appendChild(dirDisc(g.key, g.open.reduce((m, e) => Math.max(m, e.todo.importance || 0), 0) || null))
    h.appendChild(span('', ' ' + g.tab + ' · ' + g.open.length + ' open' + (g.done.length ? ' · ' + g.done.length + ' resolved' : '')))
    host.appendChild(h)
    const list = div('rc-tasklist')
    // every direction in one list — each row leads with its own mark (user, 2026-08-21)
    const rowEl = (e) => taskRowEl(e.todo, e.project, taskHandlers,
      { projectName: e.project.name, onOpenProject, showDirection: true })
    for (const e of g.open) list.appendChild(rowEl(e))
    const doneShown = showAllResolved ? g.done : g.done.slice(0, DONE_CAP)
    for (const e of doneShown) list.appendChild(rowEl(e))
    host.appendChild(list)
    if (g.done.length > doneShown.length) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'epv-more-btn'
      b.textContent = '+ ' + (g.done.length - doneShown.length) + ' more resolved'
      b.addEventListener('click', () => onExpandResolved && onExpandResolved())
      host.appendChild(b)
    }
  }
  if (!printed) emptyLine(host, 'No to-dos match the current filters.')
}

// ---- "Resolved" — closed while you were away ----------------------------------------------

export function renderResolved (host, items, handlers = {}) {
  host.textContent = ''
  sectionHead(host, 'Resolved', items.length, 'closed off in this window')
  if (!items.length) { emptyLine(host, 'Nothing was resolved in this window.'); return }
  const list = div('rc-tasklist')
  for (const a of items) list.appendChild(actionTaskRow(a, handlers))
  host.appendChild(list)
}

// ---- per-project activity narrative ---------------------------------------------------------

// ---- OTHER project activity ------------------------------------------------------------------
// The windowed slice of the same event language the project card's Events tab shows in full:
// one line per email received (sender + summary, ✉ opens the thread) and your manual edits
// (priorities, cancels, reopens). Per-task change lines are dropped — they duplicated the
// For-you/Resolved task lists, and the email summary carries the story. Resolves live in the
// Resolved section. For anything older than the window: explore the project (its Events tab).

// a manual edit line: ✍️disc · you <verb> [task] · when — or, for a clean-up change you accepted
// (who_kind 'superlazy' on a hand-edit-shaped action), 🧹disc · the clean-up <verb> [task]
function manualLine (a, { onSelectProject } = {}) {
  const li = div('rc-act rc-act-manual')
  li.appendChild(kindDisc(a.who_kind === 'superlazy' ? 'cleanup' : 'manual'))
  const text = span('rc-act-text')
  const who = document.createElement('b'); who.textContent = a.who; text.appendChild(who)
  text.appendChild(document.createTextNode(' ' + a.verb + ' '))
  text.appendChild(taskChip(a.short, a.imp, onSelectProject ? () => onSelectProject(a.project_id) : null))
  li.appendChild(text)
  li.appendChild(span('rc-act-when', fmtAgo(a.when)))
  return li
}

// an email line: ✉disc · who: "the model's one-sentence summary" (subject when no summary) · when · ✉
function emailLine (a, { onOpenEmail } = {}) {
  const li = div('rc-act rc-act-mail')
  li.appendChild(kindDisc(a.auto ? 'auto' : 'message'))
  const text = span('rc-act-text')
  const who = document.createElement('b'); who.textContent = a.who; text.appendChild(who)
  text.appendChild(document.createTextNode(': '))
  const sm = span('rc-act-summary', a.summary || a.subject || '(email processed)')
  sm.title = a.subject || ''
  text.appendChild(sm)
  li.appendChild(text)
  li.appendChild(span('rc-act-when', fmtAgo(a.msgDate || a.when))) // the EMAIL's date, not parse time
  if (a.msg_id && a.thread_id && onOpenEmail) {
    li.appendChild(eventChip(null, () => onOpenEmail(a), { title: 'Open the full email + thread' + (a.subject ? ': ' + a.subject : '') }))
  }
  return li
}

// hide: { manual, auto } — the filter bar's Hide checkboxes
function otherActivityLines (actions, hide = {}) {
  const out = []
  const seenMsg = new Set()
  for (const a of actions) {
    if (a.manual) {
      if (a.verb === 'resolved') continue // already in the Resolved section
      if (hide.manual) continue
      out.push({ kind: 'manual', a })
    } else if (a.msg_id && !seenMsg.has(a.msg_id)) {
      seenMsg.add(a.msg_id)
      if (hide.auto && a.auto) continue
      out.push({ kind: 'email', a })
    }
  }
  return out
}

export function renderProjectGroups (host, groups, { onSelect, onOpenEmail, hide = {} } = {}) {
  host.textContent = ''
  sectionHead(host, 'Other project activity', groups.length, 'emails + your edits in this window — open a project for its full story')
  if (!groups.length) { emptyLine(host, 'No project activity in this window.'); return }
  for (const g of groups) {
    const card = div('rc-proj')
    card.addEventListener('click', () => onSelect && onSelect(g.project.project_id))

    // a project REFERENCE, not the project itself — plain title line (no band, no description);
    // the pentagon still says where the click lands
    const head = div('rc-proj-head')
    head.appendChild(span('proj-mark'))
    head.appendChild(span('rc-proj-name', g.project.name || '(untitled project)'))
    head.appendChild(impBadge(g.project.importance))
    const bits = []
    if (g.emails.size) bits.push(g.emails.size + ' email' + (g.emails.size === 1 ? '' : 's'))
    if (g.autoProcessed) bits.push(g.autoProcessed + ' auto-processed')
    if (g.people.size) bits.push([...g.people].slice(0, 3).join(', '))
    head.appendChild(span('rc-proj-meta', bits.join(' · ')))
    head.appendChild(span('rc-proj-explore', 'open ▸'))
    card.appendChild(head)

    const acts = div('rc-proj-acts')
    const MAX = 6
    const lines = otherActivityLines(g.actions, hide)
    for (const l of lines.slice(-MAX)) {
      acts.appendChild(l.kind === 'email'
        ? emailLine(l.a, { onOpenEmail })
        : manualLine(l.a, { onSelectProject: onSelect }))
    }
    if (lines.length > MAX) {
      acts.prepend(div('rc-act-more', '+ ' + (lines.length - MAX) + ' earlier in this window — explore for the full story'))
    }
    if (!lines.length) acts.appendChild(div('rc-act-more', 'to-do changes only — see For you / Resolved above'))
    card.appendChild(acts)
    host.appendChild(card)
  }
}
