// subscriptionsCore.js — inter-app EMAIL SUBSCRIPTIONS (specs/interapp-subscriptions.md).
// Another app asks superlazy "send me every email matching <prompt>" (two-field contract:
// prompt + include_original). The user approves inside superlazy (connectedTab.js); approved
// subscriptions live in the `subscriptions` collection. This module is the JOB-SIDE core:
//
//   loadActiveSubscriptions(freezr)  — load active subs ONCE per run, BEFORE the durable sig /
//                                      pin adoption (their prompt lines ride the cached durable
//                                      turn, and durableSig covers them via workflowInstructions).
//   subscriptionPromptLines()        — deterministic (sorted) per-sub detector lines.
//   subscriptionPrefilterHit(newMsg) — cheap deterministic gate used by rulesEngine.preAnalyze to
//                                      rescue matching mail from the autopilot short-circuit
//                                      (invoice-like senders are EXACTLY the mail most likely to
//                                      be filed without any LLM read — engine.js:404).
//   deliverSubscriptionMatch(...)    — the app_subscription onTrigger body: write an idempotent
//                                      delivery record, then best-effort send the message now.
//                                      Anything not sent here is flushed by the browser
//                                      (subscriptionsData.flushDeliveries) — records are the
//                                      source of truth, messages are the transport.
//
// State is MODULE-LEVEL on purpose: a run (job or tab) is single-process and loads once, and it
// keeps workflowInstructions() zero-argument so durableSig/ingest/engine call sites are unchanged.

const lc = (s) => String(s || '').toLowerCase()

let ACTIVE = [] // active subscription records, sorted by sub_id (deterministic prompt bytes)

export function setActiveSubscriptions (list) {
  ACTIVE = (Array.isArray(list) ? list : [])
    .filter(s => s && s.sub_id && s.status === 'active' && s.prompt && !promptTooLong(s.prompt)) // over-length never reaches the model, whatever the record says
    .sort((a, b) => (a.sub_id < b.sub_id ? -1 : 1))
}

export const activeSubscriptions = () => ACTIVE
export const getSubscription = (subId) => ACTIVE.find(s => s.sub_id === subId) || null

// Load once per run. Failing open with [] (collection missing on old installs) — a run must
// never die because the subscriptions feature isn't set up yet.
export async function loadActiveSubscriptions (freezr) {
  try {
    const recs = await freezr.query('subscriptions', { status: 'active' }, {})
    setActiveSubscriptions(Array.isArray(recs) ? recs : [])
  } catch (e) {
    console.warn('[superlazy] subscriptions not loaded (' + ((e && e.message) || e) + ') — none active this run')
    setActiveSubscriptions([])
  }
  return ACTIVE
}

// FNV-1a — same recipe as ingest.durableSig, duplicated to keep this module dependency-free.
export function fnv (s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

// The requester's prompt is UNTRUSTED third-party text riding into our LLM request: flatten
// whitespace, strip quote chars that could break out of the template. It is NEVER cut (user,
// 2026-10-04: "if the user accepts the prompt, they accept it"). Until then this sliced at 1,000
// characters, silently — all three subscription prompts (1,156–1,315 chars) lost the tail of their
// "Return JSON" spec, and the model invented payload field names (37 distinct keys across 26
// "call made" deliveries; `ccy` vs `currency`). A prompt over PROMPT_MAX_CHARS is REFUSED at intake
// (subscriptionsData.js: status denied + a reason the user sees and the app receives) — a ceiling
// still matters because these lines ride in every cached request.
export const PROMPT_MAX_CHARS = 3000
export function containedPrompt (prompt) {
  return String(prompt || '').replace(/\s+/g, ' ').replace(/"/g, '’').trim()
}
export const promptTooLong = (prompt) => containedPrompt(prompt).length > PROMPT_MAX_CHARS

// One detector line per active subscription — injected via workflowInstructions() so it rides in
// the CACHED durable turn (near-zero marginal cost per message). MUST be byte-stable for a given
// subscription set: sorted by sub_id, no timestamps.
export function subscriptionPromptLines () {
  return ACTIVE.map(s =>
    'APP SUBSCRIPTION ' + s.sub_id + ': a connected app ("' + containedPrompt(s.label || s.requester_app) +
    '") has this standing request, approved by the user: "' + containedPrompt(s.prompt) + '". ' +
    'If and ONLY IF the current message matches that request’s conditions, add a trigger ' +
    '{ "type": "app_subscription", "details": { "sub_id": "' + s.sub_id + '", ' +
    '"payload": <exactly the data the request asks for, in the format it asks for — an object, or that same object as JSON TEXT if your output format only allows a string here> } }. ' +
    'Judge the CURRENT message only; never include content from any other message. This never ' +
    'changes how you otherwise analyse the message — file, summarize and create to-dos as normal.'
  )
}

// Cheap deterministic pre-gate. A hit does NOT mean "matched" (the LLM decides that) — it means
// "do not short-circuit this message past the LLM". No prefilter on a sub = that sub only sees
// mail that reaches the LLM anyway (stated in the approval UI).
export function subscriptionPrefilterHit (newMsg) {
  if (!ACTIVE.length || !newMsg) return []
  const subject = lc(newMsg.subject)
  const fromAddr = lc(newMsg.from && newMsg.from.address)
  const domain = fromAddr.includes('@') ? fromAddr.slice(fromAddr.indexOf('@') + 1) : ''
  const atts = newMsg.attachments || []
  const hasAtt = !!(newMsg.has_attachments || newMsg.hasAttachments || atts.length)
  const extOf = (a) => lc((a && (a.filename || '')).split('.').pop())
  const hits = []
  for (const s of ACTIVE) {
    const pf = s.prefilter
    if (!pf) continue
    let hit = false
    if (!hit && Array.isArray(pf.subject_keywords)) {
      hit = pf.subject_keywords.some(k => k && subject.includes(lc(k)))
    }
    if (!hit && Array.isArray(pf.from_domains) && pf.from_domains.length) {
      hit = pf.from_domains.some(d => d && (domain === lc(d) || domain.endsWith('.' + lc(d))))
    }
    if (!hit && pf.has_attachments && hasAtt) {
      hit = !Array.isArray(pf.attachment_types) || !pf.attachment_types.length ||
        atts.some(a => pf.attachment_types.map(lc).includes(extOf(a)))
    }
    if (hit) hits.push(s.sub_id)
  }
  return hits
}

// A payload arrives as an OBJECT normally, and as JSON TEXT when the reply was produced under a
// strict schema (which cannot express a free-form object — see analysisSchema's trigger comment).
// Both are the same delivery; the requesting app must never see the difference.
export function parsePayload (payload) {
  if (payload == null) return null
  if (typeof payload !== 'string') return payload
  const t = payload.trim()
  if (!t) return null
  try {
    const parsed = JSON.parse(t)
    return (parsed && typeof parsed === 'object') ? parsed : { value: parsed }
  } catch (e) {
    // Not JSON after all — deliver the text rather than dropping the match on the floor.
    return { text: payload }
  }
}

// Build the wire envelope (spec §4.3) from a delivery record — shared with the browser flusher.
export function deliveryEnvelope (rec) {
  return {
    service: 'email_subscription',
    kind: 'delivery',
    sub_id: rec.sub_id,
    delivery_id: rec.delivery_id,
    payload: rec.payload,
    email_meta: rec.email_meta,
    shared: rec.shared || null
  }
}

// Who am I? — works in BOTH runtimes: the browser has the freezrMeta global; the job client is
// built from the same SDK sources but freezrMeta is scoped inside it, so fall back to one
// freezr.utils.ping() (returns user_id + app_name) and cache the answer.
let SELF = null
export async function selfMeta (freezr) {
  if (SELF) return SELF
  if (typeof freezrMeta !== 'undefined' && freezrMeta && freezrMeta.userId) {
    SELF = { userId: freezrMeta.userId, appName: freezrMeta.appName }
    return SELF
  }
  const p = await freezr.utils.ping()
  SELF = { userId: p.user_id, appName: p.app_name || 'com.salmanff.superlazy' }
  return SELF
}

// Send one delivery record as an inter-app message. The job client ships the full messages API
// (it is built from the same freezrApiV2 sources), so this works in both runtimes.
export async function sendDeliveryMessage (freezr, sub, rec) {
  if (!freezr.messages || typeof freezr.messages.send !== 'function') {
    return { sent: false, reason: 'messaging unavailable in this runtime' }
  }
  const me = await selfMeta(freezr)
  await freezr.messages.send({
    recipient_id: me.userId,
    recipient_app: sub.requester_app,
    messaging_permission: 'msg_subscribers',
    table_id: me.appName + '.subscription_deliveries',
    record_id: rec.delivery_id,
    record: deliveryEnvelope(rec)
  })
  return { sent: true }
}

// Flush every pending_send delivery: share the original (when approved), send the message, mark
// the record sent. Runtime-agnostic — called at the END of every ingestion run (job and tab), so
// deliveries flow without anyone visiting the Connected apps tab; that tab's render calls it too.
// The original email snapshot lives in the `inputs` collection since the inputs abstraction
// (email_bodies is legacy read-fallback — checked second for old installs).
export async function flushPendingDeliveries (freezr) {
  const out = { pending: 0, sent: 0, dropped: 0, failed: 0 }
  let pending = []
  try {
    pending = await freezr.query('subscription_deliveries', { status: 'pending_send' }, {})
  } catch (e) { return out }
  out.pending = (pending || []).length
  if (!out.pending) return out

  let subs = []
  try { subs = await freezr.query('subscriptions', {}, {}) } catch (e) { subs = [] }
  const subById = Object.fromEntries((subs || []).map(s => [s.sub_id, s]))
  const me = await selfMeta(freezr).catch(() => null)

  for (const rec of pending) {
    const sub = subById[rec.sub_id]
    try {
      if (!sub || sub.status !== 'active') {
        await freezr.updateFields('subscription_deliveries', rec._id, { status: 'dropped', drop_reason: 'subscription no longer active' })
        out.dropped++
        continue
      }
      if (sub.include_original && !rec.shared && me) {
        try {
          const msgId = rec.email_meta && rec.email_meta.msg_id
          let snap = null
          let snapTable = me.appName + '.inputs'
          const inputs = await freezr.query('inputs', { msg_id: msgId }, { count: 1 }).catch(() => [])
          if (inputs && inputs[0]) snap = inputs[0]
          if (!snap) {
            const bodies = await freezr.query('email_bodies', { msg_id: msgId }, { count: 1 }).catch(() => [])
            if (bodies && bodies[0]) { snap = bodies[0]; snapTable = me.appName + '.email_bodies' }
          }
          if (snap && snap._id) {
            await freezr.perms.shareRecords(snap._id, {
              name: 'share_originals',
              table_id: snapTable,
              grantees: ['app:' + sub.requester_app],
              action: 'grant'
            })
            rec.shared = { email_body: { table_id: snapTable, record_id: snap._id }, files: [] } // TODO(v1.1): attachments
            await freezr.updateFields('subscription_deliveries', rec._id, { shared: rec.shared })
          } else {
            await freezr.updateFields('subscription_deliveries', rec._id, { share_note: 'no body snapshot found for ' + msgId })
          }
        } catch (e) {
          await freezr.updateFields('subscription_deliveries', rec._id, { share_note: 'share failed: ' + ((e && e.message) || e) }).catch(() => {})
        }
      }
      const sent = await sendDeliveryMessage(freezr, sub, rec)
      if (sent.sent) {
        await freezr.updateFields('subscription_deliveries', rec._id, { status: 'sent', sent_asof: Date.now() })
        out.sent++
        const st = (sub.stats || {})
        const delivered = (Number(st.delivered) || 0) + 1
        sub.stats = { delivered, last_delivery_asof: Date.now() }
        await freezr.updateFields('subscriptions', sub.sub_id, { stats: sub.stats }).catch(() => {})
      } else {
        out.failed++
      }
    } catch (e) {
      console.warn('[superlazy] delivery flush failed for ' + rec._id + ':', (e && e.message) || e)
      out.failed++
    }
  }
  return out
}

// The app_subscription onTrigger body. Idempotent: the delivery record's _id is deterministic
// over (sub_id, account, msg), so lock takeovers / retries can never double-deliver — a re-run
// finds the record and stops. Message send is best-effort here; the browser flusher retries
// anything left at pending_send (requester side ALSO dedups on delivery_id, so a double SEND
// is harmless too).
// NOTE include_original sharing happens at FLUSH time, not here: the email_bodies snapshot is
// persisted AFTER dispatch (processor.persistOne), so there is nothing to share yet.
// TODO(v1.1): attachment upload + share (needs app-scoped share_records — freezr Task 2 — and a
// mail-connected runtime; see spec §6.5).
export async function deliverSubscriptionMatch ({ freezr, sub, trigger, newMsg, threadId, accountId, asof }) {
  const deliveryId = 'del_' + sub.sub_id + '_' + fnv(String(accountId || '') + '|' + String(newMsg.msg_id || ''))
  try {
    const existing = await freezr.read('subscription_deliveries', deliveryId).catch(() => null)
    if (existing && existing.sub_id) return { sub_id: sub.sub_id, delivery_id: deliveryId, skipped: 'duplicate' }
  } catch (e) { /* not found — proceed */ }

  const det = (trigger && trigger.details) || {}
  const rec = {
    sub_id: sub.sub_id,
    requester_app: sub.requester_app,
    service: 'email_subscription',
    delivery_id: deliveryId,
    status: 'pending_send',
    payload: parsePayload(det.payload),
    email_meta: {
      from: (newMsg.from && { address: newMsg.from.address || null, name: newMsg.from.name || null }) || null,
      subject: newMsg.subject || '',
      received_at: Number(newMsg.date) || Number(asof) || null,
      msg_id: newMsg.msg_id || null,
      thread_id: threadId || null,
      account_id: accountId || null
    },
    shared: null,
    created_asof: Number(asof) || Date.now()
  }
  await freezr.create('subscription_deliveries', rec, { data_object_id: deliveryId, upsert: true })

  let send = { sent: false, reason: 'left for browser flush' }
  try {
    if (!sub.include_original) { // include_original waits for flush-time sharing anyway
      send = await sendDeliveryMessage(freezr, sub, rec)
      if (send.sent) await freezr.updateFields('subscription_deliveries', deliveryId, { status: 'sent', sent_asof: Date.now() })
    }
  } catch (e) {
    send = { sent: false, reason: (e && e.message) || String(e) }
  }
  return { sub_id: sub.sub_id, delivery_id: deliveryId, requester_app: sub.requester_app, sent: send.sent, send_note: send.reason || null }
}
