// styleguide.js — entry point for the STYLEGUIDE test page (not in the nav menu). Renders every
// entity treatment — tokens, chips, task rows, event rows, person avatars, the project card —
// through the REAL shared components (renderUtils.js / expandableProjectView.js / eventsUi.js)
// fed with mock fixtures, so refining here directly refines production. No freezr data calls.

import { renderTopBar } from '../shared/topbar.js'
import {
  div, span, btn, impBadge, avatarEl, kindDisc, dirDisc, DIR_LABEL, doneMark, myTodosIcon,
  projectChip, eventChip, personChip, taskChip, taskRowEl
} from '../shared/renderUtils.js'
import { renderExpandableProject } from '../shared/expandableProjectView.js'
import { renderEventCard } from '../pages/eventsUi.js'
import { mockProject, mockProject2, mockEvents, mockEventCtx, mockPeople, NAME_OF, SELF } from './styleguideFixtures.js'

renderTopBar('styleguide')

const sg = document.getElementById('sg')
const note = document.getElementById('sgNote')
let noteTimer = null
const flash = (msg) => {
  note.textContent = '⚡ ' + msg
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => { note.textContent = '' }, 2200)
}

function section (title, sub) {
  const s = div('sg-section')
  s.appendChild(div('sg-h', title))
  if (sub) s.appendChild(div('sg-sub', sub))
  const box = div('sg-box')
  s.appendChild(box)
  sg.appendChild(s)
  return box
}
const caption = (box, text) => box.appendChild(div('sg-cap', text))
const row = (box) => { const r = div('sg-row'); box.appendChild(r); return r }

// ---- 1. tokens --------------------------------------------------------------------------
{
  const box = section('Design tokens', 'One rule: COLOUR MEANS IMPORTANCE, nothing else. Direction and event kind are carried by emoji; people are neutral; project chrome is a flat slate. Rings (on avatars and direction discs) always mean importance.')
  const swatch = (varName, label) => {
    const w = div('sg-swatch')
    const c = div('sg-swatch-c')
    c.style.background = 'var(' + varName + ')'
    w.appendChild(c)
    w.appendChild(div('sg-swatch-l', label))
    return w
  }
  caption(box, 'Importance 1–5 — the only signal colour (border-left on to-do rows, badges, dots, rings)')
  const r1 = row(box)
  for (let i = 1; i <= 5; i++) r1.appendChild(swatch('--imp-' + i, 'imp ' + i))
  caption(box, 'Status (kept: failure is a status, not decoration)')
  const r3 = row(box)
  r3.appendChild(swatch('--ev-error', 'error'))
  r3.appendChild(swatch('--ok', 'ok'))
  r3.appendChild(swatch('--warn', 'warn'))
  caption(box, 'Project chrome (neutral slate frame + band — not a colour signal)')
  const r4 = row(box)
  r4.appendChild(swatch('--ent-project', 'project ink'))
  r4.appendChild(swatch('--ent-project-band', 'band'))
  r4.appendChild(swatch('--ent-project-line', 'frame'))
}

// ---- 2. cross-link chips ------------------------------------------------------------------
{
  const box = section('Cross-link chips', 'Every reference from one entity to another is one of these four chips — identical on every page, distinguished by SHAPE + GLYPH (not colour). The slate pentagon (the logo mark) always a project · ✉ always the source email/event · initials pill always a person · ☑ always a to-do reference (not an actionable row).')
  caption(box, 'pentagon = project · hollow pentagon = a button that OPENS the project')
  const r1 = row(box)
  r1.appendChild(projectChip('Acme contract renewal', () => flash('open project: Acme contract renewal')))
  r1.appendChild(projectChip('Office move logistics', null))
  r1.appendChild(span('sg-swatch-l', '← clickable (hollow) vs reference (filled)'))
  caption(box, '✉ event / source email (compact and labelled; the glyph is the signal)')
  const r2 = row(box)
  r2.appendChild(eventChip(null, () => flash('open source email')))
  r2.appendChild(eventChip('view email', () => flash('open email: Re: Acme contract')))
  r2.appendChild(eventChip('auto-processed', () => flash('open auto-processed event'), { kind: 'auto' }))
  r2.appendChild(eventChip('your edit', null, { kind: 'manual' }))
  caption(box, 'person — full pill where space allows; in to-do rows just the initials disc (hover for name + owes:/for:)')
  const r3 = row(box)
  r3.appendChild(personChip('Bob Smith', () => flash('open person: Bob Smith')))
  r3.appendChild(personChip('Maria Lopez', null, { prefix: 'owes:' }))
  r3.appendChild(avatarEl('Bob Smith', { size: 'xs', title: 'for: Bob Smith' }))
  r3.appendChild(span('sg-swatch-l', '← row-compact form'))
  caption(box, '☑ to-do reference (used in narratives + event change lines)')
  const r4 = row(box)
  r4.appendChild(taskChip('Send the revised draft contract', 4, () => flash('open to-do')))
  r4.appendChild(taskChip('Confirm the signing date', 2, null))
  r4.appendChild(taskChip('Bob to send the updated pricing schedule', 5, null))
}

// ---- 3. task rows ---------------------------------------------------------------------------
{
  const box = section('To-do rows', 'The one way an actionable to-do renders anywhere: checkbox first, 3px importance left border (to-dos own that device exclusively), date (hover-revealed in v2 — its slot hides in the text slack), initials disc for who (hover for name + owes:/for:), badge, then the ✉ source-email chip and (outside a project card) the pentagon project chip.')
  caption(box, 'My to-dos uses a miniature list; resolved uses a green boxed check. Interactive to-do checkboxes remain separate.')
  const rs = row(box)
  rs.appendChild(dirDisc('i_owe_them', 4))
  rs.appendChild(span('sg-swatch-l', 'open, on your list'))
  rs.appendChild(doneMark())
  rs.appendChild(span('sg-swatch-l', 'resolved'))
  caption(box, 'Direction marks — the symbol says the direction, the ring says the bucket\'s top importance')
  const rd = row(box)
  for (const dk of ['i_owe_them', 'they_owe_me', 'team_owes', 'read_only']) {
    rd.appendChild(dirDisc(dk, { i_owe_them: 4, they_owe_me: 5, team_owes: 3, read_only: 1 }[dk]))
    rd.appendChild(span('sg-swatch-l', DIR_LABEL[dk]))
  }
  caption(box, 'Reusable myTodosIcon(): inherits font-size and colour; decorative beside text, or pass an accessible label when used alone.')
  const samples = row(box)
  for (const size of [16, 24, 32]) {
    const icon = myTodosIcon('My to-dos')
    icon.style.fontSize = size + 'px'
    samples.appendChild(icon)
  }
  samples.appendChild(span('sg-swatch-l', 'My to-dos'))
  // THE standard row handlers — same shape as the project card's / the pages'
  const H = {
    nameOf: NAME_OF,
    onResolve: (t) => flash('resolve: ' + t.short_description),
    onCancel: (t) => flash('cancel: ' + t.short_description),
    onImportance: (t, d) => flash('priority ' + (d > 0 ? 'up' : 'down') + ': ' + t.short_description),
    openEmailModal: (t, p, msgId) => flash('open the email behind this: ' + (msgId || '(latest)')),
    onEdit: (t) => flash('open the TO-DO modal (the name and the “+ N more” both land here): ' + t.short_description)
  }
  caption(box, 'The meta line under the text is the to-do\'s HISTORY — its FIRST and LAST evidence entries, comma-separated ("+ N more" between them opens the to-do modal); each email-backed end opens THAT message')
  caption(box, 'Tail, left to right: [project pill] · due · priority · ✕ — priority sits at the far right so a column of rows lines up. The “set by you” dot rides on the badge\'s corner and takes no width')
  caption(box, 'Inside a project card (no project pill)')
  for (const t of mockProject.todos.slice(0, 4)) box.appendChild(taskRowEl(t, mockProject, H))
  caption(box, 'Mixed-direction lists (Events, “All to-dos”, the to-dos behind one email) lead with the direction mark — elsewhere the tab already says it')
  for (const t of [mockProject.todos[0], mockProject.todos[2]]) {
    box.appendChild(taskRowEl(t, mockProject, H, { showDirection: true }))
  }
  caption(box, 'Standalone list (Recent To-dos / person view) — project pill after the text')
  for (const t of [mockProject.todos[0], mockProject.todos[2]]) {
    box.appendChild(taskRowEl(t, mockProject, H, {
      projectName: 'Acme contract renewal',
      onOpenProject: () => flash('open the project MODAL: Acme contract renewal')
    }))
  }
  caption(box, 'Done state')
  box.appendChild(taskRowEl(mockProject.todos[5], mockProject, H, { projectName: 'Acme contract renewal', onOpenProject: () => flash('open project modal') }))
  caption(box, 'Importance sweep 1–5')
  for (let i = 1; i <= 5; i++) {
    box.appendChild(taskRowEl({
      todo_id: 'imp' + i,
      direction: 'i_owe_them',
      short_description: 'An importance-' + i + ' to-do reads like this',
      importance: i,
      status: 'open',
      created_asof: Date.now()
    }, mockProject, { nameOf: NAME_OF, onResolve: () => flash('resolve') }))
  }
}

// ---- 4. event rows ---------------------------------------------------------------------------
{
  const box = section('Event rows (Message Events)', 'Flat ruled rows like a mail list — no card chrome, hover highlight, hairline separators. The kind is the EMOJI in the neutral glyph disc: 📧 message · ⚙ automatic · ✍️ your action; only failure keeps a red tint. Non-email events share the same layout.')
  caption(box, 'Kind discs')
  const r0 = row(box)
  for (const k of ['message', 'auto', 'manual', 'error']) {
    r0.appendChild(kindDisc(k))
    r0.appendChild(span('sg-swatch-l', k))
  }
  caption(box, 'A day group, all four kinds (rendered by the real events renderer)')
  const feed = div('ev-feed')
  const dh = div('ev-day-head')
  dh.appendChild(span(null, 'Saturday 18 Jul 2026'))
  dh.appendChild(span('ev-day-meta', mockEvents.length + ' events · $0.0123'))
  feed.appendChild(dh)
  const day = div('ev-day')
  for (const ev of mockEvents) day.appendChild(renderEventCard(ev, mockEventCtx, { onOpenEmail: (e) => flash('open email: ' + (e.subject || '')) }))
  feed.appendChild(day)
  box.appendChild(feed)
}

// ---- 5. people --------------------------------------------------------------------------------
{
  const box = section('People', 'Circle language: a NEUTRAL initials avatar — people add no colour of their own; the thin ring is tinted by the person\'s importance. Fully-rounded rows and pills — a contact list, not a data table.')
  caption(box, 'Avatar sizes + importance rings 1–5')
  const r1 = row(box)
  r1.appendChild(avatarEl('Bob Smith', { size: 'lg', rank: 4 }))
  r1.appendChild(avatarEl('Maria Lopez', { size: 'sm', rank: 3 }))
  r1.appendChild(avatarEl('digest@newsletter.com', { size: 'sm', rank: 1 }))
  r1.appendChild(avatarEl('单字', { size: 'sm', rank: 2, title: 'unicode name' }))
  const r1b = row(box)
  for (let i = 1; i <= 5; i++) r1b.appendChild(avatarEl('R ' + i, { size: 'sm', rank: i, title: 'rank ' + i }))
  caption(box, 'Contact-list rows (proposed — replaces the current rank-dot rows)')
  const list = div('pp-list sg-pplist')
  mockPeople.forEach((p, i) => {
    const b = btn('pp-row' + (i === 0 ? ' active' : ''), null, () => flash('open person: ' + p.name))
    const top = div('pp-row-top sg-pp-top')
    top.appendChild(avatarEl(p.name, { size: 'sm', rank: p.rank }))
    const mid = div('sg-pp-mid')
    const nm = div('pp-row-top')
    nm.appendChild(span('pp-row-name', p.name))
    if (p.disposition) nm.appendChild(span('pp-chip pp-chip-auto', p.disposition))
    if (p.oweCount) nm.appendChild(span('pp-chip pp-chip-owe', p.oweCount + ' you owe'))
    if (p.owedCount) nm.appendChild(span('pp-chip pp-chip-owed', p.owedCount + ' owed you'))
    mid.appendChild(nm)
    const vol = p.stats.messagesFrom + p.stats.messagesTo
    mid.appendChild(div('pp-row-sub', p.address + (vol ? ' · ' + vol + ' msgs' : '')))
    top.appendChild(mid)
    b.appendChild(top)
    list.appendChild(b)
  })
  box.appendChild(list)
}

// ---- 6. the project card -----------------------------------------------------------------------
{
  const box = section('Project card (Dashboard)', 'The only container entity: a framed card whose slate header band says "project" at a glance — and the logo pentagon IS the expand control (points right collapsed, inverts down when open; no separate arrow). Collapsed cards summarise each direction as an emoji disc + count (ring = that bucket\'s top importance); expanded cards drop the pills and let the tabs carry the counts. To-do rows: ✉ source-email chip, initials-only person mark (hover for name + owes:/for:), and HOVER a row to reveal its date / priority arrows / cancel ✕ (band hover for the project arrows). Suggested replies stay fully visible — they are the point.')
  const handlers = {
    now: Date.now(),
    self: SELF,
    nameOf: NAME_OF,
    onResolve: (t) => flash('resolve: ' + t.short_description),
    onCancel: (t) => flash('cancel: ' + t.short_description),
    onImportance: (t, d) => flash('priority ' + (d > 0 ? 'up' : 'down') + ': ' + t.short_description),
    onProjectImportance: (p, d) => flash('project priority ' + (d > 0 ? 'up' : 'down')),
    openEmailModal: (t) => flash('open email modal: ' + t.short_description),
    openResponseView: (r) => flash('open reply composer'),
    onChange: () => {}
  }
  caption(box, 'Collapsed (the band IS the card)')
  const board1 = div(null)
  board1.id = 'sgBoardA'
  board1.appendChild(renderExpandableProject(mockProject2, handlers))
  box.appendChild(board1)
  caption(box, 'Expanded')
  const board2 = div(null)
  board2.id = 'sgBoardB'
  const card = renderExpandableProject(mockProject, handlers)
  board2.appendChild(card)
  box.appendChild(board2)
  const t = card.querySelector('.epv-toggle')
  if (t) t.click()
}

// ---- 7. how the connections read ----------------------------------------------------------------
{
  const box = section('How connections read', 'A to-do seen anywhere carries its links: ✉ opens the email that raised it, the pentagon chip jumps to its project, the initials disc names the person involved. The same chips appear on event rows and person views — the glyph + shape tells you what you will land on before you click.')
  const t = mockProject.todos[2]
  box.appendChild(taskRowEl(t, mockProject, {
    nameOf: NAME_OF,
    onResolve: () => flash('resolve'),
    onCancel: () => flash('cancel'),
    onImportance: (t2, d) => flash('priority ' + (d > 0 ? 'up' : 'down')),
    openEmailModal: () => flash('→ lands on the EMAIL that raised this to-do'),
    onEdit: () => flash('→ lands on the TO-DO modal (with its History section)')
  }, {
    projectName: 'Acme contract renewal',
    onOpenProject: () => flash('→ lands on the PROJECT modal')
  }))
  const legend = div('sg-legend')
  const li = (chipEl, text) => { const l = div('sg-legend-row'); l.appendChild(chipEl); l.appendChild(span('sg-legend-txt', text)); legend.appendChild(l) }
  li(projectChip('project', null), 'squared slate chip with the logo pentagon — always a project')
  li(eventChip('email', null), 'round ✉ chip — always the event / source email')
  li(personChip('Person', null), 'initials pill/disc — always a person (ring colour = importance)')
  li(taskChip('a to-do, referenced', 3, null), 'checkbox-glyph chip — a to-do being talked about (importance rule inside)')
  li(dirDisc('i_owe_them', 4), 'direction disc — to-do direction (list mark I owe · 📥 owed me · 👥 team · 📖 read); ring = top importance')
  li(doneMark(), 'green check in a white, green-bordered box — resolved (counterpart of the open ☑️)')
  box.appendChild(legend)
}
