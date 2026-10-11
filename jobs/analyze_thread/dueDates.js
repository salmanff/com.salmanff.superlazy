// dueDates.js — turn a free-text due hint ("next Wednesday", "end of month") into the
// machine-readable DUE WINDOW stored beside it: { earliest: 'YYYY-MM-DD', latest: 'YYYY-MM-DD' }.
// The text stays what the user sees; the window is what overdue colouring / sorting / filters
// use. A deterministic parser handles the common shapes instantly and free; anything else goes
// to the user's LLM as one small JSON call. anchorMs = when the words were WRITTEN (the email's
// own date for model output and migrations, "now" for the editors). All UTC, day-granular.

const DAY = 24 * 3600 * 1000
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/
export const isoDateOk = (s) => (ISO_RE.test(String(s || '')) ? String(s) : null)
export const todayIso = () => iso(Date.now())

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const startOfDay = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) }
const endOfMonth = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0) }
const one = (ms) => ({ earliest: iso(ms), latest: iso(ms) })
const range = (a, b) => ({ earliest: iso(a), latest: iso(b) })

// next occurrence of a weekday strictly AFTER today; "next X" pushes at least a week out
function nextWeekday (anchor, dayIdx, forceNextWeek) {
  const today = startOfDay(anchor)
  let ahead = (dayIdx - new Date(today).getUTCDay() + 7) % 7
  if (ahead === 0) ahead = 7
  if (forceNextWeek && ahead < 7) ahead += 7
  return today + ahead * DAY
}

// Deterministic pass — returns { earliest, latest } or null when the phrase needs the LLM.
export function parseDueRange (text, anchorMs = Date.now()) {
  const t = String(text || '').trim().toLowerCase().replace(/^(by|due|before|until|till)\s+/, '')
  if (!t) return null
  const today = startOfDay(anchorMs)

  // absolute dates
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return one(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  m = t.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{4})$/) // d/m/yyyy
  if (m) return one(Date.UTC(+m[3], +m[2] - 1, +m[1]))
  m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?\s*(\d{4})?$/) // 15 aug [2026]
  const m2 = t.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})?$/) // aug 15[, 2026]
  const dm = m ? { d: +m[1], mon: m[2], y: m[3] } : (m2 ? { d: +m2[2], mon: m2[1], y: m2[3] } : null)
  if (dm) {
    const mi = MONTHS.indexOf(dm.mon.slice(0, 3))
    if (mi >= 0 && dm.d >= 1 && dm.d <= 31) {
      let ms = Date.UTC(dm.y ? +dm.y : new Date(today).getUTCFullYear(), mi, dm.d)
      if (!dm.y && ms < today) ms = Date.UTC(new Date(today).getUTCFullYear() + 1, mi, dm.d)
      return one(ms)
    }
  }

  // relative words
  if (/^(today|now|asap|immediately|eod|end of (the )?day|tonight)$/.test(t)) return one(today)
  if (/^tomorrow$/.test(t)) return one(today + DAY)
  m = t.match(/^in (\d+) days?$/); if (m) return one(today + (+m[1]) * DAY)
  m = t.match(/^in (\d+) weeks?$/); if (m) return one(today + (+m[1]) * 7 * DAY)
  m = t.match(/^(next\s+)?([a-z]+day)$/) // [next] wednesday
  if (m && WEEKDAYS.includes(m[2])) return one(nextWeekday(anchorMs, WEEKDAYS.indexOf(m[2]), !!m[1]))
  if (/^(this week)$/.test(t)) return range(today, nextWeekday(anchorMs, 0, false)) // through Sunday
  if (/^(eow|end of (the )?week)$/.test(t)) return one(nextWeekday(anchorMs, 5, false)) // Friday
  if (/^next week$/.test(t)) {
    const mon = nextWeekday(anchorMs, 1, false)
    return range(mon, mon + 4 * DAY) // Mon–Fri: the working week (user, 2026-08-27)
  }
  if (/^(eom|end of (the )?month)$/.test(t)) return one(endOfMonth(anchorMs))
  if (/^this month$/.test(t)) return range(today, endOfMonth(anchorMs))
  if (/^next month$/.test(t)) {
    const d = new Date(anchorMs)
    const first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
    return range(first, endOfMonth(first))
  }
  return null
}

const clean = (v) => isoDateOk(v)

// Text → window, LLM fallback for anything the parser can't read. Never throws; unresolvable
// or non-date text yields { earliest: null, latest: null } — the display text still shows.
export async function resolveDueRange (text, anchorMs = Date.now()) {
  const t = String(text || '').trim()
  if (!t) return { earliest: null, latest: null }
  const parsed = parseDueRange(t, anchorMs)
  if (parsed) return parsed
  try {
    // NOTE the generous max_tokens: freezr's default model THINKS first and thinking counts
    // against the cap — a tight cap starves the answer entirely (empty response back)
    const res = await freezr.llm.ask(
      'Today is ' + iso(anchorMs) + ' (a ' + WEEKDAYS[new Date(startOfDay(anchorMs)).getUTCDay()] + '). ' +
      'Interpret this due-date expression: "' + t.replace(/"/g, "'") + '".\n' +
      'Answer ONLY with JSON: {"earliest":"YYYY-MM-DD","latest":"YYYY-MM-DD"} — the window the deadline falls in ' +
      '(the same date twice when it is exact; both null when the text is not a date at all).',
      { responseType: 'json', max_tokens: 1500 }
    )
    let out = res && res.success ? res.response : null
    if (typeof out === 'string') { try { out = JSON.parse(out) } catch (e) { out = null } }
    return { earliest: clean(out && out.earliest), latest: clean(out && out.latest) }
  } catch (e) {
    return { earliest: null, latest: null }
  }
}

// Batch variant for migrations: items = [{ i, text, anchorMs }] →
// { ranges: Map(i → { earliest, latest }), llmFailed }. Parser first; ONE LLM call covers the
// remainder. An entry with both nulls means the LLM READ the text and it is not a date; an item
// MISSING from the map means it was not resolved (LLM failed/omitted) — retry later.
export async function resolveDueRanges (items) {
  const ranges = new Map()
  const rest = []
  for (const it of items) {
    const r = parseDueRange(it.text, it.anchorMs)
    if (r) ranges.set(it.i, r)
    else rest.push(it)
  }
  if (!rest.length) return { ranges, llmFailed: false }
  // chunked calls with GENEROUS output budgets: the model's thinking tokens count against
  // max_tokens (observed: a 1880 cap consumed entirely by thinking → empty response). A failed
  // chunk sets llmFailed but the other chunks still land.
  let llmFailed = false
  const CHUNK = 20
  for (let at = 0; at < rest.length; at += CHUNK) {
    const chunk = rest.slice(at, at + CHUNK)
    try {
      const listing = chunk.map(it => ({ i: it.i, text: String(it.text).slice(0, 80), written_on: iso(it.anchorMs) }))
      const res = await freezr.llm.ask(
        'Each item below is a due-date expression and the date it was written on. Translate each to the ' +
        'ISO window its deadline falls in (same date twice when exact; nulls when it is not a date).\n' +
        'Items: ' + JSON.stringify(listing) + '\n' +
        'Answer ONLY with a JSON array: [{"i":0,"earliest":"YYYY-MM-DD","latest":"YYYY-MM-DD"}, …] — one entry per item, same "i".',
        { responseType: 'json', max_tokens: 2000 + 150 * chunk.length }
      )
      let arr = res && res.success ? res.response : null
      if (typeof arr === 'string') { try { arr = JSON.parse(arr) } catch (e) { arr = null } }
      if (!Array.isArray(arr)) { llmFailed = true; continue }
      for (const row of arr) {
        if (row && row.i != null) ranges.set(Number(row.i), { earliest: clean(row.earliest), latest: clean(row.latest) })
      }
    } catch (e) {
      llmFailed = true // parser results + other chunks survive; this chunk retries next run
    }
  }
  return { ranges, llmFailed }
}

// The old "Not due" HIDE predicate, still what the priority demotion below asks: a task counts
// as DUE unless its window clearly starts in the future — for a hide, NO due date means nothing
// says it can wait, so it stays.
export function isDueNow (t) {
  const ref = (t && (t.due_earliest || t.due_latest)) || null
  return !ref || ref <= todayIso()
}

// The "Due" SHOW-ONLY predicate: a real due window that has already started. Flipping the filter
// from hide-not-due to show-due flips what an undated task means too — "show me what is due" is a
// positive ask for dated work, so a task with no due date is NOT due (user, 2026-09-12).
export function isDueDated (t) {
  const ref = (t && (t.due_earliest || t.due_latest)) || null
  return !!ref && ref <= todayIso()
}

// EFFECTIVE importance: the stored priority minus the task's own "hold down until due"
// (todo.due_demote, set in the task editor) — applied only while the due window clearly starts
// in the future (same predicate as the "Not due" filter, so no due date = the hold is inert).
// Computed at read time from today's date, so a held task pops back to full priority the day
// its window opens with no job or stored transition. Every sort/filter that ranks tasks by
// importance goes through THIS; displays of what the priority IS keep todo.importance.
// (user, 2026-08-27)
export function effImportance (t) {
  const imp = Number(t && t.importance) || 3
  const hold = Number(t && t.due_demote) || 0
  if (!hold || isDueNow(t)) return imp
  return Math.max(1, imp - hold)
}
