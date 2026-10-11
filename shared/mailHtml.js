// mailHtml.js — untrusted-email HTML helpers shared by the email viewer and the reply composer:
// the sanitiser, the Shadow-DOM body renderer and its reset stylesheet, and the small string
// helpers a composed reply needs (escape, quote-prefix). No DOM state of its own.
//
// Email HTML is untrusted: sanitised (active content stripped — see freezr use_mail guidance)
// and rendered inside a Shadow DOM so it can neither run script nor restyle the app.

export function sanitize (html) {
  try {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html')
    const kill = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'frame', 'frameset']
    kill.forEach(t => doc.querySelectorAll(t).forEach(n => n.remove()))
    doc.querySelectorAll('*').forEach(el => {
      ;[...el.attributes].forEach(a => {
        const n = a.name.toLowerCase()
        const v = String(a.value).toLowerCase().trim()
        if (n.startsWith('on')) el.removeAttribute(a.name)
        if ((n === 'href' || n === 'src' || n === 'poster' || n === 'formaction' || n === 'xlink:href') &&
            (v.startsWith('javascript:') || v.startsWith('vbscript:') || v.startsWith('data:text/html'))) {
          el.removeAttribute(a.name)
        }
      })
    })
    return doc.body ? doc.body.innerHTML : ''
  } catch (e) { return '' }
}

// The email-body reset: a REAL type ramp instead of all:initial chaos, everything capped to the
// container width so wide marketing tables can't blow holes in the layout. Applied as a
// programmatic <style> node (textContent), never string-concatenated into markup — so it can
// never leak into the page as visible text. Quotes get Mail's blue cite bar.
export const EMAIL_BODY_CSS = [
  ':host { all: initial; display: block; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;',
  '  font-size: 14px; line-height: 1.55; color: #1d1d1f; overflow-wrap: break-word; word-break: break-word; }',
  '.mailbody { overflow-x: hidden; }',
  '* { max-width: 100% !important; box-sizing: border-box; }',
  'table { max-width: 100% !important; width: auto !important; border-collapse: collapse; }',
  'td, th { max-width: 100% !important; }',
  'img { max-width: 100% !important; height: auto !important; }',
  'a { color: #0a66d8; }',
  'blockquote { border-left: 2px solid #4a8ff0; margin: 8px 0 8px 2px; padding: 0 0 0 12px; color: #3d6fb4; }',
  'blockquote blockquote { border-left-color: #6fb36f; color: #3f7f3f; }',
  'blockquote blockquote blockquote { border-left-color: #c77dcf; color: #7d4a85; }',
  'pre { white-space: pre-wrap; font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; }',
  'p { margin: 0 0 0.7em; }',
  '.plain { white-space: pre-wrap; font: inherit; margin: 0; }'
].join('\n')

// Render untrusted HTML (or plain text when isText) into a Shadow-DOM host appended to parent.
// Returns the host element.
export function renderHtmlBody (parent, html, { cls = 'emv-html-host', isText = false } = {}) {
  const host = document.createElement('div')
  host.className = cls
  parent.appendChild(host)
  const shadow = host.attachShadow({ mode: 'open' })
  const st = document.createElement('style')
  st.textContent = EMAIL_BODY_CSS
  shadow.appendChild(st)
  const wrap = document.createElement('div')
  wrap.className = 'mailbody'
  if (isText) {
    const pre = document.createElement('pre')
    pre.className = 'plain'
    pre.textContent = String(html || '')
    wrap.appendChild(pre)
  } else {
    wrap.innerHTML = sanitize(html)
    // links open in a new tab so the email can't navigate the app away
    wrap.querySelectorAll('a[href]').forEach(a => { a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer') })
  }
  shadow.appendChild(wrap)
  return host
}

export const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// plain text → minimal HTML (paragraph breaks kept, nothing interpreted)
export const textToHtml = (s) => escapeHtml(s).replace(/\r\n/g, '\n').replace(/\n/g, '<br>')

// "> " on every line — the plain-text half of a quoted reply
export const quoteLines = (s) => String(s || '').replace(/\r\n/g, '\n').split('\n').map(l => '> ' + l).join('\n')
