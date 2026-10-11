// dumpBuilder.js — build the MAILBOX DUMP for the bulk bootstrap (specs/superlazy-bulk-bootstrap.md §3).
// Thread-grouped markdown: threads most-recently-active first, messages oldest-first within each.
// DETERMINISTIC (identical inputs → identical bytes) so provider prompt-caching can hit and runs
// can be diffed. Uses SHORT SURROGATE ids (m0001 / th001) — provider ids run ~150 chars and would
// dominate the model's OUTPUT (the expensive tokens); the returned maps translate back.
//
// Lessons from experiment run 1 baked in: ME aliases pre-resolved by the caller; prepBody
// (reply-strip + legal-footer trim) runs on every body BEFORE truncation; whole-mode messages
// (forwards / inline comments) get a 3x cap; bulk-labelled mail gets a small cap.
//
// ⚠ JOB-BUNDLE NOTE: this imports from ../analyze_thread/, which is fine in the BROWSER (phase 1).
// A freezr job bundles ONLY its own folder — before this runs as a job (phase 3), normalize.js,
// replyStrip.js and htmlToText.js must be copied into jobs/bootstrap/ at build time.

import { normalizeMessage } from '../analyze_thread/normalize.js'

const BODY_CAP = 2500              // chars per message body after strip
const BODY_CAP_BULK = 800          // provider-labelled bulk (newsletter/promo): sender+subject is the signal
const WHOLE_MULT = 3               // forwards / inline-comment replies: the quoted chain IS the content
const DUMP_CHAR_CAP = 800000       // ≈200k tokens — degrade gracefully past this, never truncate silently

const BULK_LABELS = /promotions|newsletters?|social|updates|forums/i

const iso = (ms) => { try { return new Date(Number(ms)).toISOString().replace(/\.\d{3}Z$/, 'Z') } catch (e) { return String(ms) } }
const day = (ms) => iso(ms).slice(0, 10)
const pad = (n, w) => String(n).padStart(w, '0')

/**
 * @param {Object}  o
 * @param {Object}  o.source        a MailSource (listEnvelopes + loadThreadRaw)
 * @param {Array}   o.accountInfos  [{ account_id, account_email }] — the accounts to dump
 * @param {number}  o.historyDays   window size, anchored like processor.plan (newest message ≈ now)
 * @param {Set}     o.meSet         ALL of the user's addresses (incl. aliases — run-1 lesson)
 * @param {string} [o.seedContext]  user-supplied context for the dump header
 * @param {string} [o.currentState] phase-3 re-calibration state block; phase 1: omitted
 * @param {Function}[o.onProgress]  ({ stage, done, total })
 * @param {Function}[o.shouldStop]
 * @returns {Promise<{ text, stats, maps }>}
 *   maps: { realMsgId: {m0001:…}, realThreadId: {th001:…}, surrogateMsgId: {real:…} }
 */
export async function buildDump ({ source, accountInfos, historyDays, meSet, seedContext, currentState, onProgress, shouldStop }) {
  const progress = onProgress || (() => {})
  const stop = shouldStop || (() => false)
  const accountIds = (accountInfos || []).map(a => a.account_id)

  // window anchored to the newest message (processor.plan's approach: a static archive's "last N
  // days from real now" is usually empty; on live mail the newest message ≈ now anyway)
  progress({ stage: 'scanning mailbox…' })
  const probe = await source.listEnvelopes({ accountIds, limit: 50 })
  const probeEnvs = probe.envelopes || []
  const anchorMs = probeEnvs.length ? probeEnvs[probeEnvs.length - 1].date : Date.now()
  const fromMs = anchorMs - historyDays * 24 * 3600e3

  // Fetch the WINDOW'S raw messages. Fast path: the source's parallel window loader (bodies in
  // ~6 lanes, window-only). Fallback for sources without it (the archive): pooled per-thread
  // loads. Either way we NEVER fetch a thread's pre-window history — the dump is the window.
  let rawMessages = []
  if (typeof source.loadWindowRaw === 'function') {
    const r = await source.loadWindowRaw({
      accountIds,
      fromMs,
      concurrency: 6,
      onProgress: (done, total) => progress({ stage: 'fetching bodies (parallel)', done, total }),
      shouldStop: stop
    })
    rawMessages = r.messages || []
  } else {
    const all = await source.listEnvelopes({
      accountIds,
      fromMs,
      limit: 2500,
      onPage: (p) => progress({ stage: 'scanning mailbox… ' + ((p && p.rows) || '') })
    })
    const envs = (all.envelopes || []).filter(e => e.date >= fromMs)
    const tids = [...new Set(envs.map(e => e.thread_id))]
    let next = 0
    let done = 0
    const worker = async () => {
      while (next < tids.length && !stop()) {
        const tid = tids[next++]
        try {
          const { messages } = await source.loadThreadRaw(tid, {})
          rawMessages.push(...messages)
        } catch (e) {
          console.warn('[superlazy bootstrap] thread fetch failed', tid, (e && e.message) || e)
        }
        done++
        progress({ stage: 'fetching thread bodies', done, total: tids.length })
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker))
  }

  // normalize + group into threads, newest-thread-first, oldest-message-first within each
  const byThread = new Map()
  const fullBodies = {} // real msg_id -> UNTRUNCATED clean_text (answers the model's fetch_requests)
  // A thread that started BEFORE the window is only partly visible here, and saying so matters
  // twice over: the model must not read "the project starts here" into a beheaded thread, and the
  // user must not read a short history as a complete one.
  //
  // TWO WAYS TO KNOW, because the two fetch paths differ. The pooled fallback hands back WHOLE
  // threads, so we can count exactly what we dropped. The fast window fetch (loadWindowRaw) asks
  // the provider only for messages inside the window — it never sees the older ones, so counting
  // dropped messages there always yields zero. What it DOES carry is each message's RFC 822
  // References / In-Reply-To headers: if the earliest message we hold in a thread replies to
  // something, that something exists and we do not have it. Free, already fetched, and provable
  // rather than guessed — see partialThreadIds below.
  const droppedBefore = new Map() // thread_id -> messages older than the window (whole-thread path)
  for (const raw of rawMessages) {
    if (!raw) continue
    if ((Number(raw.date) || 0) < fromMs) {
      const tid = raw.thread_id || raw.msg_id
      droppedBefore.set(tid, (droppedBefore.get(tid) || 0) + 1)
      continue
    }
    const m = normalizeMessage(raw)
    // normalizeMessage drops attachment info — carry it over while the raw message is in hand
    m.has_attachments = !!(raw.has_attachments || (Array.isArray(raw.attachments) && raw.attachments.length))
    if (!byThread.has(m.thread_id)) byThread.set(m.thread_id, [])
    const list = byThread.get(m.thread_id)
    if (!list.some(x => x.msg_id === m.msg_id)) list.push(m) // fallback path can double-load a thread
  }
  // headers first (works on both paths), then the exact count when we happened to see the whole thread
  const startsEarlier = (msgs) => {
    const first = msgs[0]
    if (!first) return false
    // in_reply_to is resolved to OUR msg_id when the parent is in hand; a header value that did
    // NOT resolve, or any References entry, means the parent is outside what we fetched
    if (first.in_reply_to && !msgs.some((m) => m.msg_id === first.in_reply_to)) return true
    if ((first.references || []).length) return true
    return !!droppedBefore.get(first.thread_id)
  }
  const partialThreadIds = [...byThread.entries()]
    .filter(([tid, msgs]) => startsEarlier(msgs.slice().sort((a, b) => a.date - b.date)))
    .map(([tid]) => tid)
  const threads = [...byThread.entries()].map(([tid, msgs]) => {
    msgs.sort((a, b) => a.date - b.date)
    for (const m of msgs) fullBodies[m.msg_id] = m.clean_text || ''
    return { tid, msgs }
  }).sort((a, b) => {
    const la = a.msgs[a.msgs.length - 1].date
    const lb = b.msgs[b.msgs.length - 1].date
    return (lb - la) || (a.tid < b.tid ? -1 : 1)
  })

  // surrogate ids, assigned in DUMP ORDER (deterministic given identical inputs).
  // TWO maps, one per namespace: on Gmail a single-message thread's thread_id EQUALS its
  // message's id, so a shared map would hand messages thread-surrogates (and vice versa).
  const realMsgId = {}
  const realThreadId = {}
  const surrogateMsgId = {}
  const surrogateThreadId = {}
  // real msg_id -> the message's own date. The map's evidence citations come back as message ids,
  // so this is what lets anything built from them be dated by the EMAIL rather than by the moment
  // the setup ran (see adopt.js).
  const msgDate = {}
  // real msg_id -> everything needed to STORE that message later (adopt.js keeps the ones the map
  // actually cites, so evidence is openable mail rather than a dead id)
  const msgMeta = {}
  let mSeq = 0
  let tSeq = 0

  const meTag = (a) => {
    const s = String(a || '').toLowerCase()
    return s ? (a + (meSet.has(s) ? ' [ME]' : '')) : ''
  }
  const addrsLine = (list) => (list || []).map(x => meTag(x && x.address)).filter(Boolean).join(', ')

  const stats = {
    accounts: (accountInfos || []).map(a => a.account_email || a.account_id),
    windowFrom: day(fromMs),
    windowTo: day(anchorMs),
    // machine-readable window bounds. newestMs is the date of the LAST message actually included —
    // adoption turns it into the account cursor, i.e. the line between "the bootstrap read this"
    // and "this is new mail", so it must be the real maximum, not the window's end.
    fromMs,
    anchorMs,
    newestMs: 0,
    partialThreads: 0,
    historyDays,
    messages: 0,
    threads: threads.length,
    truncatedBodies: 0,
    wholeMode: 0,
    bulkCapped: 0,
    degraded: null
  }

  // per-message renderer; caps is { normal, bulk } so the degrade pass can shrink and re-render
  const renderMsg = (m, sur, caps) => {
    const isBulk = (m.labels || []).some(l => BULK_LABELS.test(String(l)))
    let cap = isBulk ? caps.bulk : caps.normal
    if (m.body_mode === 'whole') cap = cap * WHOLE_MULT
    let body = m.clean_text || ''
    if (body.length > cap) {
      stats.truncatedBodies++
      body = body.slice(0, cap) + '\n…[truncated ' + (body.length - cap) + ' chars]'
    }
    if (isBulk) stats.bulkCapped++
    if (m.body_mode === 'whole') stats.wholeMode++
    const lines = [
      '--- msg ' + sur + ' · ' + iso(m.date),
      'From: ' + meTag(m.from && m.from.address) + (m.from && m.from.name ? ' (' + m.from.name + ')' : '') +
        ((m.to || []).length ? '  To: ' + addrsLine(m.to) : '') +
        ((m.cc || []).length ? '  Cc: ' + addrsLine(m.cc) : '')
    ]
    if (m.in_reply_to && surrogateMsgId[m.in_reply_to]) lines.push('↳ replies to: ' + surrogateMsgId[m.in_reply_to])
    if ((m.labels || []).length) lines.push('Labels: ' + m.labels.join(', '))
    if (m.body_mode === 'whole') lines.push('[WHOLE BODY' + (m.body_mode_reason ? ': ' + m.body_mode_reason : '') + ']')
    lines.push(body || '(empty body)')
    return lines.join('\n')
  }

  const build = (caps) => {
    stats.messages = 0
    stats.newestMs = 0
    stats.truncatedBodies = 0
    stats.wholeMode = 0
    stats.bulkCapped = 0
    const parts = []
    parts.push('# MAILBOX DUMP for bulk analysis')
    parts.push('User addresses (ME): ' + [...meSet].sort().join(', '))
    parts.push('Accounts: ' + stats.accounts.join(', '))
    parts.push('Window: ' + stats.windowFrom + ' → ' + stats.windowTo + ' (' + historyDays + ' days) · ' +
      threads.reduce((n, t) => n + t.msgs.length, 0) + ' messages · ' + threads.length + ' threads')
    parts.push('Note: msg/thread ids in this dump are short surrogates — cite them exactly as given.')
    parts.push('')
    parts.push('## Seed context from the user')
    parts.push(seedContext && seedContext.trim() ? seedContext.trim() : 'none provided')
    parts.push('')
    parts.push('## Current state')
    parts.push(currentState && currentState.trim() ? currentState.trim() : 'none — this is a first run.')
    parts.push('')
    for (const { tid, msgs } of threads) {
      const tSur = surrogateThreadId[tid] || ('th' + pad(++tSeq, 3))
      surrogateThreadId[tid] = tSur
      realThreadId[tSur] = tid
      const earlier = droppedBefore.get(tid) || 0
      const partial = partialSet.has(tid)
      parts.push('=== THREAD ' + tSur + ' · ' + msgs.length + ' message' + (msgs.length > 1 ? 's' : '') +
        ' · last active ' + day(msgs[msgs.length - 1].date) +
        (partial
          ? ' · ⚠ INCOMPLETE: ' + (earlier ? earlier + ' earlier message(s)' : 'earlier messages') +
            ' in this thread are outside the window and NOT shown'
          : '') +
        ' ===')
      parts.push('Subject: ' + (msgs[0].subject || '(no subject)'))
      for (const m of msgs) {
        let sur = surrogateMsgId[m.msg_id]
        if (!sur) {
          sur = 'm' + pad(++mSeq, 4)
          surrogateMsgId[m.msg_id] = sur
          realMsgId[sur] = m.msg_id
        }
        stats.messages++
        msgDate[m.msg_id] = Number(m.date) || 0
        msgMeta[m.msg_id] = {
          msg_id: m.msg_id,
          thread_id: tid,
          date: Number(m.date) || 0,
          // m is a normalizeMessage() output: nested from {address,name} + to/cc object lists.
          // adopt.js and persist.saveEmailBody both read .address off the recipient objects.
          from_address: (m.from && m.from.address) || '',
          from_name: (m.from && m.from.name) || '',
          to_addresses: m.to || [],
          cc_addresses: m.cc || [],
          subject: m.subject || '',
          body_text: m.clean_text || '',
          has_attachments: !!m.has_attachments
        }
        if ((Number(m.date) || 0) > stats.newestMs) stats.newestMs = Number(m.date) || 0
        parts.push(renderMsg(m, sur, caps))
      }
      parts.push('')
    }
    return parts.join('\n')
  }

  const partialSet = new Set(partialThreadIds)
  progress({ stage: 'rendering dump…' })
  let text = build({ normal: BODY_CAP, bulk: BODY_CAP_BULK })
  // graceful degrade (spec §3): shrink bulk to headers-only, then all bodies — never drop threads
  if (text.length > DUMP_CHAR_CAP) {
    stats.degraded = 'bulk mail reduced to headers'
    text = build({ normal: BODY_CAP, bulk: 60 })
  }
  if (text.length > DUMP_CHAR_CAP) {
    stats.degraded = 'bulk mail reduced to headers + all bodies capped at 1200 chars'
    text = build({ normal: 1200, bulk: 60 })
  }
  stats.partialThreads = partialThreadIds.length
  stats.chars = text.length
  stats.estTokens = Math.round(text.length / 4)
  stats.overCap = text.length > DUMP_CHAR_CAP

  return { text, stats, maps: { realMsgId, realThreadId, surrogateMsgId, surrogateThreadId, msgDate, msgMeta, partialThreadIds }, fullBodies }
}

// Translate the model's surrogate ids back to REAL provider ids, in place, everywhere the output
// shape carries them (spec §4 round-trip requirement). Unknown ids are left as-is (flagged by the
// UI rather than dropped — a wrong citation is reviewable, a vanished one is not).
export function translateIds (output, maps) {
  if (!output || typeof output !== 'object') return output
  const m = (id) => (maps.realMsgId[id] || id)
  const t = (id) => (maps.realThreadId[id] || id)
  const mapArr = (arr, fn) => Array.isArray(arr) ? arr.map(fn) : arr
  for (const p of (output.projects || [])) {
    p.thread_ids = mapArr(p.thread_ids, t)
    p.evidence_msg_ids = mapArr(p.evidence_msg_ids, m)
    // todos (the current shape) AND notable_open_items (what they were called before §2b) — an
    // untranslated evidence id is a surrogate like m0042, which resolves to nothing downstream
    for (const it of (p.todos || [])) it.evidence_msg_ids = mapArr(it.evidence_msg_ids, m)
    for (const it of (p.notable_open_items || [])) it.evidence_msg_ids = mapArr(it.evidence_msg_ids, m)
  }
  for (const pr of (output.profiles || [])) pr.evidence_msg_ids = mapArr(pr.evidence_msg_ids, m)
  for (const a of (output.autofile_candidates || [])) a.evidence_msg_ids = mapArr(a.evidence_msg_ids, m)
  for (const f of (output.fetch_requests || [])) f.msg_id = m(f.msg_id)
  return output
}
