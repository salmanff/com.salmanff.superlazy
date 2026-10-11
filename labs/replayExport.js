// replayExport.js — the Export button on /replay: turns the built replay into a drop-in for ANY
// freezr page (e.g. a presentation), as two downloads:
//   superlazy-replay.html — an inner-body fragment: one scoped <style> (inline styles are allowed by
//                           freezr's CSP; inline scripts are not), the stage pre-filled with frame 1
//                           so it reads even without the player, and every frame as inert <template>s.
//   superlazy-replay.js   — the player (replayEmbed.js, unchanged), for the host's `script_files`.
// Frames are rendered by the SAME code as the live stage (the page's paint()), so the export is
// exactly what the page shows. Size is kept down by storing each distinct to-do row once and each
// distinct board once; a frame is then just its input strip, its counter and a board number.
// Only the text that is ON the stage leaves the app — never a raw event.

const PLAYER_URL = new URL('./replayEmbed.js', import.meta.url)

// The CSS is not hand-copied: every rule in the page's stylesheets that matches something in the
// exported frames is carried over, prefixed with .slr-root so it cannot touch the host page.
// Design tokens are resolved to their values here, so the host needs none of our stylesheets.
const DYNAMIC_PSEUDO = /::?(?:before|after|hover|focus-visible|focus-within|focus|active|visited|placeholder|first-letter|first-line|marker|selection|-webkit-[\w-]+)/g
const PAGE_ANCESTOR = /^(?:(?:html|body|:root|#app)(?:[.#][\w-]+)*\s*>?\s*)+/

function splitSelector (sel) {
  const out = []; let depth = 0; let cur = ''
  for (const ch of sel) {
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth--
    if (ch === ',' && !depth) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out.map(s => s.trim()).filter(Boolean)
}

function matchesIn (scope, sel) {
  const test = sel.replace(DYNAMIC_PSEUDO, '').replace(/[\s>+~]+$/, '').trim()
  if (!test) return false
  try { return !!scope.querySelector(test) } catch (e) { return false }
}

function collectCss (scope) {
  const keyframes = new Map()
  const walk = (rules) => {
    const out = []
    for (const r of rules) {
      if (r instanceof CSSStyleRule) {
        const parts = splitSelector(r.selectorText)
          .map(p => p.replace(PAGE_ANCESTOR, ''))
          .filter(p => p && matchesIn(scope, p))
        if (parts.length) out.push(parts.map(p => '.slr-root ' + p).join(', ') + ' { ' + r.style.cssText + ' }')
      } else if (r instanceof CSSMediaRule) {
        // skipped: the player SCALES the fixed slide frame to its column, and the page's
        // narrow-screen reflow (stage width 100%) would fight that and clip the stage
        continue
      } else if (r instanceof CSSSupportsRule) {
        const inner = walk(r.cssRules)
        if (inner.length) out.push('@supports ' + r.conditionText + ' {\n' + inner.join('\n') + '\n}')
      } else if (r instanceof CSSKeyframesRule) keyframes.set(r.name, r.cssText)
    }
    return out
  }
  const rules = []
  for (const sheet of document.styleSheets) {
    let list = null
    try { list = sheet.cssRules } catch (e) { continue }
    rules.push(...walk(list))
  }
  let css = PLAYER_CSS + '\n' + rules.join('\n')
  for (const [name, text] of keyframes) if (new RegExp('\\b' + name + '\\b').test(css)) css += '\n' + text
  // the tokens, frozen to their values (computed custom properties come back with var()s resolved)
  const cs = getComputedStyle(scope.querySelector('.sl-v2'))
  const vars = [...new Set(css.match(/var\(\s*--[\w-]+/g) || [])].map(v => v.replace(/^var\(\s*/, ''))
  const tokens = vars.map(v => v + ': ' + cs.getPropertyValue(v).trim() + ';').join(' ')
  // what the stage INHERITS here (the font lives on #app) becomes the root's own, so the host
  // page's body font does not leak in
  const base = getComputedStyle(scope)
  return '.slr-root { ' + tokens + ' font-family: ' + base.fontFamily + '; color: ' + base.color +
    '; font-size: ' + base.fontSize + '; line-height: ' + base.lineHeight + '; }\n' + css
}

// the player's own chrome: the slide frame and a one-line transport under it
const PLAYER_CSS = [
  '.slr-root { outline: none; }',
  '.slr-root .slr-frame { display: flex; justify-content: center; align-items: flex-start; overflow: hidden; }',
  '.slr-root .slr-frame:fullscreen { align-items: center; background: #101722; }',
  '.slr-root .rp-stage { cursor: pointer; flex: 0 0 auto; }',
  '.slr-root .slr-ctl { display: flex; align-items: center; gap: 10px; max-width: 640px; margin: 10px auto 0; }',
  '.slr-root .slr-ctl button { border: 1px solid var(--border-2); background: var(--surface); color: var(--text); border-radius: 6px; padding: 5px 11px; font: inherit; font-size: 13px; cursor: pointer; }',
  '.slr-root .slr-ctl .slr-play { background: var(--accent); border-color: var(--accent); color: #fff; }',
  '.slr-root .slr-scrub { flex: 1; min-width: 0; }'
].join('\n')

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

function stageSkeleton (shape) {
  const root = document.createElement('div')
  root.className = 'slr-root'
  root.innerHTML = '<div class="slr-frame"><div class="sl-v2"><div class="rp-stage rp-stage-' + shape + '">' +
    '<div class="rp-in" data-slot="in"></div><div class="rp-board" data-slot="board"></div>' +
    '<div class="rp-prog" data-slot="prog"></div></div></div></div>'
  const slot = (n) => root.querySelector('[data-slot="' + n + '"]')
  return { root, slots: { in: slot('in'), board: slot('board'), prog: slot('prog') } }
}

function download (name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url; a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

// paint(i, slots) renders frame i into { in, board, prog } exactly as the live stage does.
// Returns { bytes, frames, rows, boards } for the status line.
export async function exportReplay ({ total, shape, secs, paint, caption }) {
  const player = await (await fetch(PLAYER_URL)).text()

  const { root: work, slots } = stageSkeleton(shape)
  work.style.cssText = 'position:absolute;left:-20000px;top:0;'
  const parent = document.getElementById('app') || document.body // inside #app: same inherited font
  parent.appendChild(work)
  const rows = new Map() // row html -> id
  const boards = new Map() // board html (rows as placeholders) -> id
  const frames = []
  let first = null
  try {
    for (let i = 0; i < total; i++) {
      paint(i, slots)
      if (i === 0) first = { in: slots.in.innerHTML, board: slots.board.innerHTML, prog: slots.prog.innerHTML }
      for (const r of [...slots.board.querySelectorAll('.rp-row')]) {
        const flash = r.classList.contains('rp-row-flash')
        r.classList.remove('rp-row-flash')
        const html = r.outerHTML
        if (!rows.has(html)) rows.set(html, rows.size)
        const ph = document.createElement('i')
        ph.dataset.r = String(rows.get(html))
        if (flash) ph.setAttribute('data-x', '')
        r.replaceWith(ph)
      }
      const bh = slots.board.innerHTML
      if (!boards.has(bh)) boards.set(bh, boards.size)
      frames.push({ b: boards.get(bh), in: slots.in.innerHTML, pg: slots.prog.innerHTML })
    }

    // one probe stage holding every distinct input, row and board, so the CSS walk sees every
    // class the frames use (a flashed row included, for the keyframes)
    slots.in.innerHTML = [...new Set(frames.map(f => f.in))].join('')
    slots.board.innerHTML = [...rows.keys()].join('') + [...boards.keys()].join('')
    const probeRow = slots.board.querySelector('.rp-row')
    if (probeRow) probeRow.classList.add('rp-row-flash')
    slots.prog.innerHTML = frames.length ? frames[frames.length - 1].pg : ''
    const css = collectCss(work)

    const html = [
      '<!-- SuperLazy replay — exported ' + new Date().toISOString().slice(0, 10) + ' · ' + esc(caption).replace(/--/g, '—') + '.',
      '     Paste this into a freezr page\'s HTML, and add superlazy-replay.js to that page\'s',
      '     "script_files" in its manifest (freezr blocks inline scripts). Click the stage or press',
      '     space to play; ← → step; ⛶ goes full screen. If the page inserts this HTML after load,',
      '     call window.slReplayInit() once it is in the DOM. -->',
      '<div class="slr-root" tabindex="0" data-secs="' + esc(secs) + '">',
      '<style>\n' + css + '\n</style>',
      '<div class="slr-frame"><div class="sl-v2"><div class="rp-stage rp-stage-' + esc(shape) + '">',
      '<div class="rp-in" data-slot="in">' + first.in + '</div>',
      '<div class="rp-board" data-slot="board">' + first.board + '</div>',
      '<div class="rp-prog" data-slot="prog">' + first.prog + '</div>',
      '</div></div></div>',
      '<div class="slr-ctl"><button type="button" class="slr-play">▶ Play</button>' +
        '<input class="slr-scrub" type="range" min="0" max="' + Math.max(0, frames.length - 1) + '" value="0">' +
        '<button type="button" class="slr-full" title="Full screen">⛶</button></div>',
      ...[...rows.keys()].map((h, i) => '<template data-r="' + i + '">' + h + '</template>'),
      ...[...boards.keys()].map((h, i) => '<template data-b="' + i + '">' + h + '</template>'),
      ...frames.map((f, i) => '<template data-f="' + i + '" data-b="' + f.b + '"><div data-in>' + f.in + '</div><div data-pg>' + f.pg + '</div></template>'),
      '</div>'
    ].join('\n')

    download('superlazy-replay.html', html, 'text/html')
    // a second download in the same click; the browser may ask once to allow multiple downloads
    setTimeout(() => download('superlazy-replay.js', player, 'text/javascript'), 400)
    return { bytes: html.length, frames: frames.length, rows: rows.size, boards: boards.size }
  } finally {
    work.remove()
  }
}
