// mailTools.js — the SHARED mail controls + the single background poller, mounted on every page:
//   [Check Messages]  [All Accounts ▾]        ← in the title row (topbar.js renders the slots)
//   "Mail was checked 10 min ago"          ← the small grey note under the title
//   ⏳ Background check: 8/12 …            ← the status strip (processingNotice.js) under the bar
//
// THIS PAGE NEVER STARTS A CHECK ON ITS OWN unless background mode is on. That is the deal:
//   MODE ON  — the freezr JOB does the work, so a check can never be interrupted by navigating,
//              and nothing long-running lives in the tab. The page starts runs (hourly schedule +
//              a foreground poll while open) and watches; see backgroundMode.js.
//   MODE OFF — nothing runs unless the user presses a button. The Dashboard asks once on load if
//              mail has gone stale (checkMailPrompt.js); the check then runs IN THIS TAB behind
//              the keep-page-open modal, because closing the tab really would stop it.
//
// Data only reloads when a run actually PROCESSED something — never on a timer, never on tab
// focus. Pages re-render state-preservingly (ui.js keeps expanded cards / scroll), and the strip
// says what landed, so the page is never quietly rearranged under the user.
//
// The ACCOUNT dropdown filters what every page shows, by TWO different keys because the records
// carry different provenance: events by account_id (the connection name), and derived records —
// projects, profiles — by sources: ['email:<address>'] (see persist.sourceTagFor). Both the id and
// the resolved tag are shared across pages via sessionStorage; matchesAccountSource() is the
// predicate pages use for the second kind.

import { runNewMailCheck, startBackgroundRun } from './newMail.js'
import { cleanupDue } from '../jobs/analyze_thread/maintenance/cleanupSchedule.js'
import { lockReleaseHint } from '../jobs/analyze_thread/lockText.js'
import { failureLine } from './failureHint.js'
import { openProcessingModal, updateProcessingModal, finishProcessingModal, closeProcessingModal, setProcessingModalPhase } from './processingModal.js'
import { createStatusStrip } from './processingNotice.js'
import { openCheckMailPrompt, shouldPromptForCheck, clearMailPromptSnooze } from '../pages/checkMailPrompt.js'
import {
  loadBackgroundState, reconcileSchedule, setBackgroundMode, createStatusPoller, agoText
} from './backgroundMode.js'
import { APP_SETTINGS_URL } from '../pages/onboarding.js'
import { agentNameOfAccount } from '../jobs/analyze_thread/config.js'

const FILTER_KEY = 'sl_account_filter' // '' = all accounts; else account_id
const FILTER_TAG_KEY = FILTER_KEY + '_tag'

export function getAccountFilter () {
  try { return window.sessionStorage.getItem(FILTER_KEY) || '' } catch (e) { return '' }
}
// The selected account's SOURCE TAG ('email:<address>'), kept beside the id because the two filters
// need different keys: events carry account_id (the connection name), while derived records
// (projects, profiles) carry sources: ['email:<address>'] — see persist.sourceTagFor.
export function getAccountFilterTag () {
  try { return window.sessionStorage.getItem(FILTER_TAG_KEY) || '' } catch (e) { return '' }
}
function setAccountFilter (v, tag) {
  try {
    if (v) window.sessionStorage.setItem(FILTER_KEY, v); else window.sessionStorage.removeItem(FILTER_KEY)
    if (tag) window.sessionStorage.setItem(FILTER_TAG_KEY, tag); else window.sessionStorage.removeItem(FILTER_TAG_KEY)
  } catch (e) {}
}

/**
 * Does a DERIVED record (project / profile) belong to the selected account?
 * True when no account is selected, and — deliberately — true for a record with NO sources at all:
 * those were written before source tagging existed, so hiding them would empty the page for anyone
 * with history from before. Same convention as the events filter, which shows events with no
 * account_id. Pass the tag in (read once per paint) rather than hitting sessionStorage per record.
 */
export function matchesAccountSource (rec, tag) {
  if (!tag) return true
  const sources = rec && rec.sources
  if (!Array.isArray(sources) || !sources.length) return true
  return sources.includes(tag)
}

function holderText (holder) {
  if (!holder) return 'Mail is being processed elsewhere…'
  const p = holder.progress
  const owner = String(holder.owner || '')
  const who = owner.startsWith('job:') ? 'in the background'
    : owner.startsWith('inspect:') ? 'by the Inspect page (finish or Ignore its pending run)'
      : owner.startsWith('tab:note') ? 'for a just-saved note'
        : 'in another tab'
  // progress may carry counts, a stage line, or neither — never print "undefined"
  const detail = p
    ? (p.done != null && p.total != null
        ? ' — ' + p.done + '/' + p.total + ' · $' + Number(p.cost || 0).toFixed(2) +
          (p.latest && p.latest.subject ? ' · latest: ' + p.latest.subject : '')
        : (p.stage ? ' — ' + p.stage : ''))
    : ''
  return 'Mail is being processed ' + (holder.kind === 'training' ? 'by a history build' : who) +
    detail + ' · last update ' + agoText(holder._date_modified || holder.started_at) +
    (lockReleaseHint(holder) ? ' · ' + lockReleaseHint(holder) : '') + '…'
}

/**
 * @param {Object}   o
 * @param {Object}   o.persist
 * @param {Array}    [o.accounts]       already-loaded account records (e.g. from persist.loadAll)
 *                                      — skips this mount's own accounts query when provided
 * @param {Function} [o.onRefreshed]    reload + re-render this page's data. Called ONLY when a run
 *                                      processed something. MUST preserve view state — it now fires
 *                                      while the user is reading the page.
 * @param {Function} [o.onAccountChange](accountId|'', sourceTag|'') — sourceTag filters projects/people
 * @param {boolean}  [o.allowInTab]     this page may run the IN-TAB flow with the keep-open modal
 *                                      (Dashboard only; other pages point the user there)
 * @param {boolean}  [o.promptWhenStale] show the mode-off prompt on load (Dashboard only)
 * @returns {Object} { checkForNewMail, checkInBackground, state, poller, stop }
 */
// Accounts a tab run could not list (expired token etc.) — appended to the result note so a run
// that processed everything else still says which account it skipped (2026-10-04).
const acctNote = (res) => (res && Array.isArray(res.accountErrors) && res.accountErrors.length)
  ? ' ⚠ Not checked: ' + res.accountErrors.map(e => e.account_id + ' — ' + e.message).join('; ')
  : ''

export async function mountMailTools ({
  persist, accounts: presetAccounts = null, onRefreshed = null, onAccountChange = null, allowInTab = false, promptWhenStale = false
} = {}) {
  const tools = document.getElementById('topbarTools')
  const note = document.getElementById('topbarNote')
  if (!tools || !note) return null

  let checking = false        // an IN-TAB run is under way in this page
  let stopRequested = false
  let state = null
  let poller = null

  tools.textContent = ''
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'sl-mailbtn'
  btn.textContent = 'Check Messages'
  btn.style.display = 'none' // revealed once we know which mode we are in
  tools.appendChild(btn)

  // "Check ONE" — process exactly one message then stop. The quality-testing control: judge each
  // analysis on its own without cancelling a full run, at the honest single-message price (the
  // cache is skipped for one-call runs — full input beats paying the write premium).
  const oneBtn = document.createElement('button')
  oneBtn.type = 'button'
  oneBtn.className = 'sl-mailbtn sl-mailbtn-one'
  oneBtn.textContent = 'Check ONE'
  oneBtn.title = 'Process just the next unhandled email, then stop — for judging analyses one at a time'
  oneBtn.style.display = 'none'
  tools.appendChild(oneBtn)

  // Inspect — the debug page: analyse messages with full wire visibility (request, reply,
  // tokens, cache traffic, cost) and decide per run whether to save. Always available.
  // const inspectLink = document.createElement('a')
  // inspectLink.className = 'sl-mailbtn sl-mailbtn-inspect'
  // inspectLink.textContent = '🔍 Inspect'
  // inspectLink.href = '/apps/com.salmanff.superlazy/inspect'
  // inspectLink.title = 'Analyse the next message(s) with the full request/response shown — nothing is saved until you say so'
  // tools.appendChild(inspectLink)

  const sel = document.createElement('select')
  sel.className = 'sl-acctsel'
  sel.title = 'Choose the account you are viewing — filters the projects, people, Recent and Events on every page. Records analysed before per-account tracking existed always show.'
  tools.appendChild(sel)

  const setNote = (t) => { note.textContent = t || '' }

  // the clean-up results bar: opening it marks the run SEEN in the shared settings, so it goes away on
  // every page and device at once
  const strip = createStatusStrip({
    onCheckNow: () => checkForNewMail(),
    onCleanupSeen: (run) => persist.stampSettingsFields({ cleanup_last_run: { ...run, seen: true, seen_at: Date.now() } })
  })
  // BACKGROUND MODE OFF: nothing hourly is running, so a due weekly clean-up is started from the first
  // page that notices — still as the background JOB (it runs for minutes; a tab may close). Asked once
  // per page load; the job itself re-checks the schedule and stamps the attempt, so two tabs cannot
  // both run it.
  let cleanupFiredThisLoad = false
  function maybeStartDueCleanup (status) {
    if (cleanupFiredThisLoad || !state || state.mode === 'on' || !state.capable || !status || status.active || !status.settings) return
    if (!cleanupDue(status.settings).due) return
    cleanupFiredThisLoad = true
    startBackgroundRun({ freezr, task: 'cleanup' }).catch(() => {}) // the clean-up only — mode off means no background MAIL checks
  }

  // ---- accounts dropdown -----------------------------------------------------------------
  let accounts = Array.isArray(presetAccounts) ? presetAccounts : []
  if (!Array.isArray(presetAccounts)) {
    try { accounts = (await freezr.query('accounts', {}, { count: 50 })) || [] } catch (e) { accounts = [] }
  }
  const all = document.createElement('option'); all.value = ''; all.textContent = 'All Accounts'
  sel.appendChild(all)
  for (const a of accounts) {
    const o = document.createElement('option')
    o.value = a.account_id || ''
    // a Slack workspace's login email is usually the SAME address as a mail account — say which
    // channel each row is, or two identical-looking rows filter completely differently
    // an AGENT account is named by its agent (Claude Code / Codex), never by an address: its
    // me_email is the user's mail address and says nothing about which agent ran the sessions
    o.textContent = a.channel === 'work'
      ? '🤖 ' + agentNameOfAccount(a)
      : (a.channel === 'messages' ? '💬 Slack — ' : '✉ ') + (a.account_email || a.account_id || '(account)')
    // two stores of the same agent (say two Claude folders) would read identically — say which
    if (a.channel === 'work') o.title = agentNameOfAccount(a) + ' — file store “' + (a.account_id || '') + '”'
    sel.appendChild(o)
  }
  // the provenance tag this account's records carry (persist.sourceTagFor semantics):
  // mail tags by ADDRESS, messaging by CONNECTION NAME — the address would collide with mail's
  const tagOf = (id) => {
    const a = accounts.find(x => (x.account_id || '') === id)
    if (!a) return ''
    if (a.channel === 'messages') return 'slack:' + (a.account_id || '')
    if (a.channel === 'work') return 'agents:' + (a.account_id || '')
    const e = String(a.account_email || '').trim().toLowerCase()
    return e ? 'email:' + e : ''
  }
  sel.value = getAccountFilter()
  if (sel.value !== getAccountFilter()) { setAccountFilter('', ''); sel.value = '' } // stored id no longer exists
  else setAccountFilter(sel.value, tagOf(sel.value)) // refresh the tag (it may never have been stored)
  sel.style.display = accounts.length ? '' : 'none' // shown even with one account — the concept stays visible
  sel.addEventListener('change', () => {
    setAccountFilter(sel.value, tagOf(sel.value))
    if (onAccountChange) onAccountChange(sel.value, tagOf(sel.value))
  })

  // ---- the two check paths ------------------------------------------------------------------

  // MODE ON: hand the work to the job and return immediately. Progress arrives via the poller, so
  // the user is free to navigate — the run is not tied to this page in any way.
  async function checkInBackground () {
    // a background run belongs to the server, not this page — no keep-open modal, and close any
    // that an earlier in-tab run left standing (it would read as "this page is still working")
    closeProcessingModal()
    setNote('Asking the background job to check your mail…')
    const r = await poller.runNow({ task: 'auto', manual: true })   // the button: no 30-min quiet wait for in-progress agent turns
    if (r.started) { setNote('Background check started — progress appears below.'); return r }
    // The job REFUSED (grant revoked, un-trusted after a re-install, compute gone) while this page
    // still believed mode was on. The user pressed the button for a reason: run it here instead,
    // exactly as an install without the permission does — mail, Slack and agent activity alike —
    // and flip this page to in-tab so the next press goes straight there.
    if (r.refused && allowInTab) {
      state = { ...state, mode: 'off', capable: false, reason: r.error || 'the background job refused to start' }
      paintButton()
      return checkInTab({ fallbackFrom: r.error || 'the background job refused to start' })
    }
    setNote('⚠ Could not start the background check: ' + (r.error || 'unknown error') + '.' +
      (r.refused ? ' Press Check Messages on the Dashboard to run it in that tab instead.' : ''))
    return r
  }

  // MODE OFF: run it here, behind the keep-open modal. Blocking by nature — the analysis happens
  // in this tab, so closing the page really does stop it mid-message.
  async function checkInTab ({ onlyOne = false, fallbackFrom = null } = {}) {
    if (checking) return
    checking = true
    stopRequested = false
    btn.disabled = true
    oneBtn.disabled = true
    clearMailPromptSnooze()

    // Be explicit about WHY this is running here. Background mode resolves to OFF whenever the job
    // cannot actually run (no run_job grant, job not trusted, no compute) — and that silent
    // downgrade is indistinguishable from "the user chose in-tab", which made a keep-open modal
    // appear when they believed they were running in the background.
    setNote(fallbackFrom
      ? '⚠ The background job refused to start (' + fallbackFrom + ') — checking mail and agent activity in THIS TAB instead; keep the page open.'
      : (state && state.capable === false
        ? '⚠ Background jobs unavailable (' + (state.reason || 'not runnable on this server') + ') — checking mail and agent activity in THIS TAB; keep the page open.'
        : 'Checking mail and agent activity in this tab (background mode is off) — keep the page open…'))
    let modalUp = true
    openProcessingModal({
      kind: 'newmail',
      phase: 'checking',
      backgroundCapable: !!(state && state.capable),
      settingsHref: APP_SETTINGS_URL,
      onStop: () => { stopRequested = true }
    })
    try {
      const data = await persist.loadAll() // fresh snapshot for the ingestion stores
      const res = await runNewMailCheck({
        freezr,
        persist,
        data,
        maxMessages: onlyOne ? 1 : 0,
        manual: true, // only the two buttons reach checkInTab: agent turns still in progress are analysed now (no 30-min quiet wait)
        onPlanned: ({ total, estLow, estHigh, overThreshold }) => {
          setNote(overThreshold
            ? '⚠ ' + total + ' new message(s) — estimated $' + estLow.toFixed(2) + '–$' + estHigh.toFixed(2) + '. Processing (Stop is in the dialog)…'
            : total + ' new message(s) — processing…')
          setProcessingModalPhase('processing')
          updateProcessingModal({ done: 0, total, cost: 0 })
        },
        onProgress: (p) => {
          // Deliberately NOT refreshing the page mid-run: the modal carries the progress. Data is
          // reloaded once, at the end, so the view is rearranged exactly once.
          setNote('Processing ' + p.done + '/' + p.total + ' — $' + p.cost.toFixed(4) +
            (p.stage ? ' · ' + p.stage : (p.latest && p.latest.subject ? ' · ' + p.latest.subject : '')))
          updateProcessingModal(p)
        },
        shouldStop: () => stopRequested
      })
      const at = new Date().toLocaleTimeString()
      if (res.skipped) {
        closeProcessingModal(); modalUp = false
        setNote(res.holder || /elsewhere/.test(res.skipped) ? holderText(res.holder) : 'Check skipped — ' + res.skipped + '.')
      } else if (!res.planned) {
        closeProcessingModal(); modalUp = false
        setNote('Nothing new in mail, Slack or agent activity (checked ' + at + ').' + acctNote(res))
      } else {
        // res.failure = a run STOPPED by an error (no credit, expired mail token, network drop). The
        // message it stopped on is recorded as errored and processed first next time, so the honest
        // report is "stopped, here is why", never a bare "N pending".
        const summary = onlyOne && !res.done
          ? 'Checked ONE: processed 1 of ' + res.planned + ' pending ($' + Number(res.cost || 0).toFixed(4) +
            ') — ' + res.remaining + ' still waiting. Press “Check ONE” again for the next.'
          : res.planned + ' new message(s)' + (res.retried ? ' (' + res.retried + ' retried after an earlier failure)' : '') + ': ' +
            (res.done
              ? 'all processed ($' + Number(res.cost || 0).toFixed(4) + ')'
              : (res.planned - res.remaining) + ' processed, ' + res.remaining + ' pending' +
                (res.failure
                  ? '. ' + failureLine(res.failure)
                  : (res.lockLost ? ' (another process took over)' : (stopRequested ? ' (stopped)' : ''))))
        setNote(summary + ' — checked ' + at + '.' + acctNote(res))
        if (modalUp) finishProcessingModal(summary + '.', res.done)
        strip.announceLanded({ processed: res.planned - res.remaining, cost: res.cost, remaining: res.remaining, more_pending: !res.done })
        if (onRefreshed) await onRefreshed()
      }
    } catch (e) {
      const msg = '⚠ ' + ((e && e.message) || e) + ' — press “Check Messages” to resume.'
      setNote(msg)
      if (modalUp) finishProcessingModal(msg, false)
      else closeProcessingModal()
    } finally {
      checking = false
      btn.disabled = false
      oneBtn.disabled = false
      poller.tick().catch(() => {})
    }
  }

  // The one entry point the pages call. Routes to whichever path this mode uses.
  async function checkForNewMail () {
    if (!state) return
    if (state.mode === 'on') return checkInBackground()
    if (allowInTab) return checkInTab()
    setNote('In-tab processing runs on the Dashboard (it keeps the page open while working) — check mail there.')
  }

  // ---- wire the mode in ----------------------------------------------------------------------

  function paintButton () {
    btn.style.display = ''
    // Check ONE is retired from the UI (user, 2026-08-25) — the Inspect page owns one-at-a-time
    // debugging. checkInTab({ onlyOne }) stays for it; the button never shows.
    oneBtn.style.display = 'none'
    if (state.mode === 'on') {
      btn.textContent = 'Check Messages'
      btn.title = 'Ask the background job to check mail, Slack and agent activity now (safe to keep browsing)'
    } else if (allowInTab) {
      btn.textContent = 'Check Messages'
      btn.title = 'Check mail, Slack and agent activity and process it in this tab (keep the page open while it works)'
    } else {
      btn.textContent = 'Check Messages'
      btn.title = 'Checking runs on the Dashboard while background mode is off'
    }
  }

  async function turnBackgroundOn () {
    state = await setBackgroundMode({ persist, on: true })
    poller.setState(state)
    paintButton()
    setNote('Background checking is on — SuperLazy will keep itself up to date.')
    poller.tick().catch(() => {})
  }

  state = await loadBackgroundState({ persist })
  state = await reconcileSchedule(state)

  poller = createStatusPoller({
    persist,
    state,
    onStatus: (status) => {
      strip.render(status, { mode: state.mode, allowInTab })
      strip.renderCleanup(status.cleanupRun)
      maybeStartDueCleanup(status)
      // The topbar note is the quiet, always-there line; the strip carries the loud stuff.
      if (!checking && !status.active) {
        setNote(status.lastCheck ? 'Last checked ' + agoText(status.lastCheck) : 'No check has run yet this session.')
      }
    },
    onLanded: (lastRun) => {
      strip.announceLanded(lastRun)
      if ((Number(lastRun && lastRun.processed) > 0 || Number(lastRun && lastRun.notes_drained) > 0) && onRefreshed) {
        Promise.resolve(onRefreshed()).catch(e => console.error('refresh after background run failed', e))
      }
    }
  })

  paintButton()
  btn.addEventListener('click', () => { checkForNewMail().catch(e => console.error('mail check failed', e)) })
  oneBtn.addEventListener('click', () => { checkInTab({ onlyOne: true }).catch(e => console.error('mail check failed', e)) })

  // MODE OFF on the Dashboard: ask once, explicitly, if mail has gone stale. Never auto-runs.
  if (promptWhenStale && shouldPromptForCheck({ mode: state.mode, lastCheck: state.lastCheck })) {
    openCheckMailPrompt({
      lastCheck: state.lastCheck,
      capable: !!state.capable,
      onTurnOnBackground: () => { turnBackgroundOn().catch(e => console.error(e)) }
    }).then(yes => { if (yes) checkForNewMail().catch(e => console.error('mail check failed', e)) })
  }

  return {
    checkForNewMail,
    checkInBackground,
    poller,
    getState: () => state,
    stop () { poller.stop(); strip.remove() }
  }
}
