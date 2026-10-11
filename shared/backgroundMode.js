// backgroundMode.js — the two processing modes and the shared status poller. No DOM here; the
// pages render whatever this reports (mailTools.js draws the topbar note + the strip).
//
// MODE OFF — nothing runs by itself, ever. Mail is only checked when the user presses a button.
//   The Dashboard prompts once on load if mail has gone stale (checkMailPrompt.js), and the check
//   then runs IN THE TAB, so it needs the keep-page-open modal.
// MODE ON — the freezr job does the work, so the user can navigate freely mid-check.
//   Two cadences drive it, deliberately:
//     · the hourly SCHEDULE — freezr's scheduler, runs with the browser closed. Hourly is the
//       finest granularity freezr offers, which is right for "keep me current while I'm away".
//     · the foreground POLL — while a page is actually open the user expects fresher mail than
//       that, so the page asks for an extra on-demand run every foreground_poll_minutes.
//   Either way it is the JOB doing the work. The page only starts runs and watches.
//
// WHY THE POLLING: freezr's POST /jobs/run blocks for the whole run and is never awaited (see
// newMail.js), so a page can NEVER learn an outcome from the call it made — let alone from a run
// the scheduler made while the browser was shut. Both facts land on the same answer: the job
// writes settings.bg_last_run, the run lock carries live progress, and pages poll the two.

import { STATUS_POLL_MS, DEFAULT_FOREGROUND_POLL_MIN } from '../jobs/analyze_thread/config.js'
import { startBackgroundRun } from './newMail.js'
import { isAuthExpiredError } from '../jobs/analyze_thread/persist.js'
import { isEnvironmentalFailure, ENVIRONMENTAL_BACKOFF_MS } from '../jobs/analyze_thread/config.js'

const JOB_NAME = 'analyze_thread'

// ---- capability + preference -----------------------------------------------------------------

// Can the job actually run? Needs the run_job grant AND somewhere to run it: either an admin
// trusted the app to run in-process on this server, or the user has their own serverless cloud.
export async function probeCapability () {
  try {
    if (typeof freezr === 'undefined' || !freezr.jobs || !freezr.jobs.ping) {
      return { known: false, capable: false, reason: 'this freezr server has no jobs API' }
    }
    const info = await freezr.jobs.ping()
    const j = (info && info.jobs && info.jobs[JOB_NAME]) || {}
    const granted = !!j.run_job_granted
    const somewhere = !!j.trusted || !!(info && info.has_compute)
    return {
      known: true,
      capable: granted && somewhere,
      granted,
      scheduleGranted: !!j.schedule_job_granted,
      trusted: !!j.trusted,
      hasCompute: !!(info && info.has_compute),
      scheduled: !!j.scheduled,
      location: j.location || 'auto',
      reason: granted
        ? (somewhere ? null : 'the job has nowhere to run — an admin must trust SuperLazy on this server, or you can add a serverless key')
        : 'the background-jobs permission is not granted'
    }
  } catch (e) {
    // An expired sign-in (upstream identity layer or freezr session — every call 401s) is not a
    // capability problem: don't let it read as "permission missing" on page load.
    if (isAuthExpiredError(e)) {
      return { known: false, capable: false, authExpired: true, reason: 'your sign-in has expired — reload the page to sign in again' }
    }
    return { known: false, capable: false, reason: (e && e.message) || String(e) }
  }
}

/**
 * The effective mode plus everything the UI needs to explain it.
 * `background_mode` is deliberately TRI-state in storage: absent means "auto" (use background
 * whenever it's available), and only an explicit user choice writes 'on' / 'off'. That way an
 * install that later gains the permission starts using it without the user re-visiting prefs.
 */
export async function loadBackgroundState ({ persist, settings = null } = {}) {
  const [cap, s] = await Promise.all([
    probeCapability(),
    settings ? Promise.resolve(settings) : (persist ? persist.readSettings() : Promise.resolve(null))
  ])
  const prefMode = (s && s.background_mode) || 'auto'
  const mode = (prefMode === 'off' || !cap.capable) ? 'off' : 'on'
  return {
    ...cap,
    prefMode,
    mode,
    // off DESPITE being able to run — the user chose it; the UI says so rather than pitching a grant
    offByChoice: prefMode === 'off' && cap.capable,
    pollMinutes: Number(s && s.foreground_poll_minutes) || DEFAULT_FOREGROUND_POLL_MIN,
    lastCheck: Number(s && s.newmail_last_check) || 0,
    lastRun: (s && s.bg_last_run) || null
  }
}

/**
 * Turn background mode on/off. Granting schedule_job is CONSENT only — freezr does not start the
 * recurring schedule for us — so the toggle is what actually calls schedule()/unschedule().
 * Returns the refreshed state.
 */
export async function setBackgroundMode ({ persist, on }) {
  await persist.stampSettingsFields({ background_mode: on ? 'on' : 'off' })
  try {
    if (typeof freezr !== 'undefined' && freezr.jobs) {
      if (on) await freezr.jobs.schedule(JOB_NAME)
      else await freezr.jobs.unschedule(JOB_NAME)
    }
  } catch (e) {
    console.warn('[superlazy] could not ' + (on ? 'start' : 'stop') + ' the background schedule:', (e && e.message) || e)
  }
  return loadBackgroundState({ persist })
}

// Bring the recurring schedule in line with the effective mode. Called once per page mount so an
// install that just gained the permission starts scheduling without the user opening prefs.
export async function reconcileSchedule (state) {
  if (!state.known || typeof freezr === 'undefined' || !freezr.jobs) return state
  const want = state.mode === 'on' && state.scheduleGranted
  if (want === !!state.scheduled) return state
  try {
    if (want) await freezr.jobs.schedule(JOB_NAME)
    else await freezr.jobs.unschedule(JOB_NAME)
    return { ...state, scheduled: want }
  } catch (e) {
    console.warn('[superlazy] schedule reconcile failed:', (e && e.message) || e)
    return state
  }
}

// ---- the shared status poller -----------------------------------------------------------------

export const agoText = (ms) => {
  const n = Number(ms) || 0
  if (!n) return 'never'
  const s = Math.max(0, Math.round((Date.now() - n) / 1000))
  if (s < 90) return s + 's ago'
  if (s < 5400) return Math.round(s / 60) + ' min ago'
  if (s < 172800) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86400) + 'd ago'
}

/**
 * Poll the run lock + settings, report status, and (mode ON only) keep asking the job to run.
 *
 * @param {Object}   o
 * @param {Object}   o.persist
 * @param {Object}   o.state       from loadBackgroundState()
 * @param {Function} o.onStatus    ({ active, lock, stalled, lastRun, lastCheck, running }) — every tick
 * @param {Function} o.onLanded    (lastRun) — ONCE per completed run that actually processed
 *                                  something. This is the page's cue to reload its data.
 * @returns {Object} controller { stop, tick, runNow, getState, setState }
 */
export function createStatusPoller ({ persist, state, onStatus = null, onLanded = null } = {}) {
  let st = state
  let timer = null
  let stopped = false
  let firing = false          // a run request from THIS page is in flight
  let sawActiveLock = false
  let lastSeenRunAt = st && st.lastRun ? Number(st.lastRun.finished_at) || 0 : 0
  let lastFireAt = 0
  let fireBackoffUntil = 0
  let lastRefusal = null      // { at, error } — the job REFUSED to start (not trusted / no grant / nowhere to run)
  // { at, error } — the SIGN-IN died (e.g. the identity layer in front of freezr timed out on an
  // idle page): every api call 401s, so nothing can be read or started until the user re-logs in.
  // Kept separate from lastRefusal because the advice is the opposite — reload and sign in, not
  // "check your grants". Seeded from probeCapability when the page loaded already signed out.
  let authExpired = (state && state.authExpired) ? { at: Date.now(), error: state.reason || 'sign-in expired' } : null
  let accountWarnings = []
  let retriedFailureOnLoad = false
  // While the sign-in is dead every status read is a guaranteed 401, and freezr's auth
  // rate-limiter counts each one against the IP ("Too many requests", seen live 2026-08-30 and
  // again 2026-09-16 — the limit turned out to be a handful of failures per MINUTE, so even one
  // tick's parallel reads could block the user's own IP). Three rules keep a dead tab harmless:
  //   · the poll slows to once per AUTH_EXPIRED_POLL_MS;
  //   · a dead-looking tab sends ONE probe request, never the full read batch (see tick);
  //   · returning to the tab (visibilitychange) probes early so recovery after a re-login still
  //     feels instant — but at most once per AUTH_FORCE_PROBE_MIN_MS, since alt-tabbing back and
  //     forth used to fire a burst per switch.
  const AUTH_EXPIRED_POLL_MS = 5 * 60e3
  const AUTH_FORCE_PROBE_MIN_MS = 60e3
  let lastAuthProbeAt = 0

  // floor of ONE minute (this was Math.max(60, …) — a 60-MINUTE floor that silently turned the
  // "check every 5 minutes while a page is open" poll into an hourly one)
  const pollMs = () => Math.max(1, Number(st.pollMinutes) || DEFAULT_FOREGROUND_POLL_MIN) * 60e3

  // Ask the job for a run. Never awaited for its result (it blocks for the whole run) — we only
  // wait long enough to catch an immediate refusal. task 'auto' = continue a pending history
  // build first, else check new mail — so the foreground poll also drains an unfinished backfill.
  // ifStale: an AUTOMATIC fire (the interval poll) re-reads the shared last-check stamp right
  // before starting — with several pages open, whichever tab fired first stamps the check and
  // the others find it fresh and stand down. Manual button presses never pass ifStale.
  async function runNow ({ task = 'auto', ifStale = false, manual = false } = {}) {
    if (firing || stopped) return { started: false, error: 'already starting' }
    firing = true
    lastFireAt = Date.now()
    try {
      if (ifStale) {
        try {
          const s = await persist.readSettings()
          const lastCheck = Number(s && s.newmail_last_check) || 0
          if (Date.now() - lastCheck < pollMs()) {
            st = { ...st, lastCheck }
            return { started: false, error: 'checked ' + agoText(lastCheck) + ' by another page' }
          }
        } catch (e) { /* can't read settings — fall through and let the run lock arbitrate */ }
      }
      const r = await startBackgroundRun({ freezr, task, manual })   // manual only from the button; the poll's runNow leaves it false
      if (!r.started && isAuthExpiredError({ status: r.status, message: r.error })) {
        // The start didn't fail because of the job's configuration — the SIGN-IN is gone (401 on
        // the /jobs/run call itself). Reporting this as a refusal sent users chasing grants and
        // job-trust that were fine; record it as the auth problem it is, and back off the same way.
        fireBackoffUntil = Date.now() + 10 * 60e3
        authExpired = { at: Date.now(), error: r.error || 'sign-in expired' }
        console.warn('[superlazy] background run failed — sign-in expired:', r.error)
      } else if (!r.started) {
        // A refusal is a CONFIGURATION problem (grant revoked, job un-trusted after a re-install,
        // compute gone) — back off so it doesn't retry every tick, but crucially RECORD it so the
        // strip can say why nothing is happening. Silent backoff left the user staring at a stale
        // error with no hint that every new attempt was being turned away.
        fireBackoffUntil = Date.now() + 10 * 60e3
        lastRefusal = { at: Date.now(), error: r.error || 'refused' }
        console.warn('[superlazy] background run refused:', r.error)
        await tick()
        // `refused` lets the button fall back to an in-tab run (mailTools.checkInBackground): a
        // configuration refusal means the job path is closed, not that there is nothing to do.
        return { ...r, refused: true }
      } else {
        lastRefusal = null
      }
      await tick()
      return r
    } finally {
      firing = false
    }
  }

  // Should the page ask for another run right now?
  function wantsRun (lock, lastRun) {
    if (st.mode !== 'on') return false
    if (authExpired) return false // signed out — every start would 401; the strip says to re-login
    if (firing || Date.now() < fireBackoffUntil) return false
    if (lock) return false // something is already processing — never stack runs
    // The last run stopped on something ENVIRONMENTAL (a busy local connector, a rate limit, the
    // network): re-firing at once just hits the same wall — and on 2026-09-12 it did so five times
    // in eight minutes, burning the retry cap of every queued item. Give it a moment first.
    if (lastRun && lastRun.failure && isEnvironmentalFailure(lastRun.failure.reason) &&
        (Date.now() - Number(lastRun.finished_at)) < ENVIRONMENTAL_BACKOFF_MS) return false
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false
    // A run that stopped on its time budget left work behind: drain it now rather than making the
    // user wait for the next interval (this is what turns a 15-min job into a full backlog catch-up).
    if (lastRun && lastRun.more_pending && Number(lastRun.finished_at) > lastFireAt) return true
    // The last run FAILED (e.g. mail token expired): retry once per page load, immediately.
    // This is the "I reconnected my mailbox, refresh should recheck" path — a failed stamp is
    // never cleared by anything except a newer run, so the retry is what heals it. Once per
    // mount: a genuinely-still-broken run just refreshes the stamp and waits for the interval.
    if (!retriedFailureOnLoad && lastRun && lastRun.ok === false) {
      retriedFailureOnLoad = true
      return true
    }
    return (Date.now() - Math.max(Number(st.lastCheck) || 0, lastFireAt)) >= pollMs()
  }

  async function tick ({ force = false } = {}) {
    if (stopped) return
    // signed out: stand down to the slow cadence (see AUTH_EXPIRED_POLL_MS above) — except when
    // the user just came back to the tab (force), the moment a re-login is most likely
    if (authExpired) {
      const sinceProbe = Date.now() - lastAuthProbeAt
      if (sinceProbe < (force ? AUTH_FORCE_PROBE_MIN_MS : AUTH_EXPIRED_POLL_MS)) return
    }
    let lock = null
    let settings = null
    try {
      if (authExpired) lastAuthProbeAt = Date.now()
      // Settings FIRST, on its own: it is the one read every mode needs, and if the sign-in is
      // dead it is the only 401 this tick produces — the other reads never start. Only once it
      // succeeds do the lock and account-warning reads go out (in parallel, as before).
      settings = await persist.readSettings()
      ;[lock, accountWarnings] = await Promise.all([persist.readRunLock(), persist.readAccountWarnings ? persist.readAccountWarnings() : []])
      // The reads work, so the session is alive — clear a previous expiry (the user re-logged in
      // from another tab; this page can quietly resume without a reload).
      authExpired = null
    } catch (e) {
      // persist swallows ordinary read errors and only rethrows auth expiry — but check anyway
      // rather than assume, so a future rethrow of some other error can't masquerade as a logout.
      if (isAuthExpiredError(e)) {
        authExpired = { at: authExpired ? authExpired.at : Date.now(), error: (e && e.message) || 'sign-in expired' }
        lastAuthProbeAt = Date.now()
      }
      /* otherwise keep the last known status; try again next tick */
    }

    const lastRun = (settings && settings.bg_last_run) || st.lastRun || null
    const lastCheck = Number(settings && settings.newmail_last_check) || st.lastCheck || 0
    st = { ...st, lastRun, lastCheck }

    const stalled = !!(lock && Number(lock.expires_at) < Date.now())
    const active = !!lock && !stalled

    if (onStatus) {
      onStatus({ accountWarnings, active, stalled, lock: lock || null, lastRun, lastCheck, mode: st.mode, starting: firing, refusal: lastRefusal, authExpired, cleanupRun: (settings && settings.cleanup_last_run) || null, settings: settings || null })
    }

    // "A run finished" fires on EITHER signal, because neither alone is reliable: a short run can
    // start and end between two 10s polls (so we never see its lock), and an in-tab run writes no
    // bg_last_run at all (so only the lock clearing marks it).
    const runStamp = lastRun ? Number(lastRun.finished_at) || 0 : 0
    const newRunLanded = runStamp > lastSeenRunAt && (Number(lastRun.processed) > 0 || Number(lastRun.notes_drained) > 0)
    const lockJustCleared = sawActiveLock && !lock
    if (runStamp > lastSeenRunAt) lastSeenRunAt = runStamp
    sawActiveLock = active
    if ((newRunLanded || lockJustCleared) && onLanded) onLanded(lastRun)

    if (wantsRun(lock, lastRun)) runNow({ ifStale: true }).catch(() => {})
  }

  timer = setInterval(() => { tick().catch(() => {}) }, STATUS_POLL_MS)
  const onVisible = () => { if (document.visibilityState === 'visible') tick({ force: true }).catch(() => {}) }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  tick().catch(() => {})

  return {
    tick,
    runNow,
    getState: () => st,
    setState: (next) => { st = { ...st, ...next } },
    stop () {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    }
  }
}
