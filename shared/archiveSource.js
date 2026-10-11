// archiveSource.js — the Email Cabinet implementation of the MailSource interface.
// DISCARDABLE adapter: reads threads from the Email Cabinet archive (com.salmanff.emailcabinet)
// via a read_all permission and MIME-parses the stored EML files into source-shaped raw messages.
// A future liveMailSource implements the SAME interface over freezr.connections.mail; the engine
// (jobs/analyze_thread/engine.js) receives a source instance and never knows which one it has.
//
// ## The MailSource interface (what any source must provide)
//   id                                      — string identifying the source (for logs/debug)
//   listAccounts() → { accounts: [{ account_id, account_email, provider, message_count, last_received }] }
//       the mail accounts this source can read — for the setup account picker. Live mail maps
//       to connections.mail.listAccounts; the archive derives them from its messages.
//   listEnvelopes({ fromMs, beforeMs, limit, accountIds }) → { envelopes, hitCeiling }
//       lightweight rows { msg_id, thread_id, date, from_address, from_name, subject, has_body,
//       account_id }, oldest-first — for pickers and backfill planning; NO bodies fetched.
//   loadThreadRaw(threadId, { onProgress }) → { messages }
//       one thread's messages as SOURCE-SHAPED raw objects (the input normalize.js consumes):
//       { msg_id, thread_id, date, from:{address,name}, to:[], cc:[], subject, labels?,
//         source_ref, message_id_header, in_reply_to (OUR msg_id, resolved), references, text, html }
//   getNewer({ cursor, limit }) → { envelopes, nextCursor, expired }
//       incremental "what arrived since cursor", oldest-first — the live-ingestion feed. The
//       archive simulates it by received_at; live mail maps to connections.mail.getNewer.
//   loadSentSamples(meSet, { max }) → [{ subject, text }]
//       samples of the user's own sent mail, for the writing-style guide.
//   getFullBody(msg) → { from, to, cc, date, subject, fullText } | null
//       the FULL body (whole quoted chain, NOT reply-stripped) of a normalized message, for the
//       UI "Full view"; msg.source_ref says where the bytes live (here: the EML file path).

import PostalMime from './postal-mime.js'
import { htmlToText } from '../jobs/analyze_thread/htmlToText.js'

const ARCHIVE_APP = 'com.salmanff.emailcabinet'
const MESSAGES_TABLE = ARCHIVE_APP + '.messages'
const PERM = 'read_archive'

// fz/fm are injectable for jobs/tests; default to the browser globals.
export function createArchiveSource ({ freezr: fz, freezrMeta: fm } = {}) {
  const F = fz || (typeof freezr !== 'undefined' ? freezr : null)
  const M = fm || (typeof freezrMeta !== 'undefined' ? freezrMeta : null)
  let _token = null

  // Two-step cross-app access (CLAUDE.md HARD RULE 6): validateDataOwner -> token,
  // then pass the token as appToken on every query. The archive is the user's OWN data.
  async function getArchiveToken () {
    if (_token) return _token
    const res = await F.perms.validateDataOwner({
      data_owner_user: M.userId,
      table_id: MESSAGES_TABLE,
      permission: PERM
    })
    _token = res && res['access-token']
    if (!_token) {
      throw new Error('No access token from validateDataOwner — is the "read_archive" permission granted in Settings, and does the Email Cabinet archive exist for this user?')
    }
    return _token
  }

  async function queryMessages (query, options = {}) {
    const token = await getArchiveToken()
    return F.query(MESSAGES_TABLE, query, {
      appToken: token,
      permission_name: PERM,
      data_owner_user: M.userId,
      app_id: M.appName,
      ...options
    })
  }

  // ---- accounts / envelopes (pickers / backfill planning / incremental feed) ----------------

  // Derive the archive's mail accounts from its messages (the archive has no accounts table).
  async function listAccounts ({ batch = 2500 } = {}) {
    const msgs = await queryMessages({}, { sort: { _date_modified: -1 }, count: batch })
    const groups = new Map()
    for (const m of (msgs || [])) {
      const id = String(m.account_id || '(unknown account)')
      if (!groups.has(id)) groups.set(id, { account_id: id, account_email: m.account_email || m.account_id || '', provider: 'archive', message_count: 0, last_received: 0 })
      const g = groups.get(id)
      g.message_count++
      g.last_received = Math.max(g.last_received, Number(m.received_at) || 0)
    }
    return { accounts: [...groups.values()].sort((a, b) => b.message_count - a.message_count) }
  }

  // Pull a recent batch (sorted by the always-indexed _date_modified — no custom index needed)
  // and build a flat list of lightweight envelopes ordered oldest-first by received_at.
  // hitCeiling true = the batch was full, so messages older than the oldest row may be missing.
  async function listEnvelopes ({ fromMs = 0, beforeMs = 0, limit = 2500, accountIds = null } = {}) {
    const msgs = await queryMessages({}, { sort: { _date_modified: -1 }, count: limit })
    const rows = msgs || []
    const wanted = accountIds && accountIds.length ? new Set(accountIds.map(String)) : null
    const envelopes = []
    for (const m of rows) {
      const date = Number(m.received_at) || 0
      if (fromMs && date < fromMs) continue
      if (beforeMs && date >= beforeMs) continue
      if (wanted && !wanted.has(String(m.account_id || '(unknown account)'))) continue
      envelopes.push({
        msg_id: m.message_id,
        thread_id: m.thread_id || ('(no-thread):' + m.message_id),
        date,
        from_address: String(m.from_address || '').toLowerCase(),
        from_name: m.from_name || '',
        subject: m.subject || '(no subject)',
        has_body: !!m.eml_path,
        account_id: String(m.account_id || '(unknown account)')
      })
    }
    envelopes.sort((a, b) => (a.date - b.date) || (a.msg_id < b.msg_id ? -1 : 1))
    return { envelopes, hitCeiling: rows.length >= limit }
  }

  // Incremental feed: everything that "arrived" strictly after the cursor (a received_at ms),
  // oldest-first, capped at limit. The archive can't expire; live sources may set expired=true
  // (Gmail delta window elapsed) and the caller falls back to a full listEnvelopes + re-seed.
  async function getNewer ({ cursor = 0, limit = 50 } = {}) {
    const { envelopes } = await listEnvelopes({ fromMs: cursor ? cursor + 1 : 0 })
    const batch = envelopes.slice(0, limit)
    const nextCursor = batch.length ? batch[batch.length - 1].date : cursor
    return { envelopes: batch, nextCursor, expired: false }
  }

  // Thread list for the replay picker: group a recent batch by thread_id in memory.
  // beforeMs keeps only messages received strictly before that moment.
  async function listRecentThreads ({ batch = 600, beforeMs = 0 } = {}) {
    const msgs = await queryMessages({}, { sort: { _date_modified: -1 }, count: batch })
    const groups = new Map()
    for (const m of (msgs || [])) {
      if (beforeMs && (Number(m.received_at) || 0) >= beforeMs) continue
      const tid = m.thread_id || ('(no-thread):' + m.message_id)
      if (!groups.has(tid)) {
        groups.set(tid, {
          thread_id: tid,
          subject: m.subject || '(no subject)',
          count: 0,
          last: 0,
          account_id: m.account_id || '',
          senders: new Set(),
          with_eml: 0
        })
      }
      const g = groups.get(tid)
      g.count++
      if (m.eml_path) g.with_eml++
      if (m.from_address) g.senders.add(String(m.from_address).toLowerCase())
      const d = Number(m.received_at) || 0
      if (d >= g.last) { g.last = d; g.subject = m.subject || g.subject }
    }
    return [...groups.values()]
      .map(g => ({ ...g, senders: [...g.senders] }))
      .sort((a, b) => b.last - a.last)
  }

  // ---- EML loading + parsing ----------------------------------------------------------------

  // Cross-app file-byte read: build a URL for the EML file in the archive app's files collection.
  async function fetchEmlBuffer (emlPath) {
    const url = F.getFileUrl(emlPath, {
      requestee_app: ARCHIVE_APP,
      permission_name: PERM,
      requestee_user_id: M.userId
    })
    const resp = await fetch(url)
    if (!resp.ok) {
      throw new Error('EML fetch failed: HTTP ' + resp.status + ' for ' + emlPath + ' (url: ' + url + ')')
    }
    return { buffer: await resp.arrayBuffer(), url }
  }

  async function parseEml (buffer) {
    const parser = new PostalMime()
    return parser.parse(buffer)
  }

  async function loadParsedEml (emlPath) {
    const { buffer, url } = await fetchEmlBuffer(emlPath)
    const email = await parseEml(buffer)
    return { email, url, bytes: buffer.byteLength }
  }

  // Pull a header value from a parsed EML, tolerant of postal-mime's shapes.
  function emlHeader (email, name, conv) {
    if (conv && email[conv]) return email[conv]
    const lc = name.toLowerCase()
    for (const h of (email.headers || [])) {
      if (((h.key || h.name || '') + '').toLowerCase() === lc) return h.value
    }
    return ''
  }
  function splitRefs (v) {
    if (Array.isArray(v)) return v.filter(Boolean)
    return String(v || '').split(/\s+/).map(s => s.trim()).filter(Boolean)
  }

  // ---- the core loads -------------------------------------------------------------------------

  // Load the messages of one thread, oldest-first. Tries the direct thread_id query (needs a
  // thread_id index on the archive backend); falls back to filtering a larger recent batch.
  async function loadThreadMessages (threadId, { batch = 1500 } = {}) {
    let msgs = []
    let path = 'thread_id query'
    try {
      msgs = await queryMessages({ thread_id: threadId }, { sort: { _date_modified: 1 } })
    } catch (e) {
      msgs = []
    }
    if (!msgs || msgs.length === 0) {
      path = 'recent-batch fallback (thread_id query returned nothing — index may be missing)'
      const all = await queryMessages({}, { sort: { _date_modified: -1 }, count: batch })
      msgs = (all || []).filter(m => m.thread_id === threadId)
    }
    msgs.sort((a, b) => (Number(a.received_at) || 0) - (Number(b.received_at) || 0))
    return { messages: msgs, path }
  }

  // Load a thread as SOURCE-SHAPED raw messages (envelope from the archive record, body from
  // the EML). source_ref = the EML file path — opaque to everything outside this adapter.
  async function loadThreadRaw (threadId, { onProgress } = {}) {
    const { messages, path } = await loadThreadMessages(threadId)
    const out = []
    for (const m of messages) {
      let text = ''
      let html = ''
      let messageIdHeader = ''
      let inReplyToHeader = ''
      let references = []
      if (m.eml_path) {
        try {
          const { email } = await loadParsedEml(m.eml_path)
          text = email.text || ''
          html = email.html || ''
          // Reply threading comes from the RFC headers (authoritative; NOT the provider id).
          messageIdHeader = emlHeader(email, 'message-id', 'messageId')
          inReplyToHeader = emlHeader(email, 'in-reply-to', 'inReplyTo')
          references = splitRefs(email.references || emlHeader(email, 'references'))
        } catch (e) {
          text = '[EML fetch/parse failed: ' + (e && e.message ? e.message : e) + ']'
        }
      }
      if (onProgress) onProgress(out.length + 1, messages.length)
      out.push({
        msg_id: m.message_id,
        thread_id: m.thread_id,
        date: m.received_at,
        from: { address: String(m.from_address || '').toLowerCase(), name: m.from_name || '' },
        to: (m.to_addresses || []).map(x => ({ address: String(x.address || '').toLowerCase(), name: x.name || '' })),
        cc: (m.cc_addresses || []).map(x => ({ address: String(x.address || '').toLowerCase(), name: x.name || '' })),
        subject: m.subject || '',
        source_ref: m.eml_path || '',
        message_id_header: messageIdHeader,
        in_reply_to_header: inReplyToHeader,
        references,
        text,
        html
      })
    }
    // Resolve in_reply_to (RFC Message-ID header) → OUR msg_id, within the thread.
    const byHeader = new Map()
    for (const r of out) if (r.message_id_header) byHeader.set(r.message_id_header, r.msg_id)
    for (const r of out) {
      r.in_reply_to = (r.in_reply_to_header && byHeader.get(r.in_reply_to_header)) || null
    }
    return { messages: out, path }
  }

  // Sample the USER's own recently-sent messages — raw material for the writing-style guide.
  async function loadSentSamples (meSet, { batch = 500, max = 8 } = {}) {
    const me = new Set([...(meSet || [])].map(s => String(s).toLowerCase()))
    if (!me.size) return []
    const msgs = await queryMessages({}, { sort: { _date_modified: -1 }, count: batch })
    const mine = (msgs || []).filter(m => me.has(String(m.from_address || '').toLowerCase()) && m.eml_path)
    const out = []
    for (const m of mine) {
      if (out.length >= max) break
      try {
        const { email } = await loadParsedEml(m.eml_path)
        const text = (email.text || '').replace(/\r/g, '').trim()
        if (text.length < 20) continue
        out.push({ subject: m.subject || '', text: text.slice(0, 1200) })
      } catch (e) { /* skip unreadable */ }
    }
    return out
  }

  // Full body (whole quoted chain, NOT reply-stripped) of a normalized message, for "Full view".
  async function getFullBody (msg) {
    if (!msg || !msg.source_ref) return null
    const { email } = await loadParsedEml(msg.source_ref)
    const fullText = email.text || (email.html ? htmlToText(email.html) : '') || '(no body)'
    return { from: msg.from, to: msg.to, cc: msg.cc, date: msg.date, subject: msg.subject, fullText }
  }

  return {
    id: 'archive:' + ARCHIVE_APP,
    listAccounts,
    listEnvelopes,
    getNewer,
    listRecentThreads,
    loadThreadRaw,
    loadSentSamples,
    getFullBody
  }
}
