// chunker.js — PURE chunk formation for the messages channel (Slack first).
// specs/superlazy-inputs.md §4.1: the input item for chat is a CHUNK of dialogue, not one
// platform message. A chunk is transport, not a unit of meaning — boundaries only need to be
// operationally cheap (the check window), because the semantic grouping lives in PROJECTS.
//
// This module is deliberately provider-free and freezr-free so `test/verifyMessages.mjs` can
// exercise every boundary rule offline. slackSource.js owns fetching, user resolution and
// persistence; this file owns only: messages in → chunks out.
//
// Stream model (the chunk's thread_id):
//   main stream of a conversation:  slack:<team>:<convId>
//   one Slack thread (reply chain): slack:<team>:<convId>:<parentMsgId>
// Each stream is chunked independently — a thread is a genuinely separate mini-conversation.
//
// Chunk identity is DETERMINISTIC: msg_id = <streamId>|<first message's provider id>. If a held
// (debounced) chunk is re-formed next check with more messages appended, the id is unchanged —
// downstream that means the event upserts, i.e. re-forming is an amendment, never a duplicate.
// ('|' as the id joiner: stream ids are built with ':' and Slack ts strings contain '.', so '|'
// keeps the three parts unambiguous.)

// Messages whose subtype is pure room plumbing — never content. A chunk consisting ONLY of
// these is dropped without trace (they'd otherwise cost an LLM call to learn "someone joined").
const NOISE_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'group_join', 'group_leave',
  'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive', 'channel_unarchive',
  'bot_add', 'bot_remove', 'pinned_item', 'unpinned_item'
])

export const CHUNK_TUNING = {
  // soft debounce (spec §4.1b): a chunk this small whose last message is this fresh is
  // mid-conversation — hold it (do not advance the stream cursor past it) so it rides into the
  // next check as one coherent chunk…
  TINY_CHARS: 240,
  HOT_AGE_MS: 5 * 60 * 1000,
  // …but never hold longer than this past the chunk's FIRST message (freshness ceiling).
  MAX_HOLD_MS: 15 * 60 * 1000,
  // previous-chunk adjacency for HISTORY chunking: a day/char-cap cut within this of the previous
  // chunk is a mid-conversation cut — the predecessor is inlined IN FULL (via in_reply_to → the
  // engine's parent-inlining). LIVE chunks always inline their predecessor, gap regardless: chunk
  // boundaries are arbitrary transport cuts and chat leans on continuity — "i put it in the same
  // folder" right after a check ran is unreadable without the request that preceded it
  // (user, 2026-08-30: a 12-min request→fulfilment gap fell outside the old 10-min window).
  ADJACENT_MS: 10 * 60 * 1000,
  // history mode: replaying a window (cursor-0 backfill / bootstrap) chunks per stream per DAY,
  // splitting further when a day's talk exceeds this many transcript chars.
  HISTORY_CHUNK_CHARS: 12000
}

// ---- helpers ---------------------------------------------------------------------------------

const msgChars = (m) => String(m.text || '').length

export const streamIdFor = (team, conversationId, threadParentId = null) =>
  'slack:' + team + ':' + conversationId + (threadParentId ? ':' + threadParentId : '')

export const chunkIdFor = (streamId, firstMsgId) => streamId + '|' + firstMsgId

const isNoise = (m) => !!(m.subtype && NOISE_SUBTYPES.has(String(m.subtype)))

// Split one conversation's fetched messages into per-stream lists (main flow vs each thread).
// Thread PARENTS stay in the main stream (that is where they were said); their REPLIES form the
// thread's own stream. Oldest-first within each stream, deduped by id.
export function splitStreams ({ team, conversationId, messages }) {
  const byStream = new Map()
  const seen = new Set()
  const sorted = [...(messages || [])]
    .filter(m => m && m.id && Number(m.sentAt))
    .sort((a, b) => (Number(a.sentAt) - Number(b.sentAt)) || (String(a.id) < String(b.id) ? -1 : 1))
  for (const m of sorted) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    if (isNoise(m)) continue
    const sid = streamIdFor(team, conversationId, m.threadParentId || null)
    if (!byStream.has(sid)) byStream.set(sid, [])
    byStream.get(sid).push(m)
  }
  return byStream
}

// ---- live formation (the check window IS the boundary) ---------------------------------------
//
// Input: one stream's NEW messages (already after the stream cursor), oldest-first, noise gone.
// Decides: emit one chunk, or hold (soft debounce). Returns { chunk, holds } where holds is the
// count of messages left un-chunked (cursor must NOT advance past them).
export function formLiveChunk ({ streamId, conversationId, messages, nowMs, prevChunk = null, tuning = CHUNK_TUNING }) {
  const msgs = messages || []
  if (!msgs.length) return { chunk: null, holds: 0 }
  const first = msgs[0]
  const last = msgs[msgs.length - 1]
  const totalChars = msgs.reduce((n, m) => n + msgChars(m), 0)
  const lastAge = nowMs - Number(last.sentAt)
  const firstAge = nowMs - Number(first.sentAt)
  const tiny = totalChars < tuning.TINY_CHARS
  const hot = lastAge < tuning.HOT_AGE_MS
  // the soft debounce: tiny AND hot ⇒ mid-conversation — hold, unless we have already held too long
  if (tiny && hot && firstAge < tuning.MAX_HOLD_MS) return { chunk: null, holds: msgs.length }
  return {
    chunk: {
      msg_id: chunkIdFor(streamId, first.id),
      thread_id: streamId,
      conversation_id: conversationId,
      first_ts: Number(first.sentAt),
      last_ts: Number(last.sentAt),
      date: Number(last.sentAt),            // the chunk SORTS at its last message (plan Part 1 §5)
      messages: msgs,
      // a LIVE chunk ALWAYS names its predecessor: the boundary is where the check happened to
      // fall, not where the conversation paused, so the previous chunk is inlined in full as the
      // conversation-so-far (the exact analogue of the replied-to email; capped by the prior-body
      // budget like any parent)
      in_reply_to: prevChunk ? prevChunk.msg_id : null
    },
    holds: 0
  }
}

// ---- history formation (cursor-0 backfill / bootstrap) ----------------------------------------
//
// A whole window at once: chunk per stream per DAY, splitting when a day overflows the char cap.
// No debounce (nothing is "hot" in history). Adjacency links consecutive chunks of one stream so
// mid-conversation day cuts still inline their predecessor.
export function formHistoryChunks ({ streamId, conversationId, messages, tuning = CHUNK_TUNING }) {
  const msgs = messages || []
  const chunks = []
  let cur = []
  let curChars = 0
  let curDay = null
  const dayOf = (ms) => Math.floor(Number(ms) / (24 * 3600 * 1000))
  const flush = () => {
    if (!cur.length) return
    const first = cur[0]
    const last = cur[cur.length - 1]
    const prev = chunks[chunks.length - 1] || null
    const adjacent = !!(prev && (Number(first.sentAt) - Number(prev.last_ts) < tuning.ADJACENT_MS))
    chunks.push({
      msg_id: chunkIdFor(streamId, first.id),
      thread_id: streamId,
      conversation_id: conversationId,
      first_ts: Number(first.sentAt),
      last_ts: Number(last.sentAt),
      date: Number(last.sentAt),
      messages: cur,
      in_reply_to: adjacent ? prev.msg_id : null
    })
    cur = []
    curChars = 0
  }
  for (const m of msgs) {
    const d = dayOf(m.sentAt)
    if (cur.length && (d !== curDay || curChars + msgChars(m) > tuning.HISTORY_CHUNK_CHARS)) flush()
    curDay = d
    cur.push(m)
    curChars += msgChars(m)
  }
  flush()
  return chunks
}

// ---- transcript rendering ---------------------------------------------------------------------
//
// The chunk's stored body_text: a mini-transcript, one line per message. Author names come from
// the caller's resolver (slackSource's users cache); reactions render inline because a ✅/👍 on a
// request is resolution evidence the model should see. Bots are marked — they are never people.
export function renderTranscript (messages, { nameOf = (id) => id, isMe = () => false } = {}) {
  const lines = []
  let lastDay = ''
  for (const m of (messages || [])) {
    const d = new Date(Number(m.sentAt) || 0)
    const day = d.toISOString().slice(0, 10)
    if (day !== lastDay) { lines.push('— ' + day + ' —'); lastDay = day }
    const hm = d.toISOString().slice(11, 16)
    const who = m.sender && m.sender.type === 'bot'
      ? 'bot:' + (nameOf(m.sender.id) || m.sender.id || 'unknown')
      : (isMe(m.sender && m.sender.id) ? 'ME' : (nameOf(m.sender && m.sender.id) || (m.sender && m.sender.id) || 'unknown'))
    const reacts = (m.reactions || []).length
      ? '  [' + m.reactions.map(r => r.name + (r.count > 1 ? ' ' + r.count : '')).join(', ') + ']'
      : ''
    const edited = m.edited ? ' (edited)' : ''
    const files = (m.files || []).length
      ? '  [files: ' + m.files.map(f => f.filename || f.mimeType || 'file').join(', ') + ']'
      : ''
    lines.push(hm + ' · ' + who + ': ' + String(m.text || '').replace(/\s*\n\s*/g, ' ⏎ ') + edited + reacts + files)
  }
  return lines.join('\n')
}

// Resolve Slack mrkdwn entities in message text: <@U123> → @Name, <#C1|general> → #general,
// <https://url|label> → label (https://url), <https://url> → https://url.
export function resolveMarkup (text, { nameOf = (id) => id } = {}) {
  return String(text || '')
    .replace(/<@([A-Z0-9_]+)(\|[^>]*)?>/g, (_, id) => '@' + (nameOf(id) || id))
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_, name) => '#' + name)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_, url, label) => label + ' (' + url + ')')
    .replace(/<(https?:\/\/[^>]+)>/g, (_, url) => url)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

// Everyone a chunk involves: authors + @-mentioned ids, for the users-cache prefetch and the
// participants list on the inputs record.
export function participantIdsOf (messages) {
  const ids = new Set()
  for (const m of (messages || [])) {
    if (m.sender && m.sender.id && m.sender.type !== 'bot') ids.add(m.sender.id)
    const t = String(m.text || '')
    for (const hit of t.matchAll(/<@([A-Z0-9_]+)(\|[^>]*)?>/g)) ids.add(hit[1])
  }
  return [...ids]
}
