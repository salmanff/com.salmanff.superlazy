// slacklab.js — the Slack DEV LAB. Channel setup itself (connection picker, roster opt-in/out,
// Save selection) is the SHARED slackChannelsUi.js module — the same UI the setup page mounts
// on its Channels tab and on the messaging-only welcome. What this page ADDS is the dev tooling:
// a formation DRY RUN over a chosen window (nothing persisted — chunk transcripts, the
// user-resolution table, a volume/cost projection), for tuning chunking against a real workspace.

import { createSlackSource } from '../jobs/analyze_thread/slackSource.js'
import { renderSlackChannels } from '../pages/slackChannelsUi.js'
import { createPersistence } from '../jobs/analyze_thread/persist.js'

const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const d = document.createElement(tag)
  if (cls) d.className = cls
  if (text != null) d.textContent = text
  return d
}
const fmtDate = (ms) => { try { return new Date(Number(ms)).toLocaleString() } catch (e) { return String(ms) } }

const F = typeof freezr !== 'undefined' ? freezr : null
const persist = createPersistence(F)

let storedAccounts = []   // stored account records (all channels), from loadAll
let current = null        // { connectionName, workRec, src } from the channels module
let building = false

function setStatus (text, bad) {
  const s = $('slStatus')
  s.textContent = text
  s.style.color = bad ? '#b3261e' : ''
}

// ---- init --------------------------------------------------------------------------------------

async function init () {
  try {
    const snapshot = await persist.loadAll()
    storedAccounts = (snapshot && snapshot.accounts) || []
  } catch (e) {
    storedAccounts = []
  }
  renderSlackChannels($('slChannelsHost'), {
    freezr: F,
    persist,
    storedAccounts,
    // this page SAVES only; the dry-run button below is the read — no onReadAll, so no Read button
    onConnectionLoaded: (loaded) => {
      current = loaded
      $('slResults').hidden = true
      $('slBuildNote').textContent = ''
      setStatus('Roster loaded for ' + loaded.connectionName + ' — build a dry run below, or Save the selection above.')
    }
  })
  $('slBuildBtn').addEventListener('click', build)
  $('slSetup').hidden = false
  setStatus('Loading…')
}

// ---- the dry run --------------------------------------------------------------------------------

async function build () {
  if (building || !current) return
  building = true
  $('slBuildBtn').disabled = true
  const days = Number($('slDaysSel').value) || 6
  const fromMs = Date.now() - days * 24 * 3600 * 1000
  const { workRec, src } = current
  // history mode needs cursor 0 on the WORK COPY — a stored trained account would otherwise take
  // the steady-state getNewer path. This is a dry run: forcing history here fetches the window
  // without touching the real record.
  workRec.cursor = 0
  workRec.streams = []
  workRec.conv_tokens = {}
  workRec.backfill_from = 0 // the dry run's own window select wins over a saved first-read floor
  setStatus('Building chunks (dry run — nothing is stored)…')
  $('slBuildNote').textContent = ''
  try {
    const summary = await src.formAll({
      fromMs,
      onPage: ({ connectionName, rows, pages }) => setStatus('Fetching ' + connectionName + ' — conversation ' + pages + ', ' + rows + ' message(s)…')
    })
    renderResults(summary, days)
    const savedRec = storedAccounts.find(r => r.account_id === workRec.account_id && r.channel === 'messages')
    setStatus('Dry run done: ' + summary.chunks.length + ' chunk(s)' +
      (summary.truncated ? ' — TRUNCATED (deadline/caps hit; a real run continues next check)' : '') +
      (summary.errors.length ? ' — ' + summary.errors.length + ' error(s), see console' : '') +
      (savedRec ? '' : '. ⚠ NOTHING IS SAVED — press “Save selection” above or the checks will see no Slack.'),
    !!summary.errors.length || !savedRec)
  } catch (e) {
    setStatus('Build failed: ' + ((e && e.message) || e), true)
  } finally {
    building = false
    $('slBuildBtn').disabled = false
  }
}

function renderResults (summary, days) {
  $('slResults').hidden = false

  // ---- volume & cost projection
  const byConv = new Map()
  for (const c of summary.chunks) {
    if (!byConv.has(c.conversation_id)) byConv.set(c.conversation_id, { chunks: 0, msgs: 0, chars: 0, title: c.title })
    const v = byConv.get(c.conversation_id)
    v.chunks++
    v.msgs += (c.messages_raw || []).length
    v.chars += String(c.body_text || '').length
  }
  const vol = $('slVolume')
  vol.innerHTML = ''
  const totChars = [...byConv.values()].reduce((n, v) => n + v.chars, 0)
  const totMsgs = [...byConv.values()].reduce((n, v) => n + v.msgs, 0)
  const estTokens = Math.round(totChars / 4)
  const table = el('table', 'slch-table')
  table.innerHTML = '<thead><tr><th>conversation</th><th>chunks</th><th>msgs</th><th>chars</th><th>/day</th></tr></thead>'
  const tb = el('tbody')
  for (const [, v] of [...byConv.entries()].sort((a, b) => b[1].chars - a[1].chars)) {
    const tr = el('tr')
    tr.appendChild(el('td', null, v.title))
    tr.appendChild(el('td', null, String(v.chunks)))
    tr.appendChild(el('td', null, String(v.msgs)))
    tr.appendChild(el('td', null, v.chars.toLocaleString()))
    tr.appendChild(el('td', null, Math.round(v.chars / days).toLocaleString()))
    tb.appendChild(tr)
  }
  table.appendChild(tb)
  vol.appendChild(table)
  const note = el('div', 'slch-muted',
    'Window: ' + days + ' day(s) · ' + summary.chunks.length + ' chunk(s), ' + totMsgs + ' message(s), ' +
    totChars.toLocaleString() + ' transcript chars ≈ ' + estTokens.toLocaleString() + ' body tokens. ' +
    'Each chunk costs one analysis slot (plus prompt/context overhead — the same overhead an email pays). ' +
    'Held by the debounce this pass: ' + summary.held + '. Sync mode: ' +
    Object.entries(summary.mode_by_account).map(([k, v]) => k + '=' + v).join(', '))
  vol.appendChild(note)

  // ---- user-resolution table
  const users = new Map()
  for (const c of summary.chunks) {
    for (const m of (c.messages_raw || [])) {
      const key = m.author_id || m.author_name
      if (!users.has(key)) users.set(key, { id: m.author_id || '', name: m.author_name, email: m.author_email || '', bot: m.is_bot, msgs: 0 })
      users.get(key).msgs++
    }
  }
  const utb = $('slUsers').querySelector('tbody')
  utb.innerHTML = ''
  for (const u of [...users.values()].sort((a, b) => b.msgs - a.msgs)) {
    const tr = el('tr')
    tr.appendChild(el('td', null, u.id))
    tr.appendChild(el('td', null, u.name))
    tr.appendChild(el('td', u.email ? null : 'sl-lab-warn', u.email || '(none — would key slack:' + u.id + ')'))
    tr.appendChild(el('td', null, u.bot ? 'bot' : ''))
    tr.appendChild(el('td', null, String(u.msgs)))
    utb.appendChild(tr)
  }

  // ---- chunks as transcripts
  const box = $('slChunks')
  box.innerHTML = ''
  $('slChunkCount').textContent = '(' + summary.chunks.length + ')'
  for (const c of [...summary.chunks].sort((a, b) => a.date - b.date)) {
    const d = el('details', 'sl-lab-chunk')
    const sum = el('summary', null,
      fmtDate(c.first_ts) + (c.last_ts !== c.first_ts ? ' → ' + fmtDate(c.last_ts) : '') + ' · ' + c.title +
      ' · ' + (c.messages_raw || []).length + ' msg(s)' +
      (c.item_kind === 'thread' ? ' · THREAD' : '') +
      (c.in_reply_to ? ' · inlines previous chunk' : ''))
    d.appendChild(sum)
    d.appendChild(el('div', 'slch-muted', 'chunk id: ' + c.msg_id + ' · stream: ' + c.thread_id))
    const pre = el('pre', 'sl-lab-pre', c.body_text || '(empty)')
    d.appendChild(pre)
    box.appendChild(d)
  }
}

init()
