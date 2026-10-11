// replyComposer.js — THE reply composer, shared by every surface that writes back on a
// conversation: the email viewer's Reply / Reply all / Forward, and the Edit view of a suggested
// reply (email viewer, events feed, project cards). One component, so a suggested reply being
// edited looks and behaves exactly like a reply being written.
//
// A Mail-style compose card: To / Cc / Subject rows, a formatted body (richEditor.js), and the
// conversation QUOTED BELOW the text, the way every mail client does it — "On <date>, <who>
// wrote:" over the message being answered. That message's stored HTML already carries the
// earlier chain it quoted, so quoting it quotes the thread. When no body is reachable the
// composer says so and quotes the model's summary instead.
//
// CHANNELS. channel 'mail' sends HTML + a plain-text alternative, threaded by threadId. channel
// 'chat' (Slack today, any messaging provider later) posts Slack markup in the conversation /
// thread; the conversation is shown under the editor as CONTEXT only (chat replies never quote).
//
// configureReplyContext({ persist, source, selfAddrs }) — once per page (the email viewer's
//   configureEmailViewer does it), so thread bodies can be loaded from anywhere.
// loadReplySource({ thread_id, msg_id, account_id }) → { msg, count, complete }
// openComposer(opts) → { el, isDirty(), focus(), destroy() }   (see openComposer)

import { htmlToText } from '../jobs/analyze_thread/htmlToText.js'
import { createRichEditor } from './richEditor.js'
import { renderHtmlBody, sanitize, escapeHtml, textToHtml, quoteLines } from './mailHtml.js'

let persistRef = null
let sourceRef = null
let selfFn = null
export function configureReplyContext ({ persist, source, selfAddrs } = {}) {
  if (persist !== undefined) persistRef = persist || null
  if (source !== undefined) sourceRef = source || null
  if (selfAddrs !== undefined) selfFn = selfAddrs || null
}
export const selfAddresses = () => { try { return ((selfFn && selfFn()) || []).map(a => String(a).toLowerCase()) } catch (e) { return [] } }

// ---- the conversation behind a reply ---------------------------------------------------------

const rowToMsg = (r) => ({
  msg_id: r.msg_id,
  date: Number(r.date) || 0,
  from: r.from || { name: r.from_name || '', address: r.from_address || '' },
  to: r.to || r.to_addresses || [],
  cc: r.cc || r.cc_addresses || [],
  subject: r.subject || '',
  html: r.html != null ? r.html : (r.body_html || ''),
  text: r.text != null ? r.text : (r.body_text || '')
})
const noLive = (tid) => /^(note_|slack:|cc:)/.test(String(tid || ''))

// The message a reply answers, with its body. msg_id names it; without one, the NEWEST message on
// the thread. Stored bodies first (the app's own snapshot), then the live mail source.
// Returns { msg | null, count (messages known on the thread), complete (a real body was found) }.
export async function loadReplySource ({ thread_id, msg_id, account_id } = {}) {
  let rows = []
  if (persistRef && thread_id && persistRef.getThreadBodies) {
    try { rows = ((await persistRef.getThreadBodies(thread_id)) || []).map(rowToMsg) } catch (e) { /* fallbacks below */ }
  }
  if (msg_id && !rows.some(r => r.msg_id === msg_id) && persistRef && persistRef.getEmailBody && account_id) {
    try { const one = await persistRef.getEmailBody({ account_id, msg_id }); if (one) rows.push(rowToMsg(one)) } catch (e) { /* live below */ }
  }
  if ((!rows.length || (msg_id && !rows.some(r => r.msg_id === msg_id))) && sourceRef && sourceRef.loadThreadRaw && thread_id && !noLive(thread_id)) {
    try {
      const res = await sourceRef.loadThreadRaw(thread_id)
      const live = ((res && res.messages) || []).map(rowToMsg)
      if (live.length) rows = live
    } catch (e) { if (sourceRef.handleTokenExpired) sourceRef.handleTokenExpired(e) }
  }
  rows.sort((a, b) => a.date - b.date)
  const msg = (msg_id && rows.find(r => r.msg_id === msg_id)) || rows[rows.length - 1] || null
  return { msg, count: rows.length, complete: !!(msg && (String(msg.html || '').trim() || String(msg.text || '').trim())) }
}

const who = (p) => (p && (p.name ? p.name + ' <' + p.address + '>' : p.address)) || 'someone'
const fmtQuoteDate = (ms) => {
  if (!ms) return ''
  try { return new Date(ms).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch (e) { return '' }
}
const addrList = (l) => (l || []).map(x => (typeof x === 'string' ? x : who(x))).join(', ')

// The quoted part of an outgoing mail — { html, text, header }. mode 'forward' uses the
// forwarded-message block instead of a reply citation.
export function buildQuote (msg, { mode = 'reply', fallbackText = '' } = {}) {
  if (!msg && !fallbackText) return null
  const body = msg || {}
  const hasHtml = !!String(body.html || '').trim()
  const plain = (String(body.text || '').trim()) || (hasHtml ? htmlToText(body.html) : '') || fallbackText || ''
  const innerHtml = hasHtml ? sanitize(body.html) : textToHtml(plain)
  if (mode === 'forward') {
    const lines = ['---------- Forwarded message ----------',
      'From: ' + who(body.from), 'Date: ' + fmtQuoteDate(body.date), 'Subject: ' + (body.subject || ''),
      (body.to && body.to.length) ? 'To: ' + addrList(body.to) : null].filter(Boolean)
    return {
      header: 'Forwarded message',
      plain,
      hasHtml,
      html: '<div>' + lines.map(escapeHtml).join('<br>') + '</div><br>' + innerHtml,
      text: lines.join('\n') + '\n\n' + plain
    }
  }
  const header = 'On ' + (fmtQuoteDate(body.date) || 'an earlier date') + ', ' + who(body.from) + ' wrote:'
  return {
    header,
    plain,
    hasHtml,
    html: '<div>' + escapeHtml(header) + '</div><blockquote type="cite" style="margin:0 0 0 .8ex;border-left:2px solid #4a8ff0;padding-left:1ex">' + innerHtml + '</blockquote>',
    text: header + '\n' + quoteLines(plain)
  }
}

// The full outgoing message for a reply whose text is already settled (a suggested reply sent
// straight from its read view): the user's text + the quoted thread. Best effort — without a
// reachable body it is just the text.
export async function composeWithQuote ({ userText = '', userHtml = '', thread_id, msg_id, account_id } = {}) {
  const ownHtml = userHtml || textToHtml(userText)
  const ownText = userText || htmlToText(userHtml || '')
  let q = null
  try { const src = await loadReplySource({ thread_id, msg_id, account_id }); q = src.msg ? buildQuote(src.msg) : null } catch (e) { q = null }
  if (!q) return { bodyText: ownText, bodyHtml: '<div>' + ownHtml + '</div>' }
  return { bodyText: ownText + '\n\n' + q.text, bodyHtml: '<div>' + ownHtml + '</div><br>' + q.html }
}

// ---- the composer ---------------------------------------------------------------------------

const splitAddrs = (s) => String(s || '').split(/[,;]/).map(x => x.trim()).filter(Boolean)
const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const mkBtn = (cls, text, fn, title) => { const b = mk('button', cls, text); b.type = 'button'; if (title) b.title = title; if (fn) b.addEventListener('click', fn); return b }

// openComposer(opts):
//   channel      'mail' | 'chat'
//   mode         'reply' | 'replyAll' | 'forward' | 'draft'  (label + quote style)
//   title        heading text (defaults per mode)
//   to, cc       arrays of addresses (mail);  subject (mail)
//   chatTarget   'in the thread' / '#general' — where a chat reply lands (chat)
//   bodyHtml / bodyText  the initial text of the user's part (a draft's body)
//   quoteFrom    { thread_id, msg_id, account_id } — the conversation to load and quote
//   fallbackSummary  quoted instead when no body can be reached
//   sendState    { ok, reason }
//   onSend(payload) → Promise   payload: { to, cc, subject, bodyHtml, bodyText, mrkdwn, userHtml, userText }
//   onCancel()   cancelLabel ('Cancel' | 'Done')   onChange(payload) — optional, fires (debounced) on edits, for draft autosave
//   extraActions [{ label, title, cls, fn(payload) }]  e.g. Dismiss on a suggested reply
//   compact      tighter layout for cards
export function openComposer (opts = {}) {
  const {
    channel = 'mail', mode = 'reply', title = null, fromLabel = '', to = [], cc = [], subject = '', chatTarget = '',
    bodyHtml = '', bodyText = '', quoteFrom = null, fallbackSummary = '', sendState = { ok: true },
    onSend = null, onCancel = null, onChange = null, extraActions = [], compact = false, sendLabel = null, cancelLabel = 'Cancel'
  } = opts
  const isChat = channel === 'chat'
  let dirty = false
  let destroyed = false
  // .rc-dirty marks UNSAVED typing — modalStack asks before closing a modal that holds one. An
  // autosaving draft (onChange) is clean again once its edit has been handed over.
  const setDirty = (on) => { dirty = on; root.classList.toggle('rc-dirty', on) }
  const markDirty = () => {
    setDirty(true)
    if (onChange) {
      clearTimeout(changeTimer)
      changeTimer = setTimeout(() => { if (!destroyed) { onChange(payload()); setDirty(false) } }, 600)
    }
  }
  let changeTimer = null

  const root = mk('div', 'rc' + (compact ? ' rc-compact' : '') + (isChat ? ' rc-chat' : ''))
  const head = mk('div', 'rc-head')
  const TITLES = { reply: '↩ Reply', replyAll: '↩ Reply all', forward: '↪ Forward', draft: '↩ Suggested reply' }
  head.appendChild(mk('div', 'rc-title', title || TITLES[mode] || 'Reply'))
  const headActs = mk('div', 'rc-head-acts')
  head.appendChild(headActs)
  root.appendChild(head)

  // ---- address / subject rows (mail) or the destination line (chat)
  const fields = mk('div', 'rc-fields')
  let toIn = null; let ccIn = null; let subjIn = null
  const row = (label, input, extra) => {
    const r = mk('label', 'rc-field')
    r.appendChild(mk('span', 'rc-field-l', label))
    r.appendChild(input)
    if (extra) r.appendChild(extra)
    fields.appendChild(r)
    return r
  }
  // FROM: which mailbox / workspace this goes out of — always visible, so a reply can never leave
  // from the wrong account unnoticed
  if (fromLabel) {
    const f = mk('div', 'rc-field rc-field-static rc-from')
    f.appendChild(mk('span', 'rc-field-l', 'From:'))
    f.appendChild(mk('span', 'rc-from-v', fromLabel))
    fields.appendChild(f)
  }
  if (isChat) {
    const d = mk('div', 'rc-field rc-field-static')
    d.appendChild(mk('span', 'rc-field-l', 'To:'))
    d.appendChild(mk('span', 'rc-chat-target', chatTarget || 'this conversation'))
    fields.appendChild(d)
  } else {
    toIn = mk('input', 'rc-in'); toIn.type = 'text'; toIn.value = (to || []).join(', '); toIn.placeholder = 'name@example.com, …'
    toIn.addEventListener('input', markDirty)
    let ccRow = null
    const ccToggle = mkBtn('rc-cc-toggle', 'Cc', () => { ccRow.hidden = false; ccToggle.hidden = true; ccIn.focus() }, 'Add Cc recipients')
    row('To:', toIn, ccToggle)
    ccIn = mk('input', 'rc-in'); ccIn.type = 'text'; ccIn.value = (cc || []).join(', ')
    ccIn.addEventListener('input', markDirty)
    ccRow = row('Cc:', ccIn)
    ccRow.hidden = !(cc && cc.length)
    ccToggle.hidden = !ccRow.hidden
    subjIn = mk('input', 'rc-in rc-subj'); subjIn.type = 'text'; subjIn.value = subject || ''
    subjIn.addEventListener('input', markDirty)
    row('Subject:', subjIn)
  }
  root.appendChild(fields)

  // ---- the text
  const editor = createRichEditor({
    html: bodyHtml, text: bodyHtml ? '' : bodyText, onInput: markDirty, compact,
    placeholder: isChat ? 'Write a reply…' : (mode === 'forward' ? 'Add a note…' : 'Write your reply…')
  })
  root.appendChild(editor.el)

  // ---- the quoted conversation (mail) / context (chat)
  const quoteBox = mk('div', 'rc-quote')
  const quoteHead = mk('div', 'rc-quote-head')
  const quoteLabel = mk('span', 'rc-quote-label', isChat ? 'Loading the conversation…' : 'Loading the thread…')
  quoteHead.appendChild(quoteLabel)
  const quoteActs = mk('span', 'rc-quote-acts')
  quoteHead.appendChild(quoteActs)
  quoteBox.appendChild(quoteHead)
  const quoteBody = mk('div', 'rc-quote-body')
  quoteBox.appendChild(quoteBody)
  const quoteNote = mk('div', 'rc-quote-note')
  quoteBox.appendChild(quoteNote)
  let quote = null        // { html, text, header } — what gets appended to a mail
  let includeQuote = true
  if (quoteFrom || fallbackSummary) root.appendChild(quoteBox)

  const paintQuote = (msg, info) => {
    quoteBody.textContent = ''
    quoteActs.textContent = ''
    if (isChat) {
      const txt = (msg && (String(msg.text || '').trim() || htmlToText(msg.html || ''))) || fallbackSummary
      if (!txt) { quoteBox.remove(); return }
      quoteLabel.textContent = 'The conversation — context only, not included in your reply'
      renderHtmlBody(quoteBody, txt, { cls: 'rc-quote-host', isText: true })
    } else {
      quote = buildQuote(msg, { mode: mode === 'forward' ? 'forward' : 'reply', fallbackText: fallbackSummary })
      if (!quote) { quoteBox.remove(); return }
      quoteLabel.textContent = quote.header
      const host = renderHtmlBody(quoteBody, quote.hasHtml ? msg.html : quote.plain, { cls: 'rc-quote-host', isText: !quote.hasHtml })
      host.classList.toggle('rc-quote-host-fwd', mode === 'forward')
      if (!info.complete) {
        quoteNote.textContent = info.count
          ? 'The full message isn’t stored — quoting its summary only.'
          : 'The thread isn’t available here — quoting the summary of the last message only.'
      } else if (info.count > 1 && mode !== 'forward') {
        quoteNote.textContent = info.count + ' messages on this thread — the earlier ones travel inside the quoted message.'
      }
      const drop = mkBtn('rc-link', 'Remove quote', () => {
        includeQuote = !includeQuote
        quoteBox.classList.toggle('rc-quote-off', !includeQuote)
        drop.textContent = includeQuote ? 'Remove quote' : 'Include quote'
        markDirty()
      }, 'Send without the quoted thread')
      quoteActs.appendChild(drop)
    }
    const more = mkBtn('rc-link', 'Show all', () => {
      const open = quoteBox.classList.toggle('rc-quote-open')
      more.textContent = open ? 'Collapse' : 'Show all'
    }, 'Show the whole quoted text')
    quoteActs.insertBefore(more, quoteActs.firstChild)
  }
  if (quoteFrom) {
    loadReplySource(quoteFrom).then(info => { if (!destroyed) paintQuote(info.msg, info) })
      .catch(() => { if (!destroyed) paintQuote(null, { count: 0, complete: false }) })
  } else if (fallbackSummary) {
    paintQuote(null, { count: 0, complete: false })
  }

  // ---- actions
  const status = mk('div', 'rc-status')
  // a status line, with a "Reconnect ↗" link (new tab — the reply stays here) when the fix is a
  // reconnect / access change at /account/resources
  function setStatus (text, reauthUrl) {
    status.textContent = text || ''
    if (reauthUrl) {
      const a = mk('a', 'rc-link rc-reauth', 'Reconnect ↗')
      a.href = reauthUrl; a.target = '_blank'; a.rel = 'noopener'
      status.appendChild(document.createTextNode(' '))
      status.appendChild(a)
    }
  }
  const send = mkBtn('rc-send', sendLabel || (isChat ? 'Send' : 'Send'), null)
  send.insertBefore(mk('span', 'rc-send-ico', '➤'), send.firstChild)
  const cancel = onCancel ? mkBtn('rc-btn', cancelLabel, () => {
    // Done on an autosaving draft flushes the last keystrokes before closing
    if (onChange && dirty) onChange(payload())
    destroy(); onCancel()
  }) : null

  function payload () {
    const userHtml = editor.getHtml()
    const userText = editor.getText()
    const q = (!isChat && includeQuote && quote) ? quote : null
    return {
      to: toIn ? splitAddrs(toIn.value) : [],
      cc: ccIn ? splitAddrs(ccIn.value) : [],
      subject: subjIn ? subjIn.value.trim() : '',
      userHtml,
      userText,
      mrkdwn: editor.getMrkdwn(),
      bodyHtml: '<div>' + userHtml + '</div>' + (q ? '<br>' + q.html : ''),
      bodyText: userText + (q ? '\n\n' + q.text : '')
    }
  }

  if (!sendState || !sendState.ok || !onSend) {
    send.disabled = true
    send.title = (sendState && sendState.reason) || 'Sending isn’t available here'
    setStatus((sendState && sendState.reason) || '', sendState && sendState.reauth)
  } else {
    send.title = isChat ? 'Post this reply' : 'Send this email now (⌘↵)'
    send.addEventListener('click', doSend)
  }
  async function doSend () {
    const p = payload()
    if (!isChat && !p.to.length) { status.textContent = 'Add at least one recipient.'; toIn.focus(); return }
    if (editor.isEmpty() && !(mode === 'forward')) { status.textContent = 'Write something first.'; editor.focus(); return }
    send.disabled = true
    status.textContent = 'Sending…'
    root.classList.add('rc-busy')
    try {
      await onSend(p)
      setDirty(false)
      destroyed = true
      editor.destroy()
      root.classList.remove('rc-busy')
      root.textContent = ''
      root.classList.add('rc-sent')
      root.appendChild(mk('div', 'rc-sent-note', '✓ Sent'))
    } catch (e) {
      root.classList.remove('rc-busy')
      send.disabled = false
      setStatus('Send failed: ' + ((e && e.message) || e), e && e.reauth_url)
    }
  }
  root.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !send.disabled) { e.preventDefault(); doSend() }
  })

  headActs.appendChild(send)
  for (const a of extraActions) headActs.appendChild(mkBtn('rc-btn ' + (a.cls || ''), a.label, () => a.fn(payload()), a.title))
  if (cancel) headActs.appendChild(cancel)
  root.appendChild(status)

  function destroy () { destroyed = true; clearTimeout(changeTimer); root.classList.remove('rc-dirty'); editor.destroy() }
  return {
    el: root,
    isDirty: () => dirty && !destroyed,
    focus: () => { if (!isChat && toIn && !toIn.value.trim()) toIn.focus(); else editor.focus() },
    payload,
    destroy
  }
}
