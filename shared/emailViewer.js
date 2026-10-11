// emailViewer.js — the SHARED full-email viewer: a reading-pane mail client around one email's
// PROJECT context.
//
//   LEFT: one flat list of email SNIPPETS — this thread's emails AND every email from the
//   related projects' other threads. Each snippet: sender (bold) · date right · subject ·
//   first lines of the summary · the project(s) it relates to. An unsent suggested-reply
//   draft appears as a snippet too, and is the DEFAULT selection when present.
//
//   RIGHT: the selected item, laid out like Mac Mail's reading pane: an action toolbar (Reply /
//   Reply all / Forward — Reply for a chat), the reply COMPOSER when one is open (replyComposer.js:
//   formatting + the thread quoted under the text), then the message header (subject, sender
//   avatar + name, recipients, date), the TASKS that message raised/changed, and the body
//   (sanitised, Shadow-DOM-isolated). For a draft: the full draft with Send / Edit / Dismiss.
//
// STORED-FIRST: bodies come from the app's own `email_bodies` snapshot; the live mail source
// is the fallback (pruned copies, attachment bytes).
//
// Pages opt in via configureEmailViewer({ context }); without a context the viewer lists just
// the one thread. context = {
//   nameOf(addr) → display name | null,
//   related({ msg_id, thread_id }) → {
//     projects: [project],
//     messages: [{ msg_id, thread_id, account_id, date, from_address, subject, summary,
//                  projects: [name] }],   // newest first
//     drafts: [{ response, project, todo, evLike }],
//     tasksFor(msg_id) → [{ todo, project }]
//   },
//   onOpenProject(project),
//   drafts: { sendState(evLike), onSend(evLike, ent, payload?), onEdit(evLike, ent), onDismiss(ent) },
//   sendMail({ connectionName, to, cc, subject, bodyText, bodyHtml, threadId }) → Promise,
//   sendChat({ connectionName, conversationId, threadId, text, thread_id }) → Promise,
//   chatSendState({ account_id }) → { ok } | { ok:false, reason },
//   selfAddrs() → your own addresses (Reply all leaves them out)
// }
//
// Email HTML is untrusted: sanitised and rendered inside a Shadow DOM so it can neither run
// script nor restyle the app. Plain text is shown via textContent.

import { htmlToText } from '../jobs/analyze_thread/htmlToText.js'
import { effortLine } from '../jobs/analyze_thread/sessionDigest.js'
import { openModalShell } from './modalStack.js'
import { renderHtmlBody } from './mailHtml.js'
import { configureReplyContext, openComposer, selfAddresses } from './replyComposer.js'
import { div, span, btn, el, projectChip, taskRowEl, renderDraft, fmtDateTime, fmtAgo, chatTitle, docIndexForFile, editorUrlFor, serverIsLocal, EDITOR_URL_DEFAULT, absPathFor } from './renderUtils.js'
import { renderMarkdown } from './markdownLite.js'

let mailSource = null
let persistRef = null
let pageCtx = null
let railSeq = 0 // unique ids for each viewer's rail, so the ☰ can point aria-controls at it
export function configureEmailViewer ({ source, persist, context } = {}) {
  mailSource = source || null
  persistRef = persist || null
  pageCtx = context || null
  // the reply composer loads threads for quoting from the same stores, from any surface
  configureReplyContext({ persist: persistRef, source: mailSource, selfAddrs: (pageCtx && pageCtx.selfAddrs) || null })
}
export function emailViewerReady () { return !!(mailSource || persistRef) }

const threadCache = new Map() // thread_id -> raw LIVE messages (oldest-first)
export function clearEmailViewerCache () { threadCache.clear() }

function fmtSize (bytes) {
  const n = Number(bytes) || 0
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return n + ' B'
}

// sanitize / EMAIL_BODY_CSS / renderHtmlBody live in mailHtml.js (shared with the composer)

// Mail's header date, in the reader's own clock ("Wed 24 Sep 2026 at 12:14"); the app-wide
// fmtDateTime is UTC and stays on the tooltip
const localWhen = (ms) => {
  const n = Number(ms); if (!n) return ''
  try {
    const d = new Date(n)
    return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' at ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  } catch (e) { return fmtDateTime(ms) }
}

// the sender's initials in a coloured disc — Mail's avatar placeholder. Colour is a stable hash
// of the address, so a person keeps their colour across messages.
const AVATAR_HUES = [211, 262, 330, 18, 145, 190, 38, 290]
function avatarEl (p) {
  const name = String((p && (p.name || p.address)) || '?').replace(/<.*>/, '').trim()
  const parts = name.split(/[\s@._-]+/).filter(Boolean)
  const ini = ((parts[0] || '?')[0] + (parts.length > 1 && !name.includes('@') ? parts[parts.length - 1][0] : '')).toUpperCase()
  const key = String((p && p.address) || name).toLowerCase()
  let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  const a = document.createElement('span')
  a.className = 'emv-avatar'
  a.textContent = ini
  a.style.setProperty('--av-h', String(AVATAR_HUES[h % AVATAR_HUES.length]))
  a.setAttribute('aria-hidden', 'true')
  return a
}

// ---- unify stored records and live raw messages into one render view --------------------

const storedToView = (r) => ({
  msg_id: r.msg_id,
  account_id: r.account_id || null,
  date: Number(r.date) || 0,
  from: { name: r.from_name || '', address: r.from_address || '' },
  to: r.to_addresses || [],
  cc: r.cc_addresses || [],
  subject: r.subject || '',
  html: r.body_html || '',
  text: r.body_text || '',
  attachments: r.attachments || [],
  htmlTruncated: !!r.html_truncated,
  // channel extras (inputs-mapped records; legacy email_bodies rows default to mail)
  channel: r.channel || 'mail',
  item_kind: r.item_kind || null,
  authority: r.authority || null,
  // work (agent session) header fields
  repo_name: r.repo_name || null,
  branch: r.branch || null,
  turn_n: r.turn_n || null,
  turns_total: r.turns_total || null,
  turn_state: r.turn_state || null,
  turn_kind: r.turn_kind || null,
  work_stats: r.work_stats || null,
  files_changed: r.files_changed || [],
  files_changed_paths: r.files_changed_paths || [],
  commits: r.commits || [],
  agent_name: r.agent_name || null,
  agent_work: r.agent_work || null,
  // cwd resolves Codex's relative changed-file paths (absPathFor); the rest is kept for parity
  // with the inputs record
  thread_id: r.thread_id || null,
  provider: r.provider || null,
  cwd: r.cwd || null,
  source_path: r.source_path || null,
  conversation_id: r.conversation_id || null
})
// the changed files of a work turn: basenames, full paths on hover
// onOpenDoc(i): when given, a changed file that is one of the turn's captured documents
// (agent_work.plans) renders as a link that opens it in the Plan pane (user, 2026-09-10: "Files:
// agent-plans-and-task-quality.md in the metadata but no way to open it")
// The user's editor URL template (Preferences → "Open files in"), default VS Code. Read through
// the host's context so a change in Preferences shows without a reload.
const editorTemplate = () => {
  try { const st = pageCtx && typeof pageCtx.getSettings === 'function' ? pageCtx.getSettings() : null; return (st && st.editor_url_template) || EDITOR_URL_DEFAULT } catch (e) { return EDITOR_URL_DEFAULT }
}
// One clickable NAME that opens the file in the user's editor (Preferences → "Open files in",
// default VS Code). Only when the server is on THIS machine — a local path means nothing to a
// browser elsewhere — otherwise the name is plain text carrying the path as its tooltip. No copy
// button and no separate "open" pill (user, 2026-09-13: clicking the file name should open it).
const editorLink = (absPath, text, cls) => {
  if (!absPath || !String(absPath).startsWith('/')) return null
  if (!serverIsLocal()) return null
  const url = editorUrlFor(editorTemplate(), absPath)
  if (!url) return null
  const a = document.createElement('a'); a.className = cls; a.href = url; a.textContent = text
  a.title = 'Open in ' + editorTemplate().split(':')[0] + ' — ' + absPath + ' (change the editor in Preferences)'
  return a
}
const nameEl = (text, absPath) => {
  const a = editorLink(absPath, text, 'emv-file-name emv-file-link')
  if (a) return a
  const n = span('emv-file-name', text)
  if (absPath) n.title = absPath
  return n
}

const filesCell = (view, onOpenDoc = null) => {
  const names = view.files_changed || []
  const paths = view.files_changed_paths || []
  const plans = (view.agent_work && view.agent_work.plans) || []
  const list = div('emv-file-list')
  names.slice(0, 12).forEach((nm, k) => {
    const row = div('emv-file-row')
    const abs = absPathFor(paths.find(pp => String(pp).split('/').pop() === nm) || null, view.cwd)
    const di = onOpenDoc ? docIndexForFile(plans, nm) : -1
    row.appendChild(nameEl(nm, abs))
    if (di >= 0) {
      // a document captured on this turn: the name opens the LATEST file in the editor; this
      // opens the version written HERE in the Plan pane below
      const b = document.createElement('button'); b.type = 'button'; b.className = 'emv-doc-link emv-doc-here'; b.textContent = 'this version'
      b.title = 'Show the version written on this turn in the Plan pane below'
      b.addEventListener('click', () => onOpenDoc(di))
      row.appendChild(b)
    }
    list.appendChild(row)
  })
  if (names.length > 12) list.appendChild(div('wl-muted', '+' + (names.length - 12) + ' more'))
  return list
}
const liveToView = (m) => ({
  msg_id: m.msg_id,
  account_id: m.account_id || null,
  date: Number(m.date) || 0,
  from: m.from || { name: '', address: '' },
  to: m.to || [],
  cc: m.cc || [],
  subject: m.subject || '',
  html: m.html || '',
  text: m.text || '',
  attachments: [], // live loadThreadRaw carries no manifest — attachments come from the stored snapshot
  htmlTruncated: false
})

async function loadLiveThread (threadId) {
  if (threadCache.has(threadId)) return threadCache.get(threadId)
  const res = await mailSource.loadThreadRaw(threadId)
  const messages = ((res && res.messages) || []).slice()
    .sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0))
  threadCache.set(threadId, messages)
  return messages
}

// ---- the modal --------------------------------------------------------------------------

// Open the viewer. msg_id/thread_id anchor the context; account_id lets the stored body be
// read by _id; snippet paints instantly while the body loads.
// project_id (optional): opened FROM one project (task row / project card) — the sidebar shows
// only that project's items; the header still names every project the message touched. Omitted
// when opened from the Events page (there the whole picture is wanted).
// prefer_latest: land on the NEWEST message of that thread rather than msg_id (the ✉ on a task row).
// host (optional): EMBED the viewer in that element instead of a modal — the Threads view's
// columns 2 + 3 (threadsView.js). Same header, list and reading pane; no overlay, no ✕. Returns
// { destroy(), holdsTyping() } in that mode (the modal mode returns the overlay, as before).
export function openEmailViewer ({ msg_id, thread_id, account_id, subject, snippet, project_id, prefer_latest = false, host = null } = {}) {
  let closed = false
  let rel = null
  if (pageCtx && pageCtx.related) {
    try { rel = pageCtx.related({ msg_id, thread_id, project_id }) } catch (e) { rel = null }
  }
  const nice = (a) => (pageCtx && pageCtx.nameOf && pageCtx.nameOf(a)) || a || '?'
  const bodyCache = new Map() // msg_id -> render view | null (looked up, nothing found)

  const teardown = () => { closed = true; if (activeComposer) activeComposer.destroy(); document.removeEventListener('keydown', onRailKey, true) }
  let overlay = null
  let modal = null
  if (host) {
    host.textContent = ''
    modal = host
    host.classList.add('emv-modal', 'emv-embedded')
  } else {
    ({ overlay, modal } = openModalShell({ className: 'epv-modal-wide emv-modal', onClose: teardown }))
  }

  // ONE header line in title font — "4 related emails, 1 unsent draft, 2 projects:" + pills
  const head = div('epv-modal-title emv-title')
  modal.appendChild(head)
  function paintHead () {
    head.textContent = ''
    const msgs = items.filter(i => i.kind === 'msg').length
    const drafts = items.filter(i => i.kind === 'draft').length
    const projs = (rel && rel.projects) || []
    if (rel && rel.filter_project) {
      // filtered mode (opened from one project): the header claims ONLY that project — other
      // projects a given input touches are noted on the input itself, above its tasks.
      const fp = projs.find(p => p.project_id === rel.filter_project_id)
      const parts = [msgs + ' item' + (msgs === 1 ? '' : 's')]
      if (drafts) parts.push(drafts + ' unsent draft' + (drafts === 1 ? '' : 's'))
      head.appendChild(span('emv-title-txt', parts.join(', ') + ' for '))
      head.appendChild(fp
        ? projectChip(fp.name, (pageCtx && pageCtx.onOpenProject) ? () => pageCtx.onOpenProject(fp) : null)
        : span('emv-title-txt', '“' + rel.filter_project + '”'))
      return
    }
    const parts = [msgs + ' related email' + (msgs === 1 ? '' : 's')]
    if (drafts) parts.push(drafts + ' unsent draft' + (drafts === 1 ? '' : 's'))
    if (projs.length) parts.push(projs.length + ' project' + (projs.length === 1 ? '' : 's'))
    head.appendChild(span('emv-title-txt', parts.join(', ') + (projs.length ? ':' : '')))
    for (const p of projs) {
      head.appendChild(projectChip(p.name, (pageCtx && pageCtx.onOpenProject) ? () => pageCtx.onOpenProject(p) : null))
    }
    // TEMPORARY DEBUG (thread-linking investigation): the raw provider ids, selectable for
    // comparison against project.thread_ids. Remove once the linking bug is closed.
    const dbg = div(null, 'thread: ' + (thread_id || '(none)') + '   ·   msg: ' + (msg_id || '(none)'))
    dbg.style.cssText = 'font: 10px ui-monospace, Menlo, monospace; color: #999; margin-top: 3px; word-break: break-all; user-select: all;'
    head.appendChild(dbg)
  }

  // ---- the conversation list: a column on a wide screen, a DRAWER on a narrow one -----------
  // Phone mail clients all work this way and it is the only shape that fits: side by side, 265px
  // of snippets leaves nothing for the message itself, and stacking them (what this did before)
  // spent a third of the screen on a list you are not reading. So on a narrow screen the rail
  // slides in over the message from the left, on a ☰ in the modal's top corner, and slides back
  // out the moment you pick something. All of that is CSS (index.css, max-width:700px); the JS
  // only owns the open/closed flag, so a window resize needs no handling at all.
  // It opens CLOSED: this modal is always entered from one specific message — that message is
  // what you asked for, and the list is there to go elsewhere afterwards.
  const body = div('epv-modal-body')
  const rail = div('emv-rail')
  rail.id = 'emv-rail-' + (++railSeq)
  const scrim = div('emv-railscrim') // catches the tap beside the open drawer; display:none wide
  const detail = div('epv-modal-detail emv-detail')
  body.appendChild(rail); body.appendChild(scrim); body.appendChild(detail); modal.appendChild(body)

  let railOpen = false
  const railBtn = el('button', 'emv-railbtn')
  railBtn.type = 'button'
  railBtn.setAttribute('aria-controls', rail.id)
  railBtn.setAttribute('aria-expanded', 'false')
  railBtn.appendChild(span('emv-railbtn-glyph', '☰'))
  const railCount = span('emv-railbtn-n')
  railBtn.appendChild(railCount)
  modal.appendChild(railBtn)

  function setRail (on) {
    railOpen = on
    body.classList.toggle('emv-rail-open', on)
    railBtn.setAttribute('aria-expanded', String(on))
    railBtn.title = on ? 'Hide the conversation' : 'The rest of this conversation'
    // querySelector with a selector LIST returns the first match in document order, not the first
    // matching selector — so the active item has to be asked for on its own, or a long
    // conversation opens focused (and scrolled) on its first snippet instead of the one you are
    // reading.
    if (on) {
      const item = rail.querySelector('.emv-snip.active') || rail.querySelector('.emv-snip')
      if (item) { item.focus({ preventScroll: true }); item.scrollIntoView({ block: 'nearest' }) }
    }
  }
  // Escape closes the DRAWER before the modal. Capture phase on document, so it runs ahead of
  // modalStack's own bubble-phase Escape handler and can stop the event reaching it.
  function onRailKey (e) {
    if (e.key !== 'Escape' || !railOpen) return
    e.stopPropagation(); e.preventDefault()
    setRail(false)
    railBtn.focus({ preventScroll: true })
  }
  document.addEventListener('keydown', onRailKey, true)
  railBtn.addEventListener('click', () => setRail(!railOpen))
  scrim.addEventListener('click', () => setRail(false))
  setRail(false)

  function spinnerLine (text) {
    const w = div('epv-loader')
    w.appendChild(span('freezr-spinner'))
    w.appendChild(span(null, ' ' + text))
    return w
  }

  // ---- the item list (drafts pinned first, then emails newest-first) ----------------------
  let items = []
  let sel = null
  function buildItems () {
    items = []
    for (const d of (rel && rel.drafts) || []) items.push({ kind: 'draft', id: 'd:' + d.response.response_id, d })
    for (const m of (rel && rel.messages) || []) items.push({ kind: 'msg', id: 'm:' + m.msg_id, m })
  }

  // live task rows — resolve / cancel / re-prioritise right here. The email icon and project
  // pill are dropped via showOnly: this modal IS the email, and the header carries the projects.
  const TASK_FIELDS = ['check', 'due', 'edit', 'imp', 'cancel']
  function taskSection (label, tasks) {
    const wrap = div('emv-msg-tasks')
    wrap.appendChild(div('epv-modal-head', label))
    const list = div('emv-msg-tasks-list')
    const base = (pageCtx && pageCtx.taskHandlers) || {}
    const rerender = () => { if (sel) select(sel) }
    const th = {
      ...base,
      onResolve: base.onResolve ? (t, p) => { base.onResolve(t, p); rerender() } : null,
      onCancel: base.onCancel ? (t, p) => { base.onCancel(t, p); rerender() } : null,
      onImportance: base.onImportance ? (t, d, p) => { base.onImportance(t, d, p); rerender() } : null,
      onEdit: base.onEdit ? (t, p) => base.onEdit(t, p, { onChange: rerender }) : null
    }
    for (const { todo, project } of tasks) {
      // same content as the Events page's task rows (which this modal opens from), so the
      // same direction marks — the list mixes I-owe / owed / team freely
      list.appendChild(taskRowEl(todo, project, th, { showOnly: TASK_FIELDS, showDirection: true }))
    }
    wrap.appendChild(list)
    return wrap
  }

  // ---- the snippets ------------------------------------------------------------------------
  function snipEl (item) {
    const s = el('button', 'emv-snip' + (sel && sel.id === item.id ? ' active' : '') + (item.kind === 'draft' ? ' emv-snip-draft' : ''))
    s.type = 'button'
    const top = div('emv-snip-top')
    if (item.kind === 'draft') {
      const r = item.d.response
      top.appendChild(span('emv-snip-from', (r.kind === 'delegate' ? '➜ Delegation draft' : '↩ Suggested reply') + ' — unsent'))
      s.appendChild(top)
      const toList = ((r.to && r.to.length) ? r.to : [item.d.evLike.from_address]).filter(Boolean)
      s.appendChild(div('emv-snip-subj', 'to ' + toList.map(nice).join(', ')))
      s.appendChild(div('emv-snip-sum', r.body || '(empty draft)'))
      s.appendChild(div('emv-snip-projs', item.d.project.name || ''))
    } else {
      const m = item.m
      const isChat = m.channel === 'messages'
      const isWork = m.channel === 'work'
      // a chat chunk's identity is its CONVERSATION, not the first author; no subject line.
      // a work turn's identity is its SESSION (the title) — same treatment
      top.appendChild(span('emv-snip-from', isChat ? '💬 ' + chatTitle(m.subject) : isWork ? '🤖 ' + (m.subject || 'session') : nice(m.from_address)))
      // the message this viewer was opened on — Mail's blue dot in the gutter
      if (m.msg_id === focusId) { const dot = span('emv-snip-dot'); dot.title = 'the message you opened'; s.appendChild(dot) }
      const dt = span('emv-snip-date', fmtAgo(m.date)); dt.title = fmtDateTime(m.date)
      top.appendChild(dt)
      s.appendChild(top)
      if (!isChat && !isWork) s.appendChild(div('emv-snip-subj', m.subject || '(no subject)'))
      if (m.summary) s.appendChild(div('emv-snip-sum', m.summary))
      if ((m.projects || []).length) s.appendChild(div('emv-snip-projs', m.projects.join(' · ')))
    }
    s.addEventListener('click', () => select(item))
    return s
  }

  let railBusy = false // true while the rest of the conversation loads in the background
  function paintRail () {
    rail.textContent = ''
    for (const item of items) rail.appendChild(snipEl(item))
    if (railBusy) rail.appendChild(spinnerLine('loading the conversation…'))
    else if (!items.length) rail.appendChild(div('epv-empty', 'No related emails found.'))
    // the count IS the drawer's label on a narrow screen — with the list off-canvas it is the
    // only sign that there is more of this conversation to read
    railCount.textContent = items.length > 1 ? String(items.length) : ''
  }

  let activeComposer = null // the open reply composer, if any (one at a time)
  let focusId = msg_id // the message the viewer lands on (the newest of the thread when prefer_latest)
  function select (item) {
    if (activeComposer && activeComposer.isDirty() && sel && sel.id !== item.id &&
        !window.confirm('Discard the reply you are writing?')) return
    if (activeComposer) { activeComposer.destroy(); activeComposer = null }
    sel = item
    paintRail()
    setRail(false) // picking an item sends the drawer back, like every phone mail client
    if (item.kind === 'draft') showDraft(item)
    else showEmail(item)
  }

  // ---- right panel: the draft ---------------------------------------------------------------
  function showDraft (item) {
    detail.textContent = ''
    const wrapped = {
      ...pageCtx.drafts,
      onSend: async (evLike, ent, payload) => { await pageCtx.drafts.onSend(evLike, ent, payload); afterDraftGone(item) },
      onDismiss: (ent) => { pageCtx.drafts.onDismiss(ent); afterDraftGone(item) }
    }
    detail.appendChild(renderDraft(item.d.evLike, { response: item.d.response, project: item.d.project }, { nameOf: pageCtx && pageCtx.nameOf }, wrapped))
    if (item.d.todo) {
      detail.appendChild(taskSection('For to-do', [{ todo: item.d.todo, project: item.d.project }]))
    }
  }
  function afterDraftGone (item) {
    if (pageCtx && pageCtx.related) { try { rel = pageCtx.related({ msg_id, thread_id, project_id }) } catch (e) { /* keep */ } }
    buildItems(); paintHead()
    const next = items.find(i => i.kind === 'msg' && i.m.msg_id === msg_id) || items[0] || null
    if (next) select(next)
    else { paintRail(); detail.textContent = ''; detail.appendChild(div('epv-empty', 'Nothing else here.')) }
  }

  // ---- right panel: an email ----------------------------------------------------------------
  async function ensureBody (m) {
    if (bodyCache.has(m.msg_id)) return bodyCache.get(m.msg_id)
    let view = null
    if (persistRef) {
      try {
        const stored = await persistRef.getEmailBody({ account_id: m.account_id || account_id, msg_id: m.msg_id })
        if (stored) view = storedToView(stored)
      } catch (e) { /* fallbacks below */ }
    }
    // The stored-body id is (account|msg)-scoped, and some open paths (a task's history row)
    // carry no account_id — the direct lookup misses even though the record exists. The thread
    // ledger doesn't need the account: fetch the thread's stored bodies and pick the message.
    // This is also the ONLY body path for Slack chunks opened without an account id.
    if (!view && persistRef && m.thread_id) {
      try {
        const hit = ((await persistRef.getThreadBodies(m.thread_id)) || []).find(r => r.msg_id === m.msg_id)
        if (hit) view = storedToView(hit)
      } catch (e) { /* live below */ }
    }
    // no live fallback for notes (canonical — inputs IS the store) or slack chunks (the ledger is
    // authoritative; the MAIL source would walk the whole mailbox hunting a 'slack:…' thread id)
    if (!view && mailSource && m.thread_id &&
        !String(m.thread_id).startsWith('note_') && !String(m.thread_id).startsWith('slack:') && !String(m.thread_id).startsWith('cc:')) {
      try {
        const live = (await loadLiveThread(m.thread_id)).find(x => x.msg_id === m.msg_id)
        if (live) view = liveToView(live)
      } catch (e) {
        if (mailSource.handleTokenExpired && mailSource.handleTokenExpired(e)) return null
      }
    }
    bodyCache.set(m.msg_id, view)
    return view
  }

  function headTable (lines) {
    const head = div('epv-eml-head')
    for (const ln of lines) {
      if (!ln) continue
      // a row is a [label, value] PAIR; anything else (a stray string from a mis-spliced array) is
      // skipped and reported rather than rendered one character at a time
      if (!Array.isArray(ln)) { console.error('[superlazy] headTable: non-pair row skipped', ln); continue }
      const r = div(null)
      r.appendChild(el('b', null, ln[0] + ': '))
      // a value may be a prebuilt node (address links) or plain text
      if (ln[1] && typeof ln[1] === 'object') r.appendChild(ln[1])
      else r.appendChild(document.createTextNode(ln[1] || '—'))
      head.appendChild(r)
    }
    return head
  }

  // an address as a PERSON LINK — opens the person modal (profile + special instructions)
  function personLink (p) {
    const addr = String((p && (p.address != null ? p.address : (typeof p === 'string' ? p : ''))) || '')
    const label = (p && p.name) ? p.name + ' <' + addr + '>' : (addr || '?')
    if (!(pageCtx && pageCtx.onOpenPerson) || !addr.includes('@')) return span('emv-addr', label)
    const b = btn('emv-addr emv-addr-link', label, () => pageCtx.onOpenPerson(addr.toLowerCase()))
    b.title = 'Open ' + addr + ' — profile & special instructions'
    return b
  }
  function addrCells (list) {
    const wrap = span('emv-addrs')
    const arr = (list || []).filter(Boolean)
    if (!arr.length) { wrap.textContent = '—'; return wrap }
    arr.forEach((p, i) => {
      if (i) wrap.appendChild(document.createTextNode(', '))
      wrap.appendChild(personLink(p))
    })
    return wrap
  }

  function renderAttachments (host, view) {
    if (!view.attachments || !view.attachments.length) return
    const wrap = div('emv-atts')
    const canFetch = !!(mailSource && mailSource.getAttachment)
    for (const att of view.attachments) {
      const chip = btn('emv-att', '📎 ' + (att.filename || 'attachment') + (att.sizeBytes ? ' · ' + fmtSize(att.sizeBytes) : ''))
      chip.title = canFetch
        ? 'Open — fetches from the mail server' + (att.mimeType ? ' (' + att.mimeType + ')' : '')
        : 'Attachments need the live mail source (not configured on this page)'
      if (!canFetch) chip.disabled = true
      else chip.addEventListener('click', () => openAttachment(chip, view, att))
      wrap.appendChild(chip)
    }
    host.appendChild(wrap)
  }

  async function openAttachment (chip, view, att) {
    const label = chip.textContent
    chip.disabled = true; chip.textContent = '⏳ ' + (att.filename || 'attachment')
    try {
      const blob = await mailSource.getAttachment({
        account_id: view.account_id, connectionName: view.account_id,
        messageId: view.msg_id, attachmentId: att.id, filename: att.filename, mimeType: att.mimeType
      })
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener')
      setTimeout(() => URL.revokeObjectURL(url), 60000)
    } catch (e) {
      if (mailSource.handleTokenExpired && mailSource.handleTokenExpired(e)) return
      chip.title = 'Could not fetch: ' + ((e && e.message) || e)
    } finally {
      if (!closed) { chip.disabled = false; chip.textContent = label }
    }
  }

  // ---- what the agent PLANNED and TICKED OFF on this turn (agent_work) ------------------------
  // The plan text is stored whole; shown collapsed (median 13k chars) and marked as the LATEST plan
  // of this session or an EARLIER version superseded by a later turn (user, 2026-09-10 — access plus
  // a version marker; diffs later if ever needed).
  function latestPlanTurnInThread () {
    let latest = 0
    for (const it of items) {
      const mm = it && it.m
      const aw = mm && mm.agent_work
      if (aw && Array.isArray(aw.plans) && aw.plans.some(p => p && p.kind !== 'patch') && Number(mm.turn_n) > latest) latest = Number(mm.turn_n)
    }
    return latest
  }
  function planRows (view, onOpenDoc = null) {
    const aw = view && view.agent_work
    const plans = (aw && Array.isArray(aw.plans)) ? aw.plans : []
    if (!plans.length) return []
    const latestTurn = latestPlanTurnInThread()
    const cell = div('emv-plans')
    plans.forEach((p, i) => {
      const isPatch = p.kind === 'patch'
      const mark = isPatch ? 'change to a document'
        : (!latestTurn || Number(view.turn_n) >= latestTurn) ? 'latest plan for this session' : 'earlier version — superseded on turn ' + latestTurn
      const row = div('emv-plan-row')
      const b = document.createElement('button'); b.type = 'button'; b.className = 'emv-doc-link'
      b.textContent = (isPatch ? '✎ ' : '📋 ') + (p.title || '(untitled)')
      b.title = 'Show this ' + (isPatch ? 'change' : 'plan') + ' in the pane below (toggle back to the dialogue there)'
      if (onOpenDoc) b.addEventListener('click', () => onOpenDoc(i))
      row.appendChild(b)
      row.appendChild(span('emv-plan-mark', ' — ' + mark + ' · ' + (p.chars || 0).toLocaleString() + ' chars' + (p.truncated ? ' (stored truncated)' : '')))
      cell.appendChild(row)
    })
    return [[plans.some(p => p.kind !== 'patch') ? 'Plan' : 'Plan change', cell]]
  }
  function checklistRow (view) {
    const aw = view && view.agent_work
    const cl = (aw && Array.isArray(aw.checklist)) ? aw.checklist : []
    if (!cl.length) return []
    const MARK = { completed: '✓', in_progress: '◐', pending: '○' }
    const cell = div('emv-checklist')
    for (const t of cl) {
      const row = div('emv-check emv-check-' + (t.status || 'pending'))
      row.textContent = (MARK[t.status] || '○') + ' ' + (t.content || '')
      cell.appendChild(row)
    }
    const done = cl.filter(t => t.status === 'completed').length
    return [['Checklist (' + done + '/' + cl.length + ')', cell]]
  }

  async function showEmail (item) {
    const m = item.m
    detail.textContent = ''
    detail.appendChild(spinnerLine('Loading the message…'))
    const view = await ensureBody(m)
    if (closed || sel !== item) return
    detail.textContent = ''
    // Mail's reading-pane shape: the action toolbar pinned on top, the reply composer (when open)
    // right under it, then the message
    const toolbar = div('emv-toolbar')
    const slot = div('emv-compose-slot')
    detail.appendChild(toolbar)
    detail.appendChild(slot)

    // WORK turns: the body area is a PANE that toggles between the dialogue and any plan/document
    // the agent wrote on this turn (user, 2026-09-10: show the plan below Tasks, toggle back to the
    // dialogue). openDoc(i) is wired into the header's Plan row and Files row; it exists before the
    // header is built and acts once the pane is on the page.
    const isWorkView = !!(view && view.channel === 'work')
    const docs = (isWorkView && view.agent_work && Array.isArray(view.agent_work.plans)) ? view.agent_work.plans : []
    let showPane = null   // (which) => void, set when the pane renders
    const openDoc = (i) => { if (showPane) showPane(i) }

    // The header block is per-channel (specs/superlazy-inputs.md §7): mail shows its
    // From/To/Cc envelope; a note shows author + attendees (attendees may be name-only —
    // personLink degrades those to plain text).
    if (view && view.channel === 'notes') {
      detail.appendChild(headTable([
        ['Note by', personLink(view.from)],
        (view.to && view.to.length ? ['Attendees', addrCells(view.to)] : null),
        ['Date', fmtDateTime(view.date)],
        ['Title', view.subject || '(untitled)']
      ]))
    } else if (view && view.channel === 'messages') {
      // a Slack CHUNK: the body is a transcript; the "recipients" are the chunk's participants
      detail.appendChild(headTable([
        ['Conversation', chatTitle(view.subject) || '(chat)'],
        (view.to && view.to.length ? ['Participants', addrCells(view.to)] : null),
        ['When', fmtDateTime(view.date)]
      ]))
    } else if (view && view.channel === 'work') {
      // an agent-session TURN: the body is the dialogue (YOU / CLAUDE CODE); the session is the thread
      const turnState = view.turn_state === 'unanswered' ? ' — no answer (left mid-turn)' : view.turn_state === 'mid_tool' ? ' — stopped mid-tool' : ''
      detail.appendChild(headTable([
        ['Session', view.subject || '(untitled session)'],
        ['Turn', (view.turn_n ? view.turn_n + (view.turns_total ? ' of ' + view.turns_total : '') : '?') + turnState],
        (view.repo_name ? ['Repo', view.repo_name + (view.branch ? ' (' + view.branch + ')' : '')] : null),
        ['With', (view.agent_name || 'AI agent') + ' (agent, team member)'],
        (view.work_stats ? ['Work', effortLine(view.work_stats) + (view.turn_kind === 'question' ? ' · ended with a question to you' : '')] : null),
        (view.files_changed && view.files_changed.length ? ['Files', filesCell(view, openDoc)] : null),
        (view.commits && view.commits.length ? ['Commits', view.commits.map(c => c.hash.slice(0, 7) + ' ' + (c.message || '')).join(' · ')] : null),
        // planRows / checklistRow return [] or [[label, cell]] — SPREAD them. (A .flat() here once
        // flattened every [label, value] pair too, and headTable then read "Session" as S: e.)
        ...planRows(view, openDoc),
        ...checklistRow(view),
        ['When', fmtDateTime(view.date)]
      ]))
    } else if (view) {
      detail.appendChild(mailHeader(view))
    } else {
      detail.appendChild(mailHeader({ from: { name: '', address: m.from_address || '' }, to: [], cc: [], date: m.date, subject: m.subject || '' }))
    }

    // filtered mode: this input may also serve OTHER projects (one DM chunk, several topics) —
    // say so here, on the input, since the header claims only the opened project
    if (rel && rel.filter_project_id) {
      const others = ((rel.projects || []).filter(p => p.project_id !== rel.filter_project_id &&
        (item.m.projects || []).includes(p.name)))
      if (others.length) {
        const row = div('emv-other-projs')
        row.appendChild(span('emv-other-projs-label', 'Other related project' + (others.length === 1 ? '' : 's') + ': '))
        for (const p of others) {
          row.appendChild(projectChip(p.name, (pageCtx && pageCtx.onOpenProject) ? () => pageCtx.onOpenProject(p) : null))
        }
        detail.appendChild(row)
      }
    }

    // the model's summary of THIS message — from the events log (rel.messages), never the body
    // snippet the rail falls back to. Above the to-dos, whatever the channel. Until 2026-09-21 it
    // rendered only when the body could NOT be fetched (the else-branch below), so every loaded
    // email and every repo dialogue hid it (user: "the modal doesn't show the summary").
    const relMsg = rel ? ((rel.messages || []).find(x => x.msg_id === m.msg_id) || null) : null
    const evSummary = (relMsg && relMsg.has_summary && relMsg.summary) ? relMsg.summary : ''
    if (evSummary) {
      const s = div('epv-eml-sum', evSummary)
      s.title = 'the model’s summary of this message, from the events log'
      detail.appendChild(s)
    }

    // the superlazy metadata: the tasks this email raised or changed — LIVE rows (in filtered
    // mode, only the opened project's — the other projects' tasks are their own business)
    let tasks = (rel && rel.tasksFor) ? rel.tasksFor(m.msg_id) : []
    if (rel && rel.filter_project_id) tasks = tasks.filter(x => x.project && x.project.project_id === rel.filter_project_id)
    if (tasks.length) detail.appendChild(taskSection('To-dos', tasks))

    if (view) {
      if (view.htmlTruncated) {
        detail.appendChild(div('emv-warn', 'The full formatted body was too large to store — showing plain text.'))
      }
      renderAttachments(detail, view)
      if (view.html) {
        renderHtmlBody(detail, view.html)
      } else if (isWorkView && docs.length) {
        // Dialogue | Plan… tabs above one pane; default = the dialogue
        const text = (view.text && view.text.trim()) || '(no body)'
        const tabs = div('emv-pane-tabs')
        const pane = div('emv-pane')
        const tabEls = []
        const mkTab = (label, title) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'emv-pane-tab'; b.textContent = label; if (title) b.title = title; tabs.appendChild(b); tabEls.push(b); return b }
        const paint = (which) => {
          pane.textContent = ''
          tabEls.forEach((t, k) => t.classList.toggle('active', k === which + 1))
          if (which < 0) { pane.appendChild(el('pre', 'epv-eml-body emv-body', text)); return }
          const p = docs[which]
          const meta = div('emv-plan-meta', (p.kind === 'patch' ? 'Change to ' : (p.kind === 'plan' ? 'Plan · ' : 'Document · ')) + (p.path || p.source) +
            ' · ' + (p.chars || 0).toLocaleString() + ' chars' + (p.truncated ? ' · stored truncated at the cap' : ''))
          const openLatest = editorLink(absPathFor(p.path, view && view.cwd), 'open latest in editor', 'emv-file-act')
          if (openLatest) meta.appendChild(openLatest)
          pane.appendChild(meta)
          if (p.kind === 'patch') { pane.appendChild(el('pre', 'emv-plan-text', p.text || '')); return }
          // a plan or document: FORMATTED by default (markdownLite — DOM only, untrusted text), Raw on demand
          const modeBar = div('emv-md-modes')
          const body = div('emv-md-body')
          const modes = []
          const setMode = (fmt) => {
            body.textContent = ''
            modes.forEach(([b, isFmt]) => b.classList.toggle('active', isFmt === fmt))
            body.appendChild(fmt ? renderMarkdown(p.text || '') : el('pre', 'emv-plan-text', p.text || ''))
          }
          for (const [label, isFmt] of [['Formatted', true], ['Raw', false]]) {
            const b = document.createElement('button'); b.type = 'button'; b.className = 'emv-md-mode'; b.textContent = label
            b.addEventListener('click', () => setMode(isFmt)); modeBar.appendChild(b); modes.push([b, isFmt])
          }
          pane.appendChild(modeBar); pane.appendChild(body)
          setMode(true)
        }
        showPane = (i) => { paint(i); tabs.scrollIntoView({ block: 'nearest' }) }
        mkTab('Dialogue', 'What you asked and what the agent answered').addEventListener('click', () => paint(-1))
        docs.forEach((p, i) => mkTab((p.kind === 'patch' ? '✎ ' : '📋 ') + (p.title || 'plan'), p.path || p.source).addEventListener('click', () => paint(i)))
        detail.appendChild(tabs); detail.appendChild(pane)
        paint(-1)
      } else {
        const text = (view.text && view.text.trim()) || (view.html ? htmlToText(view.html) : '') || '(no body)'
        detail.appendChild(el('pre', 'epv-eml-body emv-body', text))
      }
    } else {
      if (m.summary && !evSummary) {
        const s = div('epv-eml-sum', m.summary)
        s.title = 'the model’s one-sentence summary of this message'
        detail.appendChild(s)
      }
      detail.appendChild(div('epv-empty', 'The full message body is not stored and could not be fetched.'))
    }

    // the toolbar's actions, per channel: mail → Reply / Reply all / Forward; a chat chunk →
    // Reply (posts in its conversation or thread); a canonical note → Edit note; a work turn has
    // no counterparty to answer
    const isNote = view && view.channel === 'notes'
    const isChat = view && view.channel === 'messages'
    const isWork = view && view.channel === 'work'
    const tbBtn = (glyph, label, fn, title, state) => {
      const b = el('button', 'emv-tb-btn')
      b.type = 'button'
      b.appendChild(span('emv-tb-ico', glyph))
      b.appendChild(span('emv-tb-lbl', label))
      if (state && !state.ok) { b.disabled = true; b.title = state.reason || 'unavailable' } else b.title = title
      b.addEventListener('click', fn)
      toolbar.appendChild(b)
      return b
    }
    if (!isNote && !isChat && !isWork && pageCtx && pageCtx.sendMail && pageCtx.drafts && pageCtx.drafts.sendState) {
      const st = pageCtx.drafts.sendState({ account_id: mailAccountOf(m, view) })
      toolbar._offState = st
      tbBtn('↩', 'Reply', () => openReply('reply', m, view, slot), 'Reply to the sender', st)
      tbBtn('↩↩', 'Reply all', () => openReply('replyAll', m, view, slot), 'Reply to everyone on this message', st)
      tbBtn('↪', 'Forward', () => openReply('forward', m, view, slot), 'Forward this message', st)
    } else if (isChat && pageCtx && pageCtx.sendChat) {
      const st = pageCtx.chatSendState ? pageCtx.chatSendState({ account_id: view.account_id || m.account_id || account_id }) : { ok: false, reason: 'Chat replies are not available on this page' }
      toolbar._offState = st
      tbBtn('↩', 'Reply', () => openChatReply(m, view, slot), 'Reply in this conversation', st)
    }
    if (isNote && view.authority === 'canonical' && pageCtx && pageCtx.onEditNote) {
      tbBtn('✎', 'Edit note', () => pageCtx.onEditNote({ account_id: m.account_id || account_id, msg_id: m.msg_id }),
        'Edit this note — saving re-analyses it and updates its to-dos (no duplicates)')
    }
    // replies are OFF: say why right in the toolbar (a tooltip alone hid it — user, 2026-09-27),
    // with the reconnect link when the fix is at /account/resources
    const offState = toolbar._offState
    if (offState && !offState.ok && offState.reason) {
      const note = span('emv-tb-note', offState.reason.replace(/ at \/account\/resources.*$/, ''))
      note.title = offState.reason
      if (offState.reauth) {
        const a = el('a', 'emv-tb-fix', 'Fix ↗'); a.href = offState.reauth; a.target = '_blank'; a.rel = 'noopener'
        note.appendChild(document.createTextNode(' ')); note.appendChild(a)
      }
      toolbar.appendChild(note)
    }
    const when = span('emv-tb-when', localWhen((view && view.date) || m.date))
    toolbar.appendChild(when)
    if (!toolbar.querySelector('.emv-tb-btn')) toolbar.classList.add('emv-toolbar-bare')
    detail.scrollTop = 0
  }

  // ---- Mac Mail's message header: subject, then avatar · sender · recipients · date ---------------
  function mailHeader (view) {
    const h = div('emv-mailhead')
    h.appendChild(div('emv-subject', view.subject || '(no subject)'))
    const row = div('emv-mailhead-row')
    row.appendChild(avatarEl(view.from))
    const who = div('emv-mailhead-who')
    const fromLine = div('emv-from-line')
    const fromName = (view.from && view.from.name) || nice(view.from && view.from.address) || '?'
    const fromBtn = personLink({ name: '', address: (view.from && view.from.address) || '' })
    fromBtn.textContent = fromName
    fromBtn.classList.add('emv-from-name')
    fromLine.appendChild(fromBtn)
    if (view.from && view.from.address && fromName !== view.from.address) fromLine.appendChild(span('emv-from-addr', view.from.address))
    who.appendChild(fromLine)
    const rcpt = (label, list) => {
      if (!list || !list.length) return
      const r = div('emv-rcpt-line')
      r.appendChild(span('emv-rcpt-l', label))
      r.appendChild(addrCells(list))
      who.appendChild(r)
    }
    rcpt('To:', view.to)
    rcpt('Cc:', view.cc)
    row.appendChild(who)
    const dt = span('emv-mailhead-date', localWhen(view.date))
    dt.title = fmtDateTime(view.date) + ' UTC'
    row.appendChild(dt)
    h.appendChild(row)
    return h
  }

  // ---- replying: the shared composer opens in the slot under the toolbar -----------------------
  const reSubj = (s) => (/^\s*re\s*:/i.test(String(s || '')) ? String(s) : 'Re: ' + String(s || ''))
  const fwdSubj = (s) => (/^\s*(fwd?|fw)\s*:/i.test(String(s || '')) ? String(s) : 'Fwd: ' + String(s || ''))
  const lc = (a) => String(a || '').toLowerCase()
  const addrOf = (x) => lc(x && (x.address != null ? x.address : x))

  function mountComposer (slot, comp) {
    if (activeComposer && activeComposer !== comp) activeComposer.destroy()
    slot.textContent = ''
    slot.appendChild(comp.el)
    activeComposer = comp
    comp.focus()
    slot.scrollIntoView({ block: 'nearest' })
  }
  // which mail connection a reply goes out on: the message's own, the stored body's, the one the
  // viewer was opened with, or the mailbox its project's mail comes from — never a guess at
  // "whichever account can send" (that once answered a work thread from a personal mailbox)
  const mailAccountOf = (m, view) => m.account_id || (view && view.account_id) || account_id || projectAccount()
  function projectAccount () {
    if (!(pageCtx && pageCtx.accountFromSources) || !rel) return null
    const ps = rel.filter_project_id ? (rel.projects || []).filter(p => p.project_id === rel.filter_project_id) : (rel.projects || [])
    const names = [...new Set(ps.map(p => pageCtx.accountFromSources(p)).filter(Boolean))]
    return names.length === 1 ? names[0] : null
  }
  const fromLabelOf = (name) => (pageCtx && pageCtx.accountLabel && name) ? pageCtx.accountLabel(name) : (name || '')
  const composerBusy = () => activeComposer && activeComposer.isDirty() && !window.confirm('Discard the reply you are writing?')

  function openReply (mode, m, view, slot) {
    if (composerBusy()) return
    const self = new Set(selfAddresses())
    const sender = addrOf((view && view.from) || m.from_address)
    const toAll = ((view && view.to) || []).map(addrOf).filter(Boolean)
    const ccAll = ((view && view.cc) || []).map(addrOf).filter(Boolean)
    let to = []; let cc = []
    if (mode !== 'forward') {
      // your OWN message: replying goes to the people you wrote to, not to yourself
      const fromSelf = self.has(sender)
      to = fromSelf ? toAll.filter(a => !self.has(a)) : [sender]
      if (mode === 'replyAll') {
        if (!fromSelf) to = [...new Set([sender, ...toAll.filter(a => !self.has(a))])]
        cc = [...new Set(ccAll.filter(a => !self.has(a) && !to.includes(a)))]
      }
      to = to.filter(Boolean)
    }
    const subj = (view && view.subject) || m.subject || ''
    const connectionName = mailAccountOf(m, view)
    const comp = openComposer({
      channel: 'mail',
      mode,
      fromLabel: fromLabelOf(connectionName),
      to,
      cc,
      subject: mode === 'forward' ? fwdSubj(subj) : reSubj(subj),
      quoteFrom: { thread_id: m.thread_id || thread_id, msg_id: m.msg_id, account_id: connectionName },
      fallbackSummary: m.summary || '',
      sendState: pageCtx.drafts.sendState({ account_id: connectionName }),
      onSend: (p) => pageCtx.sendMail({
        connectionName,
        to: p.to,
        cc: p.cc.length ? p.cc : undefined,
        subject: p.subject,
        bodyText: p.bodyText,
        bodyHtml: p.bodyHtml,
        // a reply stays on the conversation; a forward starts its own thread
        threadId: mode === 'forward' ? undefined : (m.thread_id || undefined)
      }),
      onCancel: () => { slot.textContent = ''; activeComposer = null }
    })
    mountComposer(slot, comp)
  }

  // a chat reply: Slack stream ids are slack:<team>:<conversation>[:<thread parent ts>] — a
  // thread chunk answers in that thread, a channel chunk posts to the channel
  function openChatReply (m, view, slot) {
    if (composerBusy()) return
    const parts = String(m.thread_id || (view && view.thread_id) || '').split(':')
    const conversationId = (view && view.conversation_id) || parts[2] || null
    const threadTs = parts.length > 3 ? parts.slice(3).join(':') : null
    const connectionName = (view && view.account_id) || m.account_id || account_id
    const st = pageCtx.chatSendState ? pageCtx.chatSendState({ account_id: connectionName }) : { ok: false, reason: 'unavailable' }
    const comp = openComposer({
      channel: 'chat',
      mode: 'reply',
      fromLabel: fromLabelOf(connectionName),
      chatTarget: (threadTs ? 'the thread in ' : '') + (chatTitle(view && view.subject) || 'this conversation'),
      quoteFrom: { thread_id: m.thread_id || thread_id, msg_id: m.msg_id, account_id: connectionName },
      fallbackSummary: m.summary || '',
      sendState: conversationId ? st : { ok: false, reason: 'This conversation’s id is not stored — cannot reply to it' },
      onSend: (p) => pageCtx.sendChat({ connectionName, conversationId, threadId: threadTs, text: p.mrkdwn, thread_id: m.thread_id || null }),
      onCancel: () => { slot.textContent = ''; activeComposer = null }
    })
    mountComposer(slot, comp)
  }

  // ---- entry --------------------------------------------------------------------------------
  const viewToItem = (v) => ({
    kind: 'msg',
    id: 'm:' + v.msg_id,
    m: {
      msg_id: v.msg_id,
      thread_id,
      account_id: v.account_id || account_id,
      date: v.date,
      from_address: (v.from && v.from.address) || '',
      subject: v.subject,
      summary: (v.text || '').trim().slice(0, 160),
      projects: []
    }
  })

  async function run () {
    if (rel) {
      buildItems()
      // GUARANTEE the clicked email is in the list. rel.messages is built from EVENTS whose
      // changes touch a related project (viewerContext.relatedFor) — a task's evidence message
      // can legitimately be missing from it (its event recorded different projects, or its
      // thread_id differs from the evidence's). It used to fall through to items[0] = the NEWEST
      // message, so clicking ✉ on a task opened the wrong email.
      if (msg_id && !items.some(i => i.kind === 'msg' && i.m.msg_id === msg_id)) {
        items.push({
          kind: 'msg',
          id: 'm:' + msg_id,
          m: { msg_id, thread_id, account_id, date: 0, from_address: '', subject: subject || '', summary: snippet || '', projects: [] }
        })
      }
    } else if (msg_id || thread_id) {
      // no context on this page — show the CLICKED email IMMEDIATELY (stored body loads in a
      // beat); the rest of the conversation fills the rail in the background with a loader
      items = msg_id
        ? [{ kind: 'msg', id: 'm:' + msg_id, m: { msg_id, thread_id, account_id, date: 0, from_address: '', subject: subject || '', summary: snippet || '', projects: [] } }]
        : []
      railBusy = true
      ;(async () => {
        let views = []
        if (persistRef && thread_id) {
          try { views = ((await persistRef.getThreadBodies(thread_id)) || []).map(storedToView) } catch (e) { /* live below */ }
        }
        if (!views.length && mailSource && thread_id) {
          try { views = (await loadLiveThread(thread_id)).map(liveToView) } catch (e) { /* nothing reachable */ }
        }
        if (closed) return
        railBusy = false
        if (views.length) {
          views.sort((a, b) => b.date - a.date)
          const rebuilt = views.map(v => { bodyCache.set(v.msg_id, v); return viewToItem(v) })
          if (msg_id && !rebuilt.some(i => i.m.msg_id === msg_id)) rebuilt.unshift(items[0])
          items = rebuilt
          // keep the current selection pointing at the SAME message in the rebuilt list — and
          // RE-SELECT it, so the now-loaded full body replaces the stub's snippet view
          // prefer_latest (the task row's ✉): the thread has loaded, so jump to its newest message
          if (prefer_latest && items[0] && items[0].m) focusId = items[0].m.msg_id
          const same = prefer_latest ? items[0] : (sel && sel.m ? items.find(i => i.m && i.m.msg_id === sel.m.msg_id) : null)
          if (same) { sel = same; select(same) }
          paintHead()
        }
        paintRail()
      })()
    }
    paintHead()
    // The CLICKED email always wins — it is what the user pointed at. An unsent draft is the
    // default only when no specific message was named (opening the pane from a project card),
    // and items[0] (the newest) is the last resort. (The draft used to be preferred over the
    // clicked message, which is the other way this modal opened on the wrong mail.)
    if (prefer_latest && thread_id) {
      const newest = items.filter(i => i.kind === 'msg' && i.m.thread_id === thread_id)
        .sort((a, b) => (Number(b.m.date) || 0) - (Number(a.m.date) || 0))[0]
      if (newest && (Number(newest.m.date) || 0) > 0) focusId = newest.m.msg_id
    }
    const start = (focusId && items.find(i => i.kind === 'msg' && i.m.msg_id === focusId)) ||
      items.find(i => i.kind === 'draft') || items[0] || null
    if (start) select(start)
    else {
      paintRail()
      detail.textContent = ''
      detail.appendChild(div('epv-empty', snippet
        ? 'No stored copy and no mail source on this page — showing the snippet only:\n' + snippet
        : 'No related emails could be found for this message.'))
    }
  }

  run()
  if (host) {
    return {
      destroy: () => { teardown(); host.textContent = '' },
      holdsTyping: () => !!(activeComposer && activeComposer.isDirty())
    }
  }
  return overlay
}
