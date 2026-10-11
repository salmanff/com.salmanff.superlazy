// liveMailSource.js — the LIVE-MAIL implementation of the MailSource interface, over
// freezr.connections.mail (Gmail connector today). Same interface as archiveSource.js —
// the engine and the pages can't tell them apart. Needs the use_mail permission granted AND
// the connection's own access set at /account/resources.
//
// Reply threading: the mail API exposes the RFC-822 headers (messageId / inReplyTo / references,
// raw with angle brackets) on every message row, so in_reply_to is resolved to OUR msg_id within
// the thread — same as the archive source — and parent inlining / fork context work on live mail.

import { htmlToText } from './htmlToText.js'

const PAGE = 100 // provider max per listMessages call
// Pagination is HARD-BOUNDED on three axes, because a caller's row budget alone is not a bound the
// user can feel: a big `limit` on a busy mailbox is minutes of back-to-back provider calls with a
// blank page in front of it. Worse, withTimeout() abandons the promise but CANNOT cancel this loop —
// so without a self-imposed ceiling an abandoned fetch keeps hammering the provider (and a reload
// starts a second one on top of it). Whichever of these trips first ends the walk and the caller
// sees hitCeiling/truncated.
const MAX_PAGES = 25                  // ≤ 2500 rows per connection, whatever the caller asked for
// Wall-clock ceiling per connection. Sized so a normal-speed provider finishes all MAX_PAGES pages
// (only a genuinely slow one gets cut short) while two connections back to back still land inside
// the caller's STEP_TIMEOUT_MS — the walk must end itself before that timeout abandons it.
const FETCH_DEADLINE_MS = 75 * 1000

export function createLiveMailSource ({ freezr: fz } = {}) {
  const F = fz || (typeof freezr !== 'undefined' ? freezr : null)
  const mail = () => (F.connections && F.connections.mail) || null
  let accountsCache = null      // raw rows from mail.listAccounts()
  const rowCache = new Map()    // msg_id -> envelope-level row (from listMessages)
  const msgCache = new Map()    // msg_id -> full message (from getMessage)
  const connErrors = new Map()  // connectionName -> { account_id, channel, message, token_expired, reauth_url } of the LAST listing

  // Structural detection of the connector's token_expired payload. We do NOT lean on the client's
  // own handleTokenExpired() here because this file runs in TWO hosts: in a page it can redirect,
  // but inside a background job the sandbox defines `window` as a bare {} — so that helper's
  // `window.location.assign(...)` throws a TypeError and buries the real mail error. Reading the
  // payload ourselves behaves identically in both hosts.
  const tokenExpiredOf = (err) => {
    for (const d of [err, err && err.data]) {
      if (d && d.error === 'token_expired') return d
    }
    return null
  }

  // CANONICAL error handling: check token expiry first. In a page we redirect to re-auth; in a job
  // there is nowhere to redirect to, so we throw a TAGGED error (err.tokenExpired) that the caller
  // records for the UI to surface as "reconnect your mail account".
  // redirect:false — the caller isolates failures per connection (fetchAllRows) and must get the
  // tagged error back instead of the page being navigated away mid-run.
  async function guarded (fn, { redirect = true } = {}) {
    if (!mail()) {
      throw new Error('Live mail is not available — grant superlazy the mail permission in Settings and connect a mail account at /account/resources.')
    }
    try {
      return await fn()
    } catch (err) {
      const expired = tokenExpiredOf(err)
      if (!expired) throw err
      const inPage = typeof window !== 'undefined' && window.location && typeof window.location.assign === 'function'
      if (redirect && inPage && expired.reauth_url) {
        window.location.assign(expired.reauth_url)
        throw new Error('Mail access token expired — redirecting to re-authorise…')
      }
      const e = new Error('Mail access for “' + (expired.connectionName || 'your account') +
        '” has expired — reconnect it at /account/resources.')
      e.tokenExpired = true
      e.connectionName = expired.connectionName || null
      e.reauth_url = expired.reauth_url || null
      throw e
    }
  }

  async function rawAccounts () {
    if (!accountsCache) {
      const res = await guarded(() => mail().listAccounts())
      // The connections listing is ONE shared endpoint across services — it returns messaging
      // (Slack) connections too. Keep only rows that actually serve mail: a Slack connection in
      // this list is how "No use_mail permission covers connection: slack3" happens downstream.
      accountsCache = ((res && res.accounts) || [])
        .filter(a => !Array.isArray(a.services) || a.services.includes('mail'))
    }
    return accountsCache
  }

  async function listAccounts () {
    const rows = await rawAccounts()
    return {
      accounts: rows.map(a => ({
        account_id: a.connectionName,
        account_email: a.account_email || a.connectionName,
        provider: a.provider || 'mail',
        message_count: null,
        last_received: null
      }))
    }
  }

  // Paginate one connection's message list (newest-first) up to `limit` rows. When sinceMs /
  // beforeMs are given the provider filters server-side (searchMessages), so the row budget is
  // spent INSIDE the wanted window — without this, a past start date could fall off the newest-N
  // listing entirely and the oldest-first walk would silently start too late.
  async function fetchRows (connectionName, { limit = 300, sinceMs = 0, beforeMs = 0, onPage = null, noRedirect = false } = {}) {
    const rows = []
    let pageToken
    const seenTokens = new Set()
    const windowed = !!(sinceMs || beforeMs)
    const deadline = Date.now() + FETCH_DEADLINE_MS
    let pages = 0
    let truncated = false
    while (rows.length < limit) {
      if (pages >= MAX_PAGES || Date.now() > deadline) { truncated = true; break }
      const args = { connectionName, limit: Math.min(PAGE, limit - rows.length), pageToken }
      if (sinceMs) args.since = sinceMs
      if (beforeMs) args.before = beforeMs
      const res = await guarded(() => windowed ? mail().searchMessages(args) : mail().listMessages(args), { redirect: !noRedirect })
      const batch = (res && res.messages) || []
      for (const m of batch) rows.push({ ...m, connectionName })
      pages++
      if (onPage) onPage({ connectionName, rows: rows.length, pages })
      if (!res || !res.nextPageToken || !batch.length) break
      // a provider that hands back a cursor it already gave us would page forever
      if (seenTokens.has(res.nextPageToken)) { truncated = true; break }
      seenTokens.add(res.nextPageToken)
      pageToken = res.nextPageToken
    }
    if (rows.length >= limit) truncated = true
    rows.forEach(r => rowCache.set(r.id, r))
    return { rows, truncated }
  }

  // PER-CONNECTION ISOLATION (2026-10-04): one connection whose token expired used to throw out of
  // the whole listing, and with it out of plan() — no account, mail or otherwise, was processed
  // until the user re-authorised that one. Now a failing connection is recorded (accountErrors) and
  // the others are listed; only when EVERY connection fails is the first error thrown, so a
  // single-mailbox install still gets the plain failure it always had. In a page the guard no
  // longer redirects for a LISTING failure — ingest reports the account with its reauth link.
  async function fetchAllRows ({ accountIds, limit = 300, sinceMs = 0, beforeMs = 0, onPage = null } = {}) {
    const conns = (accountIds && accountIds.length) ? accountIds : (await rawAccounts()).map(a => a.connectionName)
    const all = []
    let truncated = false
    let okCount = 0
    let firstErr = null
    for (const c of conns) {
      try {
        const r = await fetchRows(c, { limit, sinceMs, beforeMs, onPage, noRedirect: true })
        all.push(...r.rows)
        if (r.truncated) truncated = true
        okCount++
        connErrors.delete(c)
      } catch (e) {
        if (!firstErr) firstErr = e
        const message = (e && e.message) || String(e)
        connErrors.set(c, { account_id: c, channel: 'mail', message, token_expired: !!(e && e.tokenExpired), reauth_url: (e && e.reauth_url) || null })
        console.error('[superlazy] mail listing failed for ' + c + ' — skipped this run, the other accounts continue:', message)
      }
    }
    if (!okCount && firstErr) throw firstErr
    return { rows: all, truncated }
  }

  const rowToEnvelope = (m, markers) => ({
    msg_id: m.id,
    thread_id: m.threadId || ('(no-thread):' + m.id),
    date: Number(m.receivedAt) || 0,
    from_address: String((m.from && m.from.address) || '').toLowerCase(),
    from_name: (m.from && m.from.name) || '',
    subject: m.subject || '(no subject)',
    has_body: true,
    labels: Array.isArray(m.labels) ? m.labels : [],
    is_draft: markers ? looksDraft(m.labels, markers) : false,
    account_id: m.connectionName
  })

  // onPage (optional): called after each provider page with { connectionName, rows, pages } — the
  // caller can show "scanning… N messages" instead of a blank page during a long mailbox walk.
  async function listEnvelopes ({ fromMs = 0, beforeMs = 0, limit = 300, accountIds = null, onPage = null } = {}) {
    const { rows, truncated } = await fetchAllRows({ accountIds, limit, sinceMs: fromMs, beforeMs, onPage })
    // resolve each connection's draft markers once, then never queue an unsent draft
    const conns = [...new Set(rows.map(r => r.connectionName).filter(Boolean))]
    const markersBy = new Map()
    for (const c of conns) markersBy.set(c, await draftMarkers(c))
    const mapped = rows.map(m => rowToEnvelope(m, markersBy.get(m.connectionName)))
    const drafts = mapped.filter(e => e.is_draft).length
    if (drafts) console.info('[superlazy] skipped ' + drafts + ' unsent draft(s) — drafts are never analysed')
    const envelopes = mapped
      .filter(e => !e.is_draft)
      .filter(e => (!fromMs || e.date >= fromMs) && (!beforeMs || e.date < beforeMs))
      .sort((a, b) => (a.date - b.date) || (a.msg_id < b.msg_id ? -1 : 1))
    return { envelopes, hitCeiling: truncated }
  }

  // Thread list for the replay picker — same grouped shape as the archive source.
  async function listRecentThreads ({ batch = 300, beforeMs = 0, accountIds = null } = {}) {
    const { rows } = await fetchAllRows({ accountIds, limit: batch, beforeMs })
    const groups = new Map()
    for (const m of rows) {
      const date = Number(m.receivedAt) || 0
      if (beforeMs && date >= beforeMs) continue
      const tid = m.threadId || ('(no-thread):' + m.id)
      if (!groups.has(tid)) {
        groups.set(tid, { thread_id: tid, subject: m.subject || '(no subject)', count: 0, last: 0, account_id: m.connectionName, senders: new Set(), with_eml: 0 })
      }
      const g = groups.get(tid)
      g.count++
      g.with_eml++ // live mail always has a fetchable body
      if (m.from && m.from.address) g.senders.add(String(m.from.address).toLowerCase())
      if (date >= g.last) { g.last = date; g.subject = m.subject || g.subject }
    }
    return [...groups.values()].map(g => ({ ...g, senders: [...g.senders] })).sort((a, b) => b.last - a.last)
  }

  async function getMessageCached (connectionName, messageId) {
    if (msgCache.has(messageId)) return msgCache.get(messageId)
    const res = await guarded(() => mail().getMessage({ connectionName, messageId }))
    const msg = res && res.message
    if (msg) msgCache.set(messageId, msg)
    return msg
  }

  // Load a thread as SOURCE-SHAPED raw messages. The provider has no direct thread fetch, so we
  // filter the listed rows by threadId (widening the listing if the thread isn't cached yet),
  // then pull each message's body via getMessage.
  async function loadThreadRaw (threadId, { onProgress } = {}) {
    let rows = [...rowCache.values()].filter(r => (r.threadId || ('(no-thread):' + r.id)) === threadId)
    if (!rows.length) {
      await fetchAllRows({ limit: 500 })
      rows = [...rowCache.values()].filter(r => (r.threadId || ('(no-thread):' + r.id)) === threadId)
    }
    rows.sort((a, b) => (Number(a.receivedAt) || 0) - (Number(b.receivedAt) || 0))
    // one marker set for the thread's connection (rows of a thread share it)
    const threadMarkers = await draftMarkers((rows[0] && rows[0].connectionName) || '')
    let skippedDrafts = 0
    const out = []
    for (const r of rows) {
      let text = ''
      let html = ''
      try {
        const full = await getMessageCached(r.connectionName, r.id)
        text = (full && full.bodyText) || ''
        html = (full && full.bodyHtml) || ''
      } catch (e) {
        text = '[body fetch failed: ' + (e && e.message ? e.message : e) + ']'
      }
      if (onProgress) onProgress(out.length + 1, rows.length)
      // an unsent draft is not part of the conversation — it would read as a sent message in the
      // thread index and invite the model to treat it as something the other side has seen
      if (looksDraft(r.labels, threadMarkers)) { skippedDrafts++; continue }
      out.push({
        msg_id: r.id,
        thread_id: threadId,
        date: Number(r.receivedAt) || 0,
        from: { address: String((r.from && r.from.address) || '').toLowerCase(), name: (r.from && r.from.name) || '' },
        to: (r.to || []).map(x => ({ address: String(x.address || '').toLowerCase(), name: x.name || '' })),
        cc: (r.cc || []).map(x => ({ address: String(x.address || '').toLowerCase(), name: x.name || '' })),
        subject: r.subject || '',
        labels: Array.isArray(r.labels) ? r.labels : [],
        source_ref: r.connectionName + '|' + r.id,
        message_id_header: r.messageId || '',
        in_reply_to_header: r.inReplyTo || '',
        references: String(r.references || '').split(/\s+/).map(s => s.trim()).filter(Boolean),
        text,
        html
      })
    }
    // Resolve in_reply_to (RFC Message-ID header) → OUR msg_id, within the thread — the same
    // resolution the archive source does, so the engine's parent inlining works identically.
    const byHeader = new Map()
    for (const m of out) if (m.message_id_header) byHeader.set(m.message_id_header, m.msg_id)
    for (const m of out) {
      m.in_reply_to = (m.in_reply_to_header && byHeader.get(m.in_reply_to_header)) || null
    }
    if (skippedDrafts) console.info('[superlazy] thread ' + threadId + ': left out ' + skippedDrafts + ' unsent draft(s)')
        return { messages: out, path: 'live listMessages filter' }
  }

  // Load the RAW messages of a TIME WINDOW directly — bodies fetched in PARALLEL lanes, and ONLY
  // for messages inside the window (a thread's older history is never fetched). Built for the
  // bulk-bootstrap dump: loadThreadRaw above hunts one thread at a time and one body at a time,
  // which for a 400-thread window means 400+ SERIAL getMessage calls (minutes of blank progress);
  // this does the same work in `concurrency` lanes. Same raw item shape as loadThreadRaw,
  // including the in_reply_to resolution (done per thread, over the window's messages).
  async function loadWindowRaw ({ accountIds = null, fromMs = 0, concurrency = 6, onProgress = null, shouldStop = null } = {}) {
    await fetchAllRows({ accountIds, limit: 2500, sinceMs: fromMs })
    const rows = [...rowCache.values()]
      .filter(r => (Number(r.receivedAt) || 0) >= fromMs &&
        (!accountIds || !accountIds.length || accountIds.includes(r.connectionName)))
      .sort((a, b) => (Number(a.receivedAt) || 0) - (Number(b.receivedAt) || 0))
    const out = []
    let next = 0
    let done = 0
    const stop = shouldStop || (() => false)
    const worker = async () => {
      while (next < rows.length && !stop()) {
        const r = rows[next++]
        let text = ''
        let html = ''
        try {
          const full = await getMessageCached(r.connectionName, r.id)
          text = (full && full.bodyText) || ''
          html = (full && full.bodyHtml) || ''
        } catch (e) {
          text = '[body fetch failed: ' + (e && e.message ? e.message : e) + ']'
        }
        done++
        if (onProgress) onProgress(done, rows.length)
        out.push({
          msg_id: r.id,
          thread_id: r.threadId || ('(no-thread):' + r.id),
          date: Number(r.receivedAt) || 0,
          from: { address: String((r.from && r.from.address) || '').toLowerCase(), name: (r.from && r.from.name) || '' },
          to: (r.to || []).map(x => ({ address: String(x.address || '').toLowerCase(), name: x.name || '' })),
          cc: (r.cc || []).map(x => ({ address: String(x.address || '').toLowerCase(), name: x.name || '' })),
          subject: r.subject || '',
          labels: Array.isArray(r.labels) ? r.labels : [],
          source_ref: r.connectionName + '|' + r.id,
          message_id_header: r.messageId || '',
          in_reply_to_header: r.inReplyTo || '',
          references: String(r.references || '').split(/\s+/).map(s => s.trim()).filter(Boolean),
          account_id: r.connectionName,
          text,
          html
        })
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
    out.sort((a, b) => (a.date - b.date) || (a.msg_id < b.msg_id ? -1 : 1))
    // resolve in_reply_to (RFC Message-ID) → OUR msg_id, within each thread
    const byThreadHeader = new Map()
    for (const m of out) {
      if (!m.message_id_header) continue
      byThreadHeader.set(m.thread_id + '|' + m.message_id_header, m.msg_id)
    }
    for (const m of out) {
      m.in_reply_to = (m.in_reply_to_header && byThreadHeader.get(m.thread_id + '|' + m.in_reply_to_header)) || null
    }
    return { messages: out, path: 'live window parallel' }
  }

  // The user's own sent mail, for the writing-style guide. Best-effort — returns [] on any failure.
  // The user's SENT folder, by id, per provider. Gmail calls it the SENT label, Microsoft Graph
  // 'sentitems' / "Sent Items" — asking listFolders is how we avoid caring which.
  // ---- DRAFTS ---------------------------------------------------------------------------------
  // An unsent draft is not mail: it has not happened yet. Analysing one produces phantom items
  // ("duplicate of the user's prior note — no new information") and, worse, can create to-dos from
  // a message the counterparty never received. Provider-agnostic detection: Gmail tags rows with
  // the literal label 'DRAFT'; Graph puts them in the Drafts FOLDER, so its rows carry that
  // folder's id. Resolve the folder once per connection and treat both as draft markers.
  const draftIdCache = new Map() // connectionName -> Set(ids)
  async function draftMarkers (connectionName) {
    if (draftIdCache.has(connectionName)) return draftIdCache.get(connectionName)
    const set = new Set(['DRAFT', 'DRAFTS'])
    try {
      const res = await guarded(() => mail().listFolders({ connectionName }))
      for (const f of ((res && res.folders) || [])) {
        if (/^drafts?$/i.test(String(f.id || '')) || /^drafts?\b/i.test(String(f.name || ''))) set.add(String(f.id))
      }
    } catch (e) { /* keep the literals — better than failing the fetch */ }
    draftIdCache.set(connectionName, set)
    return set
  }
  const looksDraft = (labels, markers) => (labels || []).some(l => markers.has(String(l)))

  async function sentFolderId (connectionName) {
    const res = await guarded(() => mail().listFolders({ connectionName }))
    const folders = (res && res.folders) || []
    const hit = folders.find(f => /^sent(items|_?mail)?$/i.test(String(f.id || '')) || /^sent\b/i.test(String(f.name || '')))
    return hit ? hit.id : null
  }

  // Sent mail for the writing-style guide. Reads the SENT FOLDER rather than searching `from:me`:
  // the structured search has to be translated into each provider's own query language, and Graph
  // rejects the address ("character '@' is not valid…"), so a Microsoft account never produced a
  // style guide. A folder listing needs no query syntax and is a better definition of "mail the user
  // wrote" anyway. The from: search stays as a fallback for a connector with no listFolders.
  async function loadSentSamples (meSet, { max = 8 } = {}) {
    const me = [...(meSet || [])].map(s => String(s).toLowerCase()).filter(Boolean)
    if (!me.length) return []
    const out = []
    try {
      const conns = (await rawAccounts()).map(a => a.connectionName)
      for (const c of conns) {
        if (out.length >= max) break
        let rows = []
        // the folder lookup failing is not fatal — it just means we fall through to the search
        let sent = null
        try { sent = await sentFolderId(c) } catch (e) { sent = null }
        try {
          if (sent) {
            const res = await guarded(() => mail().listMessages({ connectionName: c, labelIds: [sent], limit: 20 }))
            rows = (res && res.messages) || []
          }
          if (!rows.length) {
            const res = await guarded(() => mail().searchMessages({ connectionName: c, from: me[0], limit: 20 }))
            rows = (res && res.messages) || []
          }
        } catch (e) {
          // one account's mailbox being unreadable must not cost the style guide on the others
          console.info('[superlazy] no sent-mail samples from ' + c + ' (' + ((e && e.message) || e) + ')')
          continue
        }
        for (const m of rows) {
          if (out.length >= max) break
          // a Sent folder is the user's own mail by definition, but delegated/shared mailboxes can
          // hold others' — keep only what the user actually wrote
          const from = String((m.from && m.from.address) || '').toLowerCase()
          if (from && me.length && !me.includes(from)) continue
          try {
            const full = await getMessageCached(c, m.id)
            const text = ((full && full.bodyText) || '').replace(/\r/g, '').trim()
            if (text.length < 20) continue
            out.push({ subject: m.subject || '', text: text.slice(0, 1200) })
          } catch (e) { /* skip unreadable */ }
        }
      }
    } catch (e) {
      // Best-effort by design: the style guide only shapes suggested replies. freezrApiV2 logs its
      // own "apiRequest error" for the failed search, which looks alarming mid-training — say plainly
      // that nothing is broken, so it is not mistaken for the cause of a stopped run.
      console.info('[superlazy] could not read your sent mail for the writing-style guide (' +
        ((e && e.message) || e) + ') — harmless: analysis continues, only suggested-reply wording is ' +
        'less tailored. It is retried on the next run.')
      return out
    }
    return out
  }

  // Full body for the UI "Full view". source_ref = "<connectionName>|<messageId>".
  async function getFullBody (msg) {
    if (!msg || !msg.source_ref) return null
    const i = String(msg.source_ref).indexOf('|')
    if (i < 0) return null
    const full = await getMessageCached(msg.source_ref.slice(0, i), msg.source_ref.slice(i + 1))
    if (!full) return null
    const fullText = full.bodyText || (full.bodyHtml ? htmlToText(full.bodyHtml) : '') || '(no body)'
    return { from: msg.from, to: msg.to, cc: msg.cc, date: msg.date, subject: msg.subject, fullText }
  }

  // Body SNAPSHOT for storage (email_bodies): the full HTML/text + attachment MANIFEST (no bytes).
  // Reads the same cached full message the analysis already fetched, so this costs no extra call.
  // Accepts a normalized message (source_ref = "<connectionName>|<messageId>").
  async function getBodyPayload (msg) {
    if (!msg || !msg.source_ref) return null
    const i = String(msg.source_ref).indexOf('|')
    if (i < 0) return null
    const full = await getMessageCached(msg.source_ref.slice(0, i), msg.source_ref.slice(i + 1))
    if (!full) return null
    return {
      html: full.bodyHtml || '',
      text: full.bodyText || '',
      attachments: (full.attachments || []).map(a => ({
        id: a.id, filename: a.filename || '', mimeType: a.mimeType || '', sizeBytes: Number(a.sizeBytes) || 0
      }))
    }
  }

  // Fetch attachment / inline-image BYTES on demand (the one thing the stored snapshot can't hold).
  // Returns a Blob by default. connectionName falls back to account_id.
  async function getAttachment ({ account_id: acc, connectionName, messageId, attachmentId, filename, mimeType, responseType } = {}) {
    return guarded(() => mail().getAttachment({
      connectionName: connectionName || acc, messageId, attachmentId, filename, mimeType, responseType
    }))
  }

  // Token-expiry helper for callers (e.g. the email viewer). Page-only by nature — it redirects.
  // Returns false in a job (nowhere to redirect to); `guarded` already tagged the thrown error.
  function handleTokenExpired (resOrErr) {
    const expired = tokenExpiredOf(resOrErr)
    if (!expired || !expired.reauth_url) return false
    if (typeof window === 'undefined' || !window.location || typeof window.location.assign !== 'function') return false
    window.location.assign(expired.reauth_url)
    return true
  }

  // Incremental feed. First version: date-cursor over a fresh listing (same semantics as the
  // archive source). Later: switch to connections.mail.getNewer history tokens per account.
  async function getNewer ({ cursor = 0, limit = 50 } = {}) {
    rowCache.clear() // force a fresh listing — we're asking "what's new"
    const { envelopes } = await listEnvelopes({ fromMs: cursor ? cursor + 1 : 0, limit: 300 })
    const batch = envelopes.slice(0, limit)
    return { envelopes: batch, nextCursor: batch.length ? batch[batch.length - 1].date : cursor, expired: false }
  }

  return {
    id: 'live:connections.mail',
    listAccounts,
    listEnvelopes,
    getNewer,
    listRecentThreads,
    loadThreadRaw,
    loadWindowRaw,
    loadSentSamples,
    getFullBody,
    getBodyPayload,
    getAttachment,
    handleTokenExpired,
    // connections the LAST listing could not read (expired token, provider error) — the run went on
    // without them; plan() keeps them out of the window arithmetic, ingest.js reports them
    accountErrors: () => [...connErrors.values()]
  }
}
