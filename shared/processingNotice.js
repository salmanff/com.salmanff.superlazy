// processingNotice.js — the background-status STRIP under the top bar, on every page.
//
// Pure renderer: it holds no timer and reads nothing itself. mailTools.js owns the single poller
// (backgroundMode.createStatusPoller) and pushes status in here. It used to poll the run lock on
// its own, which meant every page ran TWO overlapping pollers telling slightly different stories.
//
// What it says, by situation:
//   signed out       — the sign-in expired (identity layer or freezr); reload to log in again
//   processing now   — live progress from the run lock (works for a job run, an in-tab run, or a
//                      run started in another tab/device — they all touch the same lock)
//   just finished    — what landed, so an auto-refreshed page never changes under the user
//                      without a word of explanation
//   stalled          — the holder died mid-run; point at the recovery
//   mail expired     — the connector needs re-authorising; nothing will work until it is
//   stopped on error — a run processed some mail then hit a wall (no LLM credit, offline); what to do
//   mode off + idle  — the standing reminder that nothing is checking mail but this button

import { failureHint } from './failureHint.js'

const RESOURCES_URL = '/account/resources'
const APP_SETTINGS_URL = '/account/app/settings/' + ((typeof freezrMeta !== 'undefined' && freezrMeta.appName) || 'com.salmanff.superlazy')
const APP_PATH = '/apps/' + ((typeof freezrMeta !== 'undefined' && freezrMeta.appName) || 'com.salmanff.superlazy')

// How long a "✓ 12 messages processed" note stays before the strip goes quiet again.
const LANDED_NOTE_MS = 45000

const agoText = (ms) => {
  const n = Number(ms) || 0
  if (!n) return 'never'
  const s = Math.max(0, Math.round((Date.now() - n) / 1000))
  if (s < 90) return s + 's ago'
  if (s < 5400) return Math.round(s / 60) + ' min ago'
  if (s < 172800) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86400) + 'd ago'
}

// Who opens the clean-up results when the bar is clicked. The shell (which has the task handlers and
// the review modal's styles) installs a modal opener; any other page falls back to the /cleanup page
// with the run pre-selected.
let cleanupResultsOpener = null
export function setCleanupResultsOpener (fn) { cleanupResultsOpener = typeof fn === 'function' ? fn : null }

const fmtWhen = (ms) => {
  try { return new Date(Number(ms)).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) } catch (e) { return '' }
}

export function createStatusStrip ({ onCheckNow = null, onCleanupSeen = null } = {}) {
  let host = null
  let bar = null      // the clean-up RESULTS bar — above the strip, stays until clicked
  let barRunKey = null
  let landedUntil = 0
  let landedText = ''

  // THE STRIP ALWAYS OCCUPIES ITS LINE (user, 2026-09-16). It used to be display:none until it
  // had something to say, so every background run shoved the whole page down when it started and
  // yanked it back up when it finished — while you were reading or reaching for a checkbox. It
  // now keeps a one-line box at all times and merely goes invisible (index.css .su-notice-blank),
  // so appearing and disappearing costs no layout. The host is built EAGERLY for the same reason:
  // created on first use, the very first notice of the session would still jolt.

  function ensureHost () {
    if (host && host.isConnected) return host
    host = document.createElement('div')
    host.className = 'su-processing-notice su-notice-blank' // reserved, invisible, until painted
    const topbar = document.getElementById('topbar')
    if (topbar) topbar.insertAdjacentElement('afterend', host)
    else document.body.prepend(host)
    return host
  }

  // "nothing to say" is a STATE OF THE BOX, not its absence — see the note above.
  const hide = () => {
    if (!host) return
    host.className = 'su-processing-notice su-notice-blank'
    host.textContent = ''
  }

  ensureHost() // claim the line now, so the session's FIRST notice costs no layout either

  function paint (cls, build) {
    const h = ensureHost()
    h.className = 'su-processing-notice' + (cls ? ' ' + cls : '')
    h.textContent = ''
    build(h)
  }

  const text = (h, t) => h.appendChild(document.createTextNode(t))
  // the work-in-progress spinner (freezr_core.css) — mail checks and clean-ups alike
  const spinner = (h) => { const s = document.createElement('span'); s.className = 'freezr-spinner su-notice-spinner'; h.appendChild(s) }

  /**
   * The clean-up RESULTS bar (2026-09-27): shown when the last full clean-up was run by the background
   * job and has not been opened yet (settings.cleanup_last_run.seen === false). It sits ON TOP of the
   * yellow strip and does not go away on its own — clicking it marks the run seen and opens the
   * results. The cost is shown so the user can judge the next run.
   */
  function renderCleanup (run) {
    const show = !!(run && run.seen === false)
    const key = run ? String(run.run_id || '') + ':' + String(run.finished_at || '') : null
    if (!show) { if (bar) { bar.remove(); bar = null; barRunKey = null } return }
    if (bar && bar.isConnected && barRunKey === key) return
    const h = ensureHost()
    if (!bar || !bar.isConnected) {
      bar = document.createElement('div')
      h.insertAdjacentElement('beforebegin', bar)
    }
    barRunKey = key
    bar.className = 'su-cleanup-bar' + (run.failure ? ' su-cleanup-bar-fail' : '')
    bar.textContent = ''
    const cost = Number(run.cost) ? ' · $' + Number(run.cost).toFixed(2) : ''
    const msg = run.failure
      ? '⚠ The clean-up (' + fmtWhen(run.started_at) + ') did not complete: ' + run.failure + cost + '. '
      : '🧹 The clean-up ran ' + fmtWhen(run.finished_at) + ': ' + (run.suggestions || 0) + ' suggestion' + (run.suggestions === 1 ? '' : 's') +
        (run.attention ? ', ' + run.attention + ' need your attention' : '') + cost + (run.incomplete ? ' (the reply was cut short)' : '') + '. '
    text(bar, msg)
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'sl-mailbtn'
    b.textContent = run.failure ? 'Dismiss' : 'See the results'
    bar.appendChild(b)
    const open = () => {
      if (bar) { bar.remove(); bar = null }
      if (onCleanupSeen) Promise.resolve(onCleanupSeen(run)).catch(() => {})
      if (run.failure || !run.run_id) return
      if (cleanupResultsOpener) cleanupResultsOpener(run)
      else window.location.href = APP_PATH + '/cleanup?run=' + encodeURIComponent(run.run_id)
    }
    bar.addEventListener('click', open)
  }

  function link (h, href, label) {
    const a = document.createElement('a')
    a.href = href
    a.textContent = label
    h.appendChild(a)
    return a
  }

  function button (h, label, title, onClick) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'sl-mailbtn'
    b.textContent = label
    if (title) b.title = title
    b.addEventListener('click', onClick)
    h.appendChild(b)
    return b
  }

  // Announce a finished run. Called by mailTools the moment the poller reports one landed, so the
  // strip and the (state-preserving) page refresh tell the same story at the same time.
  function announceLanded (lastRun) {
    const n = Number(lastRun && lastRun.processed) || 0
    if (!n) return
    landedText = '✓ ' + n + ' message' + (n === 1 ? '' : 's') + ' processed' +
      (Number(lastRun.cost) ? ' ($' + Number(lastRun.cost).toFixed(4) + ')' : '') +
      (lastRun.more_pending ? ' · ' + lastRun.remaining + ' still queued — continuing' : '') +
      ' — this page has been updated.'
    landedUntil = Date.now() + LANDED_NOTE_MS
  }

  /**
   * @param {Object} status  from backgroundMode.createStatusPoller's onStatus
   * @param {Object} opts    { mode, allowInTab } — how to word the idle / mode-off cases
   */
  function render (status, opts = {}) {
    const { active, stalled, lock, lastRun, lastCheck, refusal, authExpired } = status || {}
    const mode = (status && status.mode) || opts.mode || 'off'

    // The sign-in died (e.g. the identity layer in front of freezr timed out while the page sat
    // idle) — every api call 401s, so everything below would be guesswork built on stale reads.
    // This outranks every other state, and the fix is a reload: that walks back through the
    // identity provider's login and freezr's, after which checking resumes on its own.
    if (authExpired) {
      paint('su-notice-warn', (h) => {
        text(h, '⚠ Your sign-in has expired' + (mode === 'on' ? ' — background mail checks are paused' : '') +
          '. Reload this page to sign in again' + (mode === 'on' ? '; checking resumes automatically' : '') + '. ')
        button(h, 'Sign in again', 'Reload the page to go through sign-in again', () => window.location.reload())
      })
      return
    }

    const accountWarnings = (status && status.accountWarnings) || []
    if (accountWarnings.length) {
      // a missing / outdated PERMISSION is fixed on the app's settings page, not by reconnecting
      // the account (user, 2026-09-27: the Slack warning sent them to the wrong page)
      const isPerm = (a) => /permission/i.test(String(a.message || ''))
      const permOnly = accountWarnings.every(isPerm)
      paint('su-notice-warn', (h) => {
        text(h, '⚠ Could not fully fetch messages: ' + accountWarnings.map(a => a.account_id + ': ' + a.message).join(' · ') + ' ')
        if (accountWarnings.some(isPerm)) link(h, APP_SETTINGS_URL, 'Grant the permission in superlazy’s settings')
        if (!permOnly) { if (accountWarnings.some(isPerm)) text(h, ' · '); link(h, RESOURCES_URL, 'Check or reconnect your accounts') }
        if (onCheckNow) button(h, 'Check again', 'Retry fetching messages', () => onCheckNow())
      })
      return
    }

    // A failed bg_last_run is only cleared by the NEXT job run — so after the user fixes the
    // cause (reconnects the mailbox), the stamp lingers until a run lands. Any check that
    // COMPLETED after the failure (in-tab or job — both stamp newmail_last_check on the way out)
    // outranks it: treat the old failure as history, not as the current state.
    const stampSuperseded = !!(lastRun && Number(lastCheck) > Number(lastRun.finished_at) + 5000)
    const failureIsStale = !!(lastRun && lastRun.ok === false && stampSuperseded)

    if (active) {
      const p = lock && lock.progress
      const owner = String((lock && lock.owner) || '')
      const kind = lock && lock.kind
      // the lock's KIND says what is running — a clean-up blocks mail checks, so say which it is
      const who = kind === 'cleanup' ? 'Clean-up running' + (owner.startsWith('job:') ? ' in the background' : '') + ' — mail checks wait until it finishes'
        : kind === 'project_review' ? 'Reviewing a project — mail checks wait until it finishes'
          : kind === 'audit' ? 'Applying clean-up changes'
            : owner.startsWith('job:') ? 'Background check'
              : owner.startsWith('inspect:') ? 'Inspect page'
                : owner.startsWith('tab:note') ? 'Note' : 'Mail processing'
      // a lock's progress may carry counts, a stage line, or neither — never print "undefined"
      // the STAGE wins over the latest subject: with batching, "sent 10 emails to the AI together"
      // is the honest description of a long quiet stretch, where one subject looks stuck
      const detail = p
        ? (p.done != null && p.total != null
            ? ' — ' + p.done + '/' + p.total + ' · $' + Number(p.cost || 0).toFixed(2) +
              (p.stage ? ' · ' + p.stage : (p.latest && p.latest.subject ? ' · ' + p.latest.subject : ''))
            : (p.stage ? ' — ' + p.stage : ' — in progress…'))
        : ' — starting…'
      paint('su-notice-busy', (h) => {
        spinner(h)
        text(h, who + (lock && lock.kind === 'training' ? ' (building history)' : '') + detail)
      })
      return
    }

    if (stalled) {
      const p = lock && lock.progress
      paint('su-notice-warn', (h) => {
        text(h, '⚠ Mail processing stalled' + (p && p.done != null && p.total != null ? ' at ' + p.done + '/' + p.total : '') +
          ' (last update ' + agoText(lock && (lock._date_modified || lock.started_at)) + '). ')
        link(h, APP_PATH + '/setup', 'Force resync on Setup & Prefs')
        text(h, ' to take over.')
      })
      return
    }

    // The job REFUSED to start (not trusted after a re-install, grant revoked, nowhere to run) —
    // the most actionable state there is, and previously invisible: runs were silently turned
    // away while an old error stayed on screen.
    if (refusal && refusal.error) {
      paint('su-notice-warn', (h) => {
        text(h, '⚠ Background checks can’t start: ' + refusal.error +
          '. If you just re-installed the app, an admin needs to re-trust its job (Admin → Trusted Jobs); otherwise check the grants in ')
        link(h, '/account/app/settings/' + ((typeof freezrMeta !== 'undefined' && freezrMeta.appName) || 'com.salmanff.superlazy'), 'app settings')
        text(h, '.')
      })
      return
    }

    // A dead mail connection blocks everything — say so above any other idle state, with the
    // direct retest: reconnect, press the button, and a clean run replaces this stamp.
    if (lastRun && lastRun.token_expired && !failureIsStale) {
      paint('su-notice-warn', (h) => {
        text(h, '⚠ ' + (lastRun.message || 'Mail access has expired.') + ' ')
        link(h, RESOURCES_URL, 'Reconnect your mail account')
        if (onCheckNow) button(h, 'Check again', 'Run a check now to confirm the reconnection worked', () => onCheckNow())
      })
      return
    }

    // A run that was STOPPED by an error mid-way. Note ok === true: the messages before the failure
    // really were processed, so this is not a failed run — but it needs the user to do something
    // (top up credit, get back online) and it outranks the "results landed" note for exactly that
    // reason. The failed message itself is already queued first for the next run.
    if (lastRun && lastRun.failure && !stampSuperseded) {
      const reason = lastRun.failure.reason || 'an error'
      paint('su-notice-warn', (h) => {
        text(h, '⚠ Mail processing stopped after ' + (lastRun.processed || 0) + ' of ' + (lastRun.planned || 0) +
          ' message(s): ' + reason + ' ' + (failureHint(reason) || 'Fix that, then retry.') + ' ')
        if (onCheckNow) button(h, 'Retry', 'Run a check now — the message that failed is processed first', () => onCheckNow())
      })
      return
    }

    // An account the run could not LIST (an expired mail token, a provider error). The other
    // accounts were processed (2026-10-04 — before, this failed the whole run), so name the one
    // that was not and hand over the reconnect link.
    if (lastRun && Array.isArray(lastRun.account_errors) && lastRun.account_errors.length && !stampSuperseded) {
      paint('su-notice-warn', (h) => {
        text(h, '⚠ Not checked this run: ' + lastRun.account_errors.map(e => e.account_id + ' — ' + e.message).join('; ') +
          '. Your other accounts were processed normally. ')
        const re = lastRun.account_errors.find(e => e.reauth_url)
        link(h, re ? re.reauth_url : '/account/resources', re ? 'Reconnect ' + re.account_id : 'Open your connections')
        if (onCheckNow) { text(h, ' '); button(h, 'Retry', 'Run a check now', () => onCheckNow()) }
      })
      return
    }

    // An agent store the job could not read. The run itself is fine (mail was processed), which
    // is exactly why it needs its own line: "No new mail" would otherwise pass for a quiet day.
    if (lastRun && Array.isArray(lastRun.form_errors) && lastRun.form_errors.length && !stampSuperseded) {
      paint('su-notice-warn', (h) => {
        text(h, '⚠ Agent activity not read: ' + lastRun.form_errors.map(e => e.account_id + ' — ' + e.message).join('; ') +
          '. Background checks reach local stores only when the server allows in-process jobs through its localhost gate; ' +
          'until then check from a tab on localhost. ')
        if (onCheckNow) button(h, 'Retry', 'Run a check now', () => onCheckNow())
      })
      return
    }

    if (Date.now() < landedUntil) {
      paint('su-notice-ok', (h) => text(h, landedText))
      return
    }

    if (lastRun && !lastRun.ok && lastRun.error && !failureIsStale) {
      paint('su-notice-warn', (h) => {
        text(h, '⚠ The last background check failed: ' + lastRun.error + ' ')
        if (onCheckNow) button(h, 'Retry', 'Run a check now', () => onCheckNow())
      })
      return
    }

    if (mode === 'off') {
      // Standing reminder. Nothing is checking mail in this mode, so the strip is the only thing
      // stopping it silently going stale — it stays put rather than auto-hiding.
      paint('su-notice-idle', (h) => {
        text(h, 'Background checking is off — mail was last checked ' + agoText(lastCheck) + '. ')
        if (opts.allowInTab && onCheckNow) {
          button(h, 'Check messages now', 'Check for new messages and process them in this tab', () => onCheckNow())
        } else {
          link(h, APP_PATH + '/index', 'Check from the Dashboard')
        }
      })
      return
    }

    hide()
  }

  return {
    render,
    announceLanded,
    renderCleanup,
    remove () { if (host) host.remove(); host = null; if (bar) bar.remove(); bar = null }
  }
}
