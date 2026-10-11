// dueField.js — THE due-date control, shared by every place a task's due date is typed: the task
// editor modal (taskEditor.js) and the project card's "+ Add" tab (expandableProjectView.js).
// One component so both behave identically — adding a task and editing one should not be two
// different due-date experiences (user, 2026-08-31).
//
// It is: a half-width text box, the quick-fill buttons beside it (asap / today / tomorrow /
// next wk), and the interpreted machine window in small print underneath.
//
// The quick buttons insert phrases the DETERMINISTIC parser (dueDates.parseDueRange) reads
// instantly and resolve them synchronously — no debounce, no spinner, no LLM call. Typed text
// goes the slow way: debounced, with a loader, through resolveDueRange (parser first, one LLM
// call as fallback). "asap" stays literal, because the due sort pins asap tasks above every
// date; "today"/"tomorrow" land as the actual day.

import { div, span, btn, el, fmtShortDay } from './renderUtils.js'
import { parseDueRange, resolveDueRange, todayIso } from '../jobs/analyze_thread/dueDates.js'

const EMPTY = { earliest: null, latest: null }
const dayFromNow = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10)

// opts: {
//   value      — the due text to start with,
//   range      — { earliest, latest } already known for that text (an existing task's window),
//   placeholder,
//   inputClass — extra classes for the text box,
//   onRangeChange(range) — fired whenever the interpreted window changes
// }
// Returns { wrap, note, input, getText(), getRange(), isResolved() } — `wrap` is the box + quick
// buttons (drop it in a form row), `note` the interpreted-date line (drop it under the row).
// isResolved() says whether getRange() actually corresponds to the CURRENT text, so a caller
// saving mid-debounce knows to resolve once more.
export function createDueField ({ value = '', range = null, placeholder, inputClass = '', onRangeChange = null } = {}) {
  let text = value || ''
  let rng = range ? { earliest: range.earliest || null, latest: range.latest || null } : { ...EMPTY }
  let resolvedFor = text.trim()
  let timer = null
  let ticket = 0

  const input = el('input', ('pe-name te-due-in ' + inputClass).trim())
  input.type = 'text'
  input.value = text
  input.placeholder = placeholder || 'e.g. Friday · 15 Aug · end of month'

  const wrap = div('te-due-wrap')
  wrap.appendChild(input)

  const note = div('te-due-dates')
  const paintNote = (state) => {
    note.textContent = ''
    if (state && state.loading) {
      note.appendChild(span('freezr-spinner te-due-spin'))
      note.appendChild(span(null, ' interpreting…'))
      return
    }
    const { earliest, latest } = state || {}
    if (!earliest && !latest) { note.textContent = text.trim() ? 'no machine-readable date' : ' '; return }
    note.textContent = '🗓 ' + (earliest && latest && earliest !== latest ? earliest + ' → ' + latest : (latest || earliest))
  }
  const announce = () => { if (onRangeChange) onRangeChange({ ...rng }) }
  paintNote(rng)

  const quick = (label, textOf, title) => {
    const b = btn('te-due-quick', label, () => {
      const t = textOf()
      input.value = t
      text = t
      // resolve HERE, synchronously: these phrases are all in the deterministic parser, so going
      // through the input path's debounce + spinner (and its LLM fallback) is pure ceremony
      // (user, 2026-08-27). Bump the ticket so any in-flight typing resolution can't overwrite it.
      clearTimeout(timer); ticket++
      rng = parseDueRange(t) || { ...EMPTY }
      resolvedFor = t.trim()
      paintNote(rng)
      announce()
      input.focus()
    })
    if (title) b.title = title
    wrap.appendChild(b)
  }
  quick('asap', () => 'asap', 'As soon as possible — stays literal, and the due sort pins it above every date')
  quick('today', () => fmtShortDay(todayIso()), 'Due today')
  quick('tomorrow', () => fmtShortDay(dayFromNow(1)), 'Due tomorrow')
  quick('next wk', () => 'next week', 'Due some time next week')

  input.addEventListener('input', () => {
    text = input.value
    clearTimeout(timer)
    const t = text.trim()
    if (!t) {
      rng = { ...EMPTY }; resolvedFor = ''
      paintNote(rng); announce()
      return
    }
    paintNote({ loading: true })
    timer = setTimeout(async () => {
      const mine = ++ticket
      const r = await resolveDueRange(t) // anchored to NOW — the user is typing today
      if (mine !== ticket) return // superseded by more typing
      rng = r; resolvedFor = t
      paintNote(r); announce()
    }, 500)
  })

  return {
    wrap,
    note,
    input,
    getText: () => text.trim(),
    getRange: () => ({ ...rng }),
    isResolved: () => text.trim() === resolvedFor
  }
}
