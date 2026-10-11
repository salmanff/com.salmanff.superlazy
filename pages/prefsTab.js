// prefsTab.js — the PREFERENCES tab of the Setup & Prefs page (shown once training is done):
// renders the persisted settings record as an editable form and hands the merged values back
// via onSave. The fields are the `settings` record's (manifest app_tables; prefs still to build are in specs/pipeline-backlog.md);
// training-time knobs (history window, thread context) are NOT preferences — they live in the
// status tab's start-training form. Some prefs are stored ahead of the feature that reads them
// (style refresh) so they take effect as those land. Bookkeeping fields
// (training_wip, locks) stay untouched by the merge.

import { CONTEXT_CHOICES, DEFAULT_CONTEXT_CHARS } from '../jobs/analyze_thread/assemble.js'
import { DEFAULT_BATCH_MAX } from '../jobs/analyze_thread/config.js'
import { populateModelSelect } from '../shared/modelPicker.js'
import { scheduleOf, nextSlotMs, describeSchedule, DAY_NAMES } from '../jobs/analyze_thread/maintenance/cleanupSchedule.js'
import { startBackgroundRun } from '../shared/newMail.js'
import { EDITOR_URL_DEFAULT, EDITOR_PRESETS } from '../shared/renderUtils.js'

function div (cls, text) {
  const d = document.createElement('div')
  if (cls) d.className = cls
  if (text != null) d.textContent = text
  return d
}

// One titled, bordered block of the form (user, 2026-10-11: the sections were hard to tell apart).
function section (title, intro) {
  const wrap = div('su-pref-section')
  wrap.appendChild(div('su-pref-section-title', title))
  if (intro) wrap.appendChild(div('su-pref-section-intro su-muted small', intro))
  return wrap
}

function fieldRow (labelText, inputEl, hint) {
  const label = document.createElement('label')
  label.className = 'su-pref-row'
  label.appendChild(div('su-pref-label', labelText))
  label.appendChild(inputEl)
  if (hint) label.appendChild(div('su-muted small', hint))
  return label
}

function textInput (value) {
  const i = document.createElement('input')
  i.type = 'text'
  i.value = value == null ? '' : String(value)
  return i
}

function numInput (value, { min = 0, max = 365, step = 1 } = {}) {
  const i = document.createElement('input')
  i.type = 'number'
  i.min = String(min)
  i.max = String(max)
  i.step = String(step)
  i.value = value == null ? '' : String(value)
  return i
}

function checkbox (checked) {
  const i = document.createElement('input')
  i.type = 'checkbox'
  i.checked = !!checked
  return i
}

// A model picker — the shared price-labelled one (modelPicker.js), so this tab and the first-run
// form offer the identical choice. `tier` says what its "Recommended default" resolves to
// (modelDefaults.js): 'analysis' = sonnet on Claude, 'review' = opus.
function modelSelect (stored, tier) {
  const sel = document.createElement('select')
  const dflt = document.createElement('option')
  dflt.value = 'default'
  dflt.textContent = 'Recommended default'
  sel.appendChild(dflt)
  const hint = div('su-muted small')
  const ready = populateModelSelect(sel, { stored, hintEl: hint, tier })
    .catch(e => { console.error('[superlazy] model picker failed', e); return { refresh: () => {} } })
  return { sel, hint, ready }
}

// The background-checking block: mode toggle + foreground poll interval. `bgState` comes from
// backgroundMode.loadBackgroundState — when the capability is missing the toggle is disabled with
// the reason spelled out (turning it on couldn't do anything).
function backgroundBlock (s, bgState) {
  const wrap = section('Running in the background')
  const mode = checkbox(bgState ? bgState.mode === 'on' : false)
  const cap = bgState || { capable: false, reason: 'checking availability…' }
  if (!cap.capable) mode.disabled = true

  const row = fieldRow('Check mail in the background', mode,
    cap.capable
      ? 'the freezr job checks + analyses mail on its own — hourly when no page is open, and while you browse without tying up the page'
      : 'unavailable: ' + (cap.reason || 'background jobs are not available on this server'))
  row.classList.add('su-pref-check')
  wrap.appendChild(row)

  const poll = document.createElement('select')
  for (const m of [1, 2, 5, 10, 15, 30]) {
    const o = document.createElement('option')
    o.value = String(m)
    o.textContent = 'every ' + m + ' minute' + (m === 1 ? '' : 's')
    poll.appendChild(o)
  }
  poll.value = String(Number(s.foreground_poll_minutes) || 5)
  if (poll.value !== String(Number(s.foreground_poll_minutes) || 5)) poll.value = '5'
  wrap.appendChild(fieldRow('While a page is open, check', poll,
    'background mode on: how often an open page asks for an extra check on top of the hourly schedule'))

  return { wrap, mode, poll }
}

// The WEEKLY CLEAN-UP block (2026-09-27): on/off, day, hour — in the browser's timezone, which is
// saved with it (the background job has no clock of its own to read it from). Runs inside the
// hourly background job (the clean-up first, then the mail check); with background mode off, the
// first page opened after the slot starts it.
function cleanupScheduleBlock (s, bgState) {
  const wrap = section('Scheduled clean-up')
  const sched = scheduleOf(s)
  const on = checkbox(sched.enabled)
  const freq = document.createElement('select')
  for (const [v, t] of [['daily', 'every day'], ['weekly', 'every week, on']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; freq.appendChild(o) }
  freq.value = sched.frequency
  const day = document.createElement('select')
  DAY_NAMES.forEach((n, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = n; day.appendChild(o) })
  day.value = String(sched.day)
  const hour = document.createElement('select')
  for (let h = 0; h < 24; h++) { const o = document.createElement('option'); o.value = String(h); o.textContent = String(h).padStart(2, '0') + ':00'; hour.appendChild(o) }
  hour.value = String(sched.hour)
  let tz = null
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone } catch (e) { tz = null }
  const row = fieldRow('Run the clean-up on a schedule', on, 'reviews your whole map — stale items, finished projects, duplicates, people, rules — on the clean-up model; the results wait for you as a bar at the top of every page')
  row.classList.add('su-pref-check')
  wrap.appendChild(row)
  const when = document.createElement('span')
  when.appendChild(freq); when.appendChild(document.createTextNode(' ')); when.appendChild(day); when.appendChild(document.createTextNode(' at ')); when.appendChild(hour)
  const syncDay = () => { day.style.display = freq.value === 'daily' ? 'none' : '' }
  freq.addEventListener('change', syncDay); syncDay()
  const next = () => { const sc = { enabled: on.checked, frequency: freq.value, day: Number(day.value), hour: Number(hour.value), tz }; const n = nextSlotMs(sc); return sc.enabled ? describeSchedule(sc) + (n ? ' — next: ' + new Date(n).toLocaleString() : '') : 'off' }
  const hint = div('su-muted small', '')
  const paint = () => {
    const last = s.cleanup_last_run
    hint.textContent = next() + (last ? ' · last run ' + new Date(Number(last.finished_at || last.started_at)).toLocaleString() + (Number(last.cost) ? ' ($' + Number(last.cost).toFixed(2) + ')' : '') + (last.failure ? ' — failed: ' + last.failure : '') : '') +
      (bgState && bgState.mode !== 'on' ? ' · background checking is off, so it starts when you first open SuperLazy after that time' : '')
  }
  for (const el of [on, freq, day, hour]) el.addEventListener('change', paint)
  paint()
  wrap.appendChild(fieldRow('Run it on', when, ''))
  // RUN NOW (2026-09-27): the same background job run, outside the schedule (`force` skips the slot
  // check). Its progress shows in the strip and its results in the bar, exactly as a Monday run's.
  const runBtn = document.createElement('button')
  runBtn.type = 'button'
  runBtn.className = 'sl-mailbtn' // the app's small action button (the mail-check buttons' style)
  runBtn.textContent = '🧹 Run the clean-up now'
  const runNote = div('su-muted small', '')
  const capable = !!(bgState && bgState.capable)
  if (!capable) { runBtn.disabled = true; runNote.textContent = 'unavailable: ' + ((bgState && bgState.reason) || 'background jobs are not available on this server') }
  runBtn.addEventListener('click', async () => {
    runBtn.disabled = true
    runNote.textContent = 'Starting…'
    const r = await startBackgroundRun({ freezr: typeof freezr !== 'undefined' ? freezr : null, task: 'cleanup', extra: { force: true, windowDays: Number(daysBack.value) || 7 } }).catch(e => ({ started: false, error: (e && e.message) || String(e) }))
    if (r.started) {
      runNote.textContent = 'Started in the background (a few minutes on the clean-up model). The strip at the top shows it running; the results bar appears when it finishes — you can leave this page.'
      setTimeout(() => { runBtn.disabled = false }, 60e3)
    } else {
      runNote.textContent = 'Could not start: ' + (r.error || 'unknown error')
      runBtn.disabled = false
    }
  })
  // how far back THIS run reads (the scheduled run uses the Clean-up page's window, 7 days by default)
  const daysBack = document.createElement('select')
  for (const n of [1, 7, 14, 30]) { const o = document.createElement('option'); o.value = String(n); o.textContent = 'last ' + n + ' days'; daysBack.appendChild(o) }
  daysBack.value = '7'
  // the last run's results, every item with its status (the Clean-up page, where the rows are live)
  const viewBtn = document.createElement('button')
  viewBtn.type = 'button'
  viewBtn.className = 'sl-mailbtn'
  viewBtn.textContent = 'View the last clean-up'
  const lastRun = s.cleanup_last_run
  if (!lastRun || !lastRun.run_id) { viewBtn.disabled = true; viewBtn.title = 'No clean-up has run yet' }
  viewBtn.addEventListener('click', () => {
    const appPath = '/apps/' + ((typeof freezrMeta !== 'undefined' && freezrMeta.appName) || 'com.salmanff.superlazy')
    window.location.href = appPath + '/cleanup?run=' + encodeURIComponent(lastRun.run_id) + '&all=1'
  })
  const controls = document.createElement('span')
  controls.className = 'su-cleanup-controls'
  controls.appendChild(runBtn)
  controls.appendChild(document.createTextNode(' on the '))
  controls.appendChild(daysBack)
  controls.appendChild(document.createTextNode(' '))
  controls.appendChild(viewBtn)
  const runRow = fieldRow('Run it now', controls, 'outside the schedule — the weekly slot is unaffected')
  wrap.appendChild(runRow)
  wrap.appendChild(runNote)
  wrap.appendChild(hint)
  return { wrap, value: () => ({ enabled: !!on.checked, frequency: freq.value, day: Number(day.value), hour: Number(hour.value), tz }) }
}

// settings: the persisted record (never mutated here). onSave(fields) receives ONLY the
// user-editable fields; the caller merges + persists (and flips the job schedule when the
// background mode changed — see setup.js).
export function renderPrefsForm (host, settings, { onSave, bgState = null } = {}) {
  host.textContent = ''
  const s = settings || {}

  const me = textInput((s.your_addresses || []).join(', '))
  // the editor that opens a changed file from an agent turn (URL scheme with {path}); default VS Code
  const editorTpl = textInput(s.editor_url_template || EDITOR_URL_DEFAULT)
  const currentChars0 = Number(s.analysis_context_chars) || DEFAULT_CONTEXT_CHARS
  const model = modelSelect(s.default_model, 'analysis')
  // the CLEAN-UP model is a separate choice (2026-09-26): the weekly clean-up and "Review this
  // project" run on the most capable tier, the day-to-day analysis on the middle one
  const cleanupModel = modelSelect(s.cleanup_model, 'review')
  const suggest = checkbox(s.suggest_replies !== false)
  const autopilot = checkbox(s.automated_autopilot !== false)
  const styleRefresh = numInput(s.style_guide_refresh_days == null ? 30 : s.style_guide_refresh_days, { min: 0, max: 365 })
  const retention = numInput(s.events_retention_days == null ? 90 : s.events_retention_days, { min: 0, max: 3650 })
  // How much context each analysis request may carry. More = the model sees more of your project
  // history and people per email (better judgement), and costs more per email; assemble.js reduces
  // by relevance to fit whatever is chosen, so this is a genuine quality/cost dial.
  // The two REASONING dials, exposed precisely so their cost/quality trade can be TESTED rather
  // than argued about: thinking off + low effort cut a measured ~1,900 reasoning tokens per email
  // (~2c at intro sonnet rates); whether judgement suffers is only observable on real mail. The
  // events log records thinking tokens per message, so a day on each setting can be compared with
  // node test/costReport.mjs.
  const thinkSel = document.createElement('select')
  for (const [v, label] of [['off', 'Off — fastest, cheapest (default)'], ['on', 'On — model reasons before answering (adds cost & time)']]) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    thinkSel.appendChild(o)
  }
  thinkSel.value = s.analysis_thinking === true ? 'on' : 'off'
  const effortSel = document.createElement('select')
  for (const [v, label] of [['low', 'Low — cheapest, terse (default)'], ['medium', 'Medium — balanced'], ['high', 'High — most thorough (provider default)']]) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    effortSel.appendChild(o)
  }
  effortSel.value = ['low', 'medium', 'high'].includes(s.analysis_effort) ? s.analysis_effort : 'low'
  // Output ceiling per analysis call. Providers bill tokens actually generated, not the cap — a
  // LOW cap only buys truncated JSON; the dial exists so the inspect page can compare settings.
  const maxTok = numInput(s.analysis_max_tokens == null ? 40000 : s.analysis_max_tokens, { min: 4000, max: 64000, step: 1000 })
  // How many extra rounds the model may ask for detail (request_more) before it must answer.
  const roundsSel = document.createElement('select')
  for (const n of [0, 1, 2, 3, 4, 5]) {
    const o = document.createElement('option')
    o.value = String(n)
    o.textContent = n === 0 ? '0 — must answer first time' : String(n) + (n === 2 ? ' (default)' : '')
    roundsSel.appendChild(o)
  }
  roundsSel.value = String(s.analysis_fetch_rounds != null && [0, 1, 2, 3, 4, 5].includes(Number(s.analysis_fetch_rounds)) ? Number(s.analysis_fetch_rounds) : 2)
  // Durable-turn (catalog cache) refresh triggers — how often the cached prefix is re-rendered
  // (each re-render = one cache write at 2x the input rate on the 1h TTL, then reads at ~10%).
  // Two message thresholds: emails, and chat turns (Slack / AI agents) which move the catalog less.
  const snapMsgs = numInput(s.snapshot_refresh_messages == null ? 50 : s.snapshot_refresh_messages, { min: 1, max: 500 })
  const snapChats = numInput(s.snapshot_refresh_chats == null ? 100 : s.snapshot_refresh_chats, { min: 1, max: 1000 })
  const snapHours = numInput(s.snapshot_max_age_hours == null ? 24 : s.snapshot_max_age_hours, { min: 1, max: 168 })
  // the COLD block (your situation + auto-process rules + projects quiet for a week) re-renders on
  // its own, slower clock — and immediately when the rules or your situation change
  const snapColdHours = numInput(s.snapshot_cold_max_age_hours == null ? 168 : s.snapshot_cold_max_age_hours, { min: 1, max: 720 })
  // Batch size: consecutive same-account messages answered in ONE AI call. Bigger = cheaper per
  // email and faster runs; too big risks a failed call (which then splits and retries solo).
  const batchSel = document.createElement('select')
  for (const n of [1, 2, 3, 5, 8, 10, 15, 20]) {
    const o = document.createElement('option')
    o.value = String(n)
    o.textContent = n === 1 ? '1 — one email per call' : String(n) + ' emails per call' + (n === DEFAULT_BATCH_MAX ? ' (default)' : '')
    batchSel.appendChild(o)
  }
  batchSel.value = String([1, 2, 3, 5, 8, 10, 15, 20].includes(Number(s.batch_max)) ? Number(s.batch_max) : DEFAULT_BATCH_MAX)

  const context = document.createElement('select')
  for (const c of CONTEXT_CHOICES) {
    const o = document.createElement('option')
    o.value = String(c.chars)
    o.textContent = c.label
    context.appendChild(o)
  }
  const currentChars = String(currentChars0)
  context.value = currentChars
  if (context.value !== currentChars) context.value = String(DEFAULT_CONTEXT_CHARS)
  // ---- the sections, in order (user, 2026-10-11) ----
  const bg = backgroundBlock(s, bgState)
  host.appendChild(bg.wrap)
  const weekly = cleanupScheduleBlock(s, bgState)
  host.appendChild(weekly.wrap)

  const models = section('Model preferences', '“Recommended default” keeps your freezr default provider: Sonnet for each email and Opus for the clean-up on Claude, the flagship GPT for both on ChatGPT.')
  const modelRow = fieldRow('Model for analysing each email', model.sel, 'which LLM analyses your mail and drafts replies — the day-to-day, per-message work')
  modelRow.appendChild(model.hint)
  const cleanupRow = fieldRow('Clean-up & review model', cleanupModel.sel, 'which LLM runs the clean-up (/cleanup) and “Review this project” — the most capable tier; it reads your whole map once a week, not every email')
  cleanupRow.appendChild(cleanupModel.hint)
  models.appendChild(modelRow)
  models.appendChild(cleanupRow)
  models.appendChild(fieldRow('Messages per AI call (batch size)', batchSel,
    'consecutive emails from the same account are analysed together in one request — cheaper per email. ' +
    'This is a CEILING: if a batch fails or times out, the run halves the size automatically (down to 1), ' +
    'retries those messages one at a time, and climbs back up after 3 clean batches. Test sizes on Inspect.'))
  host.appendChild(models)

  const misc = section('Miscellaneous')
  misc.appendChild(fieldRow('Your own address(es)', me, 'comma-separated — messages from these are treated as yours'))
  misc.appendChild(fieldRow('Open files in', editorTpl,
    'a URL template with {path} for the editor that opens a file changed in an agent session — ' +
    EDITOR_PRESETS.map(([n, t]) => n + ': ' + t).join(' · ') +
    '. Only works when SuperLazy runs on this machine; if nothing opens, that editor is not installed (use “copy” instead).'))
  const sr = fieldRow('Suggest replies', suggest, 'draft answers/delegations/reminders in your writing style')
  sr.classList.add('su-pref-check')
  misc.appendChild(sr)
  const ap = fieldRow('Auto-process learned bulk senders', autopilot, 'newsletters/admin/social file without the LLM once learned')
  ap.classList.add('su-pref-check')
  misc.appendChild(ap)
  misc.appendChild(fieldRow('Refresh writing style every (days)', styleRefresh, 'how often your style guide is re-learned from sent mail'))
  misc.appendChild(fieldRow('Keep events for (days)', retention, 'the analysis audit log — 0 = keep forever'))
  misc.appendChild(div('su-muted small', 'Training mode: ' + (s.training_mode || 'live') + ' · per-account training windows are set on the Status tab when training an account.'))
  host.appendChild(misc)

  // TESTING DIALS — hidden, not removed (user, 2026-10-11): they were added to measure cost against
  // quality, not for everyday use. Context per email: 94% of 1,433 analysed messages were never trimmed
  // at the 70k default, so the dial only touches the ~6% on big projects — untested whether more helps. Still rendered so Save keeps writing their stored values back;
  // flip `hidden` to bring them back for an experiment.
  const testing = section('Testing dials', 'Cost/quality experiments — compare settings on the Inspect page.')
  testing.hidden = true
  testing.appendChild(fieldRow('Analysis thinking', thinkSel,
    'whether the model reasons step-by-step before each email. Off saved ~2c/email in testing; turn it on if ' +
    'project assignments or importance calls look wrong, and compare a day of each with the events log.'))
  testing.appendChild(fieldRow('Analysis effort', effortSel,
    'how hard the model works per email — scales everything it writes, reasoning included. ' +
    'Changing it mid-run costs one cache rebuild (~6c); it applies from the next check.'))
  testing.appendChild(fieldRow('Max output tokens', maxTok,
    'the reply ceiling per analysis call (default 40000). Providers bill tokens actually written, not the cap — ' +
    'too low only buys cut-off JSON. Compare settings on the Inspect page.'))
  testing.appendChild(fieldRow('Detail-fetch rounds', roundsSel,
    'how many times the model may ask for an older email body / project detail before it must answer (request_more). ' +
    'More rounds = better grounding on long threads, one extra LLM call each.'))
  testing.appendChild(fieldRow('Context sent per email', context,
    'how much of your project history, people and thread the AI sees when judging one email. More context = better ' +
    'judgement and a higher cost per email; SuperLazy always sends the most relevant parts first and trims the rest.'))
  host.appendChild(testing)

  const cache = section('Catalog caching', 'Every analysis call starts with the same cached block — your situation, project catalog and auto-process rules. Re-caching it costs one write at twice the input rate; between re-caches every call reads it at a tenth.')
  cache.appendChild(fieldRow('Re-cache the catalog after (emails)', snapMsgs,
    'the cached prefix is re-rendered after this many analysed emails. ' +
    'Each re-cache is one cache write (~15c for a 25k-token catalog).'))
  cache.appendChild(fieldRow('…or after (chat turns)', snapChats,
    'Slack messages and AI-agent turns count against this threshold instead — they change the catalog less than an email does. ' +
    'Mixed traffic adds up proportionally: 25 emails + 50 chat turns = one re-cache.'))
  cache.appendChild(fieldRow('…or after (hours)', snapHours,
    'and also when the recently-active part of the catalog is older than this — whichever comes first. ' +
    'The catalog is cached in two blocks: this HOT block (projects active in the last week) is what the thresholds above re-render.'))
  cache.appendChild(fieldRow('Re-cache the quiet part after (hours)', snapColdHours,
    'the COLD block — your situation, the auto-process rules and every project quiet for over a week — is re-rendered this often ' +
    '(default weekly), and immediately when you change the rules or your situation. It sits first in the cached prefix, so it should change least.'))
  host.appendChild(cache)

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'su-primary'
  btn.textContent = 'Save preferences'
  btn.addEventListener('click', () => {
    if (!onSave) return
    const addresses = me.value.split(/[,;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean)
    const int = (inp, dflt) => { const n = parseInt(inp.value, 10); return Number.isFinite(n) && n >= 0 ? n : dflt }
    let defaultModel = null
    try { if (model.sel.value && model.sel.value !== 'default') defaultModel = JSON.parse(model.sel.value) } catch (e) {}
    let cleanupModelVal = null
    try { if (cleanupModel.sel.value && cleanupModel.sel.value !== 'default') cleanupModelVal = JSON.parse(cleanupModel.sel.value) } catch (e) {}
    onSave({
      your_addresses: addresses,
      // must carry {path}; anything else falls back to the default rather than producing dead links
      editor_url_template: (editorTpl.value.trim().includes('{path}') ? editorTpl.value.trim() : EDITOR_URL_DEFAULT),
      default_model: defaultModel,
      cleanup_model: cleanupModelVal,
      cleanup_schedule: weekly.value(),
      suggest_replies: !!suggest.checked,
      automated_autopilot: !!autopilot.checked,
      style_guide_refresh_days: int(styleRefresh, 30),
      events_retention_days: int(retention, 90),
      analysis_context_chars: parseInt(context.value, 10) || DEFAULT_CONTEXT_CHARS,
      analysis_thinking: thinkSel.value === 'on',
      analysis_effort: effortSel.value,
      analysis_max_tokens: int(maxTok, 40000),
      analysis_fetch_rounds: parseInt(roundsSel.value, 10),
      snapshot_refresh_messages: int(snapMsgs, 50) || 50,
      snapshot_refresh_chats: int(snapChats, 100) || 100,
      snapshot_max_age_hours: int(snapHours, 24) || 24,
      snapshot_cold_max_age_hours: int(snapColdHours, 168) || 168,
      batch_max: parseInt(batchSel.value, 10) || DEFAULT_BATCH_MAX,
      // only meaningful when the capability exists (the toggle is disabled otherwise)
      background_mode: bg.mode.disabled ? (s.background_mode || 'off') : (bg.mode.checked ? 'on' : 'off'),
      foreground_poll_minutes: parseInt(bg.poll.value, 10) || 5
    })
  })
  host.appendChild(btn)

  // the Request Audit Lab (requestauditlab): every LLM exchange, verbatim, with its cost by part —
  // the place to answer "why did that cost what it did" once recording is switched on there
  const dig = div('su-pref-deeplink su-muted small')
  const a = document.createElement('a')
  a.href = '/apps/com.salmanff.superlazy/requestauditlab'
  a.textContent = 'Dig deep into your token spend with the Request Audit Lab page'
  dig.appendChild(a)
  dig.appendChild(document.createTextNode(' — records every AI request while recording is on, with the cost of each part.'))
  host.appendChild(dig)
}
