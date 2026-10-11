// slackSource.js — the MESSAGES-channel InputSource over freezr.connections.messaging (Slack
// first; the freezr API is provider-neutral, so this file should survive Telegram/Teams).
// Same interface as liveMailSource.js — the engine and the pages can't tell them apart.
// Needs the use_messaging permission granted AND the connection's own access at /account/resources.
//
// THE SHAPE OF INGESTION (specs/superlazy-inputs.md §4.1 + the Slack plan):
//   fetch (mode-dispatched) → chunk (chunker.js, pure) → PERSIST to `inputs` (status 'pending')
//   → listEnvelopes returns the PENDING inputs as envelopes → the normal queue analyses them.
// Chunks are persisted at FORMATION time, before analysis — the `inputs` record is the chunk
// ledger. That is what makes chunking idempotent (retries re-read the stored chunk, never
// re-chunk), gives the viewer the transcript for free, and decouples provider-facing work from
// LLM-facing work. processor.persistOne flips the record to 'analysed' after persistStep.
//
// TWO SYNC MODES, one function apart (fetchNewForConversation decides nothing — pickTargets does):
//   live    — the server's socket-fed activity index: getChanges(since) names the changed
//             conversations; we getNewer only those. complete:false ⇒ sweep the whole roster.
//   polling — no sockets: getNewer over every tracked conversation.
// Everything downstream of the fetched messages is byte-identical between modes.
//
// ACCOUNT RECORD (one per workspace connection, channel:'messages'). Extra fields owned here:
//   team_id, me_user_id, me_email                — from getProfile, cached on first formation
//   conversations: { <convId>: { name, type, tracked, is_member, archived, first_seen } }
//     (conv ids are dot-free, so an object is safe; the user's opt-in/out lives on `tracked`)
//   conv_tokens: { <convId>: token }             — getNewer high-water marks
//   streams: [ { id, cursor_ms, last_chunk_id, last_chunk_ts, held: [] } ]
//     (an ARRAY — stream ids embed Slack ts strings with dots, and Mongo forbids dots in keys;
//      `held` buffers soft-debounced messages, since the conv token has already moved past them)
//   last_sync_ms                                 — getChanges `since`
// The records handed in are the SAME objects processor.plan() adopts (resolveAccounts passes the
// stored array through), so cursor bumps and token advances land on one object, one save path.

import { createPendingReader } from './pendingScan.js'
import {
  splitStreams, formLiveChunk, formHistoryChunks, renderTranscript, resolveMarkup,
  participantIdsOf, streamIdFor, CHUNK_TUNING
} from './chunker.js'

// Formation is provider-chatty (rate limits are shared per workspace: never "all channels every
// cycle"). Bounded on three axes, like the mail fetch: a wall clock, a per-conversation page cap,
// and a per-run conversation cap. Whatever trips first surfaces as hitCeiling — the next run
// continues (tokens only advance for conversations actually fetched).
const FORM_DEADLINE_MS = 60 * 1000
const HISTORY_PAGE_CAP = 10        // × limit 200 = ≤2000 rows per conversation per run
const THREADS_PER_CONV_CAP = 20    // getThread calls per conversation per run
const CONVS_PER_RUN_CAP = 40

// pendingFloorMs: how far back to page for pending chunks (ingest.js, from the watermark); null = the
// legacy newest-300 read — see pendingScan.js.
export function createSlackSource ({ freezr: fz, persist = null, accounts = [], dryRun = false, eager = false, tuning: tuningOpt = CHUNK_TUNING, pendingFloorMs = null } = {}) {
  const F = fz || (typeof freezr !== 'undefined' ? freezr : null)
  // eager (user pressed Check): disable the soft debounce — TINY_CHARS 0 means no chunk is ever
  // "too small and too fresh" to analyse right now
  const tuning = eager ? { ...tuningOpt, TINY_CHARS: 0 } : tuningOpt
  const messaging = () => (F && F.connections && F.connections.messaging) || null
  const recs = (accounts || []).filter(r => r && r.account_id)
  const usersCache = new Map()   // connectionName -> Map(userId -> user row)
  let capsCache = null           // freezr.utils.ping().capabilities, fetched once per instance
  let formedPromise = null       // formation runs once per source instance (probe + window share it)
  let lastFormation = null       // summary of the last formAll, for the lab / diagnostics

  // Same structural token_expired detection as liveMailSource — this file also runs in jobs,
  // where the client helper's redirect would throw on the sandbox's bare `window`.
  const tokenExpiredOf = (err) => {
    for (const d of [err, err && err.data]) {
      if (d && d.error === 'token_expired') return d
    }
    return null
  }
  let providerErrors = []
  async function guarded (fn) {
    if (!messaging()) {
      throw new Error('Messaging is not available — grant superlazy the messaging permission in Settings and connect a Slack account at /account/resources.')
    }
    try {
      const res = await fn()
      if (res && (res.error || res.ok === false)) {
        const err = new Error(res.message || res.error || 'Messaging request failed')
        err.data = res
        throw err
      }
      return res
    } catch (err) {
      providerErrors.push(err)
      const expired = tokenExpiredOf(err)
      if (!expired) throw err
      const e = new Error('Messaging access for “' + (expired.connectionName || 'your account') +
        '” has expired — reconnect it at /account/resources.')
      e.tokenExpired = true
      e.connectionName = expired.connectionName || null
      e.reauth_url = expired.reauth_url || null
      throw e
    }
  }

  // ---- accounts / capability ------------------------------------------------------------------

  async function listAccounts () {
    const res = await guarded(() => messaging().listAccounts())
    const rows = ((res && res.accounts) || []).filter(a => (a.services || []).includes('messaging'))
    return {
      accounts: rows.map(a => ({
        account_id: a.connectionName,
        account_email: a.account_email || a.connectionName,
        provider: a.provider || 'slack',
        live: !!a.live,
        access: (a.access && a.access.messaging) || 'read',
        status: a.status || 'ok',
        message_count: null,
        last_received: null
      }))
    }
  }

  async function liveCapability () {
    if (capsCache) return capsCache
    try {
      const status = await F.utils.ping()
      capsCache = (status && status.capabilities && status.capabilities.messaging_live) || { active: false }
    } catch (e) { capsCache = { active: false } }
    return capsCache
  }

  // ---- users ------------------------------------------------------------------------------------

  async function resolveUsers (connectionName, ids) {
    if (!usersCache.has(connectionName)) usersCache.set(connectionName, new Map())
    const cache = usersCache.get(connectionName)
    const missing = [...new Set(ids)].filter(id => id && !cache.has(id))
    for (let i = 0; i < missing.length; i += 100) {  // server slices ids batches at 100
      try {
        const res = await guarded(() => messaging().getUsers({ connectionName, ids: missing.slice(i, i + 100) }))
        for (const u of ((res && res.users) || [])) cache.set(u.id, u)
      } catch (e) {
        console.warn('[superlazy] slack user resolution failed (' + ((e && e.message) || e) + ') — ids render raw')
      }
    }
    return cache
  }
  const nameOf = (cache) => (id) => {
    const u = cache.get(id)
    return (u && (u.displayName || u.realName || u.name)) || null
  }

  // ---- roster -----------------------------------------------------------------------------------

  // Merge the provider's conversation list into rec.conversations, PRESERVING the user's tracked
  // choices. Defaults: DMs / group DMs and channels the user is a MEMBER of are tracked (opt-out);
  // non-member public channels are listed but untracked (opt-in). Archived → never tracked.
  async function ensureRoster (rec) {
    const byId = rec.conversations || {}
    let cursor = null
    let pages = 0
    do {
      const res = await guarded(() => messaging().listConversations({
        connectionName: rec.account_id, limit: 200, cursor, includeArchived: false
      }))
      for (const c of ((res && res.conversations) || [])) {
        const prior = byId[c.id]
        const memberish = c.type === 'dm' || c.type === 'group_dm' || !!c.isMember
        byId[c.id] = {
          name: c.name || (c.type === 'dm' ? ('dm:' + (c.counterpartUserId || c.id)) : c.id),
          type: c.type,
          is_member: !!c.isMember,
          counterpart: c.counterpartUserId || null,
          archived: !!c.isArchived,
          tracked: prior ? !!prior.tracked : (memberish && !c.isArchived),
          first_seen: prior ? prior.first_seen : Date.now()
        }
      }
      cursor = res && res.nextCursor
      pages++
    } while (cursor && pages < 5)
    rec.conversations = byId
    return byId
  }

  async function ensureIdentity (rec) {
    if (rec.me_user_id && rec.team_id) return
    const res = await guarded(() => messaging().getProfile({ connectionName: rec.account_id }))
    const p = (res && res.profile) || {}
    rec.team_id = p.teamId || rec.team_id || 'team'
    rec.me_user_id = p.userId || rec.me_user_id || null
    rec.me_email = String(p.email || rec.me_email || '').toLowerCase()
    if (!rec.account_email && rec.me_email) rec.account_email = rec.me_email
  }

  // ---- mode dispatch ----------------------------------------------------------------------------

  // Which tracked conversations does this run visit? Live mode asks the activity index; polling
  // sweeps everything tracked. Conversations with no sync token yet are ALWAYS visited (they need
  // seeding / history), whatever the index says.
  async function pickTargets (rec) {
    const tracked = Object.entries(rec.conversations || {})
      .filter(([, c]) => c.tracked && !c.archived)
      .map(([id]) => id)
    const caps = await liveCapability()
    const live = !!(caps.active && (caps.live_connections || []).includes(rec.account_id))
    if (!live) return { targets: tracked.slice(0, CONVS_PER_RUN_CAP), mode: 'polling', overCap: tracked.length > CONVS_PER_RUN_CAP, changesByConv: null }
    try {
      const res = await guarded(() => messaging().getChanges({ connectionName: rec.account_id, since: rec.last_sync_ms || 0 }))
      if (res && res.complete) {
        const changed = new Set((res.changes || []).map(c => c.conversationId))
        const changesByConv = new Map((res.changes || []).map(c => [c.conversationId, c]))
        const tokens = rec.conv_tokens || {}
        const targets = tracked.filter(id => changed.has(id) || !tokens[id])
        return { targets: targets.slice(0, CONVS_PER_RUN_CAP), mode: 'live', overCap: targets.length > CONVS_PER_RUN_CAP, changesByConv }
      }
      console.info('[superlazy] slack activity index incomplete for the window — sweeping the tracked roster')
      return { targets: tracked.slice(0, CONVS_PER_RUN_CAP), mode: 'live_sweep', overCap: tracked.length > CONVS_PER_RUN_CAP, changesByConv: null }
    } catch (e) {
      console.info('[superlazy] getChanges unavailable (' + ((e && e.message) || e) + ') — polling instead')
      return { targets: tracked.slice(0, CONVS_PER_RUN_CAP), mode: 'polling', overCap: tracked.length > CONVS_PER_RUN_CAP, changesByConv: null }
    }
  }

  // ---- provider amendments (edits / deletes of already-captured messages) ----------------------
  // The live activity index names WHICH message ids were edited/deleted after `since`. Patch the
  // stored chunk that carries each id and RE-QUEUE it: same msg_id ⇒ the analysis event upserts
  // and the request carries the REVISED marker — the §6.4 amendment flow. Bounded per run.
  const AMENDMENTS_PER_RUN_CAP = 25

  function transcriptFromRaw (rec, msgsRaw) {
    const named = new Map(msgsRaw.map(m => [m.author_id, m.author_name]))
    return renderTranscript(msgsRaw.map(m => ({
      id: m.ts,
      sentAt: m.sent_at,
      sender: { id: m.author_id, type: m.is_bot ? 'bot' : 'user' },
      text: m.deleted ? '[message deleted]' : m.text,
      edited: !!m.edited,
      reactions: m.reactions || [],
      files: m.files || []
    })), { nameOf: (id) => named.get(id) || id, isMe: (id) => !!(id && id === rec.me_user_id) })
  }

  async function applyProviderChanges (rec, convId, change, budget) {
    const editedIds = (change.edited || []).map(e => e.id)
    const deletedIds = new Set((change.deleted || []).map(d => d.id))
    const wanted = new Set([...editedIds, ...deletedIds])
    if (!wanted.size || budget.left <= 0) return 0
    let chunks = []
    try {
      chunks = (await F.query('inputs', { conversation_id: convId }, { count: 100 }) || [])
        .filter(r => r && r.channel === 'messages' && r.account_id === rec.account_id && !r.archived)
    } catch (e) { return 0 }
    let amended = 0
    for (const chunk of chunks) {
      if (budget.left <= 0) break
      const hits = (chunk.messages_raw || []).filter(m => wanted.has(m.ts))
      if (!hits.length) continue
      let touched = false
      for (const m of hits) {
        if (deletedIds.has(m.ts)) {
          if (!m.deleted) { m.deleted = true; touched = true }
        } else {
          // re-fetch the edited message's current text (docs: oldest=id, latest=id,
          // inclusive:true returns exactly that message); keep the old text on any miss
          try {
            const res = await guarded(() => messaging().getMessages({
              connectionName: rec.account_id, conversationId: convId,
              oldest: m.ts, latest: m.ts, inclusive: true, limit: 1
            }))
            const fresh = ((res && res.messages) || []).find(x => x.id === m.ts)
            if (fresh) {
              const cache = await resolveUsers(rec.account_id, participantIdsOf([fresh]))
              m.text = resolveMarkup(fresh.text, { nameOf: nameOf(cache) })
              m.edited = true
              touched = true
            }
          } catch (e) { /* keep the stored text */ }
        }
      }
      if (!touched) continue
      chunk.body_text = transcriptFromRaw(rec, chunk.messages_raw)
      chunk.revision = (Number(chunk.revision) || 1) + 1
      chunk.edited_asof = Date.now()
      chunk.status = 'pending' // re-queues → analysed as an amendment (REVISED marker)
      chunk.attempts = 0
      if (!dryRun && persist) await persist.saveInput(chunk)
      amended++
      budget.left--
    }
    return amended
  }

  // LIVE-mode thread revival: a reply to an OLD thread never appears in the main history, so
  // getNewer can return nothing for a conversation the activity index says CHANGED. Sweep the
  // recent parents' threads (bounded) and pick up replies past each thread-stream's cursor.
  async function sweepRevivedThreads (rec, convId, deadline) {
    try {
      const res = await guarded(() => messaging().getMessages({ connectionName: rec.account_id, conversationId: convId, limit: 50 }))
      const parents = ((res && res.messages) || []).filter(m => !m.threadParentId && Number(m.replyCount) > 0)
      if (!parents.length) return []
      const replies = await fetchThreadReplies(rec, convId, parents, deadline)
      const cursorOf = (sid) => { const s = (rec.streams || []).find(x => x.id === sid); return (s && s.cursor_ms) || 0 }
      return replies.filter(m => Number(m.sentAt) > cursorOf(streamIdFor(rec.team_id || 'team', convId, m.threadParentId)))
    } catch (e) { return [] }
  }

  // ---- fetching ---------------------------------------------------------------------------------

  // Steady state: the per-conversation delta. First call (no token) SEEDS — the provider returns
  // no backfill, just a token; history for a cursor-0 account is fetched separately below.
  async function fetchNewer (rec, convId) {
    const tokens = rec.conv_tokens || (rec.conv_tokens = {})
    const res = await guarded(() => messaging().getNewer({
      connectionName: rec.account_id, conversationId: convId, lastToken: tokens[convId] || undefined, limit: 500
    }))
    const had = !!tokens[convId]
    if (res && res.nextToken) tokens[convId] = res.nextToken
    const msgs = ((res && res.messages) || []).slice().reverse() // provider returns newest-first
    return had ? msgs : [] // a seed call backfills nothing by design
  }

  // History (cursor-0 backfill / a window build): page getMessages back to fromMs.
  async function fetchHistory (rec, convId, fromMs, deadline) {
    const out = []
    let cursor = null
    let pages = 0
    while (pages < HISTORY_PAGE_CAP && Date.now() < deadline) {
      const res = await guarded(() => messaging().getMessages({
        connectionName: rec.account_id, conversationId: convId, limit: 200, cursor
      }))
      const batch = (res && res.messages) || []
      out.push(...batch)
      pages++
      const oldest = batch.length ? Number(batch[batch.length - 1].sentAt) : 0
      cursor = res && res.nextCursor
      if (!cursor || !batch.length || (oldest && oldest < fromMs)) break
    }
    return out.filter(m => Number(m.sentAt) >= fromMs).reverse() // oldest-first
  }

  // Thread replies never appear in the main history — fetch them per parent seen in this batch.
  // (Polling can't see a revived OLD thread — a noted gap; live mode's index covers conv activity.)
  async function fetchThreadReplies (rec, convId, parents, deadline) {
    const replies = []
    let calls = 0
    for (const p of parents) {
      if (calls >= THREADS_PER_CONV_CAP || Date.now() > deadline) break
      try {
        const res = await guarded(() => messaging().getThread({
          connectionName: rec.account_id, conversationId: convId, threadId: p.id, limit: 200
        }))
        calls++
        for (const m of ((res && res.messages) || [])) {
          if (m.id !== p.id) replies.push({ ...m, threadParentId: m.threadParentId || p.id })
        }
      } catch (e) {
        console.warn('[superlazy] slack thread fetch failed for ' + p.id + ': ' + ((e && e.message) || e))
      }
    }
    return replies
  }

  // ---- chunk finalisation -----------------------------------------------------------------------

  const streamStateOf = (rec, streamId) => {
    if (!Array.isArray(rec.streams)) rec.streams = []
    let s = rec.streams.find(x => x.id === streamId)
    if (!s) { s = { id: streamId, cursor_ms: 0, last_chunk_id: null, last_chunk_ts: 0, held: [] }; rec.streams.push(s) }
    return s
  }

  // DMs and group DMs have MACHINE names from the provider ('mpdm-a--b--c-1', null for 1:1) —
  // resolve the real member names once per conversation and cache them on the roster entry
  // (persisted with the account record). The title everywhere becomes "Slack DM: A, B".
  async function ensureConvNames (rec, convId, conv) {
    if (conv.display || (conv.type !== 'dm' && conv.type !== 'group_dm')) return conv.display || null
    try {
      let ids = conv.member_ids
      if (!ids) {
        const res = await guarded(() => messaging().getConversationMembers({ connectionName: rec.account_id, conversationId: convId, limit: 20 }))
        ids = (res && res.memberIds) || []
        conv.member_ids = ids
      }
      const cache = await resolveUsers(rec.account_id, ids)
      const named = nameOf(cache)
      const others = ids.filter(id => id !== rec.me_user_id).map(id => named(id) || id)
      conv.display = others.length ? others.join(', ') : (named(rec.me_user_id) || 'yourself')
    } catch (e) {
      conv.display = null // fall back to the machine name; retried next formation
    }
    return conv.display
  }

  // Resolve human names for the WHOLE roster (the channel-preferences UI shows people, never
  // provider codes like 'dm:U0BRN…' / 'mpdm-a--b-1'). DM counterparts resolve in ONE users batch;
  // group DMs need a members call each, so those are capped per load (the rest resolve on later
  // loads / at formation). Names persist on the roster entries when the selection is saved.
  async function ensureRosterNames (rec, { maxMemberLookups = 30 } = {}) {
    const convs = Object.entries(rec.conversations || {})
    const dmIds = convs.filter(([, c]) => c.type === 'dm' && !c.display && c.counterpart).map(([, c]) => c.counterpart)
    if (dmIds.length) {
      const cache = await resolveUsers(rec.account_id, dmIds)
      const named = nameOf(cache)
      for (const [, c] of convs) {
        if (c.type === 'dm' && !c.display && c.counterpart) c.display = named(c.counterpart) || null
      }
    }
    let lookups = 0
    for (const [id, c] of convs) {
      if (c.type !== 'group_dm' || c.display) continue
      if (lookups++ >= maxMemberLookups) break
      await ensureConvNames(rec, id, c)
    }
    return rec.conversations
  }

  const titleFor = (conv, display, isThread) => {
    const base = (conv.type === 'dm' || conv.type === 'group_dm')
      ? 'Slack DM: ' + (display || conv.name)
      : '#' + conv.name
    return base + (isThread ? ' › thread' : '')
  }

  // Turn a chunker chunk into the stored inputs record (the chunk ledger entry).
  async function inputRecordFor (rec, convId, chunk) {
    const conv = (rec.conversations || {})[convId] || {}
    const display = await ensureConvNames(rec, convId, conv)
    const cache = await resolveUsers(rec.account_id, [...participantIdsOf(chunk.messages), conv.counterpart].filter(Boolean))
    const named = nameOf(cache)
    const isMe = (id) => !!(id && id === rec.me_user_id)
    const msgsRaw = chunk.messages.map(m => {
      const u = cache.get(m.sender && m.sender.id)
      return {
        ts: m.id,
        sent_at: Number(m.sentAt) || 0,
        author_id: (m.sender && m.sender.id) || null,
        author_name: named(m.sender && m.sender.id) || ((m.sender && m.sender.id) || 'unknown'),
        author_email: String((u && u.email) || '').toLowerCase(),
        is_bot: !!(m.sender && m.sender.type === 'bot'),
        text: resolveMarkup(m.text, { nameOf: named }),
        edited: !!m.edited,
        reactions: m.reactions || [],
        files: m.files || []
      }
    })
    const transcript = renderTranscript(
      chunk.messages.map((m, i) => ({ ...m, text: msgsRaw[i].text })),
      { nameOf: named, isMe }
    )
    // participants: every human author + @-mentioned person. kind 'member' — the channel-members
    // meaning of to/cc (normalize PARTICIPANTS_KIND). Slack users with an attested email land on
    // that address (the person's existing mail profile); the rest keep a channel-scoped key.
    const participants = participantIdsOf(chunk.messages).map(id => {
      const u = cache.get(id)
      return {
        address: String((u && u.email) || '').toLowerCase() || (isMe(id) ? rec.me_email : ''),
        name: named(id) || id,
        kind: 'member',
        channel_id: id
      }
    })
    const firstHuman = msgsRaw.find(m => !m.is_bot) || msgsRaw[0]
    const isThread = chunk.thread_id.split(':').length > 3
    const title = titleFor(conv, display, isThread)
    return {
      channel: 'messages',
      item_kind: isThread ? 'thread' : 'chat',
      provider: rec.provider || 'slack',
      account_id: rec.account_id,
      msg_id: chunk.msg_id,
      thread_id: chunk.thread_id,
      conversation_id: convId,
      conv_type: conv.type || null,
      team_id: rec.team_id || null,
      date: chunk.date,
      first_ts: chunk.first_ts,
      last_ts: chunk.last_ts,
      in_reply_to: chunk.in_reply_to || null,
      author_address: (firstHuman && (isMe(firstHuman.author_id) ? rec.me_email : firstHuman.author_email)) || '',
      author_name: (firstHuman && (isMe(firstHuman.author_id) ? 'ME' : firstHuman.author_name)) || '',
      author_channel_id: (firstHuman && firstHuman.author_id) || null,
      participants,
      participants_kind: 'channel_members',
      title,
      body_text: transcript,
      body_html: null,
      labels: [],
      attachments: [],
      messages_raw: msgsRaw,
      authority: 'provider',
      archived: false,
      status: 'pending',
      analysis_event_id: null,
      revision: 1,
      content_hash: null,
      edited_asof: null,
      captured_asof: Date.now(),
      sources: ['slack:' + rec.account_id]
    }
  }

  // ---- formation --------------------------------------------------------------------------------

  // The whole provider-facing pass for one run: mode dispatch → fetch → chunk → persist pending
  // inputs → advance stream cursors + conv tokens. Runs ONCE per source instance (probe and the
  // window fetch share the result). fromMs > 0 is required for a cursor-0 HISTORY build — a probe
  // (no fromMs) never fetches unbounded history.
  async function formAll ({ fromMs = 0, onPage = null } = {}) {
    const deadline = Date.now() + FORM_DEADLINE_MS
    const summary = { chunks: [], held: 0, amended: 0, truncated: false, mode_by_account: {}, errors: [] }
    const amendBudget = { left: AMENDMENTS_PER_RUN_CAP }
    for (const rec of recs) {
      providerErrors = []
      try {
        await ensureIdentity(rec)
        await ensureRoster(rec)
        const { targets, mode, overCap, changesByConv } = await pickTargets(rec)
        summary.mode_by_account[rec.account_id] = mode
        if (overCap) { summary.truncated = true }
        const isHistory = !(Number(rec.cursor) > 0)
        // the account's OWN first-read floor (set by the channels UI's days input) wins over the
        // plan's global window — that window is the min across ALL accounts, so a Slack account
        // added to a mail install trained weeks back would otherwise inherit the mail window
        const histFrom = Math.max(Number(fromMs) || 0, Number(rec.backfill_from) || 0)
        let visited = 0
        for (const convId of targets) {
          if (Date.now() > deadline) { summary.truncated = true; break }
          let msgs
          if (isHistory) {
            if (!(histFrom > 0)) continue // probe: never fetch unbounded history
            msgs = await fetchHistory(rec, convId, histFrom, deadline)
            // seed the delta token so steady-state starts where history ended
            await fetchNewer(rec, convId).catch(() => [])
          } else {
            msgs = await fetchNewer(rec, convId)
          }
          // LIVE mode extras, from the activity index's per-conversation detail:
          // edits/deletes of already-captured messages become chunk AMENDMENTS, and a changed-
          // but-quiet conversation (the index fired, getNewer returned nothing) means a reply
          // landed on an OLD thread — sweep for it.
          const change = changesByConv && changesByConv.get(convId)
          if (change) {
            summary.amended += await applyProviderChanges(rec, convId, change, amendBudget)
            if (!msgs.length && !isHistory) {
              msgs = await sweepRevivedThreads(rec, convId, deadline)
            }
          }
          visited++
          if (onPage) onPage({ connectionName: rec.account_id, rows: msgs.length, pages: visited })
          if (!msgs.length && !isHistory) continue
          // thread replies ride separately (never in main history)
          const parents = msgs.filter(m => !m.threadParentId && Number(m.replyCount) > 0)
          const replies = parents.length ? await fetchThreadReplies(rec, convId, parents, deadline) : []
          // re-inject messages held by the soft debounce on a previous check (streams of THIS
          // conversation: id = slack:<team>:<convId>[:<threadTs>], so segment 2 is the conv)
          const heldPrior = (rec.streams || []).filter(s => String(s.id).split(':')[2] === convId)
            .flatMap(s => s.held || [])
          const byStream = splitStreams({
            team: rec.team_id || 'team', conversationId: convId, messages: [...heldPrior, ...msgs, ...replies]
          })
          for (const [streamId, streamMsgs] of byStream) {
            const st = streamStateOf(rec, streamId)
            const fresh = streamMsgs.filter(m => Number(m.sentAt) > (st.cursor_ms || 0))
            if (!fresh.length) continue
            const prevChunk = st.last_chunk_id ? { msg_id: st.last_chunk_id, last_ts: st.last_chunk_ts } : null
            const formed = isHistory
              ? { chunks: formHistoryChunks({ streamId, conversationId: convId, messages: fresh, tuning }) }
              : (() => {
                  const { chunk, holds } = formLiveChunk({ streamId, conversationId: convId, messages: fresh, nowMs: Date.now(), prevChunk, tuning })
                  if (holds) {
                    if (!dryRun) st.held = fresh
                    summary.held += holds
                    return { chunks: [] }
                  }
                  return { chunks: chunk ? [chunk] : [] }
                })()
            for (const chunk of formed.chunks) {
              const inputRec = await inputRecordFor(rec, convId, chunk)
              if (!dryRun && persist) await persist.saveInput(inputRec)
              if (!dryRun) {
                st.cursor_ms = chunk.last_ts
                st.last_chunk_id = chunk.msg_id
                st.last_chunk_ts = chunk.last_ts
                st.held = []
              }
              summary.chunks.push(inputRec)
            }
          }
        }
        if (providerErrors.length) throw providerErrors[0]
        if (!dryRun) {
          rec.sync_error = null
          rec.token_expired = false
          rec.last_sync_ms = Date.now()
          rec.channel = 'messages'
          rec.source_id = 'live:connections.messaging'
          if (persist) await persist.saveAccount(rec).catch(e => console.error('[superlazy] slack account save failed', e && e.message))
        }
      } catch (e) {
        if (!dryRun) {
          rec.token_expired = !!(e && (e.tokenExpired || tokenExpiredOf(e)))
          rec.sync_error = (e && e.message) || String(e)
          if (persist) await persist.saveAccount(rec)
        }
        summary.errors.push({ account_id: rec.account_id, message: (e && e.message) || String(e) })
        console.error('[superlazy] slack formation failed for ' + rec.account_id + ':', (e && e.message) || e)
      }
    }
    lastFormation = summary
    return summary
  }

  // ---- InputSource interface --------------------------------------------------------------------

  const inputToEnvelope = (r) => ({
    msg_id: r.msg_id,
    thread_id: r.thread_id,
    date: Number(r.date) || 0,
    from_address: r.author_address || (r.author_channel_id ? 'slack:' + r.author_channel_id : ''),
    from_name: r.author_name || '',
    subject: r.title || '(chat)',
    has_body: true,
    labels: [],
    is_draft: false,
    account_id: r.account_id,
    channel: 'messages'
  })

  // Pending chunks (the ledger's queue role) as envelopes. A probe (no fromMs) returns the queue
  // as it stands; the window fetch (fromMs set) runs formation first. Formation is memoised per
  // instance — probe and window within one run never fetch twice.
  const pending = createPendingReader({ persist, floorMs: pendingFloorMs })
  async function listEnvelopes ({ fromMs = 0, beforeMs = 0, limit = 300, accountIds = null, onPage = null } = {}) {
    if (fromMs > 0) {
      if (!formedPromise) formedPromise = formAll({ fromMs, onPage })
      await formedPromise
    }
    const ours = new Set((accountIds && accountIds.length ? accountIds : recs.map(r => r.account_id)))
    const pend = await pending.read()
    const mine = pend.filter(r => r.channel === 'messages' && ours.has(r.account_id))
    const envelopes = mine
      .map(inputToEnvelope)
      .filter(e => (!beforeMs || e.date < beforeMs))
      .sort((a, b) => (a.date - b.date) || (a.msg_id < b.msg_id ? -1 : 1))
      .slice(0, limit)
    // Say what happened OUT LOUD — formation failures are caught per-account (one bad workspace
    // must not kill a mail run), so without this line an empty queue is undiagnosable.
    if (fromMs > 0 && lastFormation) {
      const f = lastFormation
      console.info('[superlazy] slack: formed ' + f.chunks.length + ' chunk(s) this pass' +
        (f.amended ? ' · ' + f.amended + ' chunk(s) re-queued for provider edits/deletes' : '') +
        (f.held ? ' (' + f.held + ' message(s) held by the debounce)' : '') +
        ' · pending queue now ' + mine.length +
        ' · mode ' + JSON.stringify(f.mode_by_account) +
        (f.truncated ? ' · TRUNCATED (deadline/caps — continues next run)' : '') +
        (f.errors.length ? ' · ERRORS: ' + f.errors.map(e => e.account_id + ': ' + e.message).join(' | ') : ''))
      if (!persist) console.warn('[superlazy] slack: NO persistence wired — formed chunks were not stored and cannot be queued (source created without { persist })')
    }
    return { envelopes, hitCeiling: !!(lastFormation && lastFormation.truncated) }
  }

  // A stream's items = its chunk records, oldest-first — raw-shaped for normalizeMessage.
  // in_reply_to points at the ADJACENT previous chunk, which the engine's parent-inlining renders
  // in full (spec §4.1a's previous-chunk inlining, for free). channel_data carries what only this
  // channel knows: the per-author message counts (profiles.recordMessage counts by AUTHOR, not by
  // the item's nominal sender), the conversation type (DM vs channel — correspondence weighting
  // later), and first_ts/msg_count for the renderer's header.
  const inputToRaw = (r) => {
    const authors = new Map()
    for (const m of (r.messages_raw || [])) {
      if (m.is_bot) continue
      const key = m.author_id || m.author_name
      if (!authors.has(key)) authors.set(key, { id: m.author_id || null, address: m.author_email || '', name: m.author_name || '', count: 0 })
      authors.get(key).count++
    }
    return {
      channel: 'messages',
      item_kind: r.item_kind || 'chat',
      msg_id: r.msg_id,
      thread_id: r.thread_id,
      date: Number(r.date) || 0,
      from: { address: r.author_address || '', name: r.author_name || '' },
      to: (r.participants || []).map(p => ({ address: p.address || '', name: p.name || '' })),
      cc: [],
      subject: r.title || '',
      labels: [],
      is_draft: false,
      source_ref: r.account_id + '|' + r.msg_id,
      message_id_header: '',
      in_reply_to: r.in_reply_to || null,
      references: [],
      text: r.body_text || '',
      html: '',
      // a re-queued chunk (provider edit/delete amendment, §6.4): the renderer adds the REVISED
      // marker until the re-analysis lands (status flips back to 'analysed')
      revised: (Number(r.revision) || 1) > 1 && r.status !== 'analysed',
      channel_data: {
        authors: [...authors.values()],
        conv_type: r.conv_type || null,
        first_ts: Number(r.first_ts) || 0,
        msg_count: (r.messages_raw || []).length
      }
    }
  }

  async function loadThreadRaw (threadId) {
    let rows = []
    try {
      rows = await F.query('inputs', { thread_id: threadId }, { count: 100 })
    } catch (e) { rows = [] }
    const messages = (rows || [])
      .filter(r => r && r.channel === 'messages' && !r.archived)
      .sort((a, b) => (Number(a.date) || 0) - (Number(b.date) || 0))
      .map(inputToRaw)
    return { messages, path: 'inputs chunk ledger' }
  }

  async function getFullBody (msg) {
    if (!msg || !msg.source_ref || !persist) return null
    const i = String(msg.source_ref).indexOf('|')
    if (i < 0) return null
    const rec = await persist.getInput({ account_id: msg.source_ref.slice(0, i), msg_id: msg.source_ref.slice(i + 1) })
    if (!rec) return null
    return { from: msg.from, to: msg.to, cc: msg.cc, date: msg.date, subject: msg.subject, fullText: rec.body_text || '' }
  }

  // The chunk is stored at formation — the processor's post-analysis body capture must NOT
  // overwrite it (saveEmailBody would stamp channel:'mail'). null ⇒ that path no-ops.
  const getBodyPayload = async () => null

  const loadSentSamples = async () => [] // the writing-style guide is mail-only

  function handleTokenExpired (resOrErr) {
    const expired = tokenExpiredOf(resOrErr)
    if (!expired || !expired.reauth_url) return false
    if (typeof window === 'undefined' || !window.location || typeof window.location.assign !== 'function') return false
    window.location.assign(expired.reauth_url)
    return true
  }

  return {
    id: 'live:connections.messaging',
    channel: 'messages',
    listAccounts,
    listEnvelopes,
    loadThreadRaw,
    loadSentSamples,
    getFullBody,
    getBodyPayload,
    handleTokenExpired,
    // formation surface for the lab page (Stage 0 dry-runs call this directly)
    formAll,
    ensureRoster,
    ensureRosterNames,
    ensureIdentity,
    resolveUsers,
    liveCapability,
    lastFormation: () => lastFormation,
    // did the LAST pending read reach its floor? (ingest.js advances the scan watermark only then)
    pendingScanComplete: () => pending.lastScan().complete,
    lastPendingScan: () => pending.lastScan()
  }
}
