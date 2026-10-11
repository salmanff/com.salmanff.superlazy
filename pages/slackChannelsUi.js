// slackChannelsUi.js — the ONE Slack channel-preferences UI, mounted wherever channel setup
// happens: the setup page's Channels tab (returning users), the messaging-only first-run
// welcome (a fresh Slack-only install), and the slacklab dev page (which adds its dry-run
// tooling underneath). Extracted from slacklab.js when the lab stopped being the entry point
// (user, 2026-08-30: "the same UI should be presented when a user first sets up slack").
//
// What it does: pick a messaging connection → show identity + the live-updates pill → the
// conversation roster with per-conversation `tracked` checkboxes (member channels + DMs default
// in, public channels opt-in) → "Save selection" seeds/updates the `channel:'messages'` account
// (Save and Read are SEPARATE buttons — user, 2026-09-11: "Save selection" is local to this
//  workspace and only saves; "Read data" reads every untrained or interrupted channel account —
//  Slack and agent stores — in one chronological pass. The host supplies onReadAll() and
//  readTargets() → [{ label, state }] for the note beside the button; without onReadAll (the lab)
//  the Read button is not shown.)
// record. Saving is the ONLY write; roster edits stay local until then. Once saved, the normal
// checks analyse the tracked conversations like mail.

import { createSlackSource } from '../jobs/analyze_thread/slackSource.js'

const el = (tag, cls, text) => {
  const d = document.createElement(tag)
  if (cls) d.className = cls
  if (text != null) d.textContent = text
  return d
}
const deep = (o) => JSON.parse(JSON.stringify(o))

// host: a DOM node to render into (cleared). opts:
//   freezr, persist        — the page's instances (persist must have loadAll-populated recIds,
//                            or pass storedAccounts from the same loadAll so saves UPDATE)
//   storedAccounts         — array of stored account records (all channels; mutated on save so
//                            the caller's copy stays current)
//   onSaved(rec)           — called after a successful save
//   onConnectionLoaded({ connectionName, workRec, src }) — the lab hooks its dry-run build here
// Returns { reload } — re-runs the connection load (after an external change).
// connectionName (optional): FIXED mode — render for that one workspace only, no picker (the Status
// tab's resource detail mounts one module per Slack row).
export function renderSlackChannels (host, { freezr: F, persist, storedAccounts = [], onSaved = null, onConnectionLoaded = null, connectionName = null, onReadAll = null, readTargets = null } = {}) {
  host.textContent = ''
  const status = el('div', 'slch-status', 'Loading messaging connections…')
  host.appendChild(status)
  const body = el('div', 'slch-body')
  body.hidden = true
  host.appendChild(body)

  const setStatus = (text, bad) => { status.textContent = text; status.classList.toggle('slch-bad', !!bad) }

  if (!F || !F.connections || !F.connections.messaging) {
    setStatus('Messaging is not available — grant superlazy the messaging permission in Settings and connect a Slack account at /account/resources.', true)
    return { reload: () => {} }
  }

  // ---- structure -------------------------------------------------------------------------------
  const row = el('div', 'slch-row')
  const connSel = el('select', 'slch-conn')
  const livePill = el('span', 'slch-pill')
  row.appendChild(connSel); row.appendChild(livePill)
  body.appendChild(row)
  const identity = el('div', 'slch-muted')
  body.appendChild(identity)
  const rosterMeta = el('div', 'slch-muted')
  body.appendChild(rosterMeta)
  const table = el('table', 'slch-table')
  table.innerHTML = '<thead><tr><th>track</th><th>conversation</th><th>type</th><th>member</th></tr></thead>'
  const tbody = el('tbody')
  table.appendChild(tbody)
  body.appendChild(table)
  // how far back the FIRST read goes (stored as the account's backfill floor — formation never
  // fetches past it). Irrelevant once the account is trained; the row says so then.
  const daysRow = el('div', 'slch-row')
  const daysLabel = el('label', 'slch-muted', 'read the last ')
  const daysIn = el('input')
  daysIn.type = 'number'
  daysIn.min = '1'; daysIn.max = '90'; daysIn.value = '14'
  daysIn.style.width = '4.5em'
  daysLabel.appendChild(daysIn)
  daysLabel.appendChild(document.createTextNode(' days of history on the first read'))
  const daysHint = el('span', 'slch-muted')
  daysRow.appendChild(daysLabel); daysRow.appendChild(daysHint)
  body.appendChild(daysRow)
  const saveRow = el('div', 'slch-row')
  const saveBtn = el('button', 'slch-btn', 'Save selection')
  saveBtn.type = 'button'
  // READ: its own button, not local to this workspace (see the header) — and always available, so
  // a read stopped midway can be restarted from here
  const readRow = el('div', 'slch-row'); readRow.hidden = !onReadAll
  const readBtn = el('button', 'slch-btn', 'Read data'); readBtn.type = 'button'; readRow.appendChild(readBtn)
  const readNote = el('span', 'slch-muted'); readRow.appendChild(readNote)
  const paintReadNote = () => {
    if (!onReadAll) return
    const t = (typeof readTargets === 'function' ? (readTargets() || []) : [])
    readBtn.disabled = !t.length
    readNote.textContent = t.length
      ? 'reads ' + t.map(x => x.label + (x.state ? ' (' + x.state + ')' : '')).join(', ') + ' — oldest first across all of them'
      : 'nothing to read — every saved source is up to date'
  }
  readBtn.addEventListener('click', async () => {
    if (!onReadAll) return
    readBtn.disabled = true; readNote.textContent = 'Starting…'
    try { await onReadAll() } finally { paintReadNote() }
  })
  const saveNote = el('span', 'slch-muted')
  saveRow.appendChild(saveBtn); saveRow.appendChild(saveNote)
  body.appendChild(saveRow)
  body.appendChild(readRow)

  let connections = []
  let workRec = null
  let src = null

  async function init () {
    try {
      const probe = createSlackSource({ freezr: F, dryRun: true })
      const res = await probe.listAccounts()
      connections = res.accounts || []
      if (connectionName) {
        connections = connections.filter(c => c.account_id === connectionName)
        if (!connections.length) { setStatus('The connection "' + connectionName + '" is not available to SuperLazy (not granted, or removed).', true); return }
        connSel.hidden = true
      }
      if (!connections.length) {
        setStatus('No messaging-enabled connection found. Connect a Slack account at /account/resources, then reload.', true)
        return
      }
      connSel.innerHTML = ''
      for (const c of connections) {
        const o = el('option', null, c.account_id + (c.account_email && c.account_email !== c.account_id ? ' (' + c.account_email + ')' : ''))
        o.value = c.account_id
        connSel.appendChild(o)
      }
      connSel.addEventListener('change', () => loadConnection(connSel.value))
      saveBtn.addEventListener('click', saveSelection)
      body.hidden = false
      await loadConnection(connSel.value)
    } catch (e) {
      if (F.connections.messaging.handleTokenExpired && F.connections.messaging.handleTokenExpired(e)) return
      setStatus('Could not load: ' + ((e && e.message) || e), true)
    }
  }

  async function loadConnection (connectionName) {
    setStatus('Loading the conversation roster for ' + connectionName + '…')
    const stored = storedAccounts.find(r => r.account_id === connectionName)
    workRec = stored ? deep(stored) : { account_id: connectionName, cursor: 0, channel: 'messages', provider: 'slack' }
    src = createSlackSource({ freezr: F, accounts: [workRec], dryRun: true })
    try {
      const caps = await src.liveCapability()
      const liveHere = !!(caps.active && (caps.live_connections || []).includes(connectionName))
      livePill.textContent = liveHere ? 'live updates: ACTIVE (socket-fed)' : ('live updates: off — ' + (caps.blocked_by || 'polling mode'))
      livePill.className = 'slch-pill' + (liveHere ? ' slch-pill-on' : '')
      await src.ensureIdentity(workRec)
      identity.textContent = 'You on this workspace: ' + (workRec.me_email || '(no attested email)') +
        ' · team ' + (workRec.team_id || '?') +
        (stored ? (Number(stored.cursor) > 0 ? ' · being analysed (trained)' : ' · saved, first analysis pending') : ' · not saved yet')
      const trained = !!(stored && Number(stored.cursor) > 0)
      daysRow.style.display = trained ? 'none' : ''
      saveBtn.textContent = 'Save selection'   // Save is local and only saves; Read is its own button
      paintReadNote()
      if (!trained && stored && Number(stored.history_days)) daysIn.value = String(stored.history_days)
      await src.ensureRoster(workRec)
      renderRoster() // paint immediately with whatever names are known…
      setStatus('Resolving people’s names…')
      await src.ensureRosterNames(workRec) // …then swap provider codes for the actual people
      renderRoster()
      setStatus('Tick the conversations SuperLazy should read (member channels and DMs are on by default; public channels are opt-in), then Save.')
      if (onConnectionLoaded) onConnectionLoaded({ connectionName, workRec, src })
    } catch (e) {
      if (F.connections.messaging.handleTokenExpired && F.connections.messaging.handleTokenExpired(e)) return
      setStatus('Roster failed: ' + ((e && e.message) || e), true)
    }
  }

  function renderRoster () {
    const convs = Object.entries(workRec.conversations || {})
      .sort((a, b) => (a[1].type > b[1].type ? 1 : a[1].type < b[1].type ? -1 : (String(a[1].name) > String(b[1].name) ? 1 : -1)))
    tbody.textContent = ''
    for (const [, c] of convs) {
      const tr = el('tr')
      const tdT = el('td')
      const cb = el('input')
      cb.type = 'checkbox'
      cb.checked = !!c.tracked
      cb.addEventListener('change', () => { c.tracked = cb.checked; paintMeta() })
      tdT.appendChild(cb)
      tr.appendChild(tdT)
      const label = (c.type === 'channel' || c.type === 'private_channel')
        ? '#' + c.name
        : (c.display || (String(c.name).startsWith('dm:') || String(c.name).startsWith('mpdm-') ? '(name still resolving — ' + c.name + ')' : c.name))
      tr.appendChild(el('td', null, label))
      tr.appendChild(el('td', null, c.type === 'group_dm' ? 'group DM' : (c.type === 'dm' ? 'DM' : c.type)))
      tr.appendChild(el('td', null, c.is_member ? 'yes' : 'no'))
      tbody.appendChild(tr)
    }
    paintMeta()
    function paintMeta () {
      const t = Object.values(workRec.conversations || {}).filter(c => c.tracked).length
      rosterMeta.textContent = convs.length + ' conversation(s); ' + t + ' tracked'
    }
  }

  async function saveSelection () {
    if (!workRec) return
    // hide the button and spin at once — the save plus whatever the mount does next (the
    // foreground training's planning phase, notably) takes seconds before anything else shows
    saveBtn.hidden = true
    const spin = el('span', 'freezr-spinner')
    saveRow.insertBefore(spin, saveNote)
    saveNote.textContent = 'Saving…'
    try {
      const stored = storedAccounts.find(r => r.account_id === workRec.account_id)
      // merge ONLY what this UI owns (identity + roster choices) onto the stored record — a live
      // account's sync state (cursor, tokens, stream cursors) must never be overwritten
      const rec = stored ? { ...stored } : {
        account_id: workRec.account_id,
        account_email: workRec.account_email || workRec.me_email || '',
        provider: 'slack',
        source_id: 'live:connections.messaging',
        channel: 'messages',
        status: 'training',
        cursor: 0,
        backfill_from: 0,
        backfill_done: false,
        messages_processed: 0,
        messages_skipped: 0
      }
      rec.channel = 'messages'
      rec.source_id = 'live:connections.messaging'
      rec.team_id = workRec.team_id || rec.team_id
      rec.me_user_id = workRec.me_user_id || rec.me_user_id
      rec.me_email = workRec.me_email || rec.me_email
      rec.conversations = workRec.conversations || {}
      // the first-read window: a NOT-YET-TRAINED account gets its backfill floor from the days
      // input (formation never fetches past backfill_from); a trained account keeps its history
      if (!(Number(rec.cursor) > 0)) {
        const days = Math.min(90, Math.max(1, parseInt(daysIn.value, 10) || 14))
        rec.history_days = days
        rec.backfill_from = Date.now() - days * 24 * 3600 * 1000
      }
      await persist.saveAccount(rec)
      if (!stored) storedAccounts.push(rec)
      saveNote.textContent = 'Saved — ' + Object.values(rec.conversations).filter(c => c.tracked).length +
        ' conversation(s) tracked. ' +
        (Number(rec.cursor) > 0 ? 'The next check reads the changes.' : 'Not read yet — press “Read data” to read now, or leave it for the next check.')
      paintReadNote()
      // awaited so the spinner covers whatever follows the save too (e.g. the foreground
      // training's planning phase, which takes seconds before its own modal appears)
      if (onSaved) await onSaved(rec)
    } catch (e) {
      saveNote.textContent = 'Save failed: ' + ((e && e.message) || e)
    } finally {
      spin.remove()
      saveBtn.hidden = false
    }
  }

  init()
  return { reload: () => connSel.value && loadConnection(connSel.value) }
}
