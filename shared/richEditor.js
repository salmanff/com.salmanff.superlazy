// richEditor.js — a small formatted-text editor for replies: a contenteditable body under a
// Mail-style format bar (B · I · U · S | • list · 1. list · quote | link | clear).
//
// createRichEditor({ html, text, placeholder, onInput, compact }) →
//   { el, focus(), getHtml(), getText(), getMrkdwn(), isEmpty(), setHtml(html) }
//
// getHtml() returns the body run through an ALLOWLIST (only the tags the bar can make, links
// limited to http(s)/mailto) — whatever a paste or the browser's own editing slipped in never
// reaches a sent email. getText() is the plain-text alternative part; getMrkdwn() is the same
// content in Slack's markup (*bold* _italic_ ~strike~ <url|label>), for chat replies.
// Paste is taken as PLAIN TEXT: pasted HTML from web pages / other mail drags fonts, colours and
// tracking pixels along, and the formatting that matters is one click away on the bar.

const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'A', 'UL', 'OL', 'LI', 'BR', 'P', 'DIV', 'BLOCKQUOTE', 'SPAN'])
const DROP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'SVG', 'MATH', 'HEAD', 'TITLE'])
const BLOCKS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'BLOCKQUOTE'])
const safeHref = (h) => /^(https?:|mailto:)/i.test(String(h || '').trim())

// Rebuild a node tree keeping only allowlisted tags (unknown tags are unwrapped, their text kept)
function cleanInto (src, dst) {
  for (const n of [...src.childNodes]) {
    if (n.nodeType === 3) { dst.appendChild(document.createTextNode(n.nodeValue)); continue }
    if (n.nodeType !== 1) continue
    const tag = String(n.tagName).toUpperCase() // svg/math children keep lower-case names
    if (DROP.has(tag)) continue // content that is never text
    if (!ALLOWED.has(tag)) { cleanInto(n, dst); continue }
    // SPAN survives only as a carrier for the browser's styled bold/italic — map it to tags
    if (tag === 'SPAN') {
      const st = n.style || {}
      let target = dst
      const wrapIn = (t) => { const w = document.createElement(t); target.appendChild(w); target = w }
      if (st.fontWeight === 'bold' || Number(st.fontWeight) >= 600) wrapIn('b')
      if (st.fontStyle === 'italic') wrapIn('i')
      if (/underline/.test(st.textDecoration || '')) wrapIn('u')
      if (/line-through/.test(st.textDecoration || '')) wrapIn('s')
      cleanInto(n, target)
      continue
    }
    const out = document.createElement(tag.toLowerCase())
    if (tag === 'A') {
      const href = n.getAttribute('href')
      if (!safeHref(href)) { cleanInto(n, dst); continue }
      out.setAttribute('href', href.trim())
    }
    cleanInto(n, out)
    dst.appendChild(out)
  }
}

// Walk the editor DOM into text. mode: 'text' (plain) | 'mrkdwn' (Slack)
function serialize (root, mode) {
  const md = mode === 'mrkdwn'
  let out = ''
  const nl = () => { if (out && !out.endsWith('\n')) out += '\n' }
  const walk = (node, ctx) => {
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += n.nodeValue.replace(/ /g, ' '); continue }
      if (n.nodeType !== 1) continue
      const tag = n.tagName
      if (tag === 'BR') { out += '\n' + (ctx.quote ? '> ' : ''); continue }
      if (tag === 'UL' || tag === 'OL') { nl(); walk(n, { ...ctx, list: tag, idx: 0 }); nl(); continue }
      if (tag === 'LI') {
        nl()
        ctx.idx = (ctx.idx || 0) + 1
        out += (ctx.quote ? '> ' : '') + (ctx.list === 'OL' ? ctx.idx + '. ' : '• ')
        walk(n, ctx)
        continue
      }
      if (tag === 'BLOCKQUOTE') { nl(); out += '> '; walk(n, { ...ctx, quote: true }); nl(); continue }
      if (tag === 'A') {
        const label = n.textContent
        const href = n.getAttribute('href') || ''
        if (md) out += '<' + href + '|' + label.replace(/[|>]/g, ' ') + '>'
        else out += (label && label !== href && label !== href.replace(/^mailto:/, '')) ? label + ' (' + href + ')' : href
        continue
      }
      const mark = md ? ({ B: '*', STRONG: '*', I: '_', EM: '_', S: '~', STRIKE: '~', DEL: '~' })[tag] : null
      if (mark) { out += mark; walk(n, ctx); out += mark; continue }
      if (BLOCKS.has(tag)) { nl(); if (ctx.quote) out += '> '; walk(n, ctx); nl(); continue }
      walk(n, ctx)
    }
  }
  walk(root, {})
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

const TOOLS = [
  { cmd: 'bold', label: 'B', title: 'Bold (⌘B)', cls: 'rte-b' },
  { cmd: 'italic', label: 'I', title: 'Italic (⌘I)', cls: 'rte-i' },
  { cmd: 'underline', label: 'U', title: 'Underline (⌘U)', cls: 'rte-u' },
  { cmd: 'strikeThrough', label: 'S', title: 'Strikethrough', cls: 'rte-s' },
  null,
  { cmd: 'insertUnorderedList', label: '•≡', title: 'Bulleted list' },
  { cmd: 'insertOrderedList', label: '1≡', title: 'Numbered list' },
  { cmd: 'quote', label: '❝', title: 'Quote block' },
  null,
  { cmd: 'link', label: '🔗', title: 'Link (⌘K)' },
  { cmd: 'removeFormat', label: 'T̸', title: 'Clear formatting' }
]

export function createRichEditor ({ html = '', text = '', placeholder = '', onInput = null, compact = false } = {}) {
  const el = document.createElement('div')
  el.className = 'rte' + (compact ? ' rte-compact' : '')
  const bar = document.createElement('div')
  bar.className = 'rte-bar'
  bar.setAttribute('role', 'toolbar')
  const body = document.createElement('div')
  body.className = 'rte-body'
  body.contentEditable = 'true'
  body.setAttribute('role', 'textbox')
  body.setAttribute('aria-multiline', 'true')
  if (placeholder) body.dataset.placeholder = placeholder

  const setHtml = (h) => {
    // parsed in an INERT document (DOMParser): a detached div of the live document would still
    // load <img src> and fire onerror handlers. Cleaned by the allowlist before it is shown.
    const doc = new DOMParser().parseFromString('<body>' + String(h || '') + '</body>', 'text/html')
    body.textContent = ''
    cleanInto(doc.body, body)
  }
  if (html) setHtml(html)
  else if (text) {
    // plain text → paragraphs of text nodes + <br>s (never parsed as HTML)
    String(text).replace(/\r\n/g, '\n').split('\n').forEach((line, i) => {
      if (i) body.appendChild(document.createElement('br'))
      if (line) body.appendChild(document.createTextNode(line))
    })
  }

  const btns = []
  const exec = (cmd) => {
    body.focus()
    if (cmd === 'quote') {
      const inQuote = document.queryCommandValue('formatBlock').toLowerCase() === 'blockquote'
      document.execCommand('formatBlock', false, inQuote ? 'div' : 'blockquote')
    } else if (cmd === 'link') {
      const sel = window.getSelection()
      const had = sel && String(sel).trim()
      let url = window.prompt('Link address (https://…)', 'https://')
      if (!url) return
      url = url.trim()
      if (!/^[a-z]+:/i.test(url)) url = (url.includes('@') ? 'mailto:' : 'https://') + url
      if (!safeHref(url)) return
      if (had) document.execCommand('createLink', false, url)
      else document.execCommand('insertHTML', false, '<a href="' + url.replace(/"/g, '%22') + '">' + url.replace(/[<>&]/g, '') + '</a>')
    } else {
      document.execCommand(cmd, false, null)
    }
    syncState()
    if (onInput) onInput()
  }
  for (const t of TOOLS) {
    if (!t) { const s = document.createElement('span'); s.className = 'rte-sep'; bar.appendChild(s); continue }
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'rte-btn ' + (t.cls || ''); b.textContent = t.label; b.title = t.title
    b.setAttribute('aria-label', t.title)
    // mousedown, not click: keeps the text selection in the body while the button is pressed
    b.addEventListener('mousedown', (e) => { e.preventDefault(); exec(t.cmd) })
    bar.appendChild(b)
    btns.push([t.cmd, b])
  }

  function syncState () {
    for (const [cmd, b] of btns) {
      let on = false
      try {
        if (cmd === 'quote') on = document.queryCommandValue('formatBlock').toLowerCase() === 'blockquote'
        else if (['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].includes(cmd)) on = document.queryCommandState(cmd)
      } catch (e) { /* not supported */ }
      b.classList.toggle('on', !!on)
    }
  }
  const onSel = () => { if (body.contains(document.getSelection() && document.getSelection().anchorNode)) syncState() }
  document.addEventListener('selectionchange', onSel)

  body.addEventListener('input', () => { el.classList.toggle('rte-empty', isEmpty()); if (onInput) onInput() })
  body.addEventListener('paste', (e) => {
    const t = e.clipboardData && e.clipboardData.getData('text/plain')
    if (t == null) return
    e.preventDefault()
    document.execCommand('insertText', false, t)
  })
  body.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); exec('link') }
  })

  el.appendChild(bar)
  el.appendChild(body)

  const cleaned = () => { const d = document.createElement('div'); cleanInto(body, d); return d }
  function isEmpty () { return !body.textContent.trim() }
  el.classList.toggle('rte-empty', isEmpty())

  return {
    el,
    focus () {
      body.focus()
      // caret at the START — replies are written above the quote, like every mail client
      try { const r = document.createRange(); r.setStart(body, 0); r.collapse(true); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r) } catch (e) { /* best effort */ }
    },
    getHtml: () => cleaned().innerHTML,
    getText: () => serialize(cleaned(), 'text'),
    getMrkdwn: () => serialize(cleaned(), 'mrkdwn'),
    isEmpty,
    setHtml,
    destroy: () => document.removeEventListener('selectionchange', onSel)
  }
}
