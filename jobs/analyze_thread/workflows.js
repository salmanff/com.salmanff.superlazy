// workflows.js — PERMANENT core. The AUTO-PROCESS ACTION registry: app-side algorithms the LLM
// triggers by returning an action entry in a top-level `triggers` array — the shape is
// { type: "<registry key>", details: { ...per-type fields } }. Each entry colocates three things
// so the prompt and the app-side reaction can never drift:
//   prompt_instruction — the "if X, emit action Y" line injected into the request (assemble.js)
//   onTrigger          — the algorithm, run AFTER the analysis is reconciled (may be async / heavy)
//   shortCircuit       — OPTIONAL pre-analysis check: if it can handle the message WITHOUT the LLM
//                        (and nothing higher-priority applies), the LLM call is skipped entirely.
// The first action — `automated` — generalizes "newsletter" into a set of AUTOMATED-EMAIL
// categories (newsletter / admin / social / promotions): the LLM classifies bulk/machine-generated
// mail into one category + a standing bucket, we learn the sender (a file_to_project auto-process
// on their profile — see autoProcess.js), and future mail auto-processes with no LLM.
// See specs/pipeline-walkthrough.md §10 (the workflow registry and the trigger contract).

import { FILE_TO_PROJECT, fileToProject, getAutoProcess } from './autoProcess.js'
import { subscriptionPromptLines, getSubscription, deliverSubscriptionMatch } from './subscriptionsCore.js'

const lc = (s) => String(s || '').toLowerCase()
const isClosedStatus = (st) => st === 'resolved' || st === 'cancelled'

// The set of automated-email categories (a constant; making it user-editable is a backlog idea). `bucket` is the
// standing project name the LLM should reuse so short-circuited mail files into the SAME place.
// `importance` is what a SHORT-CIRCUITED item gets (no LLM read the body, so it cannot be judged
// per-message): bulk categories sit at the bottom at 1, but admin_actions is the category for mail
// that ASKS SOMETHING OF THE USER, so its items must not be buried.
// `prefix` is the short_description prefix for auto-filed items (defaults to `label`).
export const AUTOMATED_CATEGORIES = [
  { key: 'newsletter', label: 'Newsletters', bucket: 'Newsletters', importance: 1, description: 'Editorial or subscription digests and mailing lists the user reads (e.g. Stratechery, Substack, company blogs).' },
  { key: 'admin', label: 'Admin / Updates', bucket: 'Admin / Updates', importance: 1, description: 'Transactional/account mail that is purely INFORMATIONAL — asks nothing of the user: receipts for completed payments, shipping & delivery notices, routine account statements, service-status and security notices with no action required.' },
  { key: 'admin_actions', label: 'Admin - Action needed', bucket: 'Admin - Action needed', importance: 3, prefix: 'Action needed', description: 'Transactional/account mail that ASKS THE USER TO ACT, or carries money or a deadline: payments due or overdue, invoices to pay, requests to confirm or update bank/payment details, tax documents, signature / verification / KYC requests, expiring cards, policies or subscriptions, and appointment confirmations to make. When a message could be either this or `admin`, CHOOSE THIS ONE — the cost of over-filing here is that the user reads one extra mail; the cost of under-filing is a missed payment or deadline.' },
  { key: 'social', label: 'Social', bucket: 'Social', importance: 1, description: 'Notifications from social networks, forums, and dating sites (mentions, follows, matches, activity digests).' },
  { key: 'promotions', label: 'Promotions', bucket: 'Promotions', importance: 1, description: 'Deals, sales, marketing offers, and promotional blasts.' }
]
const CAT_KEYS = new Set(AUTOMATED_CATEGORIES.map(c => c.key))
const CAT_LABEL = Object.fromEntries(AUTOMATED_CATEGORIES.map(c => [c.key, c.label]))
const catOf = (key) => AUTOMATED_CATEGORIES.find(c => c.key === key) || null

// Mismatch comparison FAMILY. A mail system's own labels are coarser than our categories: Gmail's
// CATEGORY_UPDATES covers both `admin` and `admin_actions`, so comparing raw keys would flag EVERY
// admin_actions message as a mismatch. Collapse the pair to one family for that comparison only.
const catFamily = (key) => (key === 'admin_actions' ? 'admin' : key)

// Best-effort map from a mail system's own labels/categories to our category. Used BOTH as a hint
// we tell the model about, and as a short-circuit STRADDLE GUARD (a sender normally sends admin
// mail but THIS one is labelled Promotions ⇒ don't auto-file, let the LLM re-judge).
function categoryFromLabels (labels) {
  const set = (labels || []).map(l => String(l).toUpperCase())
  if (set.includes('CATEGORY_PROMOTIONS')) return 'promotions'
  if (set.includes('CATEGORY_SOCIAL')) return 'social'
  if (set.includes('CATEGORY_UPDATES') || set.includes('CATEGORY_FORUMS')) return 'admin'
  return null
}

// ---- the human guard ------------------------------------------------------------------------
// Putting a sender on autopilot is the stickiest decision in the app: from then on their mail is
// filed WITHOUT being read, so a false positive silently hides a real correspondent. The prompt asks
// the model to apply a sender test (see automatedInstruction), but a standing decision is too
// expensive to leave to a prompt alone — so the app checks too, and REFUSES to learn a sender that
// looks like a person. Cost of being wrong here: one LLM read of their next message. Cost of being
// wrong the other way: the user stops seeing someone's email.

// Machine-shaped local parts. Deliberately NOT including the ambiguous role addresses (info@,
// support@, team@, hello@, contact@, sales@) — a human really does answer those at a small firm.
const MACHINE_LOCAL = /^(no[-._]?reply|do[-._]?not[-._]?reply|donotreply|reply|notification[s]?|notify|alert[s]?|mailer|mail[-._]?daemon|postmaster|bounce[s]?|automated|auto[-._]?reply|autoresponder|robot|bot|daemon|system|sysadmin|noc|digest|newsletter[s]?|news|bulletin|updates?|announce(ments?)?|receipts?|statements?|invoices?|billing|payments?|orders?|shipping|tracking|security|verify|verification|confirm(ation)?|account[s]?|service[s]?|messages?|mail|email|unsubscribe|feedback|survey|marketing|promo(tions?)?|offers?|deals?|members?|community|forum|social)([-._+][a-z0-9-]+)?$/i
// Bulk-sending infrastructure in the domain.
const BULK_DOMAIN = /(^|\.)(mail|email|em|e|mailer|smtp|send|sendmail|mailing|news|notifications?|alerts?|reply|bounce|mkt|marketing)\.|(sendgrid\.net|mailchimp|mcsv\.net|list-manage\.com|substack\.com|mailgun|sparkpostmail|amazonses|postmarkapp|mandrillapp|cmail\d*\.com|hubspotemail|salesforce\.com|intercom-mail|zendesk\.com)/i

export function looksMachineAddress (address) {
  const a = lc(address)
  const at = a.indexOf('@')
  if (at < 1) return false
  const local = a.slice(0, at)
  const domain = a.slice(at + 1)
  if (MACHINE_LOCAL.test(local)) return true
  if (BULK_DOMAIN.test(domain)) return true
  // long opaque tokens are bounce/tracking addresses, never people
  if (/^[a-z0-9]{20,}$/.test(local.replace(/[-._+]/g, ''))) return true
  return false
}

/**
 * Should this sender be kept OFF autopilot? Returns a human-readable reason, or null to allow.
 * Two independent vetoes, cheapest first:
 *   1. the user has WRITTEN to them — you do not reply to a robot, so this is a correspondent.
 *      This is observed fact from the user's own mailbox, which beats any inference about the address.
 *   2. the address does not look like a machine AND the mail system does not call this bulk.
 *      Either signal alone is enough to allow learning; needing both to be absent keeps the guard
 *      from blocking genuine newsletters that happen to send from a person-shaped address.
 */
export function autopilotVeto ({ sender, newMsg, profiles }) {
  const addr = lc(sender)
  if (!addr) return 'no sender address'
  const p = profiles && profiles.get && profiles.get(addr)
  const d = (p && p.interaction_data) || {}
  if ((Number(d.messages_to) || 0) > 0 || (Number(d.replies_by_user) || 0) > 0) {
    return 'you have written to ' + addr + ' — they are a correspondent, not a mailing list'
  }
  // A user-backed decision (hand-locked, or reviewed during setup) is never second-guessed on the
  // strength of the address alone — see the shortCircuit caller.
  const ap = p && p.profile && (p.profile.auto_processes || []).find(a => a && a.type === FILE_TO_PROJECT && a.active)
  if (ap && (ap.locked || ap.source === 'bootstrap')) return null
  if (!looksMachineAddress(addr) && !categoryFromLabels(newMsg && newMsg.labels)) {
    // NB: this is a word-list test on the local part (noreply/billing/digest/…), NOT an inference
    // that the name looks human, and it ignores the domain entirely — interactive.wsj.com counts
    // for nothing. Word it as what it is, so nobody reads more into it than it can support.
    return addr + ' is not one of the machine-sounding addresses we recognise, and your mail system does not label this as bulk'
  }
  return null
}

function headline (subject) {
  const s = String(subject || '(no subject)').replace(/\s+/g, ' ').trim()
  return s.length > 56 ? s.slice(0, 56) + '…' : s
}

// bucket project NAME → category key ("Newsletters" → newsletter). The strongest learning
// fallback: WHERE the model filed an item tells us its category even when it forgot to say so.
function categoryFromBucketName (name) {
  const c = AUTOMATED_CATEGORIES.find(c => c.bucket === String(name || '').trim())
  return c ? c.key : null
}

// OBSERVABILITY: when a message went to the LLM even though its sender carries an active
// auto-process, name the gate that blocked it — surfaced on the event so "why didn't this
// auto-process?" is never invisible again. Returns null when the sender isn't flagged (normal).
export function autoprocessDiagnostic ({ newMsg, profiles, prefs, store, instructions, account } = {}) {
  const sender = lc(newMsg && newMsg.from && newMsg.from.address)
  const p = sender && profiles && profiles.get(sender)
  const prof = p && p.profile
  if (!prof) return null
  const entry = fileToProject(prof)
  if (!entry) return null
  if (!prefs || !prefs.automated_autopilot) return 'the "automated autopilot" preference is off (Setup & Prefs)'
  const blocking = instructions && instructions.matching
    ? instructions.matching(sender, account).filter(r => r.scope === 'sender' || r.scope === 'domain')
    : []
  if (blocking.length) return 'a custom instruction for this sender applies — those always go through the AI'
  // the human guard held: this sender carries an auto-process but is being read anyway (see
  // autopilotVeto). Without this line the diagnostic would report "unknown".
  if (!entry.locked) {
    const veto = autopilotVeto({ sender, newMsg, profiles })
    if (veto) return 'the stored auto-process is being ignored because ' + veto
  }
  const disp = entry.details && entry.details.disposition
  const category = CAT_KEYS.has(disp) ? disp : null
  const projectId = entry.details && entry.details.project_id
  const custom = projectId && store && store.get ? store.get(projectId) : null
  if (!custom && !category) return 'its target project no longer exists — re-set auto-process for this sender'
  return 'unknown — please report this' // every known gate passed yet no short-circuit fired
}

// The model sometimes files a bulk message into a category bucket WITHOUT emitting the
// `automated` trigger — then the sender is never learned and every future message costs an LLM
// call. This synthesizes the missing trigger: a created read_only item in a bucket-named project
// = an automated classification in all but name. Called by the engine before dispatchTriggers.
export function inferAutomatedTriggers (output, applied, newMsg, store) {
  const explicit = ((output && output.triggers) || []).some(t => t && (t.type || t.workflow) === 'automated')
  if (explicit) return []
  const sender = lc(newMsg && newMsg.from && newMsg.from.address)
  if (!sender) return []
  for (const c of ((applied && applied.changes) || [])) {
    if (c.type !== 'created' || !c.todo || c.todo.direction !== 'read_only') continue
    const proj = store && store.get && store.get(c.project_id)
    const category = proj && categoryFromBucketName(proj.name)
    if (category) return [{ type: 'automated', details: { category, sender }, inferred: true }]
  }
  return []
}

// The INVERSE hole to inferAutomatedTriggers: the model emits an `automated` trigger but files NO
// read_only item. Then the message has no to-do, so no `changes` entry, so NO ROW on Recent or the
// Events page — it vanishes silently while the sender still gets learned. (This is exactly how an
// important notice disappeared on 2026-07-30.) Synthesize the missing item so
// nothing is ever dropped without a trace. Mutates `applied` in place; returns the created todo or
// null. MUST run BEFORE dispatchTriggers so onTrigger can anchor its project_id to this item.
export function backstopAutomatedItem (triggers, applied, newMsg, store, ctx = {}) {
  const trig = (triggers || []).find(t => t && (t.type || t.workflow) === 'automated')
  if (!trig || !store || !store.addReadOnlyTodo) return null
  const already = ((applied && applied.changes) || [])
    .some(c => c.type === 'created' && c.todo && c.todo.direction === 'read_only')
  if (already) return null
  // FOLDED IN, not dropped: in a batch, a burst of near-identical notices is meant to collapse
  // into ONE item (the first message creates it, the rest UPDATE it). An update that changes no
  // status writes no `changes` entry — field edits are kept off the feed on purpose — so the
  // later messages looked unfiled here, and each got a duplicate "recovered" item, undoing the
  // collapse. If an existing item already cites this message as evidence, the message left a
  // trace: give it a feed row pointing at that item instead of minting a new one.
  const noChanges = !((applied && applied.changes) || []).length
  const msgId = ctx.msgId || (newMsg && newMsg.msg_id)
  const host = noChanges && msgId
    ? store.all().flatMap(pr => (pr.todos || []).map(t => ({ pr, t })))
      .find(({ t }) => (t.evidence || []).some(e => e && e.msg_id === msgId))
    : null
  if (host) {
    if (applied) applied.changes = [...(applied.changes || []), { type: 'absorbed', project_id: host.pr.project_id, todo: host.t }]
    return null
  }
  // The other collapse shape: the model wrote ONE item on the burst's first message (listing every
  // notice in its text) and returned nothing at all for the rest. Then no item cites them, so join
  // the read item an EARLIER message of the SAME batch from the SAME sender created — recording
  // this message on its evidence trail — rather than minting a duplicate.
  const sender0 = lc(newMsg && newMsg.from && newMsg.from.address)
  const batchIds = new Set((ctx.batchMsgIds || []).filter(id => id && id !== msgId))
  const sibling = noChanges && msgId && sender0 && batchIds.size
    ? store.all().flatMap(pr => (pr.todos || []).map(t => ({ pr, t })))
      .find(({ t }) => t.direction === 'read_only' && !isClosedStatus(t.status) && lc(t.sender) === sender0 &&
        (t.evidence || []).some(e => e && batchIds.has(e.msg_id)))
    : null
  if (sibling) {
    sibling.t.evidence = [...(sibling.t.evidence || []), { type: 'mail', source: 'mail', thread_id: ctx.threadId || null, msg_id: msgId, asof: ctx.asof, reason: 'same notice as an earlier message in this batch — folded in', who: sender0, summary: (newMsg && newMsg.subject) || null }]
    if (applied) {
      applied.changes = [...(applied.changes || []), { type: 'absorbed', project_id: sibling.pr.project_id, todo: sibling.t }]
      const touched = applied.touched_project_ids || (applied.touched_project_ids = [])
      if (!touched.includes(sibling.pr.project_id)) touched.push(sibling.pr.project_id)
    }
    return null
  }
  const sender = lc(newMsg && newMsg.from && newMsg.from.address)
  const det = (trig.details || trig || {})
  let key = lc(det.category)
  if (!CAT_KEYS.has(key)) key = categoryFromLabels(newMsg && newMsg.labels)
  const cat = CAT_KEYS.has(key) ? catOf(key) : null
  const bucketName = cat ? cat.bucket : 'Reading / FYI'
  let bucket = store.all().find(pr => pr.name === bucketName && pr.status === 'active') || null
  if (!bucket) bucket = store.ensureProject({ project_id: store.mintProjectId(), name: bucketName, asof: ctx.asof })
  // The model classified this as bulk yet filed nothing — that combination is itself a warning, so
  // never bury the result at 1: floor it at 2 (and keep a promoted category's own floor).
  const importance = Math.max(2, (cat && cat.importance) || 1)
  const { todo, project } = store.addReadOnlyTodo({
    projectId: bucket.project_id,
    short_description: (cat ? (cat.prefix || CAT_LABEL[key]) : 'Unfiled') + ': ' + headline(newMsg.subject),
    description: newMsg.subject || '',
    sender,
    importance,
    change_reason: 'recovered — the analysis marked this automated but filed no item',
    asof: ctx.asof,
    msgId: ctx.msgId,
    threadId: ctx.threadId
  })
  if (applied) {
    applied.changes = [...(applied.changes || []), { type: 'created', project_id: project.project_id, todo }]
    applied.new_ids = [...(applied.new_ids || []), todo.todo_id]
    const ld = applied.latest_delta || (applied.latest_delta = {})
    ld.new_todo_ids = [...(ld.new_todo_ids || []), todo.todo_id]
    const touched = applied.touched_project_ids || (applied.touched_project_ids = [])
    if (!touched.includes(project.project_id)) touched.push(project.project_id)
  }
  return { todo, project }
}

// Build the injected instruction from the category list — single source of truth (prompt + code).
function automatedInstruction () {
  const lines = AUTOMATED_CATEGORIES
    .map(c => `   • ${c.key} → file in a standing project named "${c.bucket}": ${c.description}`)
    .join('\n')
  return 'AUTOMATED EMAIL: if this message is automated / machine-generated BULK mail (not a personal ' +
    'message), classify it into EXACTLY ONE category below, file it as a read_only item in that ' +
    'category\'s standing bucket (reuse the given bucket name), AND add a trigger ' +
    '{ "type": "automated", "details": { "category": "<key>", "sender": "<the sender email>" } }.\n' + lines + '\n' +
    '   SENDER TEST FIRST — "automated" is about WHO SENT IT, not how routine it reads. Only a machine ' +
    'address or bulk platform qualifies: noreply@, notifications@, alerts@, statements@, a sending ' +
    'subdomain. A NAMED PERSON never does — not even for an invoice, statement, receipt or routine ' +
    'notice: that goes in the project it concerns, NOT in Admin / Updates. No category, no trigger. ' +
    'If unsure, treat them as a person. Same for a personal FYI or a forward that matters to a project. ' +
    'The mail system\'s own labels (Promotions, Social, Updates, Forums) are a STRONG hint for the ' +
    'category; their absence on a person-looking sender is a hint this is not bulk mail.\n' +
    '   THE CATEGORY IS A STANDING DECISION ABOUT THE SENDER, NOT JUST THIS MESSAGE: once you ' +
    'categorize a sender, their FUTURE mail is filed there automatically WITHOUT being read. So ask ' +
    '"where should everything this sender sends end up?" — if they ever send payment demands, ' +
    'deadlines or requests to confirm details, admin_actions is the safe home even when THIS ' +
    'particular message is only informational.\n' +
    '   YOU MUST STILL CREATE THE ITEM. Emitting the trigger without filing a read_only item makes ' +
    'the message vanish from every view — never return an "automated" trigger with no to-do for it. ' +
    'And being automated NEVER cancels the obligation test: if the message genuinely asks the USER to ' +
    'act, ALSO create the i_owe_them to-do in the project it belongs to, as you would for any message.'
}

export const WORKFLOWS = {
  automated: {
    keyword: 'automated',
    priority: 0, // pecking order (higher decides first). Automated is the FLOOR — anything out-ranks it.
    prompt_instruction: automatedInstruction(),

    // The algorithm — runs after reconcile so minted ids are visible. LEARNS: set a
    // file_to_project auto-process on the sender's profile with its category (disposition) and
    // the bucket the read item landed in, so future mail from them can be handled without the
    // LLM (see shortCircuit).
    // DETERMINISTIC learning: the model marking a message "automated" ALWAYS activates the
    // sender's file_to_project action — no ambiguity. Category is best-effort garnish (trigger →
    // mail labels → the bucket it was filed into); even with NO category, the action is set and
    // the target is wherever the model filed it. The ONLY exception: the user locked the action —
    // then nothing changes and the model's dissent is stored (entry.suggested) so the UI warns.
    async onTrigger ({ trigger, newMsg, applied, profiles, store, asof }) {
      const det = (trigger && trigger.details) || trigger || {} // details preferred; flat legacy shape tolerated
      const sender = lc(det.sender || (newMsg && newMsg.from && newMsg.from.address))
      if (!sender || !profiles.setAutoProcess) return null
      const reads = ((applied && applied.changes) || [])
        .filter(c => c.type === 'created' && c.todo && c.todo.direction === 'read_only')
      const mine = reads.find(c => lc(c.todo.sender) === sender) || reads[0]
      let category = lc(det.category)
      if (!CAT_KEYS.has(category)) category = categoryFromLabels(newMsg && newMsg.labels) // mail-system label
      if (!CAT_KEYS.has(category) && mine && store && store.get) {
        // WHERE it was filed — a bucket-named project names its own category
        const proj = store.get(mine.todo.project_id)
        category = proj ? categoryFromBucketName(proj.name) : null
      }
      const validCat = CAT_KEYS.has(category) ? category : null

      // user lock: the model may not touch a user-set action — record its dissent instead
      const existing = profiles.get && profiles.get(sender)
      const entry = existing && getAutoProcess(existing.profile, FILE_TO_PROJECT)
      if (entry && entry.locked) {
        const wanted = validCat || 'automated'
        const currentDisp = (entry.details && entry.details.disposition) || null
        const suggestedDisp = (entry.suggested && entry.suggested.disposition) || null
        if (wanted !== currentDisp && wanted !== suggestedDisp) {
          profiles.setAutoProcess(sender, { type: FILE_TO_PROJECT, suggested: { disposition: wanted }, asof })
        }
        return { sender, skipped: 'user_locked', suggested: wanted }
      }

      // THE HUMAN GUARD — refuse to put a person on autopilot, whatever the model said. The item it
      // filed stays filed (the user still sees this message where the model put it); only the
      // STANDING DECISION is withheld, so their next message is read normally instead of hidden.
      const veto = autopilotVeto({ sender, newMsg, profiles })
      if (veto) {
        console.info('[superlazy] not auto-processing ' + sender + ': ' + veto)
        return { sender, category: validCat, active: false, skipped: 'human_sender', veto }
      }

      const details = {}
      if (validCat) details.disposition = validCat
      if (mine) details.project_id = mine.todo.project_id
      if (!validCat && !mine) return null // nothing to anchor to — leave for the next message
      const change = profiles.setAutoProcess(sender, { type: FILE_TO_PROJECT, active: true, details, source: 'model', asof })
      // FIRST activation for this sender? From here on their mail is filed WITHOUT the LLM, so this
      // one moment is the user's only chance to disagree. The caller turns this into a prominent
      // 'autofile_learned' event (see processor.js) — the decision must never be silent.
      const wasActive = !!(change && change.before && change.before.active)
      const cat = catOf(validCat)
      const bucketProj = mine && store && store.get ? store.get(mine.todo.project_id) : null
      return {
        sender,
        category: validCat,
        active: true,
        project_id: mine ? mine.todo.project_id : null,
        learned_first: !wasActive,
        target_name: (bucketProj && bucketProj.name) || (cat && cat.bucket) || null,
        change
      }
    },

    // Pre-analysis. Returns an apply() handler ONLY when we already know this sender's category AND
    // the pref is on. rulesEngine still gates this behind the §C pecking order (a user instruction
    // for this sender out-ranks the short-circuit).
    shortCircuit ({ newMsg, profiles, prefs, store }) {
      if (!prefs || !prefs.automated_autopilot) return null
      const sender = lc(newMsg && newMsg.from && newMsg.from.address)
      const p = sender && profiles && profiles.get(sender)
      const prof = p && p.profile
      if (!prof) return null
      // The sender's ACTIVE file_to_project action decides (legacy auto_file* fields are
      // normalized by the getter; an explicit user off = inactive entry, never fires).
      const entry = fileToProject(prof)
      if (!entry) return null
      // SELF-HEALING: a sender learned before the human guard existed (or learned from one bulk-ish
      // message and since revealed as a person — the user has now written to them) must stop being
      // auto-filed. Skip the short-circuit so the LLM reads this message properly; the guard in
      // onTrigger then refuses to re-learn them, so it converges without deleting anything. A
      // LOCKED entry is the user's own decision and is always honoured.
      // ACT, THEN ASK. The guard used to REFUSE to apply a stored decision it doubted, which sent
      // that sender's mail to the LLM on every message, for ever, and never asked anyone — a
      // silent recurring cost with no path to resolution. It is now a DOUBT, not a veto: the mail
      // is filed as decided and the doubt is surfaced with the one-tap "Do not file these
      // automatically" control, so a wrong decision costs one tap and a right one costs nothing.
      // Ignoring it is a valid answer and stays valid.
      //
      // The guard still BLOCKS in the other direction — see onTrigger, where it refuses to LEARN
      // a person-shaped sender in the first place. Not teaching yourself something wrong is
      // different from refusing to act on what you were told.
      const doubt = (entry.locked || entry.source === 'bootstrap')
        ? null
        : autopilotVeto({ sender, newMsg, profiles })
      if (doubt) {
        console.info('[superlazy] auto-filing ' + sender + ' as decided, but flagging it for review: ' + doubt)
      }
      const disp = (entry.details && entry.details.disposition) || null
      const category = CAT_KEYS.has(disp) ? disp : null
      const projectId = (entry.details && entry.details.project_id) || null
      // NO straddle guard: the action is DETERMINISTIC — once a sender carries it, their mail
      // files to the learned/locked target regardless of the mail system's own labels.
      // (The old label-mismatch deferral silently sent every message from mislabelled senders
      // to the LLM, forever.) A misfiled item is cheap to fix; a silent LLM loop is not.
      const cat = category ? AUTOMATED_CATEGORIES.find(c => c.key === category) : null
      // the target must be resolvable NOW: the remembered project (ANY project, incl. the user's
      // own), else the category's standing bucket (recreatable by name). Neither → let the LLM
      // re-judge and re-learn.
      const custom = projectId ? store.get(projectId) : null
      if (!custom && !cat) return null
      const label = cat ? (cat.prefix || CAT_LABEL[category] || 'Automated') : 'Auto-filed'
      const targetName = custom ? custom.name : cat.bucket
      // DRIFT SIGNAL (free — no LLM). The mail system's own label disagreeing with what we learned
      // means this sender straddles categories (a bank sending both alerts and promos). We still
      // auto-file — blocking on every mismatch is what made the old straddle guard a silent
      // LLM loop — but we FLAG it so the user can counter the standing decision. Compared by
      // family, so admin_actions vs Gmail's coarse CATEGORY_UPDATES is not a false positive.
      const labelCat = categoryFromLabels(newMsg && newMsg.labels)
      const mismatch = (labelCat && category && catFamily(labelCat) !== catFamily(category))
        ? { learned: category, by_label: labelCat }
        : null
      return {
        workflow: 'automated',
        category,
        mismatch,
        doubt,   // the address-shape guard disagreed — filed anyway, surfaced for one-tap review
        importance: (cat && cat.importance) || 1,
        target_name: targetName,
        reason: (entry.locked ? 'auto-process set by you' : 'known ' + (category || 'automated') + ' sender') +
          ' — filed to “' + targetName + '” without the LLM' +
          (mismatch ? ' (but this mail is labelled ' + labelCat + ')' : ''),
        apply (store, ctx) {
          // Resolve the target: the remembered project, else the bucket by NAME, else RECREATE
          // the bucket — a learned sender never costs an LLM call again.
          let bucket = projectId ? store.get(projectId) : null
          if (!bucket && cat) bucket = store.all().find(pr => pr.name === cat.bucket && pr.status === 'active') || null
          if (!bucket && cat) bucket = store.ensureProject({ project_id: store.mintProjectId(), name: cat.bucket, asof: ctx.asof })
          if (projectId !== bucket.project_id && profiles.setAutoProcess && !entry.locked) {
            profiles.setAutoProcess(sender, { type: FILE_TO_PROJECT, details: { project_id: bucket.project_id }, asof: ctx.asof })
          }
          const { todo, project } = store.addReadOnlyTodo({
            projectId: bucket.project_id,
            short_description: label + ': ' + headline(newMsg.subject),
            description: newMsg.subject || '',
            sender,
            importance: (cat && cat.importance) || 1,
            change_reason: 'auto-filed' + (category ? ' by the ' + category + ' workflow' : ' (set by you)') + ' — no LLM call' +
              (mismatch ? '; NOTE this mail is labelled ' + mismatch.by_label + ', not ' + mismatch.learned : ''),
            asof: ctx.asof,
            msgId: ctx.msgId,
            threadId: ctx.threadId
          })
          return {
            projects: store.all(),
            touched_project_ids: [project.project_id],
            latest_delta: { new_for_me: false, new_for_team: false, new_todo_ids: [todo.todo_id], resolved: [] },
            changes: [{ type: 'created', project_id: project.project_id, todo }],
            role_changes: [],
            new_ids: [todo.todo_id],
            changed_ids: [],
            tmp_project_map: {},
            via_workflow: 'automated',
            category,
            mismatch
          }
        }
      }
    }
  },

  // INTER-APP SUBSCRIPTIONS (specs/interapp-subscriptions.md): another app's approved standing
  // request ("send me every invoice email"). The per-subscription detector lines are DATA-DRIVEN
  // (subscriptionsCore.subscriptionPromptLines, appended by workflowInstructions below) — this
  // entry carries no prompt_instruction of its own. onTrigger writes an idempotent delivery
  // record and best-effort sends the inter-app message; the browser flusher retries the rest.
  app_subscription: {
    keyword: 'app_subscription',
    priority: 50,
    prompt_instruction: null,
    async onTrigger ({ freezr, trigger, newMsg, threadId, accountId, asof }) {
      const det = (trigger && trigger.details) || {}
      const sub = det.sub_id ? getSubscription(det.sub_id) : null
      if (!sub) return { skipped: 'no_active_subscription', sub_id: det.sub_id || null }
      if (!freezr) return { skipped: 'no_freezr_in_ctx', sub_id: sub.sub_id }
      return deliverSubscriptionMatch({ freezr, sub, trigger, newMsg, threadId, accountId, asof })
    }
  }

  // Future examples — actions whose onTrigger does REAL WORK (not learning), with NO shortCircuit.
  // Per-message actions like these are usually requested via a standing user instruction on the
  // sender ("if Bob sends a bill, forward it to alice") — the instruction forces the message
  // through the LLM, which emits the trigger; the registry entry executes it.
  // forward_message: {
  //   keyword: 'forward_message', priority: 50,
  //   prompt_instruction: 'FORWARD: only when a standing user instruction asks for it, include ' +
  //     '{ "type":"forward_message", "details": { "recipient": "<email or name>", "reason": "…" } }.',
  //   async onTrigger ({ freezr, newMsg, trigger }) {
  //     // resolve the recipient, forward via freezr.connections.mail.sendMessage (needs write scope).
  //   }
  // },
  // deep_research: {
  //   keyword: 'deep_research', priority: 50,
  //   prompt_instruction: 'DEEP RESEARCH: if this message needs a researched, document-aware answer ' +
  //     '(e.g. Legal sends a contract to review), include { "type":"deep_research", "details": { "todo_id":"…" } }.',
  //   async onTrigger ({ freezr, newMsg, output, store }) {
  //     // fetch the attachment/document, run a deeper LLM/tool pass, attach a richer analysis to the to-do.
  //   }
  // }
}

// The lines injected into every analysis request telling the model when to emit each action.
// Static registry lines + the DATA-DRIVEN per-subscription detector lines (deterministic, sorted
// by sub_id — they ride the cached durable turn, and ingest.durableSig covers them through this
// very function, so a subscription change correctly re-pins the snapshot exactly once).
export function workflowInstructions () {
  return [
    ...Object.values(WORKFLOWS).map(w => w.prompt_instruction).filter(Boolean),
    ...subscriptionPromptLines()
  ]
}
