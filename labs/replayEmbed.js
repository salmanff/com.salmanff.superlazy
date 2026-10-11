// replayEmbed.js — the PLAYER for a replay exported from /replay (shipped as superlazy-replay.js).
// It is not loaded by any SuperLazy page: the Export button downloads it next to the HTML fragment,
// and the host page lists it in its manifest `script_files` (a plain script — no import/export —
// because freezr blocks inline <script>). It only shows and hides what the export pre-rendered:
//   template[data-r] — one to-do row, stored once however many frames show it
//   template[data-b] — one board, its rows as <i data-r="N"> placeholders (data-x = flash it)
//   template[data-f] — one frame: [data-in] input strip + [data-pg] counter, data-b = its board
// Several exports can sit on one page. If the page inserts the fragment after load (an SPA),
// call window.slReplayInit() once it is in the DOM.
(function () {
  function init (root) {
    if (root.slrReady) return
    root.slrReady = true
    const q = (s) => root.querySelector(s)
    const tpl = (k, n) => root.querySelector('template[data-' + k + '="' + n + '"]')
    const frames = root.querySelectorAll('template[data-f]')
    const slot = (n) => q('[data-slot="' + n + '"]')
    const box = q('.slr-frame'); const stage = q('.rp-stage')
    const playBtn = q('.slr-play'); const scrub = q('.slr-scrub')
    const secs = Math.max(0.05, Number(root.dataset.secs) || 0.25)
    let idx = 0; let timer = null
    if (!frames.length) return

    function show (i) {
      idx = Math.max(0, Math.min(frames.length - 1, i))
      const f = frames[idx]
      slot('in').replaceChildren(...f.content.querySelector('[data-in]').cloneNode(true).childNodes)
      slot('prog').replaceChildren(...f.content.querySelector('[data-pg]').cloneNode(true).childNodes)
      const board = tpl('b', f.dataset.b).content.cloneNode(true)
      board.querySelectorAll('i[data-r]').forEach(ph => {
        const row = tpl('r', ph.dataset.r).content.firstElementChild.cloneNode(true)
        if (ph.hasAttribute('data-x')) row.classList.add('rp-row-flash')
        ph.replaceWith(row)
      })
      slot('board').replaceChildren(board)
      scrub.value = String(idx)
    }
    function pause () { clearTimeout(timer); timer = null; playBtn.textContent = '▶ Play' }
    function tick () {
      if (idx >= frames.length - 1) return pause()
      show(idx + 1)
      timer = setTimeout(tick, secs * 1000)
    }
    function play () {
      if (timer) return pause()
      if (idx >= frames.length - 1) show(0)
      playBtn.textContent = '⏸ Pause'
      timer = setTimeout(tick, secs * 1000)
    }
    // the stage is a fixed-size slide frame: scale it down to the column, or up to the screen
    function fit () {
      const full = document.fullscreenElement === box
      stage.style.transform = ''
      const w = stage.offsetWidth; const h = stage.offsetHeight
      const s = full ? Math.min(box.clientWidth / w, box.clientHeight / h) : Math.min(1, box.clientWidth / w)
      stage.style.transformOrigin = full ? 'center center' : 'top center'
      stage.style.transform = 'scale(' + s.toFixed(3) + ')'
      box.style.height = full ? '' : Math.ceil(h * s) + 'px'
    }

    playBtn.addEventListener('click', play)
    stage.addEventListener('click', play)
    scrub.addEventListener('input', () => { pause(); show(Number(scrub.value) || 0) })
    q('.slr-full').addEventListener('click', () => { if (box.requestFullscreen) box.requestFullscreen() })
    root.addEventListener('keydown', (e) => {
      if (e.target.matches('input, button')) return
      if (e.key === ' ') { e.preventDefault(); play() }
      if (e.key === 'ArrowRight') { pause(); show(idx + 1) }
      if (e.key === 'ArrowLeft') { pause(); show(idx - 1) }
    })
    document.addEventListener('fullscreenchange', fit)
    window.addEventListener('resize', fit)
    fit()
  }
  function boot () { document.querySelectorAll('.slr-root').forEach(init) }
  window.slReplayInit = boot
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
