// subscriptionsData.js — browser-side data layer for INTER-APP SUBSCRIPTIONS
// (specs/interapp-subscriptions.md). Owns: request intake from the message inbox, the
// subscription lifecycle (approve / deny / pause / resume / revoke + status messages back to the
// requester), prefilter derivation, and the delivery flusher (sends pending_send delivery
// records written by the pipeline, sharing originals first when approved).
// UI lives in connectedTab.js. Job-side detection/delivery lives in jobs/analyze_thread/.

import { fnv, containedPrompt, promptTooLong, PROMPT_MAX_CHARS, flushPendingDeliveries, deliveryEnvelope } from '../jobs/analyze_thread/subscriptionsCore.js'

const SERVICE = 'email_subscription'

const approvedHash = (prompt, includeOriginal) =>
  fnv(containedPrompt(prompt) + '|' + (includeOriginal ? '1' : '0'))
// what the hash of this prompt WAS under the 1,000-character cut (containedPrompt sliced until
// 2026-10-04) — lets intake tell "the app edited its request" from "we had cut the stored text"
const legacyCutHash = (prompt, includeOriginal) =>
  fnv(containedPrompt(prompt).slice(0, 1000) + '|' + (includeOriginal ? '1' : '0'))

// A prompt over the ceiling is REFUSED, never cut (user, 2026-10-04): the record is created/kept
// as `denied` with this reason — shown verbatim on the Connected tab — and the app gets the same
// text in its status message, so it knows to shorten and re-send.
const tooLongReason = (prompt) =>
  '⚠ Refused: the request’s prompt is ' + containedPrompt(prompt).length + ' characters; superlazy accepts up to ' +
  PROMPT_MAX_CHARS + '. Nothing was cut — the requesting app must shorten it and send it again.'
const CUT_REFRESH_REASON = 'An earlier version of superlazy had cut this request’s text at 1,000 characters (the end of its return-format spec was missing). The full text is now shown — please approve it again.'

// ---- intake ------------------------------------------------------------------------------------
// Pull subscription requests out of the message inbox and mirror them into the `subscriptions`
// collection (deterministic _id over requester_app + the requester's request record id, so
// re-reading the same message is a no-op). Returns { seen, created, updated }.
export async function intakeRequests () {
  const res = await freezr.messages.getAppMessages({ count: 100 })
  const messages = (res && res.messages) || []
  const inbound = messages.filter(m =>
    m && m.app_id && m.app_id !== freezrMeta.appName &&
    m.recipient_app === freezrMeta.appName &&
    m.record && m.record.service === SERVICE)
  const out = { seen: inbound.length, created: 0, updated: 0 }
  const processedMsgIds = []
  for (const m of inbound) {
    try {
      const requesterApp = m.app_id
      const requestRef = m.record_id || m._id
      const subId = 'sub_' + fnv(requesterApp + '|' + requestRef)
      const req = m.record
      const existing = await freezr.read('subscriptions', subId).catch(() => null)
      const hash = approvedHash(req.prompt, req.include_original)
      const tooLong = promptTooLong(req.prompt)

      if (!existing || !existing.sub_id) {
        if (req.status === 'cancelled') { processedMsgIds.push(m._id); continue }
        const rec = {
          sub_id: subId,
          requester_app: requesterApp,
          request_ref: requestRef,
          service: SERVICE,
          label: containedPrompt(req.label || requesterApp).slice(0, 60),
          prompt: containedPrompt(req.prompt),
          include_original: req.include_original === true,
          requested_hash: hash,
          prefilter: null,
          status: tooLong ? 'denied' : 'pending',
          status_reason: tooLong ? tooLongReason(req.prompt) : null,
          created_asof: Date.now(),
          stats: { delivered: 0, last_delivery_asof: null }
        }
        await freezr.create('subscriptions', rec, { data_object_id: subId, upsert: true })
        if (tooLong) await sendStatusMessage(rec, 'denied', rec.status_reason).catch(e => console.warn('[superlazy] status message failed:', e))
        out.created++
      } else if (req.status === 'cancelled' && existing.status !== 'cancelled') {
        await freezr.updateFields('subscriptions', subId, { status: 'cancelled', status_reason: 'cancelled by the requesting app' })
        out.updated++
      } else if (hash !== existing.requested_hash) {
        // the requester EDITED the request — anything already approved goes back to pending; an
        // over-length edit is refused outright. A hash that only differs because WE used to cut the
        // text at 1,000 characters is not an edit: the stored copy is completed and re-approval asked
        // with the honest reason.
        const wasCutByUs = existing.requested_hash === legacyCutHash(req.prompt, req.include_original)
        const fields = {
          prompt: containedPrompt(req.prompt),
          include_original: req.include_original === true,
          label: containedPrompt(req.label || requesterApp).slice(0, 60),
          requested_hash: hash,
          status: tooLong ? 'denied' : 'pending',
          status_reason: tooLong ? tooLongReason(req.prompt) : (wasCutByUs ? CUT_REFRESH_REASON : 'edited by the requesting app — needs your approval again')
        }
        await freezr.updateFields('subscriptions', subId, fields)
        if (tooLong) await sendStatusMessage({ ...existing, ...fields }, 'denied', fields.status_reason).catch(e => console.warn('[superlazy] status message failed:', e))
        out.updated++
      }
      processedMsgIds.push(m._id)
    } catch (e) {
      console.warn('[superlazy] subscription intake failed for one message:', e)
      // leave unread so the next intake retries it
    }
  }
  if (processedMsgIds.length) {
    try { await freezr.messages.markRead(processedMsgIds) } catch (e) { /* non-fatal */ }
  }
  return out
}

export async function listSubscriptions () {
  const recs = await freezr.query('subscriptions', {}, { sort: { _date_modified: -1 } })
  return Array.isArray(recs) ? recs : []
}

// ---- lifecycle ----------------------------------------------------------------------------------

async function sendStatusMessage (sub, status, reason) {
  await freezr.messages.send({
    type: 'message_direct',
    recipient_id: freezrMeta.userId,
    recipient_app: sub.requester_app,
    messaging_permission: 'msg_subscribers',
    table_id: freezrMeta.appName + '.subscription_deliveries',
    record: { service: SERVICE, kind: 'status', sub_id: sub.sub_id, request_ref: sub.request_ref, status, reason: reason || null }
  })
}

async function setStatus (sub, status, reason, extra) {
  await freezr.updateFields('subscriptions', sub.sub_id, { status, status_reason: reason || null, ...(extra || {}) })
  try { await sendStatusMessage(sub, statusForRequester(status), reason) } catch (e) {
    console.warn('[superlazy] status message to ' + sub.requester_app + ' failed (will not retry): ', e)
  }
}

// requester-facing vocabulary (spec §4.2): approved | denied | paused | revoked
const statusForRequester = (s) => (s === 'active' ? 'approved' : s)

export async function approveSubscription (sub, prefilter) {
  await setStatus(sub, 'active', null, {
    prefilter: prefilter || null,
    approved_hash: sub.requested_hash,
    approved_asof: Date.now()
  })
}
export const denySubscription = (sub, reason) => setStatus(sub, 'denied', reason || null)

// The prefilter is superlazy's OWN dial (cost/coverage of the short-circuit rescue) — not part
// of the requester's contract, so editing it needs no re-approval and no status message. Takes
// effect on the next mail check (the pipeline loads subscriptions at run start).
export const updatePrefilter = (sub, prefilter) =>
  freezr.updateFields('subscriptions', sub.sub_id, { prefilter: prefilter || null })
export const pauseSubscription = (sub) => setStatus(sub, 'paused', 'paused by you')
export const resumeSubscription = (sub) => setStatus(sub, 'active', null)
export const revokeSubscription = (sub) => setStatus(sub, 'revoked', 'revoked by you')

// ---- prefilter derivation -----------------------------------------------------------------------
// One cheap LLM call at approval time turns the requester's prompt into a deterministic gate
// (keywords / attachment types / domains) that rescues matching mail from the autopilot
// short-circuit (see rulesEngine.preAnalyze). Best-effort: no LLM → empty prefilter, and the
// subscription simply only sees mail that reaches the LLM anyway.
export async function derivePrefilter (prompt) {
  const empty = { subject_keywords: [], attachment_types: [], from_domains: [], has_attachments: false }
  try {
    const res = await freezr.llm.ask(
      'A mail app needs a CHEAP deterministic pre-filter for this standing request over incoming email: "' +
      containedPrompt(prompt) + '". Reply with ONLY a JSON object: { "subject_keywords": [up to 8 short ' +
      'lowercase substrings likely in matching subjects], "attachment_types": [file extensions like "pdf", ' +
      'empty if attachments are not typical], "from_domains": [], "has_attachments": true|false (true if ' +
      'matching mail typically carries an attachment) }. Over-inclusion is fine (a hit only forces a ' +
      'closer read); under-inclusion misses mail.',
      { responseType: 'json', max_tokens: 300 }
    )
    const p = (res && res.success && typeof res.response === 'object') ? res.response : null
    if (!p) return empty
    return {
      subject_keywords: Array.isArray(p.subject_keywords) ? p.subject_keywords.slice(0, 12).map(String) : [],
      attachment_types: Array.isArray(p.attachment_types) ? p.attachment_types.slice(0, 6).map(String) : [],
      from_domains: Array.isArray(p.from_domains) ? p.from_domains.slice(0, 12).map(String) : [],
      has_attachments: p.has_attachments === true
    }
  } catch (e) {
    console.warn('[superlazy] prefilter derivation failed — approving with an empty prefilter:', e)
    return empty
  }
}

// ---- delivery flushing ---------------------------------------------------------------------------
// The pipeline writes idempotent delivery records (status pending_send). The FLUSH — share the
// original snapshot (inputs collection), send the inter-app message, mark sent — lives in
// subscriptionsCore.flushPendingDeliveries and runs at the tail of every ingestion run; this
// browser wrapper is the Connected-apps-tab backstop for records a job run could not send.
export const flushDeliveries = () => flushPendingDeliveries(freezr)

export async function deliveredCount (subId) {
  try {
    const recs = await freezr.query('subscription_deliveries', { sub_id: subId, status: 'sent' }, {})
    return Array.isArray(recs) ? recs.length : 0
  } catch (e) { return 0 }
}

export { deliveryEnvelope }
