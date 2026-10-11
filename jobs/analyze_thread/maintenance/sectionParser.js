// sectionParser.js — the JSONL section parser shared by the bootstrap and the weekly clean-up (moved here
// 2026-09-27 so the clean-up can run inside the background job's bundle). One JSON object per line,
// each with a `section`; malformed lines are counted, never fatal.

// ---- the incremental JSONL parser --------------------------------------------------------------
// Feed it stream chunks; it emits each complete, valid { section: … } object exactly once and
// counts what it had to skip. Tolerates code fences and stray prose lines (skipped, counted).
// Exported for the offline test harness.
export function createSectionParser (onSection) {
  const state = { buffer: '', lines: 0, badLines: 0, done: false, counts: null }
  const tryLine = (line) => {
    // Tolerate the two ways a model turns "one object per line" into a JSON array without
    // meaning to: a bare "[" / "]" line, and a trailing comma after each object (2026-09-26: an
    // opus clean-up wrote every one of its 50 lines as "{…}," and the whole run scored as empty
    // even though every verdict in it was right).
    let t = line.trim().replace(/^```(json)?$/i, '').trim()
    if (t === '[' || t === ']') return
    if (t.endsWith(',')) t = t.slice(0, -1).trim()
    if (!t) return
    state.lines++
    try {
      const o = JSON.parse(t)
      if (o && typeof o === 'object' && o.section) {
        if (o.section === 'done') { state.done = true; state.counts = o.counts || null }
        onSection(o)
        return
      }
      state.badLines++
    } catch (e) {
      state.badLines++
      console.warn('[superlazy bootstrap] unparseable output line (skipped):', t.slice(0, 160))
    }
  }
  return {
    feed (chunk) {
      state.buffer += String(chunk || '')
      let nl
      while ((nl = state.buffer.indexOf('\n')) >= 0) {
        tryLine(state.buffer.slice(0, nl))
        state.buffer = state.buffer.slice(nl + 1)
      }
    },
    finish () {
      if (state.buffer.trim()) tryLine(state.buffer)
      state.buffer = ''
      return { lines: state.lines, badLines: state.badLines, done: state.done, counts: state.counts }
    }
  }
}
