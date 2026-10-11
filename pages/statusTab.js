// statusTab.js — rendering for the STATUS tab of the Setup & Prefs page once training is done:
// the per-account summary (one row per connected mail account with a trained / training /
// not-started chip) and the detail panel below it — stats for trained accounts, a start-training
// mini-form for accounts that haven't been trained yet. Pure DOM; actions come in as handlers.

import { populateModelSelect, selectedModel } from '../shared/modelPicker.js'
import { CONTEXT_CHOICES, DEFAULT_CONTEXT_CHARS } from '../jobs/analyze_thread/assemble.js'

const esc = (s) => String(s == null ? '' : s)

function div (cls, text) {
  const d = document.createElement('div')
  if (cls) d.className = cls
  if (text != null) d.textContent = text
  return d
}

function fmtDT (ms) {
  const n = Number(ms)
  if (!n) return '—'
  try { return new Date(n).toISOString().slice(0, 16).replace('T', ' ') } catch (e) { return String(ms) }
}

const STATE_LABEL = {
  trained: '✓ trained',
  training: '⏳ training in progress',
  saved: '● saved — first read pending',
  not_started: 'not started',
  creds_expired: '⚠ needs re-authorisation',
  paused: '⏸ paused'
}

// ---- the RESOURCES layout (user, 2026-09-09): every source SuperLazy can read — mail accounts, Slack
// workspaces, AI coding-agent stores — in one left-hand list with its state; the right panel shows
// that source's details: the mail account panel below, or the channel module for Slack / work rows.
const GROUPS = [
  { kind: 'mail', title: 'Mail accounts', empty: 'No mail account connected — add one at /account/resources.' },
  { kind: 'messages', title: 'Slack workspaces', empty: null },
  { kind: 'work', title: 'AI agents', empty: null }
]
const kindOf = (row) => (row.channel === 'messages' || row.channel === 'work') ? row.channel : 'mail'

export function renderResourceList (host, rows, { selected, onSelect } = {}) {
  host.textContent = ''
  for (const g of GROUPS) {
    const mine = rows.filter(r => kindOf(r) === g.kind)
    if (!mine.length && !g.empty) continue
    const group = div('su-res-group')
    group.appendChild(div('su-res-group-title', g.title))
    if (!mine.length) group.appendChild(div('su-muted small', g.empty))
    for (const row of mine) {
      const card = div('su-acct-row su-res-row' + (selected === row.account_id ? ' selected' : ''))
      card.appendChild(div('su-account-name', esc(row.label || row.account_email || row.account_id)))
      const sub = row.sub || row.provider || ''
      if (sub) card.appendChild(div('su-muted small', sub))
      const chipState = row.paused ? 'paused' : row.state
      card.appendChild(div('su-acct-chip ' + chipState, STATE_LABEL[chipState] || chipState))
      card.addEventListener('click', () => onSelect && onSelect(row))
      group.appendChild(card)
    }
    host.appendChild(group)
  }
  if (!rows.length) host.appendChild(div('su-muted', 'No source is connected yet.'))
}

// handlers: the mail handlers of renderAccountDetail + mountChannel(hostEl, row, stripEl) for Slack /
// work rows (the page mounts the channel module there and hooks its Save to the run offer).
export function renderResourceDetail (host, row, handlers = {}) {
  host.textContent = ''
  host.style.display = ''
  if (!row) { host.appendChild(div('su-muted', 'Select a source on the left for its details and actions.')); return }
  if (kindOf(row) === 'mail') { renderAccountDetail(host, row, handlers); host.style.display = ''; return }

  const head = div('su-acct-detail-head', esc(row.label || row.account_email || row.account_id))
  head.appendChild(div('su-acct-chip ' + (row.paused ? 'paused' : row.state), STATE_LABEL[row.paused ? 'paused' : row.state] || row.state))
  host.appendChild(head)
  if (row.state === 'creds_expired') {
    const warn = div('su-res-warn', 'The connection needs re-authorisation before it can be read — open ')
    const a = document.createElement('a'); a.href = '/account/resources'; a.target = '_blank'; a.rel = 'noopener'; a.textContent = '/account/resources'
    warn.appendChild(a); warn.appendChild(document.createTextNode(' and reconnect it.'))
    host.appendChild(warn)
  }
  const rec = row.rec || {}
  host.appendChild(div('su-muted', kindOf(row) === 'messages'
    ? (row.rec ? 'Tracked conversations are analysed by every check, like mail.' : 'Not saved yet — choose the conversations to track and Save.') +
      (rec.messages_processed ? ' ' + rec.messages_processed + ' chunk(s) analysed so far.' : '')
    : (row.rec ? 'Every repo is read unless you exclude it; each finished request-and-answer turn is one analysed item.' : 'Not saved yet — confirm your address and the first-read window, then Save.') +
      (rec.messages_processed ? ' ' + rec.messages_processed + ' turn(s) analysed so far.' : '')))
  const mount = div('su-res-mount')
  host.appendChild(mount)
  const strip = div('su-status-tools su-res-strip')
  host.appendChild(strip)
  if (handlers.mountChannel) handlers.mountChannel(mount, row, strip)
  // resync / pause / forget only mean something once a first read has happened (user, 2026-09-09)
  if (row.rec && (row.state === 'trained' || row.state === 'training' || row.paused)) {
    appendResyncControl(host, row, handlers.onForceResync)
    appendPauseControl(host, row, handlers.onTogglePause)
    appendForgetControl(host, row, handlers.onForget)
  }
}

function numField (labelBefore, value, labelAfter, { min = 0, max = 60 } = {}) {
  const label = document.createElement('label')
  label.className = 'su-acct-num'
  label.appendChild(document.createTextNode(labelBefore + ' '))
  const input = document.createElement('input')
  input.type = 'number'
  input.min = String(min)
  input.max = String(max)
  input.value = String(value)
  label.appendChild(input)
  label.appendChild(document.createTextNode(' ' + labelAfter))
  return { label, input }
}

// The per-account "forget everything learned from this account" control. Separate from the global
// Start over: this one only removes what is attributable to THIS account (see
// persist.deleteAccountData) — anything the other accounts also fed survives.
function appendForgetControl (host, row, onForget) {
  if (!onForget) return
  const zone = div('su-acct-forget')
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'su-danger'
  btn.textContent = 'Forget this account’s data'
  btn.addEventListener('click', () => onForget(row))
  zone.appendChild(btn)
  zone.appendChild(div('su-muted small', 'deletes the events, stored message bodies and training record for ' +
    (row.account_email || row.account_id) + ', plus the projects and people only this account taught SuperLazy. ' +
    'Anything your other account(s) also know about is kept. Your mail itself is untouched.'))
  host.appendChild(zone)
}

// "Force resync now" for ONE source (user, 2026-09-09 — it used to be one global button under the
// list): takes over a stuck run and processes anything pending for THIS account only.
function appendResyncControl (host, row, onForceResync) {
  if (!onForceResync || !row.rec || row.paused) return
  const zone = div('su-acct-resync')
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'su-secondary'
  btn.textContent = '⟳ Force resync now'
  const info = div('su-muted small', 'If processing of this source seems stuck (a tab closed mid-run), this takes over and processes anything pending for it — including items an earlier run lost sight of (it re-scans the whole pending queue). Late responses from the old run are discarded safely.')
  btn.addEventListener('click', () => { btn.disabled = true; onForceResync(row, { btn, info }) })
  zone.appendChild(btn)
  zone.appendChild(info)
  host.appendChild(zone)
}

// Pause / resume syncing for ONE stored account. Pausing is reversible and loses nothing: the
// record's cursor simply stops moving, and every check (in-tab, background job, Inspect) skips
// the account until it is resumed — see ingest.js resolveAccounts.
function appendPauseControl (host, row, onTogglePause) {
  if (!onTogglePause || !row.rec) return
  const rec = row.rec
  const zone = div('su-acct-pause')
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'su-secondary'
  btn.textContent = rec.sync_paused ? '▶ Resume syncing' : '⏸ Pause syncing'
  btn.addEventListener('click', () => { btn.disabled = true; onTogglePause(row) })
  zone.appendChild(btn)
  const channelWord = row.channel === 'messages' ? 'messages' : (row.channel === 'work' ? 'sessions' : 'mail')
  zone.appendChild(div('su-muted small', rec.sync_paused
    ? 'Paused' + (rec.sync_paused_at ? ' since ' + fmtDT(rec.sync_paused_at) : '') + ' — no check reads this account’s ' +
      channelWord + ' (the in-tab check, the background job and Inspect all skip it). Nothing is lost: resuming continues from ' +
      (rec.cursor ? fmtDT(rec.cursor) : 'where it stopped') + '.'
    : 'Stops reading this account’s ' + channelWord + ' until you resume — useful when you are away, or while a busy source is costing more than it is worth. Everything learned so far stays.'))
  host.appendChild(zone)
}

// Detail panel for the SELECTED account only — hidden entirely when nothing is chosen. Handlers:
//   onTrain(row, { historyDays, threadDays, model, contextChars }) — train a not-started account
//   onContinue(row)                           — resume an interrupted training
//   onTogglePause(row)                        — pause / resume this account's syncing
//   onForget(row)                             — delete just this account's data
export function renderAccountDetail (host, row, { defaultHistoryDays = 6, defaultThreadDays = 1, defaultModel = null, defaultContextChars = null, onTrain, onContinue, onTogglePause, onForget, onForceResync = null } = {}) {
  host.textContent = ''
  host.style.display = row ? '' : 'none'
  if (!row) return

  const head = div('su-acct-detail-head', esc(row.account_email || row.account_id))
  if (row.paused) head.appendChild(div('su-acct-chip paused', STATE_LABEL.paused))
  host.appendChild(head)

  if (row.state === 'trained') {
    const rec = row.rec || {}
    host.appendChild(div('su-muted', '✓ This account is set up' +
      (rec.messages_processed ? ' — ' + rec.messages_processed + ' message(s) analysed, up to ' + fmtDT(rec.cursor) : '') +
      (row.paused ? '. Syncing is paused.' : '. New mail is picked up on the Dashboard.')))
    appendResyncControl(host, row, onForceResync)
    appendPauseControl(host, row, onTogglePause)
    appendForgetControl(host, row, onForget)
    return
  }

  if (row.state === 'saved') {
    const rec = row.rec || {}
    const what = row.channel === 'messages' ? 'tracked conversations' : (row.channel === 'work' ? 'tracked repos\' sessions' : 'mail')
    host.appendChild(div('su-muted', 'Saved, not read yet. Nothing has been analysed for this account: the next check — the Check button, the background job or the schedule — reads its ' + what +
      (Number(rec.history_days) ? ' from the last ' + rec.history_days + ' days' : '') + ' and it becomes trained.' +
      (row.paused ? ' Syncing is paused, so that will not happen until you resume.' : '')))
    if (!row.paused) {
      // the first-read window is the user's choice, here too (user, 2026-09-08): a channel account
      // saved with one window can still be read with another
      const winRow = div('su-status-tools')
      const lab = document.createElement('label')
      lab.appendChild(document.createTextNode('Read the last '))
      const inp = document.createElement('input'); inp.type = 'number'; inp.min = '1'; inp.max = '120'; inp.style.width = '64px'
      inp.value = String(Number(rec.history_days) || defaultHistoryDays || 7)
      lab.appendChild(inp); lab.appendChild(document.createTextNode(' days'))
      winRow.appendChild(lab)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'su-primary'
      btn.textContent = '▶ Read it now'
      btn.addEventListener('click', () => onContinue && onContinue(row, { historyDays: Math.min(120, Math.max(1, parseInt(inp.value, 10) || 7)) }))
      winRow.appendChild(btn)
      host.appendChild(winRow)
    }
    return
  }

  if (row.state === 'training') {
    host.appendChild(div('su-muted', 'The history build was started on this account but has not finished — ' +
      String((row.rec && row.rec.messages_processed) || 0) + ' message(s) processed so far.' +
      (row.paused ? ' Syncing is paused, so the checks will not continue it until you resume.' : '')))
    if (!row.paused) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'su-primary'
      btn.textContent = '▶ Continue building history'
      btn.addEventListener('click', () => onContinue && onContinue(row))
      host.appendChild(btn)
    }
    appendResyncControl(host, row, onForceResync)
    appendPauseControl(host, row, onTogglePause)
    appendForgetControl(host, row, onForget)
    return
  }

  // not started: the start-training mini-form. The training knobs live HERE (they are per-training
  // suggestions, not preferences) — and so do the two COST dials, because this is the other moment
  // a user commits to spending: the first-run form is long gone once an account is trained, and
  // sending them to Preferences first would mean the choice is made by default instead of by them.
  host.appendChild(div('su-muted', 'This account has not been trained yet — SuperLazy has to read and ' +
    'analyze its email history before it can prioritize it.'))
  const form = div('su-acct-train-form')
  const history = numField('Analyze the last', defaultHistoryDays, 'days of email', { min: 1, max: 60 })
  form.appendChild(history.label)
  const thread = numField('Full thread context for the last', defaultThreadDays, 'day(s)', { min: 0, max: 30 })
  form.appendChild(thread.label)
  form.appendChild(div('su-muted small', 'more days = a smarter start, but more time and LLM cost · recent messages get their complete thread history'))

  const costWrap = div('su-cost-choices')
  const modelRow = document.createElement('label'); modelRow.className = 'su-cost-row'
  modelRow.appendChild(document.createTextNode('Which AI reads your mail'))
  const modelSel = document.createElement('select')
  const dflt = document.createElement('option'); dflt.value = 'default'; dflt.textContent = 'Recommended default'
  modelSel.appendChild(dflt)
  modelRow.appendChild(modelSel)
  const modelHint = div('su-muted small')
  modelRow.appendChild(modelHint)
  costWrap.appendChild(modelRow)

  const ctxRow = document.createElement('label'); ctxRow.className = 'su-cost-row'
  ctxRow.appendChild(document.createTextNode('Context sent per email'))
  const ctxSel = document.createElement('select')
  for (const c of CONTEXT_CHOICES) {
    const o = document.createElement('option'); o.value = String(c.chars); o.textContent = c.label
    ctxSel.appendChild(o)
  }
  ctxSel.value = String(defaultContextChars || DEFAULT_CONTEXT_CHARS)
  if (ctxSel.value !== String(defaultContextChars || DEFAULT_CONTEXT_CHARS)) ctxSel.value = String(DEFAULT_CONTEXT_CHARS)
  ctxRow.appendChild(ctxSel)
  ctxRow.appendChild(div('su-muted small', 'more context = better judgement per email, higher cost'))
  costWrap.appendChild(ctxRow)
  form.appendChild(costWrap)

  const chosenCtx = () => parseInt(ctxSel.value, 10) || DEFAULT_CONTEXT_CHARS
  populateModelSelect(modelSel, { stored: defaultModel, hintEl: modelHint })
    .catch(e => console.error('[superlazy] model picker failed', e))

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'su-primary'
  btn.textContent = 'Train this account'
  btn.addEventListener('click', () => {
    const num = (input, dflt) => { const n = parseInt(input.value, 10); return Number.isFinite(n) && n >= 0 ? n : dflt }
    if (onTrain) {
      onTrain(row, {
        historyDays: num(history.input, defaultHistoryDays) || defaultHistoryDays,
        threadDays: num(thread.input, defaultThreadDays),
        model: selectedModel(modelSel),
        contextChars: chosenCtx()
      })
    }
  })
  form.appendChild(btn)
  host.appendChild(form)
}
