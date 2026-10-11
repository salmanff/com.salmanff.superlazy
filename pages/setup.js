// setup.js — entry point for the SETUP & PREFS page. States:
//   1. use_mail or use_llm not granted → welcome + "grant it" link
//   2. granted but no mail account     → welcome + "connect an account" link
//   3. fresh install, accounts         → welcome + ONE-account picker + window + model
//   4. the run                         → SuperLazy reads that window of mail in ONE pass and shows
//                                        what it understood: situation, projects with their open
//                                        items, people, senders not worth reading, and its own
//                                        questions. The user corrects it (as many rounds as they
//                                        like, each re-reading the mail from the provider cache),
//                                        and NOTHING is written until they press save.
//   5. saved / returning user          → STATUS tab (per-account state, forget, force resync) and
//                                        PREFERENCES tab.
//
// Setting up is therefore ONE big AI call plus corrections, not hundreds of per-message ones: it
// costs a fraction, it sees the whole picture at once (which is what makes the projects coherent),
// and the user can judge the result before committing to it. The per-message engine takes over
// from the moment this finishes — see adopt.js for the cursor that hands work across.
//
// NEW MAIL is NOT handled here — the dashboard checks for it (newMail.js) on load + button.

import { DEFAULT_HISTORY_DAYS, DEFAULT_THREAD_CONTEXT_DAYS } from '../jobs/analyze_thread/config.js'
import { sourceForId, sourceFromAccounts } from '../shared/sourceFactory.js'
import { configureEmailViewer } from '../shared/emailViewer.js'
import { createPersistence, sourceTagFor } from '../jobs/analyze_thread/persist.js'
import { runNewMailCheck, startBackgroundRun } from '../shared/newMail.js'
import { failureLine } from '../shared/failureHint.js'
import { populateModelSelect, selectedModel, priceLabel } from '../shared/modelPicker.js'
import { CONTEXT_CHOICES, DEFAULT_CONTEXT_CHARS } from '../jobs/analyze_thread/assemble.js'
import { getPermissionState, getBackgroundCapability, APP_SETTINGS_URL, RESOURCES_URL } from './onboarding.js'
import { loadBackgroundState } from '../shared/backgroundMode.js'
import { openProcessingModal, updateProcessingModal, finishProcessingModal } from '../shared/processingModal.js'
import { buildDump } from '../jobs/bootstrap/dumpBuilder.js'
import { runBootstrap, refineBootstrap, resumeBootstrap } from '../jobs/bootstrap/bootstrapCall.js'
import { adoptBootstrap } from '../jobs/bootstrap/adopt.js'
import {
  el, setPhase, setBusy, setElapsed, setCost, renderDumpStats, showDumpPreview, jumpToDumpMessage,
  resetResults, applySection, showRawJson, renderDiag, startProgress, readAnswers,
  showResume, hideResume, takeCorrections, clearCorrections, addCorrection,
  activateTab, activateSub, setMapComplete, waiveQuestions, refreshAnswersBtn, setDeclaredMe,
  noteSent
} from './bootstrapUi.js'
import { setStatus } from '../shared/ui.js'
import { setWelcomeLead, showOnboarding, showView, showTab } from './setupUi.js'
import { renderResourceList, renderResourceDetail } from './statusTab.js'
import { renderPrefsForm } from './prefsTab.js'
import { renderRulesTab } from './rulesTab.js'
import { renderConnectedTab } from './connectedTab.js'
import { renderSlackChannels } from './slackChannelsUi.js'
import { renderWorkSessions } from './workSessionsUi.js'
import { agentNameFor } from '../jobs/analyze_thread/workSource.js'
import { listFsConnections } from '../jobs/analyze_thread/sessionsSource.js'
import { renderTopBar } from '../shared/topbar.js'

renderTopBar('setup')

const persist = createPersistence(freezr)

// DEV CONSOLE COMMANDS (type in this page's console). superlazy.audit(true[, days]) records every
// LLM exchange the engine makes — verbatim requests, replies, usage, prices — for the Request Audit
// Lab page (requestauditlab); superlazy.audit(false) stops. Records age out after `days` (default 3).
globalThis.superlazy = Object.assign(globalThis.superlazy || {}, {
  audit: async (on = true, days) => {
    const fields = { llm_audit: !!on }
    if (Number(days) > 0) fields.llm_audit_days = Math.min(30, Math.max(1, Math.round(Number(days))))
    await persist.stampSettingsFields(fields)
    console.info('[superlazy] request audit ' + (on ? 'ON' : 'OFF') + (fields.llm_audit_days ? ' · kept ' + fields.llm_audit_days + ' days' : '') +
      ' — see ' + location.origin + '/apps/com.salmanff.superlazy/requestauditlab')
    return fields
  }
})
console.info('[superlazy] dev: superlazy.audit(true) records every LLM request for the Request Audit Lab; superlazy.audit(false) stops. Page: ' +
  location.origin + '/apps/com.salmanff.superlazy/requestauditlab')
const lc = (s) => String(s || '').trim().toLowerCase()

let source = null
let accounts = []          // from source.listAccounts() (the picker)
let existing = null        // persist.loadAll() result
let currentSettings = null
let statusRows = []
let selectedAccountId = null
let running = false
let bgCap = { available: false }

// the setup run's own state — one account, one map, as many correction rounds as the user wants
const run = {
  account: null,
  meSet: new Set(),
  days: DEFAULT_HISTORY_DAYS,
  dump: null,
  conversation: null,
  latest: null,
  runSeq: 0,
  refineSeq: 0,
  totalCost: 0,
  calls: 0,
  busy: false,
  stopRequested: false,
  stoppedOrFailed: false,
  saved: false
}

// ---- the picker: ONE account -------------------------------------------------------------------
// One at a time, deliberately. Every downstream decision — whose mail is "yours", which addresses
// are team, what the cursor means — is per account, and mixing two mailboxes into one first pass
// blurs all three. The second account is set up the same way afterwards, from the Status tab.

function chosenAccount () {
  const picked = document.querySelector('.bs-acc:checked')
  if (!picked) return null
  return accounts.find((a) => a.account_id === picked.value) || null
}

function meSetFor (acct) {
  const set = new Set()
  if (acct && acct.account_email) set.add(lc(acct.account_email))
  return set
}

function paintMeLine () {
  const a = chosenAccount()
  const me = [...meSetFor(a)]
  el('meLine').textContent = me.length
    ? 'Mail to or from ' + me.join(', ') + ' counts as yours. Other addresses of yours are picked up from the mail itself, for you to confirm.'
    : 'Pick the mailbox SuperLazy should learn.'
  el('startSetupBtn').disabled = !me.length
}

function renderAccountRadios () {
  const wrap = el('accounts')
  wrap.textContent = ''
  if (!accounts.length) { wrap.textContent = 'no connected accounts found'; return }
  const stored = new Map(((existing && existing.accounts) || []).map((r) => [r.account_id, r]))
  for (const a of accounts) {
    const label = document.createElement('label')
    label.className = 'bs-acclabel'
    const rb = document.createElement('input')
    rb.type = 'radio'
    rb.name = 'setupAccount'
    rb.className = 'bs-acc'
    rb.value = a.account_id
    rb.checked = accounts.length === 1 && !stored.has(a.account_id)
    rb.addEventListener('change', paintMeLine)
    label.appendChild(rb)
    const done = stored.get(a.account_id)
    label.appendChild(document.createTextNode(' ' + (a.account_email || a.account_id) +
      (done && done.backfill_done ? ' — already set up' : '')))
    wrap.appendChild(label)
  }
  paintMeLine()
}

// ---- the run bar ------------------------------------------------------------------------------

const runLabel = () => 'run ' + run.runSeq + ' · ' + run.days + 'd · ' + (run.dump ? run.dump.stats.messages : 0) + ' emails'

function setButtons () {
  const wantsRestart = !run.latest || run.stoppedOrFailed
  el('startBtn').hidden = !run.busy && !wantsRestart
  el('startBtn').disabled = run.busy
  el('startBtn').textContent = run.latest ? 'Read & analyse again' : 'Read & analyse my mail'
  el('stopBtn').disabled = !run.busy
  el('stopBtn').hidden = !run.busy
  if (!run.busy) el('sendAnswersBtn').disabled = !run.conversation || !refreshAnswersBtn()
}

function addSpend (meta) {
  run.totalCost += (meta && meta.cost && meta.cost.totalCost) || 0
  run.calls++
  setCost(run.totalCost, run.calls)
}

function settleCall ({ label, started, r, e, stats }) {
  const meta = (r && r.meta) || (e && e.meta) || null
  if (meta) {
    addSpend(meta)
    renderDiag({ label, meta, durationMs: Date.now() - started, stats: stats || null })
  }
  return (meta && meta.cost && meta.cost.totalCost) || 0
}

function adopt (r) {
  run.conversation = r.conversation || run.conversation
  run.latest = r.output
  showRawJson(r.output)
  setMapComplete(!r.incomplete)
  run.stoppedOrFailed = !!r.incomplete
  if (r.incomplete) {
    showResume((r.failure ? 'It stopped part-way: ' + r.failure : 'It ran out of room before finishing.') +
      ' Everything above did arrive and is kept — it can carry on from exactly there.')
  } else {
    hideResume()
  }
}

const mapSummary = (o) => o.projects.length + ' projects · ' +
  o.projects.reduce((n, p) => n + (p.todos || []).length, 0) + ' open items · ' +
  o.profiles.length + ' people · ' + o.autofile_candidates.length + ' senders to skip'

// ---- setup step 1: fetch the window ------------------------------------------------------------

async function buildWindow () {
  const acct = run.account
  const days = Math.max(2, parseInt(el('days').value, 10) || DEFAULT_HISTORY_DAYS)
  run.days = days
  run.meSet = meSetFor(acct)
  setDeclaredMe(run.meSet)

  run.busy = true
  run.stopRequested = false
  run.stoppedOrFailed = false
  run.dump = null
  run.conversation = null
  run.latest = null
  run.refineSeq = 0
  clearCorrections()
  setButtons()
  setBusy(true)
  const t0 = Date.now()
  const tick = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000)
    setElapsed(s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's')
  }, 1000)
  try {
    run.dump = await buildDump({
      source,
      accountInfos: [acct],
      historyDays: days,
      meSet: run.meSet,
      seedContext: el('seed').value,
      onProgress: (p) => setPhase('Fetching your mail…', p.total ? (p.stage + ' — ' + p.done + ' of ' + p.total) : p.stage),
      shouldStop: () => run.stopRequested
    })
    renderDumpStats(run.dump.stats)
    showDumpPreview(run.dump.text)
    const s = run.dump.stats
    setPhase('Mail ready', s.messages + ' emails over ' + days + ' days' +
      (s.degraded ? ' (trimmed to fit: ' + s.degraded + ')' : '') + ' — starting the analysis…', 'ok')
    return true
  } catch (e) {
    setPhase('Could not read your mail', (e && e.message) || String(e), 'error')
    run.stoppedOrFailed = true
    return false
  } finally {
    clearInterval(tick)
    setBusy(false)
    run.busy = false
    setButtons()
  }
}

// ---- setup step 2: the one big call ------------------------------------------------------------

async function startRun () {
  if (run.busy) return
  const ok = await buildWindow()
  if (ok && !run.stopRequested) await analyse()
}

async function analyse () {
  if (run.busy || !run.dump) return
  run.busy = true
  run.stopRequested = false
  setButtons()
  const started = Date.now()
  run.runSeq++
  run.refineSeq = 0
  resetResults()
  clearCorrections()
  const prog = startProgress('first pass')
  try {
    const r = await runBootstrap({
      freezr,
      dumpText: run.dump.text,
      maps: run.dump.maps,
      model: selectedModel(el('model')),
      onSection: (s) => { prog.onSection(); applySection(s, run.dump.maps, { onJump: jumpToDumpMessage }) },
      onDelta: prog.onDelta,
      onThinking: prog.onThinking,
      onContinue: (n) => prog.note('(ran out of room — asking for the rest, ' + n + ')')
    })
    prog.stop()
    const cost = settleCall({
      label: runLabel() + ' · pass 1' + (r.turns > 1 ? ' +' + (r.turns - 1) + ' cont.' : ''),
      started,
      r,
      stats: run.dump.stats
    })
    adopt(r)
    setPhase(r.incomplete ? 'Partly done' : 'Done — please review',
      mapSummary(r.output) + ' · $' + cost.toFixed(4) +
      (r.incomplete ? ' — it stopped early; use “Continue where it stopped”.' : ' · nothing is saved yet — read it through and correct anything wrong.'),
      r.incomplete ? 'error' : 'ok')
  } catch (e) {
    prog.stop()
    settleCall({ label: runLabel() + ' · pass 1 FAILED', started, e })
    run.stoppedOrFailed = true
    setPhase('That did not work', ((e && e.message) || e) + '', 'error')
    if (e && e.raw) { el('rawJson').textContent = String(e.raw); activateTab('raw'); activateSub('output') }
  } finally {
    run.busy = false
    setButtons()
  }
}

async function refine () {
  if (run.busy || !run.conversation || !run.dump) return
  run.busy = true
  setButtons()
  const started = Date.now()
  run.refineSeq++
  const pendingFetches = (run.latest && run.latest.fetch_requests) || []
  const answers = readAnswers()
  const notes = takeCorrections()
  const typed = el('freeText').value
  const freeText = [typed, ...notes].filter((x) => x && x.trim()).join('\n')
  // it is sent now, so it stops being editable input and becomes a record (see noteSent)
  noteSent([...(typed.trim() ? [typed.trim()] : []), ...notes,
    ...answers.filter((a) => a.answer && a.answer.trim()).map((a) => (a.question || a.id) + ' → ' + a.answer.trim())])
  el('freeText').value = ''
  resetResults()
  const prog = startProgress('correction round ' + run.refineSeq)
  try {
    const r = await refineBootstrap({
      freezr,
      conversation: run.conversation,
      maps: run.dump.maps,
      model: selectedModel(el('model')),
      editedContext: el('contextEdit').value,
      answers,
      freeText,
      fetchRequests: pendingFetches,
      resolveBody: (realMsgId) => run.dump.fullBodies[realMsgId] || null,
      onSection: (s) => { prog.onSection(); applySection(s, run.dump.maps, { onJump: jumpToDumpMessage }) },
      onDelta: prog.onDelta,
      onThinking: prog.onThinking,
      onContinue: (n) => prog.note('(ran out of room — asking for the rest, ' + n + ')')
    })
    prog.stop()
    const cost = settleCall({ label: runLabel() + ' · corrections ' + run.refineSeq, started, r })
    adopt(r)
    clearCorrections()
    setPhase(r.incomplete ? 'Partly redone' : 'Updated — review again',
      mapSummary(r.output) + ' · $' + cost.toFixed(4) +
      (r.incomplete ? ' — it stopped early; use “Continue where it stopped”.' : ' · correct anything still wrong, or save and start using SuperLazy.'),
      r.incomplete ? 'error' : 'ok')
  } catch (e) {
    prog.stop()
    settleCall({ label: runLabel() + ' · corrections ' + run.refineSeq + ' FAILED', started, e })
    const last = run.conversation[run.conversation.length - 1]
    if (last && last.role === 'user') run.conversation.pop()
    for (const n of notes) addCorrection(n)
    setPhase('Corrections did not go through', ((e && e.message) || e) + ' — your notes are kept; try again.', 'error')
  } finally {
    run.busy = false
    setButtons()
  }
}

async function resumeRun () {
  if (run.busy || !run.conversation || !run.latest) return
  run.busy = true
  setButtons()
  hideResume()
  const started = Date.now()
  const prog = startProgress('continuing')
  try {
    const r = await resumeBootstrap({
      freezr,
      conversation: run.conversation,
      maps: run.dump.maps,
      model: selectedModel(el('model')),
      seedOutput: run.latest,
      onSection: (s) => { prog.onSection(); applySection(s, run.dump.maps, { onJump: jumpToDumpMessage }) },
      onDelta: prog.onDelta,
      onThinking: prog.onThinking,
      onContinue: (n) => prog.note('(still short — asking again, ' + n + ')')
    })
    prog.stop()
    const cost = settleCall({ label: runLabel() + ' · continued', started, r })
    adopt(r)
    setPhase(r.incomplete ? 'Still incomplete' : 'Done — please review',
      mapSummary(r.output) + ' · $' + cost.toFixed(4), r.incomplete ? 'error' : 'ok')
  } catch (e) {
    prog.stop()
    settleCall({ label: runLabel() + ' · continue FAILED', started, e })
    setPhase('Could not continue', ((e && e.message) || e) + ' — what you have is unchanged.', 'error')
    showResume('Could not continue: ' + ((e && e.message) || e))
  } finally {
    run.busy = false
    setButtons()
  }
}

// ---- setup step 3: SAVE — the map becomes the app's stores --------------------------------------

// The save is several writes in a row, each of which can be slow on a big map. Show them as a
// checklist rather than one spinner: if it ever stops half way, what did land is on screen.
const SAVE_STEPS = [
  { key: 'projects', label: 'Projects and their open items' },
  { key: 'people', label: 'People profiles' },
  { key: 'autofile', label: 'Senders to stop reading' },
  { key: 'mail', label: 'The emails your items were found in' },
  { key: 'settings', label: 'Your situation and preferences' },
  { key: 'account', label: 'Where new mail starts from' }
]

function paintSaveSteps (current, done, total) {
  const host = el('saveSteps')
  host.textContent = ''
  const at = SAVE_STEPS.findIndex((s) => s.key === current)
  SAVE_STEPS.forEach((s, i) => {
    const li = document.createElement('li')
    const finished = at > i || (at === i && total && done >= total)
    li.className = 'bs-savestep' + (finished ? ' bs-savestep-done' : (at === i ? ' bs-savestep-doing' : ''))
    const mark = document.createElement('span')
    mark.className = 'bs-savestep-mark'
    mark.textContent = finished ? '✓' : (at === i ? '·' : ' ')
    li.appendChild(mark)
    li.appendChild(document.createTextNode(s.label +
      (at === i && total > 1 ? ' — ' + done + ' of ' + total : '')))
    host.appendChild(li)
  })
  // the bar counts finished stages plus the fraction of the one in flight
  const frac = at < 0 ? 0 : (at + (total ? Math.min(1, done / total) : 1)) / SAVE_STEPS.length
  el('saveProgressFill').style.width = Math.round(frac * 100) + '%'
}

async function saveMap () {
  if (run.busy || !run.latest || run.saved) return

  // RE-RUNNING SETUP on an account that already has data. Adoption mints ids PAST whatever is
  // stored, so saving on top would leave two sets of projects for one mailbox — silently, and with
  // no way to tell them apart afterwards. Offer the only sensible resolutions: replace what this
  // account taught SuperLazy, or stop. (Other accounts are untouched either way — deleteAccountData
  // removes only records this account is the sole source of.)
  const prior = ((existing && existing.accounts) || []).find((a) => a.account_id === run.account.account_id)
  if (prior) {
    const who = run.account.account_email || run.account.account_id
    const ok = window.confirm('SuperLazy has already been set up for ' + who + '.\n\n' +
      'Saving now REPLACES what it learned from this mailbox: its projects, people and auto-file ' +
      'senders are removed first, then this new map is saved in their place.\n\n' +
      'Anything your other accounts taught it is kept, as are your hand-edits to people and to-dos ' +
      'that other accounts also touched.\n\nReplace?')
    if (!ok) return
    run.busy = true
    setBusy(true)
    setPhase('Clearing the previous setup…', 'removing what ' + who + ' taught SuperLazy')
    try {
      await persist.deleteAccountData({
        accountId: run.account.account_id,
        sourceTag: sourceTagFor({ account_email: run.account.account_email || run.account.account_id }),
        keepLearnedSenders: false, // they are re-proposed by this very map — keeping them duplicates
        onProgress: (what, i, n) => setPhase('Clearing the previous setup…', what + ' ' + i + '/' + n)
      })
      existing = await persist.loadAll()
    } catch (e) {
      run.busy = false
      setBusy(false)
      setPhase('Could not clear the previous setup', ((e && e.message) || e) + ' — nothing was changed.', 'error')
      return
    }
    run.busy = false
  }

  run.busy = true
  el('adoptBtn').disabled = true
  el('skipQBtn').hidden = true
  el('saveProgress').hidden = false
  paintSaveSteps(null, 0, 0)
  setBusy(true)
  setPhase('Saving…', 'writing your projects, people and settings')
  try {
    // the user's edit of the situation text wins over the model's wording
    const map = { ...run.latest, business_context: el('contextEdit').value || run.latest.business_context }
    const counts = await adoptBootstrap({
      persist,
      map,
      account: {
        account_id: run.account.account_id,
        account_email: run.account.account_email,
        provider: run.account.provider,
        source_id: source && source.id
      },
      meSet: run.meSet,
      window: {
        fromMs: run.dump.stats.fromMs,
        newestMs: run.dump.stats.newestMs,
        messages: run.dump.stats.messages,
        threads: run.dump.stats.threads,
        days: run.days
      },
      model: selectedModel(el('model')),
      cost: run.totalCost,
      existing,
      // real message dates, so items are dated by the email that raised them, not by this moment
      msgDates: run.dump.maps.msgDate,
      msgMeta: run.dump.maps.msgMeta,
      partialThreadIds: run.dump.maps.partialThreadIds,
      onProgress: ({ stage, done, total }) => {
        paintSaveSteps(stage, done, total)
        setPhase('Saving…', (SAVE_STEPS.find((x) => x.key === stage) || { label: stage }).label +
          (total > 1 ? ' — ' + done + ' of ' + total : ''))
      }
    })
    run.saved = true
    setBusy(false)
    paintSaveSteps('done', 1, 1)
    setPhase('Saved — SuperLazy is ready',
      counts.projects + ' project(s), ' + counts.todos + ' open item(s), ' + counts.profiles + ' person profile(s), ' +
      counts.autofile + ' auto-file sender(s) and the ' + counts.cited + ' email(s) your items were found in. ' +
      'New mail from here on is picked up on the dashboard.', 'ok')
    el('bannerMsg').textContent = 'Saved. Everything from here is ordinary running: new mail is analysed as it arrives.'
    el('adoptBtn').textContent = 'Open my dashboard →'
    el('adoptBtn').disabled = false
    el('adoptBtn').onclick = () => { window.location.href = '/apps/com.salmanff.superlazy/index' }
    // CHAIN: a Slack workspace or agent store saved while the mailbox bootstrapped is read NOW, in
    // one chronological pass, instead of waiting for the next check (user, 2026-09-11). The
    // dashboard auto-redirect would cut that read off, so it is held while a chain runs — the
    // "Open my dashboard" button stays live throughout.
    try { existing = await persist.loadAll() } catch (e2) {}
    if (unreadChannelAccounts().length) {
      readAllChannelsNow().catch(e2 => console.warn('[superlazy] read after bootstrap failed:', e2 && e2.message))
    } else {
      setTimeout(() => { window.location.href = '/apps/com.salmanff.superlazy/index' }, 2500)
    }
  } catch (e) {
    setBusy(false)
    setPhase('Could not save', ((e && e.message) || e) +
      ' — the ticked steps above did land; pressing save again rewrites them in place rather than duplicating.', 'error')
    el('adoptBtn').disabled = false
  } finally {
    run.busy = false
  }
}

function stopRun () {
  run.stopRequested = true
  run.stoppedOrFailed = true
  setPhase('Stopping…', 'finishing the current step')
}

// ---- entering the run view ---------------------------------------------------------------------

async function beginSetup () {
  const acct = chosenAccount()
  if (!acct) return
  run.account = acct
  showView('progress')
  // "Delete processed data & start over" belongs to the setup form and the status page, not under
  // a run that has not written anything yet — Stop is the control that matters here.
  el('wipeZone').style.display = 'none'
  setPhase('Ready', 'Reading ' + (acct.account_email || acct.account_id) + ' — this takes a few minutes on a busy mailbox.', 'ok')
  setButtons()
  await startRun()
}

// ---- status & preferences page -----------------------------------------------------------------

  // the post-save offer, shared by every channel section on this tab: analyse now (foreground,
  // progress visible) or leave it to the background job / next check
// mount the channel module for a Slack / work row inside its detail panel; its Save gets the same
// "analyse now / in the background / later" offer the old Channels tab made
// After a channel source is saved: a source that has never been read starts its FIRST READ right
// here (foreground, progress in the modal — the Save button said so); a trained source just repaints
// (its changes are picked up by the next check). user, 2026-09-09: "there was no way of actually
// running the initial training".
// Channel accounts = everything that is not a mailbox: Slack workspaces and agent stores. Mail is
// excluded on purpose — a mailbox's first read is the bulk BOOTSTRAP (one reviewed pass), and the
// idea of folding it into the chronological read is a potential project in pipeline-backlog.md.
const isChannelAccount = (a) => !!a && a.account_id && a.channel && a.channel !== 'mail'
const isUnreadChannelAccount = (a) => isChannelAccount(a) && !(Number(a.cursor) > 0) && !(Number(a.last_sync_ms) > 0)
const unreadChannelAccounts = () => (((existing && existing.accounts) || []).filter(isUnreadChannelAccount).map(a => a.account_id))

// What "Read data" will read, for the note beside the button: EVERY channel account — a never-read
// one gets its first read, an interrupted or caught-up one continues from its cursor (so a read
// stopped midway is always restartable; a caught-up one simply yields nothing).
function channelReadTargets () {
  return (((existing && existing.accounts) || []).filter(isChannelAccount)).map(a => ({
    id: a.account_id,
    label: a.channel === 'work' ? agentNameFor(a.provider) + ' — ' + a.account_id : 'Slack — ' + (a.account_email || a.account_id),
    state: isUnreadChannelAccount(a) ? 'first read' : 'continues where it stopped'
  }))
}

// SAVE and READ are separate (user, 2026-09-11). "Save selection" is local to one store and only
// saves. "Read data" reads ALL channel accounts in ONE chronological pass — the composite source
// sorts the merged queue oldest-first, so Claude turns, Codex turns and Slack chunks interleave in
// the order they happened. Pressed during a run it is QUEUED and starts when that run ends, never
// silently dropped (the old combined button hit the `running` guard and did nothing).
let readQueued = false
async function readAllChannelsNow () {
  try { existing = await persist.loadAll() } catch (e) {}
  const ids = channelReadTargets().map(t => t.id)
  if (!ids.length) { setStatus('Nothing to read — no Slack workspace or agent store is saved yet.', 'info'); return }
  if (running) {
    readQueued = true
    setStatus('A run is in progress — the read of ' + ids.join(', ') + ' will start as soon as it finishes.', 'info')
    return
  }
  setStatus('Reading ' + ids.join(' and ') + (ids.length > 1 ? ' in one chronological pass' : '') + '…', 'info')
  return runChannelTraining({
    accountIds: ids,
    onDone: async ({ ok, summary }) => { try { existing = await persist.loadAll() } catch (e) {}; await refreshStatusRows(); setStatus(summary, ok ? 'ok' : 'error') }
  })
}
// at any run's end: a read requested meanwhile starts now
async function afterRunEnd () {
  if (!readQueued || running) return
  readQueued = false
  return readAllChannelsNow()
}

// Save is save-only. The module's own note tells the user to press "Read data" or wait for the
// next check; this just refreshes the page's view.
async function afterChannelSave (rec) {
  try { existing = await persist.loadAll() } catch (e) {}
  await refreshStatusRows()
  const neverRead = !(Number(rec.last_sync_ms) > 0 || Number(rec.cursor) > 0)
  setStatus(neverRead
    ? 'Saved — ' + (rec.account_id || 'the source') + ' is not read yet: press “Read data” to read now, or leave it for the next check.'
    : 'Saved — the next check reads the changes.', 'ok')
}

function mountChannelDetail (host, row) {
  const common = { freezr, persist, storedAccounts: (existing && existing.accounts) || [], onSaved: afterChannelSave, onReadAll: readAllChannelsNow, readTargets: channelReadTargets }
  if (row.channel === 'messages') renderSlackChannels(host, { ...common, connectionName: row.account_id })
  else if (row.channel === 'work') renderWorkSessions(host, { ...common, settings: currentSettings || {}, only: row.account_id })
}

function paintStatusRows () {
  // nothing selected yet → the first source, so the right panel is never empty on arrival
  if (!selectedAccountId && statusRows.length) selectedAccountId = statusRows[0].account_id
  renderResourceList(el('resourceList'), statusRows, {
    selected: selectedAccountId,
    onSelect: (row) => { selectedAccountId = row.account_id; paintStatusRows() }
  })
  renderResourceDetail(el('resourceDetail'), statusRows.find((r) => r.account_id === selectedAccountId) || null, {
    mountChannel: mountChannelDetail,
    onForceResync: (row, ui) => forceResync(row, ui),
    defaultHistoryDays: (currentSettings && currentSettings.history_days) || DEFAULT_HISTORY_DAYS,
    defaultThreadDays: (currentSettings && currentSettings.thread_context_days != null) ? currentSettings.thread_context_days : DEFAULT_THREAD_CONTEXT_DAYS,
    defaultModel: (currentSettings && currentSettings.default_model) || null,
    defaultContextChars: (currentSettings && currentSettings.analysis_context_chars) || DEFAULT_CONTEXT_CHARS,
    // Setting up a NEWLY connected account is the same one-pass read as the first one — the form's
    // history/model choices are read off the setup view, so send the user there rather than
    // starting a different kind of run behind a different button.
    onTrain: (row) => setUpAnotherAccount(row),
    // "Read it now" on a SAVED channel account (Slack / work sessions) runs the first read right
    // here in the foreground, like the Channels tab's "Analyse now"; anything else goes to setup
    onContinue: (row, opts) => (row.state === 'saved' && row.channel && row.channel !== 'mail')
      ? readSavedChannelNow(row, opts)
      : setUpAnotherAccount(row),
    onTogglePause: toggleSyncPaused,
    onForget: forgetAccount
  })
}

// Pause / resume syncing for one account: a flag on its stored record (accounts.sync_paused)
// that ingest.js resolveAccounts honours for every kind of check. The record object is the one
// held in `existing.accounts`, so mutating it keeps the page's own view current; the save is a
// full-record upsert, exactly like the processor's cursor bumps.
async function toggleSyncPaused (row) {
  const rec = row && row.rec
  if (!rec) return
  const pausing = !rec.sync_paused
  const who = row.account_email || row.account_id
  const before = { sync_paused: rec.sync_paused, sync_paused_at: rec.sync_paused_at }
  rec.sync_paused = pausing
  rec.sync_paused_at = pausing ? Date.now() : null
  try {
    await persist.saveAccount(rec)
    setStatus(pausing
      ? 'Paused ' + who + ' — the checks skip it until you resume. Nothing already learned is affected.'
      : 'Resumed ' + who + ' — the next check picks up from where it stopped.', 'ok')
  } catch (e) {
    Object.assign(rec, before)
    setStatus('Could not ' + (pausing ? 'pause' : 'resume') + ' ' + who + ': ' + ((e && e.message) || e), 'error')
  }
  row.paused = !!rec.sync_paused
  paintStatusRows()
}

// A stored account's state for the Status tab. 'saved' = the record exists (a channel selection
// was saved) but NO check has ever read it — nothing started, nothing to "continue"; 'training' =
// a first read began and stopped short (user, 2026-09-08: a fresh work account read as
// "started but not finished — 0 processed", which was simply wrong).
function accountState (rec) {
  if (!rec) return 'not_started'
  if (rec.backfill_done) return 'trained'
  const touched = Number(rec.cursor) > 0 || Number(rec.last_sync_ms) > 0 || Number(rec.messages_processed) > 0 || Number(rec.messages_skipped) > 0 || Number(rec.messages_failed) > 0
  return touched ? 'training' : 'saved'
}

// "Read it now" on a saved channel account: stamp the chosen first-read window on the record
// (formation never reads past backfill_from), then run the first read in the foreground.
async function readSavedChannelNow (row, { historyDays } = {}) {
  try {
    const rec = row.rec
    if (rec && Number(historyDays) > 0) {
      rec.history_days = Number(historyDays)
      rec.backfill_from = Date.now() - Number(historyDays) * 24 * 3600 * 1000
      await persist.saveAccount(rec)
    }
  } catch (e) {
    setStatus('Could not save the window: ' + ((e && e.message) || e), 'error')
    return
  }
  return runChannelTraining({ onDone: () => refreshStatusRows().catch(() => {}) })
}

function setUpAnotherAccount (row) {
  // Slack and agent-session sources are set up in their own detail panel on the Status tab
  if (row.channel === 'work' || row.channel === 'messages' || (row.rec && (row.rec.channel === 'work' || row.rec.channel === 'messages'))) {
    selectedAccountId = row.account_id
    showTab('status')
    paintStatusRows()
    return
  }
  const acct = accounts.find((a) => a.account_id === row.account_id) ||
    { account_id: row.account_id, account_email: row.account_email, provider: row.provider }
  showView('welcome')
  showOnboarding('setup')
  renderAccountRadios()
  const rb = document.querySelector('.bs-acc[value="' + acct.account_id + '"]')
  if (rb) { rb.checked = true; paintMeLine() }
  setStatus('Setting up ' + (acct.account_email || acct.account_id) + ' — it is read the same way as your first account.', 'info')
}

async function refreshStatusRows () {
  let connected = []
  try {
    connected = ((await source.listAccounts()) || {}).accounts || []
  } catch (e) {
    console.error('[superlazy] could not list accounts for status:', e && e.message)
  }
  accounts = connected.length ? connected : accounts
  const stored = new Map((existing.accounts || []).map((r) => [r.account_id, r]))
  const stateOf = (rec, conn) => (conn && conn.status && conn.status !== 'ok') ? 'creds_expired' : (rec ? accountState(rec) : 'not_started')
  // mail accounts (the mail source's listing)
  statusRows = connected.map((a) => {
    const rec = stored.get(a.account_id) || null
    return {
      account_id: a.account_id, label: a.account_email || (rec && rec.account_email) || a.account_id,
      account_email: a.account_email || (rec && rec.account_email) || '',
      provider: a.provider || (rec && rec.provider) || '', sub: a.provider || (rec && rec.provider) || 'mail',
      channel: 'mail', state: stateOf(rec, a), paused: !!(rec && rec.sync_paused), rec
    }
  })
  // Slack workspaces (messaging connections)
  try {
    if (freezr.connections && freezr.connections.messaging) {
      const res = await freezr.connections.messaging.listAccounts()
      for (const a of ((res && res.accounts) || []).filter(a => (a.services || []).includes('messaging'))) {
        const rec = stored.get(a.connectionName) || null
        statusRows.push({
          account_id: a.connectionName, label: a.connectionName, account_email: a.account_email || (rec && rec.account_email) || '',
          provider: a.provider || 'slack', sub: (a.provider || 'slack') + (a.account_email ? ' · ' + a.account_email : ''),
          channel: 'messages', state: stateOf(rec, a), paused: !!(rec && rec.sync_paused), rec
        })
      }
    }
  } catch (e) { console.warn('[superlazy] could not list messaging connections for status:', e && e.message) }
  // AI coding-agent stores (file-system connections)
  try {
    for (const a of await listFsConnections(freezr)) {
      const rec = stored.get(a.connectionName) || null
      const agent = rec && rec.provider ? agentNameFor(rec.provider) : null
      statusRows.push({
        account_id: a.connectionName, label: a.connectionName, account_email: (rec && rec.account_email) || '',
        provider: (rec && rec.provider) || 'agent', sub: agent ? agent + ' sessions' : 'agent sessions (local file store)',
        channel: 'work', state: stateOf(rec, a), paused: !!(rec && rec.sync_paused), rec
      })
    }
  } catch (e) { console.warn('[superlazy] could not list file stores for status:', e && e.message) }
  // stored records no listing knows (archive-trained accounts, removed connections)
  for (const [id, rec] of stored) {
    if (!statusRows.some((r) => r.account_id === id)) {
      statusRows.push({ account_id: id, label: rec.account_email || id, account_email: rec.account_email, provider: rec.provider, sub: (rec.provider || '') + ' · connection not found', channel: rec.channel || 'mail', state: accountState(rec), paused: !!rec.sync_paused, rec })
    }
  }
  paintStatusRows()
}

async function savePrefs (fields) {
  const modeBefore = (currentSettings && currentSettings.background_mode) || 'auto'
  currentSettings = { ...(currentSettings || {}), ...fields }
  try {
    await persist.saveSettings(currentSettings)
    if (fields.background_mode && fields.background_mode !== modeBefore && freezr.jobs) {
      try {
        if (fields.background_mode === 'on') await freezr.jobs.schedule('analyze_thread')
        else await freezr.jobs.unschedule('analyze_thread')
      } catch (e) {
        console.warn('[superlazy] could not update the background schedule:', (e && e.message) || e)
      }
    }
    setStatus('Preferences saved.', 'ok')
  } catch (e) {
    setStatus('Could not save preferences: ' + (e.message || e), 'error')
  }
}

async function forgetAccount (row) {
  if (running) return
  const who = row.account_email || row.account_id
  const sure = window.confirm('Forget everything SuperLazy learned from ' + who + '?\n\n' +
    'Deleted: its events, its stored message bodies, its setup record, and the projects/people ' +
    'that ONLY this account taught SuperLazy.\n' +
    'Kept: your other account(s) and anything they also know about; learned newsletter/admin/social ' +
    'senders; your mail itself.\n\n' +
    'Records analysed before per-account tracking was added cannot be attributed, so they are left in place.')
  if (!sure) return
  running = true
  setStatus('Forgetting ' + who + '…', 'info')
  try {
    const tally = await persist.deleteAccountData({
      accountId: row.account_id,
      sourceTag: sourceTagFor({ channel: row.channel || null, account_id: row.account_id, account_email: row.account_email || row.account_id }),
      keepLearnedSenders: true,
      onProgress: (what, i, n) => setStatus('Removing ' + what + ' ' + i + '/' + n + '…', 'info')
    })
    const untagged = tally.projects_untagged + tally.profiles_untagged
    setStatus('Forgot ' + who + ' — ' + tally.events + ' event(s), ' + tally.email_bodies + ' stored message(s), ' +
      tally.projects_deleted + ' project(s) and ' + tally.profiles_deleted + ' person(s) deleted; ' +
      (tally.projects_kept + tally.profiles_kept) + ' shared record(s) kept.' +
      (untagged ? ' ' + untagged + ' older untagged record(s) were left in place.' : '') +
      ' Reloading…', 'ok')
    setTimeout(() => window.location.reload(), 1500)
  } catch (e) {
    setStatus('Could not forget ' + who + ': ' + ((e && e.message) || e), 'error')
  } finally {
    running = false
  }
}

// FOREGROUND channel training — the Slack analogue of the mail bootstrap's visible run: the
// history build happens right here with the processing modal narrating progress (N of M chunks,
// running cost), instead of a background check silently filling the projects (user, 2026-08-30:
// "it went to the project page and started checking background… do the training on foreground,
// just like with mail"). Same engine, same lock, same run as any check — only WATCHED.
async function runChannelTraining ({ statusEl = null, onDone = null, accountIds = null } = {}) {
  if (running) return
  running = true
  const say = (t) => { if (statusEl) statusEl.textContent = t; else setStatus(t, 'info') }
  let stopIt = false
  let modalUp = false
  let summary = ''
  let ok = false
  try {
    say('Reading your tracked conversations…')
    const data = await persist.loadAll()
    const res = await runNewMailCheck({
      freezr,
      persist,
      data,
      accountIds, // a first read started from ONE source's Save reads that source only
      onPlanned: ({ total, estLow, estHigh }) => {
        say(total + ' item(s) to analyse (est $' + estLow.toFixed(2) + '–$' + estHigh.toFixed(2) + ')…')
        modalUp = true
        openProcessingModal({
          kind: 'newmail',
          backgroundCapable: bgCap.available,
          settingsHref: APP_SETTINGS_URL,
          onStop: () => { stopIt = true }
        })
        updateProcessingModal({ done: 0, total, cost: 0 })
      },
      onProgress: (p) => {
        say('Analysing ' + p.done + '/' + p.total + ' — $' + p.cost.toFixed(4) +
          (p.latest && p.latest.subject ? ' · ' + p.latest.subject : ''))
        updateProcessingModal(p)
      },
      shouldStop: () => stopIt
    })
    if (res.skipped) {
      summary = 'Could not start: ' + res.skipped + '.'
    } else if (!res.planned) {
      summary = 'Nothing new to analyse.'
      ok = true
    } else {
      ok = !!res.done
      summary = res.planned + ' item(s): ' + (res.done
        ? 'all analysed ($' + Number(res.cost || 0).toFixed(4) + ').'
        : (res.planned - res.remaining) + ' analysed, ' + res.remaining + ' remaining' +
          (res.failure ? '. ' + failureLine(res.failure) : ' — the next check continues from there.'))
    }
    say(summary)
    if (modalUp) finishProcessingModal(summary, ok)
  } catch (e) {
    summary = 'Training stopped: ' + ((e && e.message) || e)
    say(summary)
    if (modalUp) finishProcessingModal(summary, false)
  } finally {
    running = false
  }
  if (onDone) onDone({ ok, summary })
  // a "Read data" pressed while this ran starts now, not never (afterRunEnd guards re-entry)
  afterRunEnd().catch(e => console.warn('[superlazy] queued read failed:', e && e.message))
}

// "Force resync now": the recovery for a stuck run — steals the lock and processes what is pending.
// Force resync for ONE source (its Sources-tab detail owns the button + info line)
async function forceResync (row, { btn, info } = {}) {
  if (running) { if (btn) btn.disabled = false; return }
  running = true
  btn = btn || { disabled: false }
  info = info || { textContent: '' }
  btn.disabled = true
  info.textContent = 'Taking over any stuck run and checking for pending items on ' + (row.label || row.account_id) + '…'
  let stopForce = false
  let modalUp = false
  try {
    const data = await persist.loadAll()
    const res = await runNewMailCheck({
      freezr,
      persist,
      data,
      force: true,
      accountIds: [row.account_id],
      rescan: true, // deep pending scan: also picks up items an earlier run lost sight of (2026-10-04)
      onPlanned: ({ total, estLow, estHigh }) => {
        info.textContent = total + ' pending item(s) — processing (est $' + estLow.toFixed(2) + '–$' + estHigh.toFixed(2) + ')…'
        modalUp = true
        openProcessingModal({
          kind: 'newmail',
          backgroundCapable: bgCap.available,
          settingsHref: APP_SETTINGS_URL,
          onStop: () => { stopForce = true }
        })
        updateProcessingModal({ done: 0, total, cost: 0 })
      },
      onProgress: (p) => {
        info.textContent = 'Processing ' + p.done + '/' + p.total + ' — $' + p.cost.toFixed(4) +
          (p.latest && p.latest.subject ? ' · ' + p.latest.subject : '')
        updateProcessingModal(p)
      },
      shouldStop: () => stopForce
    })
    if (res.skipped) {
      info.textContent = 'Could not start: ' + res.skipped + '.'
    } else if (!res.planned) {
      info.textContent = 'Nothing pending — all messages are processed (checked ' + new Date().toLocaleTimeString() + ').'
    } else {
      const summary = res.planned + ' message(s)' + (res.retried ? ' (' + res.retried + ' retried after an earlier failure)' : '') + ': ' +
        (res.done
          ? 'all processed ($' + Number(res.cost || 0).toFixed(4) + ').'
          : (res.planned - res.remaining) + ' processed, ' + res.remaining + ' remaining' +
            (res.failure ? '. ' + failureLine(res.failure) : (res.lockLost ? ' — another tab/process took over.' : '.')))
      info.textContent = summary
      if (modalUp) finishProcessingModal(summary, res.done)
    }
    try { existing = await persist.loadAll() } catch (e) {}
    await refreshStatusRows()
  } catch (e) {
    const msg = 'Force resync stopped: ' + ((e && e.message) || e) + ' — press the button again to resume.'
    info.textContent = msg
    if (modalUp) finishProcessingModal(msg, false)
  } finally {
    running = false
    btn.disabled = false
  }
}

async function paintCostSummary () {
  const host = el('costSummary')
  if (!host) return
  const chars = (currentSettings && currentSettings.analysis_context_chars) || DEFAULT_CONTEXT_CHARS
  const level = CONTEXT_CHOICES.find((c) => c.chars === chars)
  const stored = (currentSettings && currentSettings.default_model) || null
  let modelLabel = 'the recommended default'
  let price = null
  try {
    const ping = await freezr.llm.ping()
    const all = Object.values((ping && ping.providers) || {}).flat()
    const m = stored && stored.provider
      ? all.find((x) => x.provider === stored.provider && x.family === stored.family)
      : all.find((x) => x.provider === ping.defaultProvider && x.family === ping.defaultFamily)
    if (m) {
      modelLabel = m.provider + ' · ' + m.family + (stored && stored.provider ? '' : ' (recommended default)')
      price = priceLabel(m.pricing)
    }
  } catch (e) { /* no keys / offline — still show what is configured */ }
  host.textContent = ''
  host.appendChild(document.createTextNode('Analysing your mail with ' + modelLabel +
    (price ? ' — ' + price : '') +
    ' · context per email: ' + (level ? level.label : chars.toLocaleString() + ' chars') + '. '))
  const a = document.createElement('button')
  a.type = 'button'
  a.className = 'su-linkish'
  a.textContent = 'Change the AI or the cost'
  a.addEventListener('click', () => { showTab('prefs') })
  host.appendChild(a)
  host.style.display = ''
}

async function wipeAll () {
  const others = ((existing && existing.accounts) || []).map((a) => a.account_email || a.account_id).filter(Boolean)
  const scopeLine = others.length > 1
    ? '\n\n⚠ This is NOT per-account — it deletes everything learned from ALL your accounts: ' + others.join(', ') + '.'
    : ''
  const sure = window.confirm('Delete processed superlazy data (projects, events, accounts, settings, non-learned profiles)?' +
    scopeLine +
    '\n\nKept: learned newsletter/admin/social senders (they cost tokens to classify — their mail keeps auto-processing).\nYour mail itself is untouched.')
  if (!sure) return
  el('wipeBtn').disabled = true
  try {
    await persist.deleteAllData({ keepLearnedSenders: true, onProgress: (c, i, n) => setStatus('Deleting ' + c + ' ' + i + '/' + n + '…', 'info') })
    setStatus('Processed data deleted (learned senders kept) — reloading fresh.', 'ok')
    setTimeout(() => window.location.reload(), 600)
  } catch (e) {
    setStatus('Delete failed: ' + (e.message || e), 'error')
    el('wipeBtn').disabled = false
  }
}

async function showStatusPage () {
  showView('status')
  showTab('status')
  el('wipeZone').style.display = ''
  paintCostSummary().catch(() => {})
  setStatus('SuperLazy is set up. New mail is picked up on the Dashboard.', 'ok')
  renderPrefsForm(el('prefsForm'), currentSettings, { onSave: savePrefs, bgState: null })
  loadBackgroundState({ persist, settings: currentSettings })
    .then((bgState) => renderPrefsForm(el('prefsForm'), currentSettings, { onSave: savePrefs, bgState }))
    .catch(() => {})
  renderRulesTab(el('rulesForm'), {
    instructions: (existing && existing.instructions) || [],
    accounts: (existing && existing.accounts) || [],
    persist
  })
  await refreshStatusRows()
}

// ---- the welcome screens -----------------------------------------------------------------------

const INTRO_LEAD = 'SuperLazy gives you a totally different view on your email boxes, using your ' +
  'favorite LLM to build your todo list, assign to-dos to your team members and <b> cross off todo items </b> ' +
  'when the email evidence is available. <b>It knows when your colleague has completed a deliverable! </b>' +
  'It knows your context so it can prioritize your emails for you, letting you be <i>lazy like Linus</i>.'

function showPermGate ({ mailGranted, messagingGranted, inputGranted, llmGranted }) {
  showView('welcome')
  // ONE input channel is enough to start: mail OR messaging (Slack). The gate only demands an
  // input permission when NEITHER is granted.
  const needInput = !(inputGranted != null ? inputGranted : (mailGranted || messagingGranted))
  const missingBoth = needInput && !llmGranted
  const lead = missingBoth
    ? 'SuperLazy needs access to an input source — your mail account or a messaging (Slack) account — and permission to use your AI (LLM) keys to analyze it. Go to '
    : (needInput
        ? 'SuperLazy needs access to your mail account (or a messaging/Slack account) to work. Go to '
        : 'SuperLazy uses your favorite AI to analyze your messages, so it needs permission to use your AI (LLM) keys. Go to ')
  const tail = missingBoth
    ? ' to grant the permissions.'
    : (needInput ? ' to give permission to use your mail or messaging.' : ' to give permission to use your AI.')
  setWelcomeLead([lead, { text: 'your settings', href: APP_SETTINGS_URL }, tail])
  const linkText = missingBoth
    ? 'Open settings to grant mail/messaging + AI access'
    : (needInput ? 'Open settings to grant mail or messaging access' : 'Open settings to grant AI access')
  showOnboarding('gate', { gateLinkText: linkText, gateLinkHref: APP_SETTINGS_URL })
  setStatus(missingBoth
    ? 'Waiting for the input (mail/messaging) and AI permissions…'
    : (needInput ? 'Waiting for a mail or messaging permission…' : 'Waiting for the AI (LLM) permission…'), 'info')
}

function showNoAccountsGate () {
  showView('welcome')
  setWelcomeLead([
    'Thank you for granting SuperLazy permission to access your mail accounts… but it doesn’t ' +
    'look like you have set up any mail accounts on your freezr. Please go to ',
    { text: 'your account resources', href: RESOURCES_URL },
    ' to set up mail on this freezr.'
  ])
  showOnboarding('gate', { gateLinkText: 'Set up a mail account', gateLinkHref: RESOURCES_URL })
  setStatus('Waiting for a mail account…', 'info')
}

// Messaging (Slack) is granted and connected, but there is no mail account: a valid start.
// Mail training (this page's one-pass setup) has nothing to read — channel setup happens RIGHT
// HERE, with the same UI the status page's Channels tab uses (slackChannelsUi.js). Saving the
// selection creates the account record; the next check builds the history and the app is live.
function showMessagingOnlyStart () {
  showView('welcome')
  setWelcomeLead([
    'SuperLazy can see your messaging (Slack) account. Pick the conversations it should read ' +
    'below and save — they are analysed like mail from the next check on. To also analyse ' +
    'email — SuperLazy’s richest source — connect a mail account at ',
    { text: 'your account resources', href: RESOURCES_URL },
    ' and come back here to train on it.'
  ])
  showOnboarding('gate', { gateLinkText: 'Set up a mail account too (optional)', gateLinkHref: RESOURCES_URL })
  const host = el('welcomeChannels')
  host.style.display = ''
  renderSlackChannels(host, {
    freezr,
    persist,
    storedAccounts: (existing && existing.accounts) || [],
    // first channel of the install: train in the FOREGROUND right here (the mail parity —
    // progress visible, nothing happening silently), then hand over to the dashboard.
    // Ensure THE settings record exists first — mail setup creates it at adopt time, a
    // slack-only install here (check stamps and prefs need somewhere to land).
    onSaved: async () => {
      if (!currentSettings) {
        currentSettings = {}
        await persist.saveSettings(currentSettings).catch(() => {})
      }
      return runChannelTraining({
        onDone: ({ ok, summary }) => {
          setStatus(summary + (ok ? ' Opening your dashboard…' : ''), ok ? 'ok' : 'error')
          if (ok) setTimeout(() => { window.location.href = '/apps/' + ((typeof freezrMeta !== 'undefined' && freezrMeta.appName) || 'com.salmanff.superlazy') + '/index' }, 1200)
        }
      })
    }
  })
  setStatus('No mail account connected — Slack-only mode. Choose the conversations to track below; saving starts the first read, with progress shown here.', 'info')
}

// An AI-agent session store is granted and connected, but there is no mail account:
// a valid start too — the same UI as the Channels tab's AI agents section, right here.
function showWorkOnlyStart () {
  showView('welcome')
  setWelcomeLead([
    'SuperLazy can read your AI coding-agent sessions. Pick the repos it should read below and ' +
    'save — every finished request-and-answer turn is analysed like mail from the next check on. ' +
    'To also analyse email — SuperLazy’s richest source — connect a mail account at ',
    { text: 'your account resources', href: RESOURCES_URL },
    ' and come back here to train on it.'
  ])
  showOnboarding('gate', { gateLinkText: 'Set up a mail account too (optional)', gateLinkHref: RESOURCES_URL })
  const host = el('welcomeWork')
  host.style.display = ''
  renderWorkSessions(host, {
    freezr,
    persist,
    storedAccounts: (existing && existing.accounts) || [],
    settings: currentSettings || {},
    onSaved: async () => {
      if (!currentSettings) {
        currentSettings = {}
        await persist.saveSettings(currentSettings).catch(() => {})
      }
      return runChannelTraining({
        onDone: ({ ok, summary }) => {
          setStatus(summary + (ok ? ' Opening your dashboard…' : ''), ok ? 'ok' : 'error')
          if (ok) setTimeout(() => { window.location.href = '/apps/' + ((typeof freezrMeta !== 'undefined' && freezrMeta.appName) || 'com.salmanff.superlazy') + '/index' }, 1200)
        }
      })
    }
  })
  setStatus('No mail account connected — sessions-only mode. Choose the repos to read below; saving starts the first read, with progress shown here.', 'info')
}
async function hasFsConnection () {
  try { return (await listFsConnections(freezr)).length > 0 } catch (e) { return false }
}

// Is at least one messaging-service connection present? (The connections listing is shared
// across services, so filter on services — a mail row must not count.)
async function hasMessagingConnection () {
  try {
    if (!freezr.connections || !freezr.connections.messaging) return false
    const res = await freezr.connections.messaging.listAccounts()
    return ((res && res.accounts) || []).some(a => (a.services || []).includes('messaging'))
  } catch (e) { return false }
}

async function showFirstRunSetup () {
  showView('welcome')
  setWelcomeLead([INTRO_LEAD])
  showOnboarding('setup')
  el('wipeZone').style.display = ''
  el('days').value = DEFAULT_HISTORY_DAYS
  renderAccountRadios()
  populateModelSelect(el('model'), {
    stored: (currentSettings && currentSettings.default_model) || null,
    hintEl: el('modelHint'),
    onError: (msg) => setStatus(msg, 'error')
  }).catch((e) => console.error('[superlazy] model picker failed', e))
  setStatus(accounts.length === 1
    ? 'Your account is ready — SuperLazy reads it in one pass and shows you what it found before saving anything.'
    : 'Pick the mailbox to start with. You can set up the others afterwards.', 'info')
}

// ---- init ---------------------------------------------------------------------------------------

function wire () {
  el('startSetupBtn').addEventListener('click', beginSetup)
  el('startBtn').addEventListener('click', startRun)
  el('stopBtn').addEventListener('click', stopRun)
  el('resumeBtn').addEventListener('click', resumeRun)
  el('sendAnswersBtn').addEventListener('click', refine)
  el('adoptBtn').addEventListener('click', saveMap)
  el('skipQBtn').addEventListener('click', waiveQuestions)
  el('wipeBtn').addEventListener('click', wipeAll)
  el('tabStatusBtn').addEventListener('click', () => showTab('status'))
  el('tabRulesBtn').addEventListener('click', () => showTab('rules'))
  el('tabConnectedBtn').addEventListener('click', () => {
    showTab('connected')
    // re-rendered on every visit: the render itself does the inbox intake + delivery flush
    renderConnectedTab(el('connectedForm'))
  })
  el('tabPrefsBtn').addEventListener('click', () => showTab('prefs'))
  for (const b of document.querySelectorAll('.bs-tab')) {
    b.addEventListener('click', () => activateTab(b.dataset.tab))
  }
  for (const b of document.querySelectorAll('.bs-subtab')) {
    b.addEventListener('click', () => activateSub(b.dataset.sub))
  }
  el('freeText').addEventListener('input', refreshAnswersBtn)
  el('contextEdit').addEventListener('input', () => { el('saveCtxBtn').disabled = false })
  el('saveCtxBtn').addEventListener('click', () => {
    el('ctxSaved').textContent = 'saved — it goes back as written with your next send, and is what gets stored'
    el('saveCtxBtn').disabled = true
    addCorrection('I edited the situation text — use my wording.')
    refreshAnswersBtn()
  })
  el('copyBtn').addEventListener('click', () => {
    navigator.clipboard.writeText(el('rawJson').textContent || '')
      .then(() => setPhase('Copied', 'The raw output is on your clipboard.', 'ok'))
      .catch(() => setPhase('Copy failed', 'Select the text manually.', 'error'))
  })
  el('diagToggle').addEventListener('click', () => {
    const w = el('diagWrap')
    w.hidden = !w.hidden
    el('diagToggle').textContent = w.hidden ? 'cost per call' : 'hide'
  })
}

async function init () {
  wire()
  getBackgroundCapability().then((c) => { bgCap = c }).catch(() => {})

  try {
    existing = await persist.loadAll()
  } catch (e) {
    existing = { projects: [], profiles: [], instructions: [], accounts: [], settings: null }
  }
  currentSettings = existing.settings || null

  source = (existing.accounts && existing.accounts.length) ? sourceFromAccounts(existing.accounts) : sourceForId(null)
  configureEmailViewer({ source })

  try {
    const res = await source.listAccounts()
    accounts = res.accounts || []
  } catch (e) {
    accounts = []
    console.error('[superlazy] could not list mail accounts:', e && e.message)
  }

  // Already set up → the status page. A half-finished record (an interrupted per-message build from
  // an older version) is treated the same way: there is no partial state to resume any more, and
  // the Status tab's own action re-runs the one-pass setup for that account.
  if (existing.accounts && existing.accounts.length) {
    currentSettings = currentSettings || {}
    if (currentSettings.training_wip) {
      currentSettings.training_wip = false
      await persist.saveSettings(currentSettings).catch((e) => console.error('settings save failed', e))
    }
    await showStatusPage()
    return
  }

  const permState = await getPermissionState()
  if (permState.known && (!permState.inputGranted || !permState.llmGranted)) { showPermGate(permState); return }
  if (!accounts.length) {
    // no MAIL account. If messaging (Slack) is granted and connected, that is a valid start —
    // its setup lives on the Slack lab page, not this page's mail training.
    if (permState.messagingGranted && await hasMessagingConnection()) { showMessagingOnlyStart(); return }
    if (permState.fsGranted && await hasFsConnection()) { showWorkOnlyStart(); return }
    showNoAccountsGate()
    return
  }
  await showFirstRunSetup()
}

init().catch((e) => {
  const loading = document.getElementById('pageLoading')
  if (loading) loading.style.display = 'none'
  setStatus('Could not load: ' + ((e && e.message) || e), 'error')
})
