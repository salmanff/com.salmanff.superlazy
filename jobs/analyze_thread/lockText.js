// lockText.js — ONE wording for "another run holds the processing lock" (2026-10-04). Pure; used by
// the clean-up core (job AND page), the agents lab and the pages' status notes. The lock record
// (persist.acquireRunLock's `holder`) carries owner, kind, started_at, progress, expires_at and
// _date_modified (the last renewal). A live holder renews it every beat; one that died (a closed
// tab, a server restart mid-job) stops renewing and is released at expires_at, so the message says
// WHO holds it, when it last showed life, and how long until a dead holder frees it — a user can
// then tell "wait for it" from "it is dead, try again in N minutes" instead of guessing.

const KIND_TEXT = {
  cleanup: 'clean-up',
  project_review: 'project review',
  newmail: 'mail check',
  note: 'note analysis',
  training: 'history build',
  sessions_commit: 'agents lab save'
}

/** "a background clean-up", "a clean-up in another tab", "the Inspect page's mail check" … */
export function lockHolderName (holder) {
  const owner = String((holder && holder.owner) || '')
  const kind = KIND_TEXT[holder && holder.kind] || (holder && holder.kind) || 'run'
  if (owner.startsWith('job:')) return 'a background ' + kind
  if (owner.startsWith('inspect:')) return 'the Inspect page’s ' + kind
  if (owner.startsWith('agentslab')) return 'the agents lab'
  if (owner.startsWith('tab:') || owner.startsWith('page:')) return 'a ' + kind + ' in another tab'
  return 'another ' + kind
}

/** "3m", "45s", "1h 05m" — short durations for the hints. */
export function shortDuration (ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm' + (s % 60 && m < 5 ? ' ' + String(s % 60).padStart(2, '0') + 's' : '')
  return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'
}

/** When the lock frees itself if its holder sends no further sign of life — ms from now (≥ 0), or null. */
export function lockReleaseInMs (holder, now = Date.now()) {
  const exp = Number(holder && holder.expires_at)
  return exp ? Math.max(0, exp - now) : null
}

/**
 * The full sentence for a refused start. Example:
 *   "a background clean-up (weekly clean-up) holds the processing lock — started 4m ago, last sign
 *    of life 2m ago. If it is still running, wait for it to finish; if it has died (a closed tab or a
 *    server restart), the lock frees itself in 3m and you can try again."
 */
export function describeLockHolder (holder, now = Date.now()) {
  if (!holder) return 'another run holds the processing lock — try again when it has finished'
  const stage = holder.progress && holder.progress.stage ? ' (' + String(holder.progress.stage).slice(0, 60) + ')' : ''
  const started = Number(holder.started_at)
  const beat = Number(holder._date_modified || holder.started_at)
  const since = started ? ' — started ' + shortDuration(now - started) + ' ago' : ''
  const life = beat ? (started ? ', ' : ' — ') + 'last sign of life ' + shortDuration(now - beat) + ' ago' : ''
  const left = lockReleaseInMs(holder, now)
  const tail = left == null
    ? ' Try again when it has finished.'
    : left === 0
      ? ' It has not renewed the lock in time, so the next start takes it over — try again now.'
      : ' If it is still running, wait for it to finish; if it has died (a closed tab or a server restart), the lock frees itself in ' + shortDuration(left) + ' and you can try again.'
  return lockHolderName(holder) + stage + ' holds the processing lock' + since + life + '.' + tail
}

/** The short hint for a status note next to a LIVE holder: "frees itself in 3m if it has died". */
export function lockReleaseHint (holder, now = Date.now()) {
  const left = lockReleaseInMs(holder, now)
  if (left == null) return ''
  return left === 0 ? 'lock lapsed — the next start takes it over' : 'if it has died, the lock frees itself in ' + shortDuration(left)
}
