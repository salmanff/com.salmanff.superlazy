// threadsData.js — groups the events log into CONVERSATIONS for the Threads view (threadsView.js).
// Pure: no DOM, no freezr. One thread = every message event sharing a thread_id (an email thread,
// or a Slack stream/thread); the row the list shows is built from the thread's messages plus the
// project records (open to-dos and live suggested replies that came from that thread).
//
// buildThreads(events, projects, { selfSet, isLiveDraft }) → [thread], newest activity first:
//   { thread_id, channel, account_id, subject, count, lastDate, latest, messages (newest first),
//     senders (addresses, newest first, unique), autoOnly, lastFromSelf, projectIds,
//     todos ([{ todo, project }] — every to-do that came from the thread), openTodos, mineOpen, drafts }

// the event kinds that ARE a message on a thread (analysed, auto-filed/skipped, or sent by you
// from superlazy) — manual edits, cache refreshes and reprofiles are not
const MESSAGE_KINDS = new Set(['message', 'skipped', 'mail_action'])
const clockOf = (e) => Number(e.asof) || Number(e._date_created) || 0

// "Re: Fwd: RE: subject" → "subject" — the thread's title, as Mail shows it
export const baseSubject = (s) => String(s || '').replace(/^\s*((re|fwd?|fw|aw|tr|sv)\s*(\[\d+\])?\s*:\s*)+/i, '').trim()

const isOpen = (t) => t && (t.status === 'open' || t.status === 'in_progress')

export function buildThreads (events, projects, { selfSet = new Set(), isLiveDraft = null } = {}) {
  const byThread = new Map()
  const seenMsg = new Set()
  for (const e of (events || [])) {
    if (!e || !e.thread_id || !e.msg_id || !MESSAGE_KINDS.has(e.kind)) continue
    // an event can be re-written (amendment / re-analysis) — one row per message, the first seen
    // (the log is newest-processed first) unless a later copy carries the model's summary
    const key = e.thread_id + '|' + e.msg_id
    if (seenMsg.has(key)) {
      const th = byThread.get(e.thread_id)
      const m = th && th.messages.find(x => x.msg_id === e.msg_id)
      if (m && !m.summary && e.summary) m.summary = e.summary
      continue
    }
    seenMsg.add(key)
    let th = byThread.get(e.thread_id)
    if (!th) {
      th = { thread_id: e.thread_id, channel: e.channel || 'mail', account_id: e.account_id || null, messages: [], projectIds: new Set() }
      byThread.set(e.thread_id, th)
    }
    if (!th.account_id && e.account_id) th.account_id = e.account_id
    if (e.channel && e.channel !== 'mail') th.channel = e.channel
    th.messages.push({
      msg_id: e.msg_id,
      date: clockOf(e),
      from: String(e.from_address || '').toLowerCase(),
      subject: e.subject || '',
      summary: e.summary || e.body_snippet || '',
      kind: e.kind
    })
    for (const c of (e.changes || [])) if (c && c.project_id) th.projectIds.add(c.project_id)
  }

  // what the PROJECTS say about each thread: the open to-dos it raised, the drafts answering it
  const todosByThread = new Map()
  const draftsByThread = new Map()
  for (const p of (projects || [])) {
    if (!p || p.merged_into) continue
    const todoThreads = new Map() // todo_id -> Set(thread_id)
    for (const t of (p.todos || [])) {
      const ths = new Set((t.evidence || []).filter(x => x.msg_id && x.thread_id).map(x => x.thread_id))
      todoThreads.set(t.todo_id, ths)
      for (const tid of ths) {
        if (!todosByThread.has(tid)) todosByThread.set(tid, [])
        todosByThread.get(tid).push({ todo: t, project: p })
      }
    }
    for (const r of (p.responses || [])) {
      if (!r || r.kind === 'reminder') continue
      if (isLiveDraft ? !isLiveDraft(r, p) : (r.status !== 'suggested' && r.status !== 'edited')) continue
      for (const tid of (todoThreads.get(r.todo_id) || [])) {
        if (!draftsByThread.has(tid)) draftsByThread.set(tid, [])
        draftsByThread.get(tid).push({ response: r, project: p })
      }
    }
  }

  const out = []
  for (const th of byThread.values()) {
    th.messages.sort((a, b) => b.date - a.date)
    const latest = th.messages[0]
    const todos = todosByThread.get(th.thread_id) || []
    for (const { project } of todos) th.projectIds.add(project.project_id)
    const open = todos.filter(x => isOpen(x.todo))
    const senders = []
    for (const m of th.messages) if (m.from && !senders.includes(m.from)) senders.push(m.from)
    out.push({
      thread_id: th.thread_id,
      channel: th.channel,
      account_id: th.account_id,
      subject: baseSubject((th.messages.find(m => m.subject) || {}).subject || ''),
      count: th.messages.length,
      lastDate: latest.date,
      latest,
      messages: th.messages,
      senders,
      autoOnly: th.messages.every(m => m.kind === 'skipped'),
      lastFromSelf: selfSet.has(latest.from),
      projectIds: [...th.projectIds],
      todos,
      openTodos: open.length,
      mineOpen: open.filter(x => x.todo.direction === 'i_owe_them').length,
      drafts: (draftsByThread.get(th.thread_id) || []).length
    })
  }
  out.sort((a, b) => b.lastDate - a.lastDate)
  return out
}
