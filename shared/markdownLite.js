// markdownLite.js — a SMALL markdown renderer for text that came out of an agent transcript (plans,
// specs). DOM nodes only, never innerHTML: the input is untrusted, so it is treated exactly as the
// mail guide treats email HTML. Covers what agent plans actually use — headings, lists (incl. task
// items), fenced code, tables, blockquotes, rules, bold/italic/code/strike, links — and nothing
// that needs a library or an `external_scripts` permission. Returns a <div class="emv-md">.
//
// Security: links keep only http(s)/mailto schemes (anything else renders as plain text), open in
// a new tab with rel=noopener noreferrer, and no attribute is ever built from the text unescaped.

const SAFE_LINK = /^(https?:\/\/|mailto:)/i

const mk = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.appendChild(document.createTextNode(String(text)))
  return e
}

// ---- inline: **bold** *italic* _italic_ `code` ~~strike~~ [text](url) ----------------------------
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(\b_[^_\n]+_\b)|(\[[^\]\n]+\]\([^)\s]+\))/
export function renderInline (text, into) {
  let rest = String(text || '')
  while (rest.length) {
    const m = INLINE.exec(rest)
    if (!m) { into.appendChild(document.createTextNode(rest)); break }
    if (m.index > 0) into.appendChild(document.createTextNode(rest.slice(0, m.index)))
    const tok = m[0]
    if (m[1]) into.appendChild(mk('code', null, tok.slice(1, -1)))
    else if (m[2]) { const b = mk('strong'); renderInline(tok.slice(2, -2), b); into.appendChild(b) }
    else if (m[3]) { const s = mk('s'); renderInline(tok.slice(2, -2), s); into.appendChild(s) }
    else if (m[4] || m[5]) { const i = mk('em'); renderInline(tok.slice(1, -1), i); into.appendChild(i) }
    else if (m[6]) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)
      const label = mm[1]; const url = mm[2]
      if (SAFE_LINK.test(url)) {
        const a = mk('a'); a.href = url; a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener noreferrer')
        renderInline(label, a); into.appendChild(a)
      } else into.appendChild(document.createTextNode(label + ' (' + url + ')'))   // javascript:, file:, data: … → text
    }
    rest = rest.slice(m.index + tok.length)
  }
  return into
}

// ---- block level ------------------------------------------------------------------------------------
const H_RE = /^(#{1,6})\s+(.*)$/
const UL_RE = /^(\s*)[-*+]\s+(.*)$/
const OL_RE = /^(\s*)\d+[.)]\s+(.*)$/
const TASK_RE = /^\[([ xX])\]\s+(.*)$/
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
const splitRow = (line) => { let s = line.trim(); if (s.startsWith('|')) s = s.slice(1); if (s.endsWith('|')) s = s.slice(0, -1); return s.split('|').map(c => c.trim()) }

export function renderMarkdown (text) {
  const root = mk('div', 'emv-md')
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n')
  let i = 0
  let para = []
  const flushPara = () => {
    if (!para.length) return
    const p = mk('p'); renderInline(para.join('\n'), p); root.appendChild(p); para = []
  }
  while (i < lines.length) {
    const line = lines[i]
    // fenced code
    if (/^\s*```/.test(line)) {
      flushPara()
      const lang = line.trim().slice(3).trim()
      const buf = []; i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++ // closing fence (or EOF)
      const pre = mk('pre', 'emv-md-code'); const code = mk('code', lang ? 'lang-' + lang.replace(/[^\w-]/g, '') : null, buf.join('\n')); pre.appendChild(code); root.appendChild(pre)
      continue
    }
    if (!line.trim()) { flushPara(); i++; continue }
    if (HR_RE.test(line)) { flushPara(); root.appendChild(mk('hr')); i++; continue }
    let m
    if ((m = H_RE.exec(line))) {
      flushPara()
      const h = mk('h' + Math.min(6, m[1].length)); renderInline(m[2].trim(), h); root.appendChild(h); i++; continue
    }
    if (/^\s*>/.test(line)) {
      flushPara()
      const buf = []
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      const bq = mk('blockquote'); bq.appendChild(renderMarkdown(buf.join('\n'))); root.appendChild(bq); continue
    }
    // table: a header row followed by a separator row
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      flushPara()
      const table = mk('table', 'emv-md-table')
      const thead = mk('thead'); const hr = mk('tr')
      for (const c of splitRow(line)) { const th = mk('th'); renderInline(c, th); hr.appendChild(th) }
      thead.appendChild(hr); table.appendChild(thead)
      const tbody = mk('tbody'); i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const tr = mk('tr')
        for (const c of splitRow(lines[i])) { const td = mk('td'); renderInline(c, td); tr.appendChild(td) }
        tbody.appendChild(tr); i++
      }
      table.appendChild(tbody); root.appendChild(table); continue
    }
    // lists (nested by indentation; task items render a checkbox glyph)
    if (UL_RE.test(line) || OL_RE.test(line)) {
      flushPara()
      root.appendChild(renderList(lines, () => i, (n) => { i = n }))
      continue
    }
    para.push(line)
    i++
  }
  flushPara()
  return root
}

function renderList (lines, getI, setI) {
  let i = getI()
  const first = UL_RE.exec(lines[i]) || OL_RE.exec(lines[i])
  const baseIndent = first[1].length
  const ordered = !!OL_RE.exec(lines[i]) && !UL_RE.exec(lines[i])
  const list = mk(ordered ? 'ol' : 'ul')
  let li = null
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    const um = UL_RE.exec(line); const om = OL_RE.exec(line)
    const m = um || om
    if (!m) break                                  // not a list line → the list ends
    const indent = m[1].length
    if (indent < baseIndent) break                 // back out to the parent list
    // a change of list TYPE at the same indent (bullets then "1.", or the reverse) ends this list
    // and starts a sibling — otherwise the ordered item would be swallowed into the bullet list
    if (indent === baseIndent && ((!!om && !um) !== ordered)) break
    if (indent > baseIndent && li) {               // a nested list under the current item
      setI(i); li.appendChild(renderList(lines, getI, setI)); i = getI(); continue
    }
    li = mk('li')
    let body = m[2]
    const tm = TASK_RE.exec(body)
    if (tm) {
      const done = tm[1] !== ' '
      li.className = 'emv-md-task' + (done ? ' done' : '')
      li.appendChild(mk('span', 'emv-md-box', done ? '☑' : '☐')); li.appendChild(document.createTextNode(' '))
      body = tm[2]
    }
    renderInline(body, li); list.appendChild(li); i++
  }
  setI(i)
  return list
}
