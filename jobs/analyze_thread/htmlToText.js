// htmlToText.js — PERMANENT core. Convert an HTML email body to readable plain text.
// Used when a message has no plain-text part (common). Prefers DOMParser (browser);
// falls back to a regex strip so the same code survives in a Node job.

function collapse (t) {
  return (t || '')
    .replace(/\r/g, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n').map(l => l.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function decodeEntities (s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(+n) } catch (e) { return _ } })
}

// Quoted text keeps its quote marks. A mail client renders the message it is replying to as a
// <blockquote>; a plain-text client prefixes those lines with "> ". Without the prefix the text
// loses the one thing that tells a reply's own words from the words it quotes — and an INLINE reply
// (answers written between the quoted paragraphs) becomes indistinguishable from the quote, so
// replyStrip cut every one of the user's answers to Pfirm on 2026-09-24 as "quoted history".
// Nested quotes get one "> " per level, exactly as text clients do.
const quoteLines = (text, depth = 1) => {
  const pre = '> '.repeat(depth)
  return String(text || '').replace(/\r/g, '').split('\n').map(l => pre + l).join('\n')
}

export function htmlToText (html) {
  if (!html) return ''
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html')
      doc.querySelectorAll('script,style,head,noscript').forEach(n => n.remove())
      doc.querySelectorAll('br').forEach(br => br.replaceWith('\n'))
      doc.querySelectorAll('p,div,tr,li,h1,h2,h3,h4,h5,h6,blockquote,table,ul,ol')
        .forEach(el => el.appendChild(doc.createTextNode('\n')))
      // innermost blockquotes first (document order lists ancestors before descendants, so walk it
      // backwards): each becomes its own text, quote-marked, and an enclosing one marks it again
      const quotes = [...doc.querySelectorAll('blockquote')]
      for (let i = quotes.length - 1; i >= 0; i--) {
        const bq = quotes[i]
        bq.replaceWith(doc.createTextNode('\n' + quoteLines(bq.textContent) + '\n'))
      }
      const body = doc.body || doc.documentElement
      return collapse(body ? body.textContent : '')
    } catch (e) { /* fall through to regex */ }
  }
  // no DOM (a job): the same, innermost blockquote first, until none is left
  let s = String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  const inner = /<blockquote[^>]*>((?:(?!<blockquote)[\s\S])*?)<\/blockquote>/i
  const toText = (frag) => decodeEntities(frag.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol)>/gi, '\n').replace(/<[^>]+>/g, ''))
  for (let guard = 0; guard < 200; guard++) {
    const m = inner.exec(s)
    if (!m) break
    // the prefixed text goes back in as an HTML-safe fragment (its own '<' / '&' escaped) so the
    // outer passes treat it as text, and an enclosing blockquote can prefix it again
    const q = quoteLines(collapse(toText(m[1]))).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    s = s.slice(0, m.index) + '\n' + q + '\n' + s.slice(m.index + m[0].length)
  }
  return collapse(toText(s))
}
