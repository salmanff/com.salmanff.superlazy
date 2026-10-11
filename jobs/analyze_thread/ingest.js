// ingest.js — the ONE ingestion driver, run by both hosts:
//   - the browser (setup page's live training, the dashboard's in-tab check), and
//   - the background job (jobs/analyze_thread/index.mjs).
// Everything host-specific is injected: `freezr`, the persistence layer, the mail source, and the
// progress callbacks. There is no second copy of "plan a window, process it, keep the lock alive".
//
// One task: check mail over the stored accounts, resuming from their cursors (the initial
// history is built by the one-pass bootstrap, not here).
//
// BOUNDED BY DESIGN. A run stops at whichever comes first: the queue emptying, the caller's stop,
// losing the run lock, the message cap, or the time budget. It always reports `remaining`, and
// because processor.js persists every message (projects, profiles, events, account cursor) BEFORE
// starting the next one, stopping early loses nothing — the next run re-plans from the stored
// cursors and continues. That is what lets a 15-minute job chip away at a long queue.
//
// Concurrency (specs/pipeline-walkthrough.md §2, Lock):
//   1. the ATOMIC run lock stops a second tab/job at the front door — zero fetches, zero LLM spend;
//   2. the processed-event set in processor.plan() backstops the cursor boundary.
// The job takes the SAME lock as a tab, signed 'job:…' instead of 'tab:…', so pages observing the
// lock show the job's progress with no extra machinery.

import { createAuditSink, AUDIT_DEFAULT_DAYS } from './llmAudit.js'
import {
  DEFAULT_HISTORY_DAYS, DEFAULT_THREAD_CONTEXT_DAYS, NEW_MAIL_AUTO_THRESHOLD,
  EST_COST_PER_MSG, LOCK_STALE_MS, DEFAULT_BATCH_MAX, DEFAULT_STALENESS_DAYS, STEP_TIMEOUT_MS,
  PENDING_SCAN_MAX_AGE_MS, PENDING_WATERMARK_MARGIN_MS
} from './config.js'
import { createProcessor } from './processor.js'
import { PROMPT_VERSION } from './prompt.js'
import { SNAPSHOT_REFRESH_MESSAGES } from './engine.js'
import { createProfileStore } from './profiles.js'
import { createProjectStore } from './projectStore.js'
import { createInstructionStore } from './instructionStore.js'
import { sourceFromAccounts } from './jobSource.js'
import { drainPendingInputs } from './noteIngest.js' // cycle with noteIngest (call-time bindings — harmless)
import { workflowInstructions } from './workflows.js'
import { loadActiveSubscriptions, flushPendingDeliveries } from './subscriptionsCore.js'
import { DIGEST_TUNING } from './sessionDigest.js'

const lc = (s) => String(s || '').toLowerCase()

export const newTabOwnerId = () => 'tab:' + Math.random().toString(36).slice(2) + Date.now().toString(36)
export const newJobOwnerId = () => 'job:analyze_thread:' + Math.random().toString(36).slice(2) + Date.now().toString(36)

export const estCostRange = (n) => ({ low: n * EST_COST_PER_MSG[0], high: n * EST_COST_PER_MSG[1] })

// The ONE place a settings record becomes the engine's prefs object. Exported so every driver
// (runIngestion here, the inspect page) maps settings identically — the business_context section
// silently never rendered for weeks because a second, hand-rolled copy of this mapping missed it.
export function sessionPrefsFrom (settings) {
  const s = settings || {}
  return {
    automated_autopilot: s.automated_autopilot !== false,
    analysis_context_chars: s.analysis_context_chars || null,
    // batch analysis + caching + staleness tiers (specs/pipeline-walkthrough.md §5–§7).
    // All safely defaulted, so an untouched settings record behaves sensibly.
    batch_max: s.batch_max != null ? s.batch_max : DEFAULT_BATCH_MAX,
    // the Preferences checkbox — drafts are the single biggest share of OUTPUT tokens, so
    // turning them off is both a cost lever and the isolation switch for "why is this reply big"
    suggest_replies: s.suggest_replies !== false,
    // the reasoning dials (Preferences): engine reads both off this prefs object
    analysis_thinking: s.analysis_thinking === true,
    analysis_effort: s.analysis_effort || null,
    // output ceiling + request_more rounds (Preferences, for the inspect page's comparisons)
    analysis_max_tokens: s.analysis_max_tokens || null,
    analysis_fetch_rounds: s.analysis_fetch_rounds != null ? s.analysis_fetch_rounds : null,
    // the durable "who the user is" paragraph written by bootstrap-adopt — rides in the CACHED
    // durable turn (renderCatalogSnapshot "The user's situation")
    business_context: s.business_context || null,
    staleness_policy: s.staleness_policy || DEFAULT_STALENESS_DAYS,
    // durable-turn refresh policy (Preferences): re-render after N messages / H hours
    snapshot_refresh_messages: s.snapshot_refresh_messages || null,
    snapshot_refresh_chats: s.snapshot_refresh_chats || null,
    snapshot_max_age_hours: s.snapshot_max_age_hours || null,
    snapshot_cold_max_age_hours: s.snapshot_cold_max_age_hours || null, // the quiet-projects + rules block (default weekly)
    // 1h cache TTL is the DEFAULT: checks run hourly, so the 5-minute TTL never got a cross-run
    // hit — every run re-paid the 1.25x write. Set snapshot_1h_ttl: false to fall back to 5m.
    snapshot_1h_ttl: s.snapshot_1h_ttl !== false,
    llm_cache: s.llm_cache !== false
  }
}

// Fingerprint of the durable inputs that ride in the cached turn BESIDES the catalog. A pinned
// snapshot whose durable inputs have since been edited must NOT be adopted — the user changed
// their business context (or the action registry changed) and the cached bytes no longer say
// what the app would say. FNV-1a over the concatenation; cheap and stable.
// Everything rendered INTO the cold block must be hashed here, or an edit to it would sit behind a
// stale pin for up to a week. Today that is: the user's situation, the third-party app
// instructions, the standing instructions that apply to ALL mail, and the writing-style guide.
// (The style guide is read from settings rather than session.userStyle because the session's copy
// is built lazily, after this runs; a freshly rebuilt style therefore costs one extra re-render on
// the following run, which is the same one-write price as any other edit.)
export function durableSig (settings, instructions) {
  const wf = workflowInstructions().join('\n')
  const always = (instructions && instructions.matching)
    ? instructions.matching('', null).filter(r => r.scope === 'all')
      .map(r => r.instruction_id + ':' + r.text).sort().join('\n')
    : ''
  const s = String((settings && settings.business_context) || '') + '\u0000' + wf +
    '\u0000' + always + '\u0000' + String((settings && settings.style_guide) || '')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

// ---- the snapshot pin: ONE writer, used by every driver ---------------------------------------
// The pin is what makes the provider cache hit ACROSS sessions: it stores the exact rendered bytes
// plus the counters, so the next session reuses the prefix instead of re-rendering (and re-paying
// the 1.25x write). Exported because the Inspect page is a driver too — it used to only READ the
// pin, so every inspect run re-rendered and re-cached. Same class of bug as the business_context
// one: a second, incomplete copy of a persistence step.
export function snapshotPinRecord (session, settings) {
  const snap = session && session.snapshot
  if (!snap || !snap.text) return null
  return {
    text: snap.text, // the HOT block
    chars: snap.chars,
    count: snap.count,
    ids: snap.ids || [],
    // the COLD block (business context + rules + quiet projects) with its own render clock
    cold: snap.cold ? { text: snap.cold.text, chars: snap.cold.chars, count: snap.cold.count, ids: snap.cold.ids || [], people: snap.cold.people || [], rendered_at: snap.cold.renderedAt || null, trigger: snap.cold.trigger || null } : null,
    touched: [...(snap.touched || [])],
    // whose cached profile has changed since that block was rendered — without this the next run
    // would trust a stale profile in the prefix
    touched_people: [...(snap.touchedPeople || [])],
    msgs_since_render: snap.msgsSinceRender || 0,
    refresh_load: Number(snap.refreshLoad) || 0, // share of the render budget drawn down (engine.noteProcessedForSnapshot)
    rendered_asof: snap.renderedAsof || null,
    rendered_at: snap.renderedAt || null, // wall clock of the render — the age policy's reference point
    prompt_version: PROMPT_VERSION,
    durable_sig: durableSig(settings, session && session.instructions),
    pinned_asof: Date.now()
  }
}

// Adopt a stored pin into a session — or say exactly WHY it was rejected. A silent rejection means
// the durable turn is re-rendered (and re-cached at 1.25x) on every single run, which is invisible
// unless something prints the reason.
export function adoptSnapshotPin (session, settings) {
  const pin = (settings && settings.snapshot_pin) || null
  if (!pin || !pin.text) { console.info('[superlazy] no stored durable-turn pin yet — this run renders it (one cache write)'); return false }
  // the reason a pin is discarded becomes the cold block's render trigger (the cache_refresh event
  // says WHY both blocks were re-written, not just that they were)
  if (pin.prompt_version !== PROMPT_VERSION) {
    console.warn('[superlazy] durable-turn pin DISCARDED: prompt version changed (' + pin.prompt_version + ' → ' + PROMPT_VERSION + ') — one re-render, then it pins again')
    session.snapshotDiscardReason = 'prompt_changed'
    return false
  }
  const sig = durableSig(settings, session && session.instructions)
  if (pin.durable_sig !== sig) {
    console.warn('[superlazy] durable-turn pin DISCARDED: your situation / standing instructions / app instructions / writing style changed (' + pin.durable_sig + ' → ' + sig + ') — one re-render, then it pins again')
    session.snapshotDiscardReason = 'rules_or_context_changed'
    return false
  }
  if (!pin.cold || !pin.cold.text) {
    console.warn('[superlazy] durable-turn pin DISCARDED: single-block format from before the cold/hot split — one re-render, then it pins again')
    session.snapshotDiscardReason = 'pin_format'
    return false
  }
  session.snapshot = {
    text: pin.text,
    chars: pin.chars || pin.text.length,
    count: pin.count || 0,
    ids: pin.ids || [],
    cold: {
      text: pin.cold.text,
      chars: pin.cold.chars || pin.cold.text.length,
      count: pin.cold.count || 0,
      ids: pin.cold.ids || [],
      people: pin.cold.people || [],
      renderedAt: pin.cold.rendered_at || pin.pinned_asof || Date.now(),
      trigger: 'pinned'
    },
    touched: new Set(pin.touched || []),
    touchedPeople: new Set(pin.touched_people || []),
    msgsSinceRender: Number(pin.msgs_since_render) || 0,
    // pins stamped before refresh_load existed: treat their count as all-mail against the mail threshold
    refreshLoad: pin.refresh_load != null
      ? Number(pin.refresh_load) || 0
      : (Number(pin.msgs_since_render) || 0) / (Number(settings && settings.snapshot_refresh_messages) > 0 ? Number(settings.snapshot_refresh_messages) : SNAPSHOT_REFRESH_MESSAGES),
    renderedAsof: pin.rendered_asof || null,
    // pins stamped before rendered_at existed fall back to when they were pinned — never null,
    // or the age rule could not fire and a pin would live until the next prompt/sig change
    renderedAt: pin.rendered_at || pin.pinned_asof || Date.now(),
    pendingWrite: null, // nothing to write: a write on this prefix now is a 'rewrite' (expired / prefix changed)
    announced: true, // its cache_refresh was announced by the run that rendered it
    trigger: 'pinned'
  }
  console.info('[superlazy] durable-turn pin ADOPTED (hot ' + (pin.count || 0) + ' projects / ' +
    Math.round((pin.chars || 0) / 1000) + 'k chars, cold ' + (pin.cold.count || 0) + ' / ' + Math.round((pin.cold.chars || 0) / 1000) + 'k chars, ' +
    (pin.msgs_since_render || 0) + ' message(s) since the hot render, ' +
    (pin.touched || []).length + ' project(s) updated since) — the provider cache should READ this prefix')
  return true
}

// Best-effort (never fails a run): stamp the pin onto the settings record.
export async function stampSnapshotPin (persist, session, settings) {
  const rec = snapshotPinRecord(session, settings)
  if (!rec || !persist || !persist.stampSettingsFields) return false
  await persist.stampSettingsFields({ snapshot_pin: rec }).catch(() => {})
  return true
}

// Every stored account is planned, whatever its channel — mail and messaging (Slack) alike
// (accounts are created by bootstrap-adopt / the Slack lab, which also set the cursor). The
// staged-rollout switch that used to gate messaging accounts out of the checks was RETIRED
// 2026-08-30 once stage 2.0 validated (the stored messages_in_checks settings field is inert);
// the Inspect page still steps whatever is pending whenever closer observation is wanted.
//
// The ONE exception is a PAUSED account (accounts.sync_paused — the Setup page's "Pause
// syncing" button): it is dropped here, before the source is built and before planning, so a
// paused mailbox / Slack workspace is not even polled. Its cursor stands still; resuming picks
// up from where it stopped (subject to the normal history window).
// accountIds (optional): limit the run to these stored accounts — the Sources tab's per-source
// "Force resync" (user, 2026-09-09). Paused accounts stay skipped even when named.
function resolveAccounts ({ stored, accountIds = null }) {
  const named = Array.isArray(accountIds) && accountIds.length ? new Set(accountIds) : null
  const all = (stored || []).filter(r => r && r.account_id && (!named || named.has(r.account_id)))
  const recs = all.filter(r => !r.sync_paused)
  return {
    infos: recs.map(r => ({ account_id: r.account_id, account_email: r.account_email, provider: r.provider })),
    existing: recs,
    paused: all.length - recs.length
  }
}

// ME across channels: settings.your_addresses is set by MAIL setup; a Slack-only (or mixed)
// install also knows the user's identity from the account records themselves (mail
// account_email, messaging me_email). Union them so direction/ME detection never goes blind.
export function meSetFromSettingsAndAccounts (settings, stored) {
  const out = new Set(((settings || {}).your_addresses || []).map(lc).filter(Boolean))
  for (const r of (stored || [])) {
    if (r && r.account_email) out.add(lc(r.account_email))
    if (r && r.me_email) out.add(lc(r.me_email))
  }
  return out
}

/**
 * Plan and process one bounded batch of mail.
 *
 * @param {Object}   o
 * @param {Object}   o.freezr            the freezr client (global in a page, a parameter in a job)
 * @param {Object}   o.persist           createPersistence(freezr)
 * @param {Object}  [o.data]             a persist.loadAll() snapshot; loaded here when omitted
 * @param {Object}  [o.source]           a MailSource; resolved from the stored accounts when omitted
 * @param {string}  [o.task]             'newmail' (default; 'auto'/'backfill' are accepted as legacy aliases)
 * @param {number}  [o.historyDays]      window size for a cursor-0 account (falls back to settings, then the default)
 * @param {number}  [o.threadContextDays]
 * @param {string}   o.owner             run-lock identity ('tab:…' / 'job:…')
 * @param {number}  [o.budgetMs]         stop cleanly after this much wall-clock (0 = no limit)
 * @param {number}  [o.maxMessages]      stop cleanly after this many messages (0 = no limit)
 * @param {boolean} [o.force]            steal the run lock even if it looks alive ("Force resync")
 * @param {Function}[o.onPlanned]        ({ total, estLow, estHigh, overThreshold })
 * @param {Function}[o.onProgress]       ({ done, total, cost, latest })
 * @param {Function}[o.onEvent]          raw engine events (the training view watches these)
 * @param {Function}[o.shouldStop]       caller's stop button
 * @returns {Promise<Object>} { skipped?, holder?, planned, processed, remaining, cost, done,
 *                              lockLost, budgetHit, capHit, stopped, truncated }
 */
export async function runIngestion ({
  freezr, persist, data = null, source = null,
  task = 'newmail', historyDays = null, threadContextDays = null,
  owner, budgetMs = 0, maxMessages = 0, force = false, accountIds = null,
  // eager: user-initiated run — the chat soft-debounce is OFF, so a fresh tiny chunk ("ok 👍"
  // seconds ago) is analysed NOW instead of riding into the next cycle. Scheduled runs stay
  // debounced (mid-conversation chunks merge more coherently there).
  eager = false,
  // manual: the user PRESSED the check. Agent turns still in progress are analysed now instead of
  // waiting for their session to be quiet 30 minutes (their completed version is re-formed later
  // as a revision). Polls and the scheduled job leave this false.
  manual = false,
  // rescan: ignore the pending-scan watermark and page the whole (age-bounded) inputs collection for
  // pending items — the Setup page's per-source "Force resync" (2026-10-04), the manual safety net
  // for anything an earlier run lost sight of.
  rescan = false,
  onPlanned = null, onProgress = null, onEvent = null, shouldStop = null
} = {}) {
  const startedAt = Date.now()
  const deadline = budgetMs > 0 ? startedAt + budgetMs : Infinity

  const snapshot = data || await persist.loadAll()
  const stored = snapshot.accounts || []
  const settings = snapshot.settings || {}

  // There is ONE task: check mail from the account cursors. The old separate 'backfill' task was
  // unreachable — bootstrap-adopt always writes backfill_done: true, and nothing else ever created
  // a record without it. 'auto' and the legacy 'backfill' both resolve to newmail; a legacy record
  // that somehow lacks backfill_done is planned anyway (its cursor 0 gives it the full window and
  // the processor marks it done when the queue drains), so nothing can be stranded.
  if (task === 'auto' || task === 'backfill') task = 'newmail'
  const idle = { task, skipped: null, planned: 0, processed: 0, remaining: 0, cost: 0, done: true }

  const { infos, existing, paused } = resolveAccounts({ stored, accountIds })
  if (!infos.length) {
    return {
      ...idle,
      skipped: paused
        ? (paused === 1 ? 'the only account is paused' : 'all ' + paused + ' accounts are paused') + ' — resume it on the Setup page to check again'
        : 'no account is set up yet (mail, Slack and work sessions are all set up on the Setup page)'
    }
  }
  if (paused) console.info('[superlazy] ' + paused + ' paused account(s) skipped this check')

  // PENDING-SCAN FLOOR (2026-10-04, pendingScan.js): how far back the queue-backed sources (agent
  // turns, Slack chunks) page for pending items. The watermark is the start of the last run that
  // scanned to its floor AND drained its queue — nothing pending can be older — never further back
  // than PENDING_SCAN_MAX_AGE_MS. No watermark yet (first run on this code) = page the whole
  // age-bounded collection once, which is also what recovers items stranded before the fix.
  const watermark = rescan ? 0 : (Number(settings.pending_scan_watermark) || 0)
  const pendingFloorMs = Math.max(watermark, startedAt - PENDING_SCAN_MAX_AGE_MS)
  if (rescan) console.info('[superlazy] rescan: paging the whole pending queue (watermark ignored)')

  // the source is built over the ACTIVE accounts only — a paused Slack workspace gets no API calls
  const src = source || sourceFromAccounts(existing, { freezr, persist, eager, pendingFloorMs, workTuning: manual ? { ...DIGEST_TUNING, QUIET_MS: 0 } : null })
  if (!src) return { ...idle, skipped: 'these accounts were trained from the local archive — they can only be checked from the browser' }

  // level 1: the atomic run lock — a second checker is stopped HERE, before any fetch or spend
  const lock = await persist.acquireRunLock({ owner, kind: 'newmail', staleMs: LOCK_STALE_MS, force })
    .catch(e => ({ ok: false, holder: null, error: (e && e.message) || String(e) }))
  if (!lock.ok) return { ...idle, skipped: 'mail is being processed elsewhere', holder: lock.holder || null }

  let lockLost = false
  let budgetHit = false
  let capHit = false
  let processed = 0
  let planTotal = 0
  let processor = null

  try {
    // Say the batch ceiling OUT LOUD: "why is it doing one at a time" was unanswerable from the
    // outside, because a settings value silently overrides the default (a stored batch_max: 1 from
    // an earlier Preferences save keeps winning after the default changed to 10).
    const prefs = sessionPrefsFrom(settings)
    console.info('[superlazy] batch ceiling: ' + prefs.batch_max + ' message(s) per AI call' +
      (settings.batch_max != null
        ? ' — from YOUR SETTING (Preferences → "Messages per AI call")'
        : ' — the default (no setting stored)') +
      '; it adapts down on failures and back up after clean batches')

    // Inter-app subscriptions: load BEFORE any durableSig / pin adoption — their detector lines
    // ride in workflowInstructions(), which the sig hashes. Fails open to [] on old installs.
    const subs = await loadActiveSubscriptions(freezr)
    if (subs.length) console.info('[superlazy] ' + subs.length + ' active app subscription(s): ' + subs.map(s => s.sub_id + '→' + s.requester_app).join(', '))

    const profiles = createProfileStore()
    profiles.hydrate(snapshot.profiles)
    const store = createProjectStore()
    store.hydrate(snapshot.projects)
    const instructions = createInstructionStore()
    instructions.hydrate(snapshot.instructions)

    processor = createProcessor({
      freezr,
      source: src,
      persist,
      meSet: meSetFromSettingsAndAccounts(settings, stored),
      model: settings.default_model || {},
      prefs: prefs,
      instructions,
      profiles,
      store,
      // a JOB is hard-killed at maxRuntime, so its per-batch ceiling must stay at the
      // single-message value; a tab has no runtime bound and heartbeats keep the lock alive
      maxStepMs: budgetMs ? STEP_TIMEOUT_MS : null
    })

    console.info('[superlazy] ' + task + ' check: planning (listing envelopes from the account cursor)…')
    const plan = await processor.plan({
      accountInfos: infos,
      historyDays: historyDays || settings.history_days || DEFAULT_HISTORY_DAYS,
      threadContextDays: threadContextDays != null
        ? threadContextDays
        : (settings.thread_context_days != null ? settings.thread_context_days : DEFAULT_THREAD_CONTEXT_DAYS),
      processDays: null, // production: no manual-stepping handover — process the whole queue
      existingAccounts: existing
    })
    planTotal = plan.total
    // formErrors: an agent store the source could not read this pass. Without it a run that formed
    // nothing because the store was unreachable is indistinguishable from a quiet day.
    const formErrors = src.formationErrors ? src.formationErrors() : []
    // accountErrors: accounts the source could not LIST (expired mail token, unreadable store). The
    // run goes on without them (2026-10-04) — before, one such account failed the whole plan and no
    // account was checked until the user fixed it. Their cursors stand still; the UI names them.
    const accountErrors = src.accountErrors ? src.accountErrors() : []
    if (accountErrors.length) console.warn('[superlazy] ' + accountErrors.length + ' account(s) not checked this run: ' + accountErrors.map(e => e.account_id + ': ' + e.message).join(' | '))
    if (plan.strandedCount) console.info('[superlazy] ' + plan.strandedCount + ' stranded pending item(s) recovered from below the cursor')
    // The watermark advances only when THIS run can vouch for everything pending: an unscoped run
    // whose pending scan reached its floor and whose queue drained, with nothing stopping it early.
    const scanComplete = src.pendingScanComplete ? src.pendingScanComplete() : false
    const advanceWatermark = async ({ drained }) => {
      if (!drained || !scanComplete || accountIds || plan.truncated || lockLost || (shouldStop && shouldStop())) return
      await persist.stampSettingsFields({ pending_scan_watermark: startedAt - PENDING_WATERMARK_MARGIN_MS }).catch(() => {})
    }
    if (!plan.total) {
      await advanceWatermark({ drained: true })
      return { ...idle, planned: 0, truncated: !!plan.truncated, formErrors, accountErrors, stranded: 0 }
    }

    // A cache WRITE costs 1.25x the input rate and only pays for itself from the second call on.
    // A run with a single message never gets that second call, so caching it is a pure ~25% loss
    // on the prefix — the commonest case for an hourly check, and worth not paying for.
    // ---- the PINNED snapshot (cross-run) ------------------------------------------------------
    // The catalog snapshot is written to the provider cache ONCE per ~25 processed messages, NOT
    // once per run: the rendered bytes are persisted in settings and reloaded here, so a run picks
    // up the exact prefix earlier runs already paid to cache. A cache hit needs byte-identity —
    // which is precisely what re-rendering per run was destroying. Correctness is untouched: the
    // volatile "Updates since the snapshot" section always carries the CURRENT rows of every
    // project touched since the render, and those override the snapshot by contract.
    // The pin is adopted only when BOTH stamps match: prompt_version (the system prompt the bytes
    // were cached against) and durable_sig (the business context + action instructions rendered
    // INTO those bytes). An edit to either re-renders — one cache write, then hits again.
    adoptSnapshotPin(processor.session, settings)

    // DEV REQUEST AUDIT (settings.llm_audit — Setup page console: superlazy.audit(true|false)):
    // every LLM exchange of this run is persisted verbatim for the Request Audit Lab page. Temporary
    // storage — records older than llm_audit_days (default 3) are pruned here first.
    let auditSink = null
    if (settings.llm_audit === true) {
      auditSink = createAuditSink({ persist, runId: owner, driver: budgetMs ? 'job' : 'tab' })
      processor.session.exchangeSink = auditSink
      persist.pruneAudit(Number(settings.llm_audit_days) || AUDIT_DEFAULT_DAYS)
        .then(n => { if (n) console.info('[superlazy] request audit: pruned ' + n + ' record(s) past the retention window') })
        .catch(() => {})
      console.info('[superlazy] request audit ON — every LLM exchange of this run is recorded for the Request Audit Lab')
    }

    const effectiveRun = maxMessages > 0 ? Math.min(plan.total, maxMessages) : plan.total
    // Skip caching for a one-call run ONLY when there is no pinned snapshot to hit: with a pin in
    // play even a single message reads the prefix at 10% and keeps the pin warm for the next check.
    if (effectiveRun === 1 && !processor.session.snapshot && processor.session.cacheOpt) {
      processor.session.cacheOpt = null
      console.info('[superlazy] one message, no pinned snapshot — skipping the prompt cache (its 1.25x write premium only pays back across calls)')
    }

    // Writing-style cache: the style guide is distilled at most once per style_guide_refresh_days,
    // not once per run. This mattered little when a session was one long training run, but a JOB
    // session is fresh every run — hourly + the foreground poll would each have paid an LLM call.
    // An empty/failed build ('') is not cached, so it retries once real sent samples exist.
    const refreshDays = Number(settings.style_guide_refresh_days) || 30
    // An EMPTY guide is a real result — "this mailbox has no sent mail to learn from" — and must
    // persist like any other, else every run re-fetches sent mail and re-asks the model, forever
    // (observed: the '…building one from sent mail' line on every single run). Freshness therefore
    // keys on the stamp's presence, not the guide's truthiness; an empty guide retries on the same
    // monthly cadence as a stale one.
    const styleFresh = settings.style_guide != null &&
      (Date.now() - (Number(settings.style_guide_asof) || 0)) < refreshDays * 24 * 3600e3
    if (styleFresh) processor.session.userStyle = settings.style_guide

    const est = estCostRange(plan.total)
    if (onPlanned) {
      onPlanned({
        total: plan.total,
        estLow: est.low,
        estHigh: est.high,
        overThreshold: plan.total > NEW_MAIL_AUTO_THRESHOLD,
        truncated: !!plan.truncated
      })
    }

    // A failure now STOPS the run (processor.analyzeEnvelope throws superlazyStop on any analysis
    // error — no credit left, mail token expired, network gone). That is a normal OUTCOME here, not
    // an exception to propagate: the messages already processed are persisted, the failed one is
    // recorded as errored (and will be retried first next time), so the run REPORTS and lets the
    // caller decide. Only a genuinely unexpected error is re-thrown.
    let res
    let failure = null
    // count each MESSAGE once, not each event: a batch-split or missing-entry retry re-runs the
    // same message and emits step_error THEN step for it — counting both inflated `processed`
    // and tripped the maxMessages cap early
    const countedMsgs = new Set()
    const runOne = () => processor.runAuto({
      onEvent: (ev) => {
        if (onEvent) onEvent(ev)
        const done = ev.type === 'step' || ev.type === 'step_error' || ev.type === 'skipped'
        // Renew the lock on EVERY beat of work, not just message completion: 'msg_start' fires
        // before each (potentially long) analysis, 'fetch' before each extra LLM round, and
        // 'llm_waiting' every 30s DURING a long call — so a live-but-slow batch keeps the lock
        // fresh and can't be wrongly taken over mid-flight.
        const beat = done || ev.type === 'msg_start' || ev.type === 'fetch' ||
          ev.type === 'building_style' || ev.type === 'llm_waiting' ||
          ev.type === 'batch_split' || ev.type === 'message_abandoned' ||
          ev.type === 'batch_formed'
        if (done) {
          const key = (ev.msg && ev.msg.msg_id) || ('idx:' + ev.idx)
          if (!countedMsgs.has(key)) { countedMsgs.add(key); processed++ }
        }
        if (!beat) return
        const stage = ev.type === 'building_style'
          ? 'learning your writing style from sent mail…'
          : ev.type === 'batch_formed'
            ? (ev.count > 1
                ? 'sent ' + ev.count + ' emails to the AI together (one request)…'
                : 'sent 1 email to the AI…')
            : ev.type === 'msg_start'
              ? 'analysing: ' + ((ev.msg && ev.msg.subject) || '(no subject)')
              : ev.type === 'batch_split'
                ? 'that request was too big — asking about each message on its own…'
                : ev.type === 'message_abandoned'
                  ? 'could not analyse “' + ((ev.msg && ev.msg.subject) || '') + '” — moving on'
                  : ev.type === 'llm_waiting'
                    ? 'waiting on the model — ' + (ev.batch > 1 ? ev.batch + ' messages in one request, ' : '') +
                      Math.floor((ev.elapsedMs || 0) / 60000) + 'm ' + Math.round(((ev.elapsedMs || 0) % 60000) / 1000) + 's'
                    : null
        const progress = {
          done: processed,
          total: plan.total,
          cost: processor.session.totalCost,
          stage,
          latest: {
            subject: (ev.msg && ev.msg.subject) || '',
            from_address: (ev.msg && ev.msg.from && ev.msg.from.address) || ''
          }
        }
        if ((done || stage) && onProgress) onProgress(progress)
        // timer-free renewal: the work itself feeds the lock; a lost lock stops the run
        persist.renewRunLock({ owner, progress, staleMs: LOCK_STALE_MS })
          .then(r => {
            if (r.lost) {
              lockLost = true
              console.warn('[superlazy] run lock lost — taken over by', r.holder && r.holder.owner, r.holder)
            }
          })
          .catch(() => {})
      },
      // Checked BETWEEN messages only, so the message in flight always finishes and persists.
      // That is why JOB_BUDGET_MS leaves a full STEP_TIMEOUT_MS of headroom under maxRuntime.
      shouldStop: () => {
        if (lockLost) return true
        if (shouldStop && shouldStop()) return true
        if (Date.now() >= deadline) { budgetHit = true; return true }
        if (maxMessages > 0 && processed >= maxMessages) { capHit = true; return true }
        return false
      }
    })
    try {
      res = await runOne()
    } catch (e) {
      if (!(e && e.superlazyStop)) throw e
      failure = e.failure || { reason: (e && e.message) || String(e) }
      res = { remaining: processor.remaining(), done: false }
      console.warn('[superlazy] run stopped on an error:', failure.reason)
      // A TIMEOUT never reached persistOne, so the message had no error event — no attempts
      // counter, nothing to retire it, and the next run re-planned the very same message. Record
      // it here so the retry cap (processor.MAX_ANALYSIS_ATTEMPTS) can eventually let it go.
      const rt = e.recordTimeout && e.recordTimeout.env
      if (rt && rt.msg_id) {
        await persist.addEvent({
          msg_id: rt.msg_id, account_id: rt.account_id, thread_id: rt.thread_id,
          source_id: (src && src.id) || null, asof: rt.date, kind: 'message',
          latest_delta: {}, changes: [], via_workflow: null, fetch_rounds: 0, cost: 0,
          subject: rt.subject || '', from_address: rt.from_address || '',
          attempts: (Number(rt.retry_attempts) || 0) + 1,
          error: failure.reason
        }).catch(() => {})
      }
    }

    await advanceWatermark({ drained: !!(res && res.done) && !failure })

    // persist a style guide this run had to (re)build, so the next run reuses it
    if (!styleFresh && processor.session.userStyle != null) {
      await persist.stampSettingsFields({ style_guide: processor.session.userStyle, style_guide_asof: Date.now() }).catch(() => {})
    }

    // Drain pending manual inputs (specs/superlazy-inputs.md §6.2): notes typed while this run
    // held the lock, or whose save-time analysis errored, are analysed here through the run's own
    // session — before the lock is released, within what is left of the budget.
    let drained = null
    try {
      drained = await drainPendingInputs(processor.session, persist, {
        deadline,
        emit: onEvent,
        renew: (progress) => persist.renewRunLock({ owner, progress, staleMs: LOCK_STALE_MS })
      })
      if (drained.pending) console.info('[superlazy] pending notes: ' + drained.processed + '/' + drained.pending + ' analysed at the run tail')
    } catch (e) { console.warn('[superlazy] pending-input drain failed:', (e && e.message) || e) }

    // persist the snapshot pin — the exact bytes, the drift set, and the message counter — so the
    // NEXT run reuses the provider cache instead of re-writing ~24k tokens (see the pin loader above)
    // the audit writes are fire-and-forget during the run; a job must not return with one in flight
    if (auditSink) await auditSink.flush().catch(() => {})
    await stampSnapshotPin(persist, processor.session, settings)

    // Inter-app subscriptions: flush pending deliveries at the run tail — the body snapshots this
    // run persisted now exist, so include_original shares can be made and the messages sent
    // WITHOUT anyone visiting the Connected apps tab (which also flushes, as a backstop).
    try {
      const fl = await flushPendingDeliveries(freezr)
      if (fl.pending) console.info('[superlazy] subscription deliveries flushed: ' + fl.sent + ' sent' + (fl.failed ? ', ' + fl.failed + ' failed (retried next run)' : '') + (fl.dropped ? ', ' + fl.dropped + ' dropped' : ''))
    } catch (e) { console.warn('[superlazy] delivery flush failed:', (e && e.message) || e) }

    return {
      task,
      planned: plan.total,
      retried: plan.retryCount || 0,  // messages that had errored earlier and were re-queued first
      processed,
      remaining: res.remaining,
      done: res.done,
      failure,                        // { msg_id, subject, from_address, reason } when a failure stopped it
      cost: processor.session.totalCost,
      lockLost,
      budgetHit,
      capHit,
      stopped: !!(shouldStop && shouldStop()),
      truncated: !!plan.truncated,
      notesDrained: drained ? drained.processed : 0,
      formErrors,
      accountErrors,                  // [{ account_id, channel, message, token_expired, reauth_url }] accounts skipped this run
      stranded: plan.strandedCount || 0, // pending queue items recovered from below the cursor
      durationMs: Date.now() - startedAt
    }
  } finally {
    await persist.releaseRunLock({ owner }).catch(() => {})
    await persist.stampNewMailCheck().catch(() => {})
  }
}
