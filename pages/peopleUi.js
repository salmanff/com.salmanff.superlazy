// peopleUi.js — DOM rendering for the People page: the person list rows and the per-person
// "meeting prep" detail panel. Text-only (no innerHTML of mail content). Handlers are injected
// by people.js: { onSelect, onRank, onResolve, onCopyBrief }.

import { impColor, div, span, avatarEl, taskRowEl, dirDisc, impBadge, DIR_GLYPHS, myTodosIcon } from '../shared/renderUtils.js'
import { entriesOf } from '../jobs/analyze_thread/responsibilities.js'
import { DIRECTIONS, DIR_LABELS, fmtDuration, meetingBrief } from './peopleData.js'
import { renderThreadHistory } from '../shared/messageHistory.js'
import { effImportance } from '../jobs/analyze_thread/dueDates.js'
import { PROFILE_TUNING } from '../jobs/analyze_thread/profileTuning.js'

const fmtDate = (ms) => {
  const n = Number(ms)
  if (!n) return ''
  return new Date(n).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

// ---- the list (left column): contact-list rows — neutral avatar, importance ring ---------

export function renderPeopleList (host, people, { selected, onSelect } = {}) {
  host.textContent = ''
  if (!people.length) { host.appendChild(div('pp-empty', 'No people match.')); return }
  for (const person of people) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'pp-row' + (person.address === selected ? ' active' : '')
    const wrap = div('pp-row-wrap')
    wrap.appendChild(avatarEl(person.name, { rank: person.rank, size: 'sm', title: person.name + ' · importance ' + person.rank + '/5' }))
    const mid = div('pp-row-mid')
    const top = div('pp-row-top')
    top.appendChild(span('pp-row-name', person.name))
    if (person.autoProcess) top.appendChild(span('pp-chip pp-chip-auto', '⚙ ' + (person.disposition || 'auto-process')))
    if (person.oweCount) {
      const chip = span('pp-chip')
      chip.append(myTodosIcon(), document.createTextNode(' ' + person.oweCount + ' you owe'))
      top.appendChild(chip)
    }
    if (person.owedCount) top.appendChild(span('pp-chip', DIR_GLYPHS.they_owe_me + ' ' + person.owedCount + ' owed you'))
    mid.appendChild(top)
    const sub = div('pp-row-sub')
    const bits = [person.address]
    const vol = person.stats.messagesFrom + person.stats.messagesTo
    if (vol) bits.push(vol + ' msgs')
    if (person.lastActivity) bits.push('last ' + fmtDate(person.lastActivity))
    sub.textContent = bits.join(' · ')
    mid.appendChild(sub)
    wrap.appendChild(mid)
    row.appendChild(wrap)
    row.addEventListener('click', () => onSelect && onSelect(person))
    host.appendChild(row)
  }
}

// ---- the detail panel (right column) ----------------------------------------------------

function rankControl (person, onRank) {
  const wrap = div('pp-rank')
  wrap.appendChild(span('pp-rank-lbl', 'Importance'))
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'pp-rank-btn' + (n <= person.rank ? ' on' : '')
    if (n <= person.rank) b.style.background = impColor(person.rank)
    b.title = person.profile.manual_rank != null
      ? 'You set ' + person.rank + ' (click same value to clear)'
      : 'Model suggests ' + person.rank + ' — click to set your own'
    b.addEventListener('click', () => onRank && onRank(person, n))
    wrap.appendChild(b)
  }
  wrap.appendChild(span('pp-rank-note', person.profile.manual_rank != null ? 'set by you' : 'model estimate'))
  return wrap
}

function statLine (person) {
  const s = person.stats
  const bits = []
  if (s.messagesFrom || s.messagesTo) bits.push(s.messagesFrom + ' from · ' + s.messagesTo + ' to')
  const them = fmtDuration(s.avgReplyByThem)
  if (them) bits.push('they reply in ~' + them + ' (' + s.repliesByThem + ')')
  const you = fmtDuration(s.avgReplyByUser)
  if (you) bits.push('you reply in ~' + you + ' (' + s.repliesByUser + ')')
  if (s.firstSeen) bits.push('since ' + fmtDate(s.firstSeen))
  return bits.join('   ·   ')
}

// one open/done item between you and this person — THE standard task row (identical to the
// project-card rows: resolve / priority ▾▴ / cancel), with the project pill after the text
// opening the live project modal
function todoRow (entry, handlers = {}) {
  const { todo, project } = entry
  return taskRowEl(todo, project, handlers.task || {}, {
    projectName: project.name,
    onOpenProject: handlers.onOpenProject || null
  })
}

// (the history row + thread rendering moved to the shared messageHistory.js — the project
// card's Messages tab shows the same view)

// which sub-tab each person's detail panel is on — survives repaints, per address
const detailTabState = new Map()

// the detail panel's sub-tabs — the project card's tab language (user, 2026-08-19):
// Profile · I owe · Owed · Team · Read · Projects · Messages
const DETAIL_TABS = [
  { key: 'profile', label: 'Profile' },
  { key: 'i_owe_them', label: 'I owe', dir: true },
  { key: 'they_owe_me', label: 'Owed', dir: true },
  { key: 'team_owes', label: 'Team', dir: true },
  { key: 'read_only', label: 'Read', dir: true },
  { key: 'projects', label: 'Projects' },
  { key: 'messages', label: 'Messages' }
]

export function renderPersonDetail (host, person, handlers = {}) {
  host.textContent = ''
  if (!person) {
    host.appendChild(div('pp-placeholder', 'Select a person to see their profile, what stands between you, and a meeting brief.'))
    return
  }
  const prof = person.profile.profile || {}
  const repaint = () => renderPersonDetail(host, person, handlers)

  // header card
  const head = div('pp-card pp-head')
  const nameRow = div('pp-name-row')
  nameRow.appendChild(avatarEl(person.name, { rank: person.rank, size: 'lg', title: 'importance ' + person.rank + '/5' }))
  nameRow.appendChild(span('pp-name', person.name))
  if (handlers.onEditPerson) {
    const eb = document.createElement('button'); eb.type = 'button'; eb.className = 'pp-editbtn'
    eb.textContent = '✏️'; eb.title = 'Edit this person: description + special instructions for their messages'
    eb.addEventListener('click', () => handlers.onEditPerson(person))
    nameRow.appendChild(eb)
  }
  if (prof.relationship && prof.relationship !== 'unknown') nameRow.appendChild(span('pp-chip pp-chip-rel', prof.relationship))
  if (person.autoProcess) nameRow.appendChild(span('pp-chip pp-chip-auto', '⚙ ' + (person.disposition || 'auto-process')))
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'pp-copy'
  copyBtn.textContent = '📋 Copy meeting brief'
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(meetingBrief(person))
      copyBtn.textContent = '✓ Copied'
      setTimeout(() => { copyBtn.textContent = '📋 Copy meeting brief' }, 1600)
    } catch (e) { copyBtn.textContent = 'copy failed' }
  })
  nameRow.appendChild(copyBtn)
  head.appendChild(nameRow)
  head.appendChild(div('pp-addr', person.address))
  head.appendChild(rankControl(person, handlers.onRank))
  host.appendChild(head)

  // ---- the sub-tab bar: Profile · I owe · Owed · Team · Read · Projects · Messages ----
  // Same tab language as the project card (epv-tab); state survives repaints per address.
  const active = detailTabState.get(person.address) || 'profile'
  const tabs = div('epv-tabs pp-tabs')
  for (const t of DETAIL_TABS) {
    const count = t.dir ? person.open[t.key].length
      : (t.key === 'projects' ? person.sharedProjects.length
          : (t.key === 'messages' ? person.msgThreads.length : 0))
    const b = document.createElement('button'); b.type = 'button'
    // Projects starts the RIGHT-aligned group (Projects · Messages), splitting the entity views
    // from the profile + direction tabs — same separation as the project card's tab bar
    b.className = 'epv-tab' + (active === t.key ? ' active' : '') + (t.key !== 'profile' && !count ? ' empty' : '') +
      (t.key === 'projects' ? ' pp-tab-gap' : '')
    if (t.dir) b.appendChild(dirDisc(t.key, count ? person.open[t.key].reduce((m, e) => Math.max(m, effImportance(e.todo)), 0) : null))
    b.appendChild(document.createTextNode(' ' + t.label + (count ? ' ' + count : '')))
    if (t.dir) b.title = DIR_LABELS[t.key]
    if (t.key === 'messages') b.title = 'The analysed emails with this person, thread-grouped, newest first'
    if (t.key === 'projects') b.title = 'Shared projects — the same live cards as the dashboard'
    b.addEventListener('click', () => { detailTabState.set(person.address, t.key); repaint() })
    tabs.appendChild(b)
  }
  host.appendChild(tabs)

  const content = div('pp-card pp-tabcontent')

  if (active === 'profile') {
    // the basic profile: summary, responsibilities, tone, responsiveness stats, lifecycle
    if (prof.summary && !person.profile.stub) content.appendChild(div('pp-summary', prof.summary))
    for (const e of entriesOf(prof)) {
      const row = div('pp-resp', 'Handles: ' + e.text)
      if (e.source === 'user') row.appendChild(span('pp-resp-tag', ' — yours'))
      content.appendChild(row)
    }
    if (prof.user_tone) content.appendChild(div('pp-resp', 'Your tone with them: ' + prof.user_tone))
    const stats = statLine(person)
    if (stats) content.appendChild(div('pp-stats', stats))
    // profile lifecycle: provisional marker, or when it was last grounded.
    // 2026-09-19: the fit score + drift log are gone with fit_concerns (never emitted).
    if (!prof.solidified_asof) {
      const seen = (person.profile.interaction_data && person.profile.interaction_data.messages_from) || 0
      content.appendChild(div('pp-fit', 'Profile: PROVISIONAL (' + Math.min(seen, PROFILE_TUNING.MESSAGES_BEFORE_SOLIDIFYING_PROFILE) + '/' + PROFILE_TUNING.MESSAGES_BEFORE_SOLIDIFYING_PROFILE + ' messages — refined freely, then grounded from history)'))
    } else {
      content.appendChild(div('pp-fit', 'Profile: grounded' +
        (prof.last_profiled_asof ? ' · profiled ' + fmtDate(prof.last_profiled_asof) : '') +
        (prof.user_edited ? ' · edited by you' : '')))
    }
    if (!content.childNodes.length) content.appendChild(div('pp-empty', 'No profile yet — it builds as their messages are analysed.'))
  } else if (DIRECTIONS.includes(active)) {
    // one direction's open items (the standard to-do rows), plus that direction's resolved ones.
    // showOpen / showDone come from the filter bar's show-only buttons, which AND: both true by
    // default, one false when the other status is asked for, and BOTH false when the user presses
    // unresolved and resolved together — an item cannot be both, so neither list shows.
    const showOpen = handlers.showOpen !== false
    const showDone = handlers.showDone !== false
    const list = person.open[active]
    if (showOpen) {
      const grp = div('pp-group pp-group-' + active)
      const gh = div('pp-group-head')
      gh.appendChild(dirDisc(active, list.reduce((m, e) => Math.max(m, effImportance(e.todo)), 0) || 3))
      gh.appendChild(span(null, DIR_LABELS[active] + (list.length ? ' (' + list.length + ')' : '')))
      grp.appendChild(gh)
      if (!list.length) grp.appendChild(div('pp-empty', 'Nothing open here.'))
      for (const entry of list) grp.appendChild(todoRow(entry, handlers))
      content.appendChild(grp)
    }
    const done = person.done.filter(e => e.todo.direction === active)
    if (done.length && showDone) {
      const det = document.createElement('details')
      det.className = 'pp-done'
      if (!showOpen) det.open = true // it is the only thing asked for — don't make them click
      const sum = document.createElement('summary')
      sum.textContent = done.length + ' resolved / cancelled'
      det.appendChild(sum)
      for (const entry of done.slice(0, 25)) det.appendChild(todoRow(entry, handlers))
      content.appendChild(det)
    }
    if (!content.childNodes.length) content.appendChild(div('pp-empty', 'Nothing here matches the \u201cshow only\u201d filters.'))
  } else if (active === 'projects') {
    // shared projects — the SAME live cards as the dashboard (expand, resolve, priorities, edit)
    if (!person.sharedProjects.length) {
      content.appendChild(div('pp-empty', 'No shared projects.'))
    } else if (handlers.renderProjects) {
      const hostEl = div('pp-proj-cards')
      handlers.renderProjects(hostEl, person.sharedProjects)
      content.appendChild(hostEl)
    } else {
      for (const p of person.sharedProjects) {
        const row = div('pp-proj')
        row.appendChild(span('proj-mark'))
        row.appendChild(span('pp-proj-name', p.name))
        row.appendChild(impBadge(p.importance || 3))
        content.appendChild(row)
      }
    }
  } else if (active === 'messages') {
    // message history (from the events log): threads, newest message leading, the rest
    // (older messages + your sent replies) collapsed under it — the shared history view
    if (person.msgEvents.length) {
      content.appendChild(div('pp-card-title', person.msgEvents.length + ' analysed, ' + person.msgThreads.length + ' threads'))
    }
    content.appendChild(renderThreadHistory(person.msgThreads, {
      onOpenEmail: handlers.onOpenEmail,
      emptyText: 'No analysed messages with this address in the events log.'
    }))
  }

  host.appendChild(content)
}
