// workSessionsUi.js — the SHARED setup UI for the WORK channel (AI coding-agent sessions read
// through use_file_sys connections), mounted wherever channel setup happens: each store's detail
// panel on the Setup page's Status tab (production path — the sibling of slackChannelsUi.js), the
// work-only first-run welcome, and the agentslab dev page. Same contract as renderSlackChannels:
//   renderWorkSessions(host, { freezr, persist, storedAccounts, settings, onSaved, onConnectionLoaded,
//                            only, onReadAll, readTargets })
// SAVE and READ are separate buttons (user, 2026-09-11). "Save selection" is LOCAL to this store and
// only saves. "Read data" reads EVERY untrained or interrupted channel account — all agent stores
// and Slack — in one chronological pass; the host supplies onReadAll() (the runner) and
// readTargets() → [{ label, state }] (what the note beside the button lists). With no onReadAll
// (the labs) the Read button is not shown at all.
// ONE BLOCK PER FILE STORE (user, 2026-09-09: with a Claude store and a Codex store side by side, a
// dropdown hid the second one): each block detects its layout (which agent), lists the repos, offers
// the first-read window and its own Save. Save seeds (or updates) that store's `channel:'work'` account
// record — from then on the normal checks form one input item per finished request-and-answer turn,
// exactly like Slack chunks or mail. Nothing else is written here; analysis is the pipeline's job.

import { createSessionsSource, listFsConnections, explainFsError } from '../jobs/analyze_thread/sessionsSource.js'
import { WORK_SOURCE_ID, isWorkAccount, agentNameFor } from '../jobs/analyze_thread/workSource.js'
import { fmtTs, fmtDuration } from '../jobs/analyze_thread/sessionDigest.js'

const DAY = 24 * 3600 * 1000
const deep = (o) => JSON.parse(JSON.stringify(o))
const el = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d }
// the slug is the cwd slugified — its tail is the repo folder name
export const repoLabel = (slug) => String(slug || '').split('-').filter(Boolean).slice(-3).join('-')

const LAYOUT_LABEL = {
  claude_home: '~/.claude — Claude Code transcripts + live-session registry',
  projects: '~/.claude/projects — Claude Code transcripts only',
  codex_sessions: '~/.codex/sessions — Codex rollouts by date',
  codex_home: '~/.codex — only sessions/ is read'
}

// only (optional): render just that one store's block, without the global status line (the Status
// tab's resource detail mounts one module per store row).
export function renderWorkSessions (host, { freezr: F, persist, storedAccounts = [], settings = {}, onSaved = null, onConnectionLoaded = null, only = null, onReadAll = null, readTargets = null } = {}) {
  host.textContent = ''
  const status = el('div', 'wks-status', 'Loading file-system connections…')
  host.appendChild(status)
  const setStatus = (text, bad) => { status.textContent = text; status.classList.toggle('wks-bad', !!bad) }
  const help = el('div', 'wks-help'); help.hidden = true
  help.innerHTML = '<p>No file store is visible to SuperLazy yet. To set one up:</p><ol>' +
    '<li>As an admin on localhost, turn on <em>local_fs_access_enabled</em> in the admin prefs.</li>' +
    '<li>At <a href="/account/resources" target="_blank" rel="noopener">/account/resources</a> add a local file store per agent: <code>~/.claude/projects</code> for Claude Code, <code>~/.codex/sessions</code> for Codex. Mount the transcript folders, never <code>~/.claude</code> or <code>~/.codex</code> themselves — both hold login credentials (Claude Code keeps <code>.credentials.json</code> there on Linux; Codex keeps <code>auth.json</code>). Not your home folder or <code>/</code>: those contain the freezr installation and are refused.</li>' +
    '<li>Grant SuperLazy the <em>read_work_sessions</em> permission in the app\'s Settings and pick the store(s).</li></ol>'
  host.appendChild(help)

  // ME is shared across stores — the same person prompts every agent
  const meRow = el('div', 'wks-row')
  const meLab = el('label', null, 'You (ME) ')
  const meIn = el('input'); meIn.type = 'email'; meIn.placeholder = 'your@address'; meIn.size = 28; meLab.appendChild(meIn); meRow.appendChild(meLab)
  meRow.appendChild(el('span', 'wks-muted', 'the author of every prompt; the agent (Claude Code, Codex…) is the other party — a team member without an address'))
  meRow.hidden = true
  host.appendChild(meRow)
  meIn.value = ((settings && settings.your_addresses) || [])[0] ||
    ((storedAccounts.find(r => r.account_email && !isWorkAccount(r) && r.channel !== 'messages') || {}).account_email) || ''
  const me = () => String(meIn.value || '').trim().toLowerCase()

  const blocksHost = el('div', 'wks-blocks')
  host.appendChild(blocksHost)
  const blocks = []          // one per fs connection
  let currentBlock = null    // the block last loaded / interacted with (the lab's dev tools act on it)

  // ---- one file store = one block --------------------------------------------------------------
  function makeBlock (conn) {
    const name = conn.connectionName
    const b = { name, reader: null, layout: null, workRec: null, repos: [], busy: false }
    const box = el('div', 'wks-block')
    const head = el('div', 'wks-block-head')
    const title = el('span', 'wks-block-title', name)
    const agentPill = el('span', 'wks-pill', '…')
    const layoutNote = el('span', 'wks-muted', '')
    head.appendChild(title); head.appendChild(agentPill); head.appendChild(layoutNote)
    box.appendChild(head)
    const bstatus = el('div', 'wks-status', 'Reading the file store…')
    box.appendChild(bstatus)
    const setB = (text, bad) => { bstatus.textContent = text; bstatus.classList.toggle('wks-bad', !!bad) }
    const body = el('div', 'wks-body'); body.hidden = true
    box.appendChild(body)

    const tableWrap = el('div', 'wks-tablewrap')
    const table = el('table', 'wks-table')
    table.innerHTML = '<thead><tr><th>Read</th><th>Repo</th><th>Last session activity</th><th class="wks-num">Sessions</th><th class="wks-num">In window</th></tr></thead>'
    const tbody = el('tbody'); table.appendChild(tbody); tableWrap.appendChild(table); body.appendChild(tableWrap)
    const repoNote = el('div', 'wks-muted', ''); body.appendChild(repoNote)
    const allNote = el('div', 'wks-muted', 'Every repo is read by default, and a repo that appears later is read automatically — the date window is the only cut. Untick a repo only to exclude it.')
    body.appendChild(allNote)

    const windowBox = el('div', 'wks-window')
    const daysLab = el('label', 'wks-window-lab', 'How far back should the first read go? ')
    const daysIn = el('input'); daysIn.type = 'number'; daysIn.value = '7'; daysIn.min = '1'; daysIn.max = '120'
    daysLab.appendChild(daysIn); daysLab.appendChild(document.createTextNode(' days'))
    windowBox.appendChild(daysLab)
    const windowNote = el('div', 'wks-muted', 'Sessions whose file changed within this many days are read; the "In window" column shows how many per repo. Every finished request-and-answer turn in them becomes one analysed item, so more days means more turns and more cost. Older turns of those sessions are kept as thread context only. After the first read, every check picks up only what is new.')
    windowBox.appendChild(windowNote)
    const trainedNote = el('div', 'wks-muted', ''); trainedNote.hidden = true
    windowBox.appendChild(trainedNote)
    body.appendChild(windowBox)

    const saveRow = el('div', 'wks-row wks-saverow')
    const saveBtn = el('button', 'wks-btn wks-btn-primary', 'Save selection'); saveBtn.type = 'button'; saveBtn.disabled = true; saveRow.appendChild(saveBtn)
    const saveNote = el('span', 'wks-muted', ''); saveRow.appendChild(saveNote)
    // READ is its own button and is NOT local to this store: it reads every untrained or interrupted
    // channel account (agents + Slack) in one chronological pass; the note says which. A stopped
    // read is therefore always restartable from here (the old combined button became Save-only
    // once a store counted as trained, leaving no way back in).
    const readRow = el('div', 'wks-row wks-readrow'); readRow.hidden = !onReadAll
    const readBtn = el('button', 'wks-btn', 'Read data'); readBtn.type = 'button'; readRow.appendChild(readBtn)
    const readNote = el('span', 'wks-muted', ''); readRow.appendChild(readNote)
    const paintReadNote = () => {
      if (!onReadAll) return
      const t = (typeof readTargets === 'function' ? (readTargets() || []) : [])
      readBtn.disabled = !t.length || b.busy
      readNote.textContent = t.length
        ? 'reads ' + t.map(x => x.label + (x.state ? ' (' + x.state + ')' : '')).join(', ') + ' — oldest first across all of them'
        : 'nothing to read — every saved source is up to date'
    }
    readBtn.addEventListener('click', async () => {
      if (!onReadAll) return
      readBtn.disabled = true; readNote.textContent = 'Starting…'
      try { await onReadAll() } finally { paintReadNote() }
    })
    body.appendChild(saveRow)
    body.appendChild(readRow)
    blocksHost.appendChild(box)

    const days = () => Math.min(120, Math.max(1, parseInt(daysIn.value, 10) || 7))
    const trained = () => !!(b.workRec && (Number(b.workRec.last_sync_ms) > 0 || Number(b.workRec.cursor) > 0))
    // a repo is read unless EXPLICITLY excluded (tracked === false) — user, 2026-09-09: no repo is left
    // out by default; the date window is the only cut, and new repos are read automatically
    const isRead = (slug) => { const r = b.workRec && b.workRec.repos && b.workRec.repos[slug]; return !(r && r.tracked === false) }
    const trackedSet = () => new Set(b.repos.map(r => r.slug).filter(isRead))
    const touch = () => { currentBlock = b }

    function paintWindow (stored) {
      const isTrained = trained()
      daysLab.hidden = isTrained; windowNote.hidden = isTrained
      trainedNote.hidden = !isTrained
      saveBtn.textContent = 'Save selection'   // Save is local and only saves; Read is its own button
      paintReadNote()
      if (isTrained) {
        const hd = Number((stored && stored.history_days) || (b.workRec && b.workRec.history_days)) || 0
        trainedNote.textContent = 'First read done' + (hd ? ' (it covered the last ' + hd + ' days)' : '') + ' — each check now picks up only new turns. Newly ticked repos are read from their recent sessions on the next check.'
      } else if (stored && Number(stored.history_days)) daysIn.value = String(stored.history_days)
    }
    function paintRepos () {
      tbody.textContent = ''
      if (!b.repos.length) { const tr = el('tr'); const td = el('td', 'wks-muted', '(no repo folders found in this store' + (b.layout && b.layout.provider === 'codex' ? ' in the last 30 days' : '') + ')'); td.colSpan = 5; tr.appendChild(td); tbody.appendChild(tr) }
      for (const r of b.repos) {
        const tr = el('tr')
        const td = el('td'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = isRead(r.slug)
        cb.addEventListener('change', () => { touch(); b.workRec.repos[r.slug] = { ...(b.workRec.repos[r.slug] || {}), tracked: cb.checked, name: r.name }; repoNote.textContent = trackedSet().size + ' of ' + b.repos.length + ' tracked' })
        td.appendChild(cb); tr.appendChild(td)
        const nm = el('td', 'wks-repo', r.name || repoLabel(r.slug)); nm.title = r.cwd || r.slug; tr.appendChild(nm)
        tr.appendChild(el('td', null, r.mtimeMs ? fmtTs(r.mtimeMs) + ' (' + fmtDuration(Date.now() - r.mtimeMs) + ' ago)' : '?'))
        tr.appendChild(el('td', 'wks-num', r.sessions != null ? String(r.sessions) : '…'))
        tr.appendChild(el('td', 'wks-num', r.inWindow != null ? String(r.inWindow) : '…'))
        tbody.appendChild(tr)
      }
      repoNote.textContent = b.repos.length ? trackedSet().size + ' of ' + b.repos.length + ' tracked' : ''
    }
    async function countSessions () {
      const since = Date.now() - days() * DAY
      for (const r of b.repos) {
        try {
          const files = await b.reader.listSessionFiles({ repoSlugs: [r.slug] })
          r.sessions = files.length; r.inWindow = files.filter(f => f.mtimeMs >= since).length
        } catch (e) { r.sessions = 0; r.inWindow = 0 }
        paintRepos()
      }
    }

    async function load () {
      try {
        b.reader = createSessionsSource({ freezr: F, connectionName: name })
        b.layout = await b.reader.detectLayout()
        const provider = b.layout.provider || 'claude_code'
        agentPill.textContent = agentNameFor(provider)
        layoutNote.textContent = LAYOUT_LABEL[b.layout.kind] || b.layout.kind
        const stored = storedAccounts.find(r => r.account_id === name && isWorkAccount(r))
        b.workRec = stored ? deep(stored) : { account_id: name, channel: 'work', provider, source_id: WORK_SOURCE_ID, cursor: 0, repos: {}, sessions: {} }
        b.workRec.provider = provider
        if (b.workRec.me_email && !me()) meIn.value = b.workRec.me_email
        paintWindow(stored)
        const repos = await b.reader.listRepos()
        b.repos = repos.map(r => ({ ...r, name: (b.workRec.repos[r.slug] && b.workRec.repos[r.slug].name) || repoLabel(r.slug), sessions: null, inWindow: null }))
        const since = Date.now() - days() * DAY
        for (const r of b.repos) if (!b.workRec.repos[r.slug]) b.workRec.repos[r.slug] = { tracked: true, name: r.name, first_seen: Date.now() }
        paintRepos()
        body.hidden = false
        saveBtn.disabled = false
        setB((stored ? 'Saved' : 'Not saved yet') + ' · ' + repos.length + ' repo' + (repos.length === 1 ? '' : 's') +
          (trained() ? ' · being analysed (' + Object.keys(b.workRec.sessions || {}).length + ' session(s) read so far)' : ' · not analysed yet') +
          '. Tick the repos SuperLazy should read, then Save.')
        if (!currentBlock) touch()
        if (onConnectionLoaded) onConnectionLoaded({ connectionName: name, workRec: b.workRec, reader: b.reader })
        countSessions().catch(() => {})
      } catch (e) {
        setB(explainFsError(e), true)
      }
    }

    async function save () {
      if (!b.workRec || b.busy) return
      touch()
      const meAddr = me()
      if (!meAddr) { setStatus('Enter your own address (ME) first — every prompt is authored by you.', true); meIn.focus(); return }
      b.busy = true; saveBtn.hidden = true
      const spin = el('span', 'freezr-spinner'); saveRow.insertBefore(spin, saveNote)
      saveNote.textContent = 'Saving…'
      try {
        const stored = storedAccounts.find(r => r.account_id === name && isWorkAccount(r))
        const provider = b.workRec.provider || 'claude_code'
        // merge ONLY what this UI owns (identity + roster + first-read window) onto the stored record —
        // a live account's sync state (cursor, high-water marks, last_sync_ms) is never overwritten
        const rec = stored ? { ...stored } : {
          account_id: name, account_email: meAddr, provider, source_id: WORK_SOURCE_ID, channel: 'work',
          status: 'training', cursor: 0, backfill_from: 0, backfill_done: false, messages_processed: 0, messages_skipped: 0, sessions: {}
        }
        rec.channel = 'work'; rec.source_id = WORK_SOURCE_ID; rec.provider = provider
        rec.me_email = meAddr; rec.account_email = meAddr
        rec.repos = b.workRec.repos || {}
        if (!(Number(rec.last_sync_ms) > 0) && !(Number(rec.cursor) > 0)) { rec.history_days = days(); rec.backfill_from = Date.now() - days() * DAY }
        await persist.saveAccount(rec)
        if (!stored) storedAccounts.push(rec); else Object.assign(stored, rec)
        b.workRec = deep(rec)
        paintWindow(rec)
        setB('Saved · ' + trackedSet().size + ' repo(s) tracked · agent ' + agentNameFor(provider))
        saveNote.textContent = trained()
          ? 'Saved — the next check reads the changes.'
          : 'Saved — not read yet. Press “Read data” to read it now, or leave it for the next check.'
        paintReadNote()
        if (onSaved) await onSaved(rec)
      } catch (e) {
        saveNote.textContent = 'Save failed: ' + ((e && e.message) || e)
      } finally {
        spin.remove(); saveBtn.hidden = false; b.busy = false
      }
    }

    daysIn.addEventListener('change', () => { touch(); countSessions().catch(() => {}) })
    saveBtn.addEventListener('click', save)
    box.addEventListener('click', touch)
    b.load = load; b.days = days; b.setBusy = (on) => { saveBtn.disabled = !!on || !b.workRec; daysIn.disabled = !!on; if (on) readBtn.disabled = true; else paintReadNote() }
    return b
  }

  // ---- init --------------------------------------------------------------------------------------
  async function init () {
    if (!F) { setStatus('freezr is not available on this page.', true); return }
    let connections = []
    try { connections = await listFsConnections(F) } catch (e) { setStatus(explainFsError(e), true) }
    if (only) {
      connections = connections.filter(c => c.connectionName === only)
      status.hidden = true
      if (!connections.length) { status.hidden = false; setStatus('The file store "' + only + '" is not available to SuperLazy (not granted, or removed).', true); return }
    }
    blocksHost.textContent = ''; blocks.length = 0; currentBlock = null
    if (!connections.length) {
      help.hidden = false
      if (!status.classList.contains('wks-bad')) setStatus('No file-system connection is available to SuperLazy. Follow the steps below, then reload.', true)
      return
    }
    help.hidden = true; meRow.hidden = false
    if (!only) setStatus(connections.length + ' file store' + (connections.length === 1 ? '' : 's') + ' visible — one block each; each store is its own account.')
    // saved stores first, then the rest, so the trained one is on top
    const isSaved = (c) => !!storedAccounts.find(r => r.account_id === c.connectionName && isWorkAccount(r))
    const order = connections.slice().sort((a, b) => Number(isSaved(b)) - Number(isSaved(a)))
    for (const c of order) blocks.push(makeBlock(c))
    await Promise.all(blocks.map(b => b.load()))
  }
  init().catch(e => setStatus('Could not load: ' + ((e && e.message) || e), true))

  return {
    reload: () => init(),
    // the block last loaded / interacted with — what the lab's dev tools act on
    current: () => currentBlock ? { connectionName: currentBlock.name, workRec: currentBlock.workRec, reader: currentBlock.reader } : { connectionName: null, workRec: null, reader: null },
    // EVERY block, live — the lab runs from what is ON SCREEN (each store's own repo ticks and its
    // own days), not from the last-touched block or the saved accounts (user, 2026-09-10: unticking
    // Claude and setting its days low silently emptied a Codex run)
    blocks: () => blocks.map(b => ({
      connectionName: b.name,
      workRec: b.workRec,
      reader: b.reader,
      provider: (b.workRec && b.workRec.provider) || (b.layout && b.layout.provider) || null,
      days: b.days ? b.days() : 7,
      loaded: !!b.workRec,
      repoCount: b.repos.length,
      trackedCount: b.repos.filter(r => { const x = b.workRec && b.workRec.repos && b.workRec.repos[r.slug]; return !(x && x.tracked === false) }).length
    })),
    me,
    days: () => (currentBlock ? currentBlock.days() : 7),
    setBusy: (on) => { meIn.disabled = !!on; for (const b of blocks) b.setBusy(on) }
  }
}
