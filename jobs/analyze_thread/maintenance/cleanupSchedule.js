// cleanupSchedule.js — WHEN the weekly clean-up is due (2026-09-27). Pure; used by the background job
// (the hourly `auto` run checks it) and by the pages (Prefs shows the next slot; a page with background
// mode off fires the clean-up job itself when it is due).
//
// freezr's scheduler has no clock — hourly/daily/weekly, anchored to when the schedule was switched on
// — so "Monday 05:00" is decided here: the hourly job asks "has the most recent Monday-05:00 slot, in
// the USER's timezone, passed without a clean-up?". With the job on its ~50-minute cadence the run
// lands within the hour after the slot. A slot is honoured for CATCH_UP_MS after it (the server was
// down at 05:00): older than that, it is skipped and the next week's slot is awaited — so installing
// on a Thursday never triggers an immediate, surprise run.

// frequency 'weekly' (on `day`) or 'daily' (every day; `day` ignored) — daily added 2026-09-27 (user:
// at ~$1.30 a run, people may want it every morning). A daily scheduled run reads the last day.
export const DEFAULT_CLEANUP_SCHEDULE = { enabled: true, frequency: 'weekly', day: 1, hour: 5 } // Monday 05:00
export const DAILY_WINDOW_DAYS = 1
export const CATCH_UP_MS = 24 * 3600e3
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** The effective schedule: stored fields over the defaults; tz from the schedule or settings.user_timezone. */
export function scheduleOf (settings) {
  const s = (settings && settings.cleanup_schedule) || {}
  const day = Number.isInteger(Number(s.day)) && Number(s.day) >= 0 && Number(s.day) <= 6 ? Number(s.day) : DEFAULT_CLEANUP_SCHEDULE.day
  const hour = Number.isInteger(Number(s.hour)) && Number(s.hour) >= 0 && Number(s.hour) <= 23 ? Number(s.hour) : DEFAULT_CLEANUP_SCHEDULE.hour
  const frequency = s.frequency === 'daily' ? 'daily' : 'weekly'
  return { enabled: s.enabled !== false, frequency, day, hour, tz: s.tz || (settings && settings.user_timezone) || null }
}

// weekday / hour / minute / second of an instant in a timezone (null tz = the host's own)
function localParts (ms, tz) {
  let fmt
  try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined, weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }) } catch (e) { fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }) }
  const o = {}
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value
  return { wd: WD[o.weekday], hour: Number(o.hour) % 24, minute: Number(o.minute), second: Number(o.second) }
}

/** The most recent slot at or before `now` (ms), or null. Walks back hour by hour — at most a week. */
export function lastSlotMs (sched, now = Date.now()) {
  const daily = sched.frequency === 'daily'
  for (let k = 0; k <= (daily ? 25 : 7 * 24 + 1); k++) {
    const t = now - k * 3600e3
    const p = localParts(t, sched.tz)
    if ((daily || p.wd === sched.day) && p.hour === sched.hour) {
      const slot = t - p.minute * 60e3 - p.second * 1000 - (t % 1000)
      if (slot <= now) return slot
    }
  }
  return null
}

/** The next slot after `now` (for display). */
export function nextSlotMs (sched, now = Date.now()) {
  const last = lastSlotMs(sched, now)
  return last == null ? null : last + (sched.frequency === 'daily' ? 1 : 7) * 24 * 3600e3
}

/**
 * Is a clean-up due right now?
 * @returns {{ due: boolean, slot: number|null, reason: string }}
 */
export function cleanupDue (settings, now = Date.now()) {
  const sched = scheduleOf(settings || {})
  if (!sched.enabled) return { due: false, slot: null, reason: 'the weekly clean-up is switched off' }
  const slot = lastSlotMs(sched, now)
  if (slot == null) return { due: false, slot: null, reason: 'no slot found' }
  const last = settings && settings.cleanup_last_run
  const done = Math.max(Number(settings && settings.cleanup_last_attempt) || 0, Number(last && last.started_at) || 0)
  if (done >= slot) return { due: false, slot, reason: 'already ran for this slot' }
  if (now - slot > CATCH_UP_MS) return { due: false, slot, reason: 'the slot passed more than a day ago — waiting for next week' }
  return { due: true, slot, reason: 'due' }
}

/** "Mondays at 05:00 (Europe/Zurich)" */
export function describeSchedule (sched) {
  return (sched.frequency === 'daily' ? 'Every day' : DAY_NAMES[sched.day] + 's') + ' at ' + String(sched.hour).padStart(2, '0') + ':00' + (sched.tz ? ' (' + sched.tz + ')' : '')
}
