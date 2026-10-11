// viewerContext.js — builds the email viewer's superlazy CONTEXT for a page, so EVERY page
// opens the same project-wide reading pane: related projects, the snippet list of all the
// projects' emails, per-email task rows, still-relevant sendable drafts, and Reply/Forward.
// Extracted from the events page so Dashboard / Recent / People share one implementation.
//
// createMailContext(opts) — opts:
//   persist            — createPersistence (addEvent / saveProject)
//   getProjects()      — the page's LIVE projects array
//   getProject(id)     — one live project | null
//   getEvents()        — the events log, newest first (may fill lazily; call refreshSelfReplies
//                        after it loads)
//   nameOf(addr)       — display name | null
//   selfAddrs()        — your own addresses (lowercase)
//   projectName(id)    — display name for a project id (defaults to getProject(id).name)
//   taskHandlers       — the page's standard task-row handlers (viewer task rows use them)
//   onOpenProject(p)   — open the live project modal
//   onOpenPerson(addr) — open the person modal (email-header address links)
//   onSent(sentEv)     — optional: reflect a just-sent mail_action event in the page's log
//   refresh()          — repaint the page (after send / dismiss / edits)
//
// Returns { context, draftHandlers, sendMail, sendChat, sendState, refreshSelfReplies } — `context` goes
// to configureEmailViewer; `draftHandlers` is the same object the events feed renders drafts with.

import { isLiveResponse } from './expandableProjectView.js'
import { openNewNoteModal } from '../pages/newNoteModal.js'
import { composeWithQuote } from './replyComposer.js'

const clockOf = (ev) => Number(ev.asof) || Number(ev._date_created) || 0
// 'Re: ' once — never 'Re: Re: '
export const replySubject = (subj) => (/^\s*re\s*:/i.test(String(subj || '')) ? String(subj) : 'Re: ' + String(subj || ''))

export function createMailContext (opts) {
  const {
    persist, getProjects, getProject, getEvents, nameOf,
    selfAddrs, taskHandlers, onOpenProject, onOpenPerson, onSent, refresh,
    getSettings = null   // the live settings record (editor_url_template …) — read at render time
  } = opts
  const projectName = opts.projectName || ((id) => { const p = getProject(id); return (p && p.name) || id || '' })
  const events = () => (getEvents && getEvents()) || []
  const projects = () => (getProjects && getProjects()) || []

  const resolveResponse = (projectId, responseId) => {
    const p = projectId && getProject(projectId)
    const r = p && (p.responses || []).find(r => r.response_id === responseId)
    return (p && r) ? { response: r, project: p } : null
  }

  // THREAD ACTIVITY, from the events log: when did the last message land on each thread (anyone),
  // and when did YOU last write there? A suggested reply older than the thread's last message
  // answers a conversation that has moved on (user, 2026-09-27: "old suggested replies should
  // disappear when there is a new email or action on the thread"); a draft older than YOUR last
  // message there is dead even if you had edited it. This catches the messages that touched no
  // task — the evidence-based rule (expandableProjectView.isSupersededResponse) sees the rest.
  let lastByThread = null
  let selfLastByThread = null
  function refreshSelfReplies () {
    lastByThread = new Map()
    selfLastByThread = new Map()
    const selfSet = new Set(selfAddrs ? selfAddrs() : [])
    for (const e of events()) {
      if (!e.thread_id || !e.msg_id || e.kind === 'manual_edit') continue
      const t = clockOf(e)
      if (t > (lastByThread.get(e.thread_id) || 0)) lastByThread.set(e.thread_id, t)
      if (selfSet.has(String(e.from_address || '').toLowerCase()) && t > (selfLastByThread.get(e.thread_id) || 0)) selfLastByThread.set(e.thread_id, t)
    }
    retireStaleDrafts()
  }
  const ensureThreadMaps = () => { if (!lastByThread) refreshSelfReplies() }
  // the threads a draft answers: every thread its task's messages came from
  const draftThreads = (r, p) => {
    const t = r && r.todo_id && (p.todos || []).find(t => t.todo_id === r.todo_id)
    return t ? [...new Set((t.evidence || []).filter(e => e.msg_id && e.thread_id).map(e => e.thread_id))] : []
  }
  // why a draft is out of date by the events log, or null
  function threadStaleReason (r, p, extraThread = null) {
    ensureThreadMaps()
    const created = Number(r.created_asof) || 0
    const threads = draftThreads(r, p)
    if (extraThread && !threads.includes(extraThread)) threads.push(extraThread)
    for (const th of threads) {
      if ((selfLastByThread.get(th) || 0) > created) return 'you wrote on this thread after the draft was made'
      if (r.status === 'suggested' && (lastByThread.get(th) || 0) > created) return 'a newer message arrived on this thread'
    }
    return null
  }

  // Retire every out-of-date draft DURABLY (persisted, stamped), so it stops resurfacing on the
  // project cards too. Runs whenever the log (re)loads and after every send; it only ever ACTS
  // when a later message is actually in the loaded window, so a partial log just means fewer
  // retirements, never a wrong one. dismissed_asof is what lets the dismissal win the 3-way
  // merge against a writer (the background job) still holding the old 'suggested' copy.
  function retireStaleDrafts () {
    if (!lastByThread || !lastByThread.size) return
    let changed = false
    for (const p of projects()) {
      let touched = false
      for (const r of (p.responses || [])) {
        if (!r || r.status === 'sent' || r.status === 'dismissed' || r.kind === 'reminder') continue
        const why = threadStaleReason(r, p)
        if (!why) continue
        r.status = 'dismissed'
        r.dismiss_reason = why
        r.dismissed_asof = Date.now()
        touched = true
      }
      if (touched) {
        changed = true
        persist.saveProject(p).catch(e => console.error('stale-draft retirement save failed', e))
      }
    }
    if (changed && refresh) refresh() // drop the draft pills from cards already painted
  }

  // can this page actually send? Needs BOTH the app-side grant AND the connection itself set to
  // read+write (checked once, best-effort — buttons stay disabled with the reason).
  //   mail: the send_replies use_mail permission + access.mail readwrite
  //   chat: ANY granted use_messaging permission with the 'write' scope + access.messaging
  //         readwrite. The manifest ships messaging read-only (Slack v1), so chat replies show
  //         the reason until a write permission is added and granted — the path itself is live.
  // accounts: connectionName → { email, access, status } for EVERY mail/messaging connection
  // visible to the app (not just the writable ones) — the From line, the "which mailbox is this
  // project on" lookup, and an honest reason when sending is off (expired ≠ read-only).
  const sendCap = { checked: false, perm: false, chatPerm: false, accounts: new Map() }
  async function loadSendCapability () {
    try {
      const perms = await freezr.perms.getAppPermissions()
      sendCap.perm = !!(perms || []).find(p => p.name === 'send_replies' && p.granted)
      sendCap.chatPerm = !!(perms || []).find(p => p.type === 'use_messaging' && p.granted && (p.scopes || []).includes('write'))
      // 'outdated' = declared but its definition changed since you accepted it — re-accept
      sendCap.mailOutdated = !!(perms || []).find(p => p.name === 'send_replies' && !p.granted && p.status === 'outdated')
      sendCap.chatOutdated = !!(perms || []).find(p => p.name === 'send_messages' && !p.granted && p.status === 'outdated')
    } catch (e) { /* treated as not granted */ }
    const accounts = new Map()
    try {
      if (freezr.connections && freezr.connections.mail) {
        const res = await freezr.connections.mail.listAccounts()
        for (const a of ((res && res.accounts) || [])) {
          accounts.set(a.connectionName, { email: String(a.account_email || '').toLowerCase(), access: a.access || {}, status: a.status || 'ok', services: a.services || [] })
        }
      }
    } catch (e) { /* archive source / no mail — sending stays off */ }
    sendCap.accounts = accounts
    sendCap.checked = true
    if (refresh) refresh()
  }
  loadSendCapability().catch(() => {})
  // a reconnect happens in another tab (/account/resources): look again when the user comes back
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && sendCap.checked) loadSendCapability().catch(() => {})
    })
  }

  const acctOf = (name) => (name && sendCap.accounts.get(name)) || null
  // the connection whose address matches one of the project's `email:<address>` sources — the
  // mailbox a project's mail came from, when no event names the account. Unique match only.
  function accountFromSources (p) {
    const emails = new Set(((p && p.sources) || []).map(x => String(x)).filter(x => x.startsWith('email:')).map(x => x.slice(6).toLowerCase()))
    if (!emails.size) return null
    const hits = [...sendCap.accounts.entries()].filter(([, a]) => a.email && emails.has(a.email) && (a.services || []).includes('mail')).map(([n]) => n)
    return hits.length === 1 ? hits[0] : null
  }
  // what the composer's From line says
  const accountLabel = (name) => { const a = acctOf(name); return a ? (a.email || name) + (a.email ? '  (' + name + ')' : '') : (name || '') }

  const RESOURCES = '/account/resources'
  const APP_SETTINGS = '/account/app/settings/' + ((typeof freezrMeta !== 'undefined' && freezrMeta.appName) || 'com.salmanff.superlazy')
  function stateFor (ev, service) {
    const a = acctOf(ev && ev.account_id)
    if (!a) return { ok: false, reason: (ev && ev.account_id) ? 'The "' + ev.account_id + '" connection is not available to superlazy' : 'Not sure which account this conversation is on — open the thread and reply from there' }
    if (a.status === 'token_expired') return { ok: false, reason: 'The ' + (a.email || ev.account_id) + ' session has expired — reconnect it at ' + RESOURCES + ', then come back to this tab', reauth: RESOURCES }
    if (a.status && a.status !== 'ok') return { ok: false, reason: 'The ' + (a.email || ev.account_id) + ' connection is not working (' + a.status + ') — check it at ' + RESOURCES, reauth: RESOURCES }
    if (a.access[service] !== 'readwrite') return { ok: false, reason: 'The ' + (a.email || ev.account_id) + ' connection is set to read-only — allow read+write for it at ' + RESOURCES, reauth: RESOURCES }
    return { ok: true }
  }
  function sendState (ev) {
    if (!sendCap.checked) return { ok: false, reason: 'Checking send permission…' }
    if (!sendCap.perm) return { ok: false, reason: sendCap.mailOutdated ? 'The "send_replies" permission changed and needs accepting again in superlazy’s settings' : 'To send from here, grant the "send_replies" permission in superlazy’s settings', reauth: APP_SETTINGS }
    return stateFor(ev, 'mail')
  }
  function chatSendState (ev) {
    if (!sendCap.checked) return { ok: false, reason: 'Checking send permission…' }
    if (!sendCap.chatPerm) return { ok: false, reason: sendCap.chatOutdated ? 'The "send_messages" permission changed and needs accepting again in superlazy’s settings' : 'Replying on Slack needs the "send_messages" permission — grant it in superlazy’s settings', reauth: APP_SETTINGS }
    return stateFor(ev, 'messaging')
  }
  // an expired session found AT SEND TIME: never navigate away (the reply being written would be
  // lost) — mark the account, and hand the composer a message + the reconnect link instead
  function expiredError (e, name) {
    const d = (e && e.data) || e || {}
    if (d.error !== 'token_expired') return null
    const a = acctOf(name); if (a) a.status = 'token_expired'
    const err = new Error('The ' + ((a && a.email) || name) + ' session has expired — reconnect it, then press Send again (your text is kept)')
    err.reauth_url = d.reauth_url || RESOURCES
    return err
  }

  const logSent = (sentEv) => {
    persist.addEvent(sentEv).catch(e => console.error('event save failed', e))
    if (onSent) onSent(sentEv)
    // your own message on a thread retires every draft that answered it — now, not on the next load
    lastByThread = null
    refreshSelfReplies()
    if (refresh) refresh()
  }

  // low-level send + event logging — used by the drafts AND the viewer's Reply/Forward.
  // bodyHtml (optional) goes as the HTML part; bodyText is always sent as the plain alternative.
  async function sendMail ({ connectionName, to, cc, subject, bodyText, bodyHtml, threadId }) {
    let res
    try {
      // Gmail threads by threadId; the RFC In-Reply-To header isn't stored for these messages
      res = await freezr.connections.mail.sendMessage({ connectionName, to, cc, subject, bodyText, bodyHtml: bodyHtml || undefined, threadId })
    } catch (e) {
      throw expiredError(e, connectionName) || e
    }
    logSent({
      kind: 'mail_action',
      source_id: 'user',
      asof: Date.now(),
      account_id: connectionName || null,
      msg_id: (res && res.messageId) || null,
      thread_id: (res && res.threadId) || threadId || null,
      subject: subject || '',
      from_address: (selfAddrs ? selfAddrs() : [])[0] || '',
      summary: 'You sent this from superlazy.',
      changes: [],
      cost: 0
    })
    return res
  }

  // a chat reply (Slack today): posts in the conversation, in-thread when threadId is given.
  // thread_id is the superlazy stream id the reply belongs to, so the event lands on that thread.
  async function sendChat ({ connectionName, conversationId, threadId, text, thread_id }) {
    const M = freezr.connections && freezr.connections.messaging
    if (!M || !M.sendMessage) throw new Error('messaging is not available on this page')
    let res
    try {
      res = await M.sendMessage({ connectionName, conversationId, text, threadId: threadId || undefined })
    } catch (e) {
      throw expiredError(e, connectionName) || e
    }
    logSent({
      kind: 'mail_action',
      channel: 'messages',
      source_id: 'user',
      asof: Date.now(),
      account_id: connectionName || null,
      msg_id: (res && (res.messageId || res.id || res.ts)) || ('sent:' + Date.now()),
      thread_id: thread_id || null,
      subject: '',
      from_address: (selfAddrs ? selfAddrs() : [])[0] || '',
      summary: 'You replied from superlazy.',
      changes: [],
      cost: 0
    })
    return res
  }

  // the mail context a draft replies INTO: its task's latest message (account, thread, subject,
  // sender) — the shape renderDraft and performSend take
  function evLikeFor (r, p) {
    const t = r && (p.todos || []).find(t => t.todo_id === r.todo_id)
    const lastMail = t ? (t.evidence || []).filter(e => e.msg_id).sort((a, b) => (Number(a.asof) || 0) - (Number(b.asof) || 0)).pop() : null
    const evs = events()
    const evt = lastMail ? evs.find(e => e.msg_id === lastMail.msg_id) : null
    // the account: that message's event; else any event on the same thread; else the mailbox the
    // PROJECT's mail came from (its email: source). NEVER "whichever account can send" — that
    // guess once replied to a work thread from a personal mailbox (2026-09-27).
    const threadEv = (!evt || !evt.account_id) && lastMail && lastMail.thread_id
      ? evs.find(e => e.thread_id === lastMail.thread_id && e.account_id) : null
    return {
      account_id: (evt && evt.account_id) || (threadEv && threadEv.account_id) || accountFromSources(p),
      thread_id: (lastMail && lastMail.thread_id) || null,
      msg_id: (lastMail && lastMail.msg_id) || null,
      subject: (evt && evt.subject) || '',
      from_address: (evt && evt.from_address) || (t && t.sender) || ''
    }
  }

  // send the draft, mark it sent, persist. payload = what the composer shows (recipients, subject,
  // formatted body + the quoted thread); without one (Send from the read view) the draft is sent
  // as stored, with the thread quoted under it.
  async function performSend (ev, ent, payload = null) {
    const r = ent.response
    let out = payload
    if (!out) {
      const body = await composeWithQuote({ userText: r.body || '', userHtml: r.body_html || '', thread_id: ev.thread_id, msg_id: ev.msg_id, account_id: ev.account_id })
      out = {
        to: (r.to && r.to.length) ? r.to : [ev.from_address].filter(Boolean),
        cc: (r.cc && r.cc.length) ? r.cc : [],
        subject: r.subject || '',
        ...body
      }
    }
    const res = await sendMail({
      connectionName: ev.account_id,
      to: out.to,
      cc: (out.cc && out.cc.length) ? out.cc : undefined,
      subject: out.subject || r.subject || replySubject(ev.subject),
      bodyText: out.bodyText,
      bodyHtml: out.bodyHtml,
      threadId: ev.thread_id || undefined
    })
    r.status = 'sent'
    r.sent_asof = Date.now()
    persist.saveProject(ent.project).catch(e => console.error('project save failed', e))
    return res
  }

  const draftHandlers = {
    resolve: resolveResponse,
    evLikeFor,
    // a draft is stale once its TASK is gone / resolved or a later message superseded it (the
    // shared isLiveResponse rule), or once the thread moved on in the events log
    isStale: (ev, r) => {
      const p = r.project_id && getProject(r.project_id)
      if (!isLiveResponse(r, p)) return true
      return !!threadStaleReason(r, p, ev && ev.thread_id)
    },
    sendState,
    accountLabel,
    onSend: async (ev, ent, payload) => { await performSend(ev, ent, payload); if (refresh) refresh() },
    // the draft is edited IN PLACE (renderUtils.renderDraft) — this just persists the result
    // — and deliberately does NOT repaint: edits autosave while the composer is open, and a
    // repaint would rebuild the card out from under the cursor
    onEdit: (ev, ent) => {
      ent.response.edited_asof = Date.now()
      persist.saveProject(ent.project).catch(e => console.error('project save failed', e))
    },
    onDismiss: (ent) => {
      ent.response.status = 'dismissed'
      ent.response.dismissed_asof = Date.now()
      persist.saveProject(ent.project).catch(e => console.error('project save failed', e))
      if (refresh) refresh()
    }
  }

  // ---- the viewer's superlazy context --------------------------------------------------------
  // projects = every project this thread/message touched (via task evidence + event changes);
  // messages = EVERY analysed email on this thread OR on those projects (the snippet list —
  // context is project-wide, not thread-bound); tasksFor(msg_id) = the todos a given email
  // raised/changed; drafts = still-relevant suggested replies on the related projects' open tasks.
  // project_id (optional): the viewer was opened FROM one project (a task row / project card) —
  // the SIDEBAR then shows only that project's items. A chat chunk routinely touches several
  // projects (one DM burst, two topics), and showing the other project's whole correspondence in
  // a task's modal read as noise (user, 2026-08-30). The head still lists EVERY touched project
  // (that is the "also touches" metadata); opening from the Events page passes no filter.
  function relatedFor ({ msg_id, thread_id, project_id = null }) {
    const evs = events()
    // what counts as "this message's" trail: the message itself, or — MAIL only — its thread. A chat
    // stream id is a whole channel (messageHistory.isMailThreadId), so matching on it would list
    // every project any chunk of the channel ever touched as "related" (user, 2026-10-04).
    const mailThread = thread_id && ((e) => e.thread_id === thread_id && (e.channel || e.type || 'mail') === 'mail')
    const touches = (e) => (msg_id && e.msg_id === msg_id) || (mailThread && mailThread(e))

    const projMap = new Map()
    for (const p of projects()) {
      for (const t of (p.todos || [])) {
        if ((t.evidence || []).some(touches)) { projMap.set(p.project_id, p); break }
      }
    }
    for (const e of evs) {
      if (touches(e)) {
        for (const c of (e.changes || [])) {
          const p = c.project_id && getProject(c.project_id)
          if (p) projMap.set(p.project_id, p)
        }
      }
    }
    const projIds = new Set(projMap.keys())

    const messages = []
    const seenMsg = new Set()
    for (const e of evs) {
      if (!e.msg_id || e.kind === 'manual_edit' || seenMsg.has(e.msg_id)) continue
      const eProjs = [...new Set((e.changes || []).map(c => c.project_id).filter(Boolean))]
      // filtered mode: only items that touched THE project (the opened message itself always
      // qualifies — it is what the user clicked). Unfiltered: same thread or any shared project.
      // A MAIL thread's other messages belong with it even when they touched no task (a reply
      // that just said "thanks") — the task's ✉ lands on the thread's newest message. Chat streams
      // stay project-filtered: one DM stream carries many unrelated topics.
      const sameMailThread = thread_id && e.thread_id === thread_id && (e.channel || 'mail') === 'mail'
      const related = project_id
        ? (eProjs.includes(project_id) || e.msg_id === msg_id || sameMailThread)
        : ((thread_id && e.thread_id === thread_id) || eProjs.some(pid => projIds.has(pid)))
      if (!related) continue
      seenMsg.add(e.msg_id)
      messages.push({
        msg_id: e.msg_id,
        thread_id: e.thread_id || null,
        account_id: e.account_id || null,
        channel: e.channel || 'mail',
        date: clockOf(e),
        from_address: e.from_address || '',
        subject: e.subject || '',
        summary: e.summary || e.body_snippet || '',
        has_summary: !!e.summary, // true = the model's summary; false = a body-snippet fallback the viewer should not repeat above the body
        projects: eProjs.filter(pid => projIds.has(pid)).map(projectName)
      })
    }
    messages.sort((a, b) => b.date - a.date)

    const tasksFor = (mid) => {
      const out = []
      for (const p of projMap.values()) {
        for (const t of (p.todos || [])) {
          if ((t.evidence || []).some(e2 => e2.msg_id === mid)) out.push({ todo: t, project: p })
        }
      }
      return out
    }

    const drafts = []
    for (const p of projMap.values()) {
      if (project_id && p.project_id !== project_id) continue // filtered mode: this project's drafts only
      for (const r of (p.responses || [])) {
        // reminders live on their task row, never as a draft; everything else must still be LIVE
        if (r.kind === 'reminder' || !isLiveResponse(r, p)) continue
        const t = (p.todos || []).find(t => t.todo_id === r.todo_id)
        const evLike = evLikeFor(r, p)
        if (!evLike.thread_id) evLike.thread_id = thread_id || null
        if (draftHandlers.isStale(evLike, r)) continue
        drafts.push({ response: r, project: p, todo: t, evLike })
      }
    }

    return {
      projects: [...projMap.values()],
      messages,
      drafts,
      tasksFor,
      // set when the sidebar is filtered — the viewer shows which project's items it is showing
      filter_project: project_id ? (projectName(project_id) || project_id) : null,
      filter_project_id: project_id || null
    }
  }

  const context = {
    nameOf: (a) => nameOf && nameOf(a),
    getSettings: () => { try { return getSettings ? (getSettings() || null) : null } catch (e) { return null } },
    related: relatedFor,
    onOpenProject,
    onOpenPerson,
    drafts: draftHandlers,
    taskHandlers,
    sendMail,
    sendChat,
    chatSendState,
    // the mailbox a project's mail came from (email: source → connection), for a message opened
    // without an account; and the From-line label for a connection
    accountFromSources,
    accountLabel,
    selfAddrs: () => (selfAddrs ? selfAddrs() : []),
    // Edit a canonical NOTE from the viewer (specs/superlazy-inputs.md §6.4): reopen the
    // Add-note modal prefilled; saving bumps the revision and re-analyses as an amendment.
    onEditNote: async ({ account_id, msg_id }) => {
      if (!persist || !persist.getInput) return
      const rec = await persist.getInput({ account_id, msg_id })
      if (!rec) return
      openNewNoteModal({
        persist,
        existing: rec,
        projects: (getProjects ? getProjects() : []).filter(p => p && p.status !== 'archived'),
        authorAddress: rec.author_address || ((selfAddrs && selfAddrs()) || [])[0] || '',
        onDone: () => { if (refresh) refresh() }
      })
    }
  }

  return { context, draftHandlers, sendMail, sendChat, sendState, refreshSelfReplies }
}
