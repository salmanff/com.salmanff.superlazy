// replayStage.js — the DEMO STAGE: the only thing an audience looks at. Sized to sit in half a
// slide (the other half is the speaker's explanation), so everything here is ruthlessly short:
//   TOP    — the input arriving, in ONE sentence (two for an agent turn: what you asked, what the
//            agent did). Nobody reads an email on a slide; the point is to feel the flow.
//   BOTTOM — the to-do list in the Tasks page's language, capped at 3 rows a bucket:
//            3 × I owe · 3 × Team · 3 × recently resolved, each with "+N more".
// Rows a step touched flash, so the eye lands on what just moved. Text-only rendering (every
// value here is untrusted content), same as every other view.

import { div, span, impClassBl, impBadge, projectChip, dirDisc, fmtAgo } from '../shared/renderUtils.js'
import { effImportance } from '../jobs/analyze_thread/dueDates.js'

const num = (v) => Number(v) || 0

// ---- one sentence, and no more ---------------------------------------------------------------
// Sentence-ends only break on a following space, so "v0.29." mid-word does not cut the line short.
export function firstSentence (text, max = 170) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  const m = /^(.{20,}?[.!?])\s/.exec(s)
  const one = m ? m[1] : s
  return one.length > max ? one.slice(0, max - 1).trimEnd() + '…' : one
}

// An agent turn's two lines (what you asked, what the agent did) are CUT, not just clamped by CSS:
// about two lines of the half-slide stage. The stage is exported to other pages (replayExport.js),
// and only what is cut here leaves the app — the rest of a prompt never makes it into the file.
const AGENT_LINE_MAX = 130

// An agent turn's body_snippet is "YOU:\n<the ask>\n\nAGENT (<name>…" and the snippet is clipped at
// ~800 chars, so the agent half is usually gone — which is fine: the model's own one-line summary
// of the turn IS the agent half, and it is on every event.
function agentAsk (ev) {
  const snip = String(ev.body_snippet || '')
  const m = /^YOU:\s*([\s\S]*?)(?:\n\s*\n|AGENT\b|$)/.exec(snip)
  return firstSentence(m ? m[1] : snip, AGENT_LINE_MAX)
}

const CHANNEL_GLYPH = { mail: '✉', work: '🤖', messages: '💬', notes: '📝', calendar: '📅' }

// A manual edit has no sender and no body — it is YOU, mid-list, overruling the machine. Said in
// the terms the row itself uses, so it reads as a beat in the same story.
const DIR_SAID = { i_owe_them: 'I owe', team_owes: 'Team owes', they_owe_me: 'Owed to me', read_only: 'Read-only' }
function manualSaid (ev) {
  const to = ev.after
  if (ev.field === 'status') {
    if (to === 'resolved') return 'ticked it off'
    if (to === 'cancelled') return 'dropped it'
    if (to === 'in_progress') return 'marked it under way'
    return 'reopened it'
  }
  if (ev.field === 'direction') return 'moved it to ' + (DIR_SAID[to] || to)
  if (ev.field === 'importance') {
    return 'set the priority to ' + to + (ev.before && String(ev.before) !== String(to) ? ' (was ' + ev.before + ')' : '')
  }
  if (ev.field === 'created') return 'added it by hand'
  if (ev.field === 'deleted') return 'deleted it'
  if (ev.field === 'merged') return 'merged the projects'
  if (ev.field === 'owner') return 'changed who owns it'
  if (ev.field === 'project') return 'filed it under another project'
  return 'edited the ' + (ev.field || 'item')
}

// ---- the input strip -------------------------------------------------------------------------
// lookup: { titleOf(todo_id), projectNameOf(project_id) } — a manual edit names no task, so the
// page hands the stage the two lookups it needs to say WHICH one moved.
export function renderInput (host, step, { nameOf, lookup, self } = {}) {
  host.textContent = ''
  if (!step) { host.appendChild(div('rp-in-empty', 'Press play to replay what came in.')); return }
  const ev = step.ev
  const channel = ev.channel || 'mail'
  const isSelf = (a) => !!a && !!self && self.has(String(a).toLowerCase())
  // on a slide "You" beats your own address: a thread you are in is half your own messages
  const nice = (a) => (isSelf(a) ? 'You' : ((nameOf && nameOf(a)) || a || ''))
  const manual = ev.kind === 'manual_edit'

  const head = div('rp-in-head')
  head.appendChild(span('rp-in-glyph', manual ? '✍️' : (CHANNEL_GLYPH[channel] || '✉')))
  if (manual) {
    head.appendChild(span('rp-in-who', 'You ' + manualSaid(ev)))
  } else if (channel === 'work') {
    head.appendChild(span('rp-in-who', ev.agent_name || 'Agent session'))
    if (ev.repo_name) head.appendChild(span('rp-in-repo', '#' + ev.repo_name))
  } else {
    head.appendChild(span('rp-in-who', nice(ev.from_address)))
  }
  head.appendChild(span('rp-in-when', new Date(num(ev.asof)).toLocaleString(undefined,
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })))
  host.appendChild(head)

  const subject = ev.subject ||
    (manual && lookup && (lookup.titleOf(ev.todo_id) || lookup.projectNameOf(ev.project_id))) || ''
  if (subject) host.appendChild(div('rp-in-subject', subject))

  // the one-sentence body. An agent turn gets two lines — the ask and what came back — because
  // that pair IS the story of a session turn.
  const lines = div('rp-in-lines')
  if (manual) {
    const where = lookup && ev.todo_id ? lookup.projectNameOf(ev.project_id) : ''
    // the head line already says what changed; the body only adds the before → after when it
    // actually moved (a coalesced burst can settle back on the value it started from)
    const moved = ev.before != null && String(ev.before) !== String(ev.after)
    const txt = ['status', 'direction', 'importance'].includes(ev.field)
      ? (moved ? String(ev.before) + ' → ' + String(ev.after) : '')
      : firstSentence(ev.after, 120)
    const l = div('rp-in-line')
    if (where) l.appendChild(span('rp-in-tag', 'in'))
    if (where) l.appendChild(span('rp-in-text', where + (txt ? ' · ' + txt : '')))
    else if (txt) l.appendChild(span('rp-in-text', txt))
    if (l.childNodes.length) lines.appendChild(l)
  } else if (channel === 'work') {
    const ask = agentAsk(ev)
    if (ask) {
      const l = div('rp-in-line rp-in-line-you')
      l.appendChild(span('rp-in-tag', 'You'))
      l.appendChild(span('rp-in-text', ask))
      lines.appendChild(l)
    }
    const said = firstSentence(ev.summary || ev.body_snippet, AGENT_LINE_MAX)
    if (said) {
      const l = div('rp-in-line rp-in-line-agent')
      l.appendChild(span('rp-in-tag', ev.agent_name || 'Agent'))
      l.appendChild(span('rp-in-text', said))
      lines.appendChild(l)
    }
  } else {
    const said = firstSentence(ev.summary || ev.body_snippet)
    if (said) {
      const l = div('rp-in-line')
      l.appendChild(span('rp-in-text', said))
      lines.appendChild(l)
    }
  }
  host.appendChild(lines)

  // what SuperLazy did with it, in a word — the connective tissue between the two halves
  const foot = div('rp-in-foot')
  if (ev.kind === 'workflow_short_circuit') {
    foot.appendChild(span('rp-tag rp-tag-auto', 'filed automatically — not read'))
  } else if (ev.kind === 'manual_edit') {
    foot.appendChild(span('rp-tag rp-tag-manual', 'your own edit'))
  } else {
    const counts = (ev.changes || []).reduce((acc, c) => {
      if (c.type === 'created') acc.created++
      else if (c.type === 'status') acc.status++
      return acc
    }, { created: 0, status: 0 })
    const bits = []
    if (counts.created) bits.push(counts.created + ' new to-do' + (counts.created > 1 ? 's' : ''))
    if (counts.status) bits.push(counts.status + ' moved on')
    foot.appendChild(span('rp-tag rp-tag-read', bits.length ? 'read → ' + bits.join(' · ') : 'read → nothing new'))
  }
  host.appendChild(foot)
}

// ---- the board -------------------------------------------------------------------------------
function todoRow (row, { flash, nameOf }) {
  const t = row.todo
  const el = div('rp-row ' + impClassBl(effImportance(t)) + (flash ? ' rp-row-flash' : ''))
  if (t.status === 'resolved' || t.status === 'cancelled') el.classList.add('rp-row-done')
  el.appendChild(dirDisc(t.direction, effImportance(t)))
  const mid = div('rp-row-mid')
  mid.appendChild(div('rp-row-text', t.short_description || t.description || '(untitled)'))
  const meta = div('rp-row-meta')
  meta.appendChild(projectChip(row.project.name))
  const who = t.owner || (t.owners || [])[0] || t.counterparty
  if (who && t.direction === 'team_owes') meta.appendChild(span('rp-row-who', (nameOf && nameOf(who)) || who))
  const when = num(t.resolved_asof) || num(t.created_asof)
  if (when) meta.appendChild(span('rp-row-when', fmtAgo(when)))
  mid.appendChild(meta)
  el.appendChild(mid)
  // the priority AS OF this step (importance is one of the rewound fields), same badge as Tasks
  el.appendChild(impBadge(effImportance(t)))
  return el
}

const SECTIONS = [
  { key: 'i_owe_them', label: 'I owe', more: 'more open' },
  { key: 'team_owes', label: 'Team owes', more: 'more open' },
  { key: 'resolved', label: 'Resolved', more: 'more resolved' }
]

export function renderBoard (host, board, { changed = new Set(), nameOf } = {}) {
  host.textContent = ''
  for (const sec of SECTIONS) {
    const b = board[sec.key]
    const wrap = div('rp-sec rp-sec-' + sec.key)
    const head = div('rp-sec-head')
    head.appendChild(span('rp-sec-title', sec.label))
    head.appendChild(span('rp-sec-count', String(b.total)))
    wrap.appendChild(head)
    if (!b.rows.length) wrap.appendChild(div('rp-sec-empty', '—'))
    for (const row of b.rows) wrap.appendChild(todoRow(row, { flash: changed.has(row.todo.todo_id), nameOf }))
    if (b.more) wrap.appendChild(div('rp-sec-more', '+ ' + b.more + ' ' + sec.more))
    host.appendChild(wrap)
  }
}

// ---- the running counter under the stage -----------------------------------------------------
export function renderProgress (host, { idx, total, atMs, cost }) {
  host.textContent = ''
  host.appendChild(span('rp-prog-step', total ? (idx + 1) + ' / ' + total : '—'))
  if (atMs) host.appendChild(span('rp-prog-date', new Date(atMs).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })))
  if (cost != null) host.appendChild(span('rp-prog-cost', '$' + cost.toFixed(2)))
}
