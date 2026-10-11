// newMail.js — the PAGE-SIDE entry points for mail ingestion. Both the in-tab run and the
// background run are thin wrappers now; the driver itself lives in jobs/analyze_thread/ingest.js
// so the browser and the background job execute the SAME code (see that file's header).
//
//   runNewMailCheck()     — process new mail IN THIS TAB (background mode off, or "run here").
//                           Blocking: the page must stay open, hence the keep-open modal.
//   startBackgroundRun()  — hand the work to the freezr job. FIRE-AND-FORGET by design (below).
//
// WHY FIRE-AND-FORGET: freezr's POST /jobs/run *blocks for the entire run* — up to maxRuntime
// (15 min). Awaiting it from a page would hang an XHR for a quarter of an hour, and behind any
// proxy with a request timeout (Heroku's is 30s) the call errors out while the job keeps happily
// running server-side. So the promise's resolution is useless as a signal: we start the run, wait
// only long enough to catch an IMMEDIATE rejection (permission denied / nowhere to run), and from
// then on every page learns what happened by polling the run lock and settings.bg_last_run.

import { runIngestion, newTabOwnerId, estCostRange } from '../jobs/analyze_thread/ingest.js'
import { JOB_MAX_RUNTIME, CLEANUP_JOB_MAX_RUNTIME } from '../jobs/analyze_thread/config.js'

export { estCostRange }

// How long to watch a just-started job run for an immediate failure before declaring it started.
// A rejected permission / "not runnable here" comes back in well under a second; a real run is
// still pending long after this.
const START_CONFIRM_MS = 4000

/**
 * Ask the freezr job to do the work. Returns { started, error } — NOT the run's outcome.
 * @param {Object} o
 * @param {Object} o.freezr
 * @param {string} [o.task]        'auto' (legacy alias) | 'newmail' — both check mail from the cursors
 * @param {number} [o.threadContextDays]
 */
// extra: further job params (e.g. { force: true } — the Prefs "Run now" clean-up, which skips the schedule check)
export async function startBackgroundRun ({ freezr, task = 'auto', threadContextDays = null, manual = false, extra = null } = {}) {
  if (!freezr || !freezr.jobs || !freezr.jobs.run) return { started: false, error: 'jobs api unavailable' }
  // eager: every run STARTED FROM A PAGE is user-initiated — grab whatever chat is there now
  // rather than letting the soft debounce hold a fresh tiny chunk for the next cycle. Only the
  // SCHEDULED run (freezr cron, no params) keeps the debounce.
  const params = { task, eager: true }
  if (threadContextDays != null) params.threadContextDays = threadContextDays
  if (manual) params.manual = true   // the user PRESSED the button: agent turns still in progress are analysed too
  if (extra && typeof extra === 'object') Object.assign(params, extra)

  // an `auto` run may be the one that finds the weekly clean-up due (it runs the clean-up first, then
  // mail), and a `cleanup` run IS one — both get the clean-up's longer ceiling. The mail check keeps
  // its own 10-minute budget either way, so this only matters when the clean-up actually runs.
  const run = freezr.jobs.run('analyze_thread', params, { maxRuntime: (task === 'auto' || task === 'cleanup') ? CLEANUP_JOB_MAX_RUNTIME : JOB_MAX_RUNTIME })
  // Swallow the late result/rejection: nobody awaits this promise, and an unhandled rejection
  // 15 minutes from now would surface as a console error with no context.
  run.then(() => {}, (e) => console.warn('[superlazy] background run ended with an error:', (e && e.message) || e))

  const pending = Symbol('pending')
  const outcome = await Promise.race([
    // __status carries the HTTP status so the poller can tell an expired sign-in (401) apart from
    // a genuine job refusal (not trusted / no grant) — they need opposite advice to the user.
    run.then(r => r, e => ({ __error: (e && e.message) || String(e), __status: e && e.status })),
    new Promise(resolve => setTimeout(() => resolve(pending), START_CONFIRM_MS))
  ])
  if (outcome === pending) return { started: true }
  if (outcome && outcome.__error) return { started: false, error: outcome.__error, status: outcome.__status }
  // Finished inside the confirm window — a no-op run (nothing to do, or the lock was held).
  return { started: true, finished: true, result: outcome }
}

/**
 * Process new mail IN THIS TAB. Same signature the dashboard and Setup page already use.
 * Returns { skipped, holder } | { planned: 0, done: true } | { planned, done, remaining, cost, lockLost }.
 */
export async function runNewMailCheck ({ freezr, persist, data, onPlanned, onProgress, shouldStop, force = false, maxMessages = 0, accountIds = null, manual = false, rescan = false }) {
  return runIngestion({
    freezr,
    persist,
    data,
    task: 'newmail',
    owner: newTabOwnerId(),
    force,
    accountIds, // per-source Force resync: only these stored accounts (null = all)
    rescan, // Force resync: page the whole pending queue, ignoring the scan watermark (2026-10-04)
    eager: true, // user-initiated: no chat debounce — analyse whatever is there right now
    manual, // the user PRESSED the button: agent turns still in progress are analysed too (no 30-min quiet wait)
    onPlanned,
    onProgress,
    shouldStop,
    // no budgetMs: a tab run is bounded by the user's own Stop button, not a clock.
    // maxMessages: the "check ONE" flow — process exactly N then stop cleanly, so per-message
    // quality can be inspected without cancelling a full run each time.
    maxMessages
  })
}
