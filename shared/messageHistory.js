// messageHistory.js — the SHARED thread-grouped message-history view: the People page's
// "Message history" language, reused wherever a summary of the mail behind an entity is wanted
// (the People detail's Messages tab, the project card's Messages tab). One row per analysed
// email — kind disc, direction mark (← from them / → you sent / · third-party), date, subject,
// what-it-changed — grouped by thread with the newest message leading and the older ones
// collapsed under it. Text-only (textContent); clicking a row opens the full email in the
// shared viewer. Styles live in entities.css (pp-msg / pp-thread) so every page has them.

import { div, span, kindDisc } from './renderUtils.js'
import { groupByThread } from '../pages/peopleData.js'
import { isMailThreadId } from '../jobs/analyze_thread/projectStore.js'

const fmtDate = (ms) => {
  const n = Number(ms)
  if (!n) return ''
  return new Date(n).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

// One history row: direction marker (← from them / → you sent / · third-party they were on),
// date, subject, what-it-changed; clicking opens the full email in the shared viewer.
const DIR_MARKS = {
  received: { mark: '←', title: 'from them', cls: 'received' },
  sent: { mark: '→', title: 'you sent', cls: 'sent' },
  other: { mark: '·', title: 'they were on this (third-party sender)', cls: 'other' }
}
export function msgRow ({ ev, dir }, { onOpenEmail } = {}) {
  const d = ev.channel === 'notes'
    ? { mark: '📝', title: 'your note', cls: 'sent' }
    : (DIR_MARKS[dir] || DIR_MARKS.other)
  const row = document.createElement(onOpenEmail ? 'button' : 'div')
  if (onOpenEmail) { row.type = 'button'; row.addEventListener('click', () => onOpenEmail(ev)) }
  row.className = 'pp-msg pp-msg-' + d.cls
  row.appendChild(kindDisc(ev.via_workflow ? 'auto' : 'message')) // history rows read as EVENTS
  const mark = span('pp-msg-dir', d.mark)
  mark.title = d.title
  row.appendChild(mark)
  row.appendChild(span('pp-msg-date', fmtDate(ev.asof)))
  row.appendChild(span('pp-msg-subj', ev.subject || '(no subject)'))
  const ld = ev.latest_delta || {}
  const what = []
  if (ev.via_workflow) what.push('auto-processed: ' + ev.via_workflow)
  // new_for_me / new_for_team are BOOLEANS, derived by reconcile from the directions of the to-dos
  // it actually minted. This line used to test Array.isArray() on them, so it never once rendered.
  if (ld.new_for_me) what.push('new for you')
  else if (ld.new_for_team) what.push('new for the team')
  if (Array.isArray(ld.resolved) && ld.resolved.length) what.push(ld.resolved.length + ' resolved')
  if (what.length) row.appendChild(span('pp-msg-what', what.join(' · ')))
  return row
}

// Render thread groups ([{ thread_id, entries }] from peopleData.groupByThread) into an element:
// newest message of each thread leads, the rest collapsed as "+ N earlier in this thread".
// opts: { onOpenEmail(ev), cap = 25, emptyText }
export function renderThreadHistory (threads, { onOpenEmail, cap = 25, emptyText } = {}) {
  const host = div('pp-history')
  if (!threads || !threads.length) {
    host.appendChild(div('pp-empty', emptyText || 'No analysed messages in the events log.'))
    return host
  }
  for (const group of threads.slice(0, cap)) {
    const grpEl = div('pp-thread')
    grpEl.appendChild(msgRow(group.entries[0], { onOpenEmail }))
    const rest = group.entries.slice(1)
    if (rest.length) {
      const det = document.createElement('details')
      det.className = 'pp-thread-rest'
      const sum = document.createElement('summary')
      sum.textContent = '+ ' + rest.length + ' earlier in this thread'
      det.appendChild(sum)
      for (const e of rest) det.appendChild(msgRow(e, { onOpenEmail }))
      grpEl.appendChild(det)
    }
    host.appendChild(grpEl)
  }
  if (threads.length > cap) host.appendChild(div('pp-empty', '+ ' + (threads.length - cap) + ' older threads not shown'))
  return host
}

// isMailThreadId lives in the job bundle (projectStore.js) — the clean-up's orphan-thread sweep
// needs it there too; re-exported here for the pages that already import it from this module.
export { isMailThreadId }
const isMailEvent = (ev) => (ev.channel || 'mail') === 'mail'

// The mail behind ONE PROJECT, as history entries ({ ev, dir }, newest-first) ready for
// groupByThread: every analysed email whose changes touched the project, that a to-do's evidence
// points at, or — MAIL only — whose thread is linked to the project. A chat chunk is on a
// project only through evidence / changes: its thread id is the whole stream (user, 2026-10-04:
// unrelated conversations on a project's card). dir: 'sent' when the user wrote it, else
// 'received'.
export function projectHistoryEntries (project, events, self) {
  const selfSet = new Set((self || []).map(a => String(a).toLowerCase()))
  const pid = project.project_id
  const threadIds = new Set((project.thread_ids || []).filter(isMailThreadId))
  const msgIds = new Set()
  for (const t of (project.todos || [])) {
    for (const e of (t.evidence || [])) if (e.msg_id) msgIds.add(e.msg_id)
  }
  const out = []
  const seen = new Set()
  for (const ev of (events || [])) {
    if (!ev.msg_id || ev.kind === 'manual_edit' || seen.has(ev.msg_id)) continue
    const touches = msgIds.has(ev.msg_id) ||
      (ev.thread_id && isMailEvent(ev) && threadIds.has(ev.thread_id)) ||
      (ev.changes || []).some(c => c.project_id === pid)
    if (!touches) continue
    seen.add(ev.msg_id)
    out.push({ ev, dir: selfSet.has(String(ev.from_address || '').toLowerCase()) ? 'sent' : 'received' })
  }
  out.sort((a, b) => (Number(b.ev.asof) || 0) - (Number(a.ev.asof) || 0))
  return out
}

export { groupByThread }
