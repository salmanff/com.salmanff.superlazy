// processor.js — the ingestion RUN DRIVER. Plans the fetch window over the stored accounts,
// processes the queue oldest-first through the shared engine (persisting projects, profiles,
// events and the account cursor after every message), and hosts the Inspect page's
// deferred-persistence mode. One driver serves the background job, the in-tab check and Inspect.

import { createSession, ensureThread, ensureUserStyle, processOneMessage, processBatch } from './engine.js'
import { eventFromStep, profileHistorySnapshot, sourceTagFor } from './persist.js'
import { STEP_TIMEOUT_MS, DEFAULT_BATCH_MAX, BATCH_MAX_CHARS, isEnvironmentalFailure } from './config.js'

const DAY_MS = 24 * 3600 * 1000
// how far below the cursor each run re-lists, so failed messages stay reachable for their retries
const RETRY_OVERLAP_MS = DAY_MS
// a message that failed analysis this many times stops being retried (its error event remains)
const MAX_ANALYSIS_ATTEMPTS = 3
// Channels whose envelopes ARE their pending queue (an inputs record with status 'pending'): agent
// turns and Slack chunks. For these "pending" is the truth and the cursor is only an optimisation —
// a pending item below the cursor is a STRANDED one, not a handled one (2026-10-04; see plan()).
const QUEUE_CHANNELS = new Set(['work', 'messages'])

// A dropped connection often STALLS an in-flight request rather than rejecting it — without a
// timeout the whole run hangs silently. Note: the abandoned promise isn't cancelled; the run
// STOPS cleanly (superlazyStop) rather than plowing on, so a late completion can't interleave.
const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), ms)
  promise.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
})

// (no transient/permanent split any more: EVERY analysis failure stops the run — see analyzeEnvelope)

const addrsOf = (m) => {
  const out = new Set()
  if (m.from && m.from.address) out.add(String(m.from.address).toLowerCase())
  for (const x of [...(m.to || []), ...(m.cc || [])]) if (x && x.address) out.add(String(x.address).toLowerCase())
  return [...out]
}

// deferPersist: nothing is written after analysis — the persistOne inputs are stashed on
// t.pendingPersist until the caller decides (t.commitPending() writes + advances the cursor,
// t.discardPending() drops them). Built for the inspect page's Save / Ignore flow.
export function createProcessor ({ freezr, source, persist, meSet, model, prefs, instructions, profiles, store, maxStepMs: maxStepOpt, deferPersist = false, promptOverride = null }) {
  const session = createSession({ freezr, source, meSet, model, prefs, instructions, profiles, store, promptOverride })
  // how many queued messages go into one LLM call (specs/pipeline-walkthrough.md §5, The batch contract)
  const batchMax = Math.max(1, Number((prefs && prefs.batch_max) || DEFAULT_BATCH_MAX) || 1)
  // Preferences: suggested replies off = no draft is ever requested, whatever the message's age.
  // Until now this setting existed in the schema and the Preferences form but was read by NOTHING —
  // the checkbox saved a value no code consumed.
  const draftsOff = !!(prefs && prefs.suggest_replies === false)
  // per-batch analysis ceiling (see processEnvelopes): jobs pass STEP_TIMEOUT_MS, tabs get 12 min
  const maxStepMs = Number(maxStepOpt) || 12 * 60 * 1000
  // ADAPTIVE BATCH SIZE. batchMax is the CEILING the user configured; this is what we actually try
  // right now. A failed batch halves it (down to 1) so the run keeps moving on smaller bites; a
  // streak of clean batches climbs back toward the ceiling. Per-session only — nothing persisted:
  // runs are hourly and conditions (thread sizes, model load) change between them.
  let batchNow = batchMax
  let cleanStreak = 0
  const RECOVER_AFTER = 3   // consecutive clean batches before trying a bigger one again
  const stepDown = (why) => {
    if (batchNow <= 1) return
    const next = Math.max(1, Math.floor(batchNow / 2))
    console.warn('[superlazy] batch size ' + batchNow + ' → ' + next + ' for the rest of this run (' + why + ')')
    batchNow = next
    cleanStreak = 0
  }
  const stepUp = () => {
    if (batchNow >= batchMax) return
    if (++cleanStreak < RECOVER_AFTER) return
    const next = Math.min(batchMax, batchNow * 2)
    console.info('[superlazy] ' + cleanStreak + ' clean batches — batch size ' + batchNow + ' → ' + next)
    batchNow = next
    cleanStreak = 0
  }
  const t = {
    session,
    queue: [],            // envelopes, oldest-first
    pos: 0,               // next envelope to process/skip
    anchorMs: 0,          // "now" — the newest envelope (archive replay) or the real now (live)
    windowStartMs: 0,     // anchor - history_days
    recentStartMs: 0,     // anchor - thread_context_days: messages this recent get FULL thread context + drafts
    autoUntilMs: 0,       // windowStart + process_days (testing): auto-run stops here
    retryCount: 0,        // how many of the queued messages are RETRIES of earlier failures
    accounts: new Map(),  // account_id -> account record (persisted)
    pendingPersist: [],   // deferPersist mode: persistOne inputs awaiting commit/discard
    pendingCacheEvents: [], // deferPersist mode: cache_refresh events awaiting commit/discard
    pendingBatch: []      // deferPersist mode: the envelopes the pending run consumed (cursor advance)
  }

  // Fetch envelopes for the chosen accounts and compute the window boundaries. In the archive
  // replay the window is anchored to the NEWEST archived message (a real "past N days" of a
  // static archive is usually empty); a live source anchors to the real now.
  // existingAccounts (optional): stored account records — resume mode. Their cursors exclude the
  // already-handled messages, and their counters carry over.
  // onScan (optional): progress callback for the WINDOW fetch — { connectionName, rows, pages } per
  // provider page. A busy mailbox is a long walk; without this the caller can only show a dead page.
  t.plan = async ({ accountInfos, historyDays, threadContextDays, processDays, existingAccounts, onScan = null }) => {
    const prior = new Map((existingAccounts || []).map(r => [r.account_id, r]))
    const accountIds = accountInfos.map(a => a.account_id)
    // Two-step fetch. (1) A small newest-first probe finds the ANCHOR — ≈ now on live mail, the
    // newest archived message on a replay. (2) The real fetch asks for the WINDOW itself (fromMs):
    // live sources filter server-side, so the row budget is spent inside the window instead of on
    // the newest N of the whole mailbox (which could miss the window's start entirely).
    const probe = await withTimeout(source.listEnvelopes({ accountIds, limit: 50 }), STEP_TIMEOUT_MS, 'mailbox probe timed out (connection stall)')
    const probeEnvs = probe.envelopes || []
    t.anchorMs = probeEnvs.length ? probeEnvs[probeEnvs.length - 1].date : Date.now()
    // Accounts the source could not list (an expired mail token, an unreadable store): the probe
    // already shows them. They are kept OUT of the window arithmetic below — a dead account's
    // stale cursor would otherwise drag every run's listing window back an hour further each hour
    // — and out of the account seeding, so nothing stamps them trained or moves their cursor.
    const failedAccounts = () => new Set((source.accountErrors ? source.accountErrors() : []).map(e => e.account_id))
    let failed = failedAccounts()
    const liveRecs = () => [...prior.values()].filter(r => !failed.has(r.account_id))
    const storedStarts = liveRecs().map(r => Number(r.backfill_from) || 0).filter(Boolean)
    const backfillStart = storedStarts.length ? Math.min(...storedStarts) : (t.anchorMs - historyDays * DAY_MS)
    // The window starts at the CURSOR (minus a one-day overlap for retries and cursor races), NOT
    // at the original setup date. The old behaviour re-listed the whole accumulated mailbox on
    // every hourly run — listing cost grew without bound, and past 2500 rows every run reported
    // `truncated`. The overlap keeps recently-failed messages (which sit below the cursor, since
    // the cursor always advances) reachable for their capped retries; anything older has had its
    // retries already. An account with cursor 0 (fresh history build) keeps the full window.
    const cursors = liveRecs().map(r => Number(r.cursor) || 0)
    const cursorMin = cursors.length && cursors.every(c => c > 0) ? Math.min(...cursors) : 0
    t.windowStartMs = cursorMin > 0 ? Math.max(cursorMin - RETRY_OVERLAP_MS, backfillStart) : backfillStart
    t.recentStartMs = t.anchorMs - threadContextDays * DAY_MS
    // processDays: null = auto-process everything; N = auto up to windowStart + N days (a resume
    // in testing mode passes 0 so the remainder is stepped manually)
    t.autoUntilMs = processDays != null ? (t.windowStartMs + processDays * DAY_MS) : Infinity
    const all = await withTimeout(source.listEnvelopes({ accountIds, fromMs: t.windowStartMs, limit: 2500, onPage: onScan }), STEP_TIMEOUT_MS, 'envelope fetch timed out (connection stall)')
    failed = failedAccounts()
    t.failedAccounts = [...failed]
    const envs = all.envelopes || []
    // A queue-channel envelope is pending BY DEFINITION (that is how it got listed), so the date
    // window — sized for re-listing a mailbox — must not drop it: an agent turn formed late
    // (its session ran long) is dated by its prompt, which can precede the window start.
    const inWindow = envs.filter(e => e.date >= t.windowStartMs || QUEUE_CHANNELS.has(e.channel))
    const afterCursor = inWindow.filter(e => {
      const rec = prior.get(e.account_id)
      // >= (not >): a sibling message sharing the cursor's exact millisecond is re-included here
      // and dropped by the analysis-status check below if it was in fact already handled
      return !rec || e.date >= (Number(rec.cursor) || 0)
    })
    t.queue = afterCursor
    t.retryCount = 0
    // Two jobs for one query over the whole window: drop what is genuinely done (the idempotency
    // net — covers cursor races between tabs/jobs and the >= boundary above), and pull out anything
    // that FAILED earlier so it is retried. Failures sit BELOW the cursor (the cursor advances past
    // a message whatever happened to it), so a retry cannot come from `afterCursor` — it has to be
    // recovered from the full window and put at the HEAD of the queue: errored mail is older than
    // the fresh mail behind it, and the project history reads wrong if it lands out of order.
    if (inWindow.length) {
      try {
        const { done, errored, attempts } = await persist.msgAnalysisStatus(inWindow.map(e => e.msg_id))
        const hasKey = (set, e) => set.has(e.account_id + '|' + e.msg_id) || set.has('*|' + e.msg_id)
        const attemptsFor = (e) => (attempts && (attempts.get(e.account_id + '|' + e.msg_id) || attempts.get('*|' + e.msg_id))) || 1
        // retries are CAPPED: a message that failed MAX_ANALYSIS_ATTEMPTS times stops burning an
        // LLM call every run (the old behaviour retried poison messages hourly, forever — a real
        // cost leak). Its error event stays visible on the Events page.
        const erroredAll = inWindow.filter(e => hasKey(errored, e))
        const retry = erroredAll
          .filter(e => attemptsFor(e) < MAX_ANALYSIS_ATTEMPTS)
          .map(e => ({ ...e, retry_attempts: attemptsFor(e) }))
        const givenUp = erroredAll.length - retry.length
        if (givenUp) console.warn('[superlazy] ' + givenUp + ' message(s) reached the ' + MAX_ANALYSIS_ATTEMPTS + '-attempt retry cap and are no longer retried (see their error events)')
        const fresh = afterCursor.filter(e => !hasKey(done, e) && !hasKey(errored, e))
        // REVISED items: an input re-formed after it was analysed (an agent turn analysed while still
        // open whose closing answer has now arrived — revision 2). It sits BELOW the cursor and HAS
        // an analysis event, so both nets above would drop it; like a retry it is recovered from
        // the full window and put at the head, so the answer is analysed against the same task.
        const revised = inWindow.filter(e => e.revised && hasKey(done, e) && !retry.some(r => r.msg_id === e.msg_id))
        // STRANDED items (2026-10-04): a queue-channel envelope BELOW the cursor with no analysis
        // event at all. Two real ways in: (a) the pending scan lost sight of it during a mail
        // burst and a newer turn then moved the cursor past it; (b) it was formed late — a long
        // agent turn is dated by its prompt, and a shorter turn in another session, prompted later
        // but finished first, had already advanced the cursor. Before this branch neither net
        // caught them (not fresh, not errored) and they stayed pending for ever. Like retries they
        // go to the HEAD of the queue — they are older than everything fresh.
        const keyOf = (e) => e.account_id + '|' + e.msg_id
        const afterCursorKeys = new Set(afterCursor.map(keyOf))
        const stranded = inWindow.filter(e => QUEUE_CHANNELS.has(e.channel) && !afterCursorKeys.has(keyOf(e)) &&
          !e.revised && !hasKey(done, e) && !hasKey(errored, e))
        if (stranded.length) console.warn('[superlazy] ' + stranded.length + ' pending item(s) sat below the account cursor with no analysis on record — queued first')
        t.retryCount = retry.length
        t.revisedCount = revised.length
        t.strandedCount = stranded.length
        t.queue = [...retry, ...revised, ...stranded, ...fresh]
      } catch (e) {
        console.error('[superlazy] analysis-status check failed — relying on the account cursor only:', e && e.message)
      }
    }
    t.pos = 0

    // seed + persist one account record per chosen account (the per-account metadata collection)
    for (const info of accountInfos) {
      if (failed.has(info.account_id)) continue // not listed this run: leave its record exactly as it is
      const rec = prior.get(info.account_id) || {
        account_id: info.account_id,
        account_email: info.account_email || '',
        provider: info.provider || source.id,
        source_id: source.id,
        status: 'training',
        cursor: 0,                    // latest retrieved/processed message date (ms)
        last_processed_msg_id: null,
        last_processed_asof: 0,
        backfill_from: t.windowStartMs,
        backfill_done: false,
        history_days: historyDays,
        thread_context_days: threadContextDays,
        messages_processed: 0,
        messages_skipped: 0
      }
      t.accounts.set(rec.account_id, rec)
      // Nothing queued for an account that HAS been read before means it is fully caught up: mark it
      // trained now. Previously the flag only flipped inside bumpAccount, so an account whose queue
      // drained in a run scoped elsewhere (or a run the user stopped) showed "training" for ever.
      // cursor > 0 guards the first-ever pass: a store that has never yielded a turn (or could not
      // be read at all) is not "trained", it is unread.
      if (!rec.backfill_done && rec.cursor > 0 && !t.queue.some(e => e.account_id === rec.account_id)) {
        rec.backfill_done = true
        rec.status = 'trained'
      }
      await persist.saveAccount(rec)
    }
    return {
      total: t.queue.length,
      retryCount: t.retryCount,   // of which: messages that errored on an earlier run, queued first
      strandedCount: t.strandedCount || 0, // of which: pending queue items recovered from below the cursor
      failedAccounts: [...failed],         // accounts the source could not list — skipped this run
      windowStartMs: t.windowStartMs,
      anchorMs: t.anchorMs,
      autoCount: t.queue.filter(e => e.date < t.autoUntilMs).length,
      truncated: !!all.hitCeiling
    }
  }

  // The cursor ALWAYS advances — an error or a skip never blocks the queue (we record it and
  // move on); resume therefore never re-processes and never gets stuck on a poison message.
  async function bumpAccount (env, { skipped, failed } = {}) {
    const rec = t.accounts.get(env.account_id)
    if (!rec) return
    rec.cursor = Math.max(rec.cursor, env.date)
    if (skipped) rec.messages_skipped++
    else if (failed) rec.messages_failed = (rec.messages_failed || 0) + 1
    else {
      rec.messages_processed++
      rec.last_processed_msg_id = env.msg_id
      rec.last_processed_asof = env.date
    }
    if (t.pos >= t.queue.length) {
      // The queue held everything pending for EVERY planned account (composite: mail + Slack +
      // agents, oldest-first), so draining it trains them all — not only the account that
      // happened to own the last envelope, which left the others stuck on "training".
      for (const other of t.accounts.values()) {
        if (other === rec || other.backfill_done) continue
        other.backfill_done = true
        other.status = 'trained'
        await persist.saveAccount(other).catch(e => console.error('account save failed', e))
      }
      rec.backfill_done = true
      rec.status = 'trained'
    }
    await persist.saveAccount(rec).catch(e => console.error('account save failed', e))
  }

  // Process ONE envelope through the engine + persist what it touched. Returns the step result.
  // A hang (STEP_TIMEOUT_MS) or a transient/network failure does NOT log the message as failed —
  // it throws a superlazyStop error so the whole run stops cleanly and visibly, resumable from this
  // exact message (the caller's finally releases the run lock). INVARIANT: STEP_TIMEOUT_MS <
  // LOCK_STALE_MS — a genuinely-stuck message is killed here BEFORE the lock can go stale, so no
  // other process ever takes over a message that is still in flight. That is what makes a per-
  // message claim unnecessary: the single run lock is the only concurrency guard.
  async function processEnvelope (env, emit) {
    return processEnvelopes([env], emit)
  }

  // Run ONE batch of envelopes (all from the same account) through the engine + persist each.
  // Returns { consumed, results } — `consumed` is how many of the given envelopes were actually
  // handled (a batch is trimmed when its bodies exceed BATCH_MAX_CHARS), so the caller advances
  // its cursor by exactly that many.
  async function processEnvelopes (envs, emit) {
    // STEP_TIMEOUT_MS was calibrated for ONE message; a batch answers them all on one call, so the
    // ceiling scales with the batch. In a JOB the cap stays at the single-message value — the
    // runtime-budget invariant (JOB_BUDGET_MS + step + slack < maxRuntime) depends on it. In a TAB
    // there is no hard runtime and the llm_waiting heartbeat keeps the run lock renewed through a
    // long call, so a bigger ceiling is safe there.
    const stepMs = Math.min(STEP_TIMEOUT_MS + (envs.length - 1) * 60000, maxStepMs)
    try {
      return await withTimeout(
        analyzeEnvelopes(envs, emit),
        stepMs,
        'no response for ' + Math.round(stepMs / 60000) + ' min (connection or provider stall)'
      )
    } catch (e) {
      if (e && e.superlazyStop) throw e
      // A TIMEOUT on a multi-message batch is not a reason to stop the whole run: the likeliest
      // cause is that this combination was too big. Step down and retry the FIRST message alone —
      // it makes progress, and if that one message is itself the problem it fails alone (where the
      // attempts cap can retire it) instead of taking the batch's siblings down with it every run.
      if (envs.length > 1) {
        console.warn('[superlazy] batch of ' + envs.length + ' timed out — retrying the first message alone')
        emit({ type: 'batch_split', count: envs.length })
        stepDown('a batch timed out')
        return await processEnvelopes([envs[0]], emit)
      }
      const first = envs[0] || {}
      const err = new Error('stopped at “' + (first.subject || first.msg_id) + '” — ' + ((e && e.message) || e))
      err.superlazyStop = true
      // A single message that TIMES OUT wrote no event (persistOne was never reached), so it had no
      // attempts counter and was re-planned forever. Record it: the retry cap can now retire it.
      err.recordTimeout = { env: first }
      throw err
    }
  }

  async function analyzeEnvelopes (envs, emit) {
    // Build one entry per envelope: load its thread, take the prior messages as context.
    const entries = []
    const envOf = new Map()
    let chars = 0
    for (const env of envs) {
      const thread = await ensureThread(session, env.thread_id, emit)
      const newMsg = thread.byId.get(env.msg_id)
      if (!newMsg) {
        emit({ type: 'step_error', idx: t.pos, total: t.queue.length, msg: { from: { address: env.from_address }, subject: env.subject }, message: 'message not found in its thread (source mismatch)' })
        // Record it — this used to be the one failure that wrote NO event at all: the message
        // vanished except for a counter on the account record, unretriable and undiagnosable.
        await persist.addEvent({
          msg_id: env.msg_id, account_id: env.account_id, thread_id: env.thread_id, source_id: source.id, asof: env.date,
          kind: 'message', latest_delta: {}, changes: [], via_workflow: null, fetch_rounds: 0,
          cost: 0, subject: env.subject || '', from_address: env.from_address || '',
          attempts: (Number(env.retry_attempts) || 0) + 1,
          error: 'message not found in its thread (source mismatch) — skipped'
        }).catch(e => console.error('error-event save failed', e))
        // consume it (the cursor must advance past a message the source can't produce)
        if (!entries.length) return { consumed: 1, results: [{ ok: false, msg_id: env.msg_id }] }
        break
      }
      // DEFENCE IN DEPTH: the live source already drops drafts at fetch time, but a queue built by
      // another source (or before the folder lookup resolved) can still carry one. Record it as
      // 'skipped' — that kind counts as handled, so it is never re-planned — and move on.
      if (newMsg.is_draft || env.is_draft) {
        emit({ type: 'skipped', idx: t.pos, total: t.queue.length, msg: newMsg, message: 'unsent draft — not analysed' })
        await persist.addEvent({
          msg_id: env.msg_id, account_id: env.account_id, thread_id: env.thread_id,
          source_id: source.id, asof: env.date, kind: 'skipped',
          latest_delta: {}, changes: [], via_workflow: null, fetch_rounds: 0, cost: 0,
          subject: env.subject || '', from_address: env.from_address || '',
          summary: 'Unsent draft — skipped. Drafts are not analysed until they are actually sent.',
          error: null
        }).catch(e => emit({ type: 'persist_error', errors: ['draft-skip event: ' + ((e && e.message) || e)] }))
        if (!entries.length) return { consumed: 1, results: [{ ok: true, dup: true, msg_id: env.msg_id }] }
        break
      }
      const size = String(newMsg.clean_text || '').length
      // keep at least one; stop growing the batch once the bodies alone would crowd the request
      if (entries.length && chars + size > BATCH_MAX_CHARS) break
      chars += size
      const isRecent = newMsg.date >= t.recentStartMs
      const posInThread = thread.sorted.findIndex(m => m.msg_id === newMsg.msg_id)
      let priorMsgs = thread.sorted.slice(0, posInThread < 0 ? 0 : posInThread)
      // context-depth knob: only RECENT messages get their complete thread (even before the
      // window); older ones see prior context from within the history window only
      if (!isRecent) priorMsgs = priorMsgs.filter(m => m.date >= t.windowStartMs)
      // messages (Slack) items never get drafts — read-only v1, and the prompt's messages guide
      // forbids all three kinds; the flag makes the request skip the style guide too
      entries.push({ newMsg, priorMsgs, threadId: env.thread_id, accountId: env.account_id || null, noDrafts: draftsOff || !isRecent || newMsg.channel === 'messages' || newMsg.channel === 'work' })
      envOf.set(env.msg_id, { env, newMsg })
    }
    if (!entries.length) return { consumed: 0, results: [] }
    console.info('[superlazy] batch formed: ' + entries.length + ' message(s), ' +
      chars.toLocaleString() + ' chars of new bodies — assembling the request')
    // tell the UI what went into this call, so the modal can say "10 emails sent together"
    // instead of narrating one subject and looking stuck for the whole call
    emit({ type: 'batch_formed', count: entries.length, chars, subjects: entries.map(e => e.newMsg.subject || '(no subject)') })

    // suggested replies for old backfill mail are stale noise — skipped when every message is old
    const noDrafts = entries.every(e => e.noDrafts)

    const stepEvents = new Map()
    const errorEvents = new Map()
    const first = entries[0]
    // the housekeeping row says WHICH block was written and why — hot (the message thresholds),
    // cold + hot (weekly / rules changed / first), or a provider rewrite of bytes already cached
    const cacheRefreshSubject = (ev) => {
      const k = (n) => Math.round((n || 0) / 1000) + 'k'
      const sizes = ' · hot ' + (ev.hot_projects || 0) + ' projects / ' + k(ev.hot_chars) + ' chars, cold ' + (ev.cold_projects || 0) + ' / ' + k(ev.cold_chars)
      if (ev.trigger === 'rewrite') return 'Project catalog re-written by the provider — ' + (ev.block || 'catalog') + ' (its entry had expired or the prefix changed)' + sizes
      if (ev.block === 'both') return 'Project catalog cached — COLD + HOT blocks' + (ev.cold_trigger ? ' (cold: ' + ev.cold_trigger + ')' : '') + sizes
      return 'Project catalog cached — HOT block only (' + (ev.trigger || 'refresh') + ')' + sizes
    }
    const wrapped = (ev) => {
      const id = ev && ev.msg && ev.msg.msg_id
      if (ev.type === 'step' && id) stepEvents.set(id, ev)
      if (ev.type === 'step_error' && id) errorEvents.set(id, ev)
      // The catalog snapshot was (re)written to the provider cache on this call — record it as its
      // own event, with its own cost, so cache spend is monitorable (and later removable) — §7.
      // deferPersist stashes the built record; commitPending writes it with everything else.
      if (ev.type === 'cache_refresh') {
        const rec = {
          kind: 'cache_refresh', source_id: source.id, asof: ev.asof || first.newMsg.date,
          account_id: (envs[0] && envs[0].account_id) || null,
          thread_id: null, msg_id: null,
          latest_delta: {}, changes: [], via_workflow: null, fetch_rounds: 0,
          cost: ev.cost || 0, importance: 1, // the WRITE premium only — the call's remainder rides on its message events
          call_cost: ev.call_cost != null ? ev.call_cost : null,
          cache_creation_tokens: ev.cache_creation_tokens || 0,
          cache_read_tokens: ev.cache_read_tokens || 0,
          trigger: ev.trigger || null,
          block: ev.block || null,               // 'both' | 'hot' | an estimate on a rewrite
          cold_trigger: ev.cold_trigger || null, // why the cold block re-rendered, when it did
          snapshot_chars: ev.snapshot_chars || 0,
          projects_in_snapshot: ev.projects_in_snapshot || 0,
          hot_chars: ev.hot_chars || 0, hot_projects: ev.hot_projects || 0,
          cold_chars: ev.cold_chars || 0, cold_projects: ev.cold_projects || 0,
          subject: cacheRefreshSubject(ev),
          from_address: '', error: null
        }
        if (deferPersist) t.pendingCacheEvents.push(rec)
        else persist.addEvent(rec).catch(e => console.error('cache_refresh event save failed', e))
      }
      emit(ev)
    }
    let splitHappened = false
    let batchRes = await processBatch(session, {
      entries, noDrafts, idx: t.pos, total: t.queue.length
    }, { emit: wrapped })

    // SPLIT AND RETRY. A batch that was too much to answer in one call is re-asked one message at
    // a time. The catalog snapshot is already in the provider's cache, so each solo call re-reads
    // it at the cached rate — per-message cost lands close to the batch's, and every message gets
    // its own chance to succeed instead of nine failing together.
    // Split on ANY batch-level failure, not only "too much at once": whatever went wrong with the
    // combined call (unparseable reply, a provider error, one poison message), asking one at a time
    // both isolates the culprit and usually succeeds — and the catalog is already cached, so the
    // per-message cost lands close to the batch's. Previously a non-tooMuchAtOnce failure took all
    // N messages down together and stopped the run.
    if (!batchRes.ok && entries.length > 1) {
      console.warn('[superlazy] the batch of ' + entries.length + ' failed as one call — ' +
        'retrying them one by one against the cached catalog' +
        (batchRes.tooMuchAtOnce ? ' (reported: too much at once)' : ''))
      splitHappened = true
      emit({ type: 'batch_split', count: entries.length })
      const soloResults = []
      for (const e of entries) {
        const solo = await processBatch(session, {
          entries: [e], noDrafts: e.noDrafts, idx: t.pos, total: t.queue.length
        }, { emit: wrapped })
        const r = (solo.results || [])[0]
        soloResults.push(r || { ok: false, msg_id: e.newMsg.msg_id })
      }
      const okCount = soloResults.filter((r) => r && r.ok).length
      console.info('[superlazy] split retry: ' + okCount + '/' + entries.length + ' processed individually')
      batchRes = { ...batchRes, ok: okCount > 0, results: soloResults, missing: [] }
    }

    // SAFETY NET: any message the model returned no entry for is retried ALONE (spec §3), so one
    // skipped message in a batch never silently disappears.
    for (const missId of (batchRes.missing || [])) {
      const rec = envOf.get(missId)
      if (!rec) continue
      const e = entries.find(x => x.newMsg.msg_id === missId)
      const solo = await processBatch(session, {
        entries: [e], noDrafts: e.noDrafts, idx: t.pos, total: t.queue.length
      }, { emit: wrapped })
      const r = (solo.results || [])[0]
      batchRes = {
        ...batchRes,
        results: batchRes.results.map(x => (x.msg_id === missId && r) ? r : x)
      }
    }

    // Persist each message that produced a step event (same work as the single-message path did).
    // In deferPersist mode the inputs are stashed instead — the caller commits or discards them.
    for (const [msgId, rec] of envOf) {
      const stepEvent = stepEvents.get(msgId)
      const errorEvent = errorEvents.get(msgId)
      const res = (batchRes.results || []).find(r => r.msg_id === msgId) || { ok: false }
      const env = rec.env
      const newMsg = rec.newMsg
      if (deferPersist) t.pendingPersist.push({ env, newMsg, res, stepEvent, errorEvent })
      else await persistOne({ env, newMsg, res, stepEvent, errorEvent, emit })
    }
    return { consumed: entries.length, results: batchRes.results || [], splitHappened, batchOk: !!batchRes.ok }
  }

  // Persist ONE analysed message: projects/profiles/events, the reprofile + autofile side-events,
  // and the body snapshot. Unchanged in substance from the pre-batch version — only its inputs
  // are now per-message rather than per-call.
  async function persistOne ({ env, newMsg, res, stepEvent, errorEvent, emit }) {
    // EVENT PRIORITY. Mail that was auto-filed WITHOUT being read ranks by the PROJECT it landed
    // in, not by a default — so a newsletter in "Promotions" (1) filters out of the feed like the
    // priority-1 thing it is, while the same decision about a priority-4 project stays visible.
    // SuperLazy's own housekeeping ranks 1. The events feed derives the same ranks live
    // (eventsUi.eventImportance), so legacy records read correctly too; this stamp is what the
    // other surfaces (Recent) read.
    const projImp = (pid) => { const p = pid && session.store.get(pid); return (p && Number(p.importance)) || 0 }
    const filedIn = (changes) => ((changes || []).map(c => c.project_id).find(Boolean)) || null
    if (res.ok && stepEvent) {
      // archive the profile versions this step's re-profiles replaced (solidified ones only —
      // provisional first-pass profiles are churn, not history)
      const profileHistory = (stepEvent.reprofiles || [])
        .filter(r => r.outcome === 'updated' && r.applied && r.applied.before && r.applied.before.solidified_asof)
        .map(r => {
          const person = session.profiles.get(r.address)
          return profileHistorySnapshot(r.address, r.applied.before, {
            manualRank: person ? person.manual_rank : null,
            source: 'reprofile:' + r.trigger, reason: r.reason, asof: newMsg.date
          })
        })
      const eventRec = eventFromStep(stepEvent, source.id, env)
      // auto-filed mail (no LLM read of its own): rank it by the bucket it landed in
      if (eventRec.kind === 'workflow_short_circuit') {
        eventRec.importance = projImp(filedIn(eventRec.changes)) || 1
      }
      const errors = await persist.persistStep({
        store: session.store,
        profiles: session.profiles,
        touchedProjectIds: (res.applied && res.applied.touched_project_ids) || [],
        touchedAddresses: addrsOf(newMsg),
        profileHistory,
        event: eventRec,
        // provenance: which account this message came from, so the projects/profiles it feeds
        // can later be removed one account at a time (persist.sourceTagFor / deleteAccountData).
        // Falls back to the account id when the provider gave us no address — an untagged record
        // would be invisible to a per-account delete, which is worse than a less pretty tag.
        // Channel-aware: a messaging account tags 'slack:<connectionName>', mail 'email:<addr>'.
        sourceTag: sourceTagFor({
          channel: (t.accounts.get(env.account_id) || {}).channel || env.channel || null,
          account_id: env.account_id,
          account_email: (t.accounts.get(env.account_id) || {}).account_email || env.account_id
        })
      })
      if (errors.length) emit({ type: 'persist_error', errors })
      // each dedicated re-profile is ALSO its own feed event (kind 'reprofile'), same shape as
      // the People page's on-demand one — so profile changes are findable in the events stream
      // regardless of what triggered them. from_address/subject make the generic row readable.
      for (const r of (stepEvent.reprofiles || [])) {
        await persist.addEvent({
          kind: 'reprofile', source_id: source.id, asof: newMsg.date, importance: 1,
          address: r.address, from_address: r.address, trigger: r.trigger,
          outcome: r.outcome, reason: r.reason || null, cost: r.cost || 0,
          msg_id: env.msg_id, account_id: env.account_id, thread_id: env.thread_id,
          subject: 'Profile ' + (r.outcome === 'updated' ? 'updated' : r.outcome) + ' (' + r.trigger + ')' + (r.reason ? ' — ' + r.reason : '')
        }).catch(e => emit({ type: 'persist_error', errors: ['reprofile event: ' + ((e && e.message) || e)] }))
      }
      // A sender being put ON AUTOPILOT is the one decision the user never gets to see otherwise:
      // from now on their mail is filed WITHOUT an LLM read. So the FIRST activation gets its own
      // event, giving the user a place on Recent / Events to counter it (the △ on the row opens the
      // sender's card). It ranks with the BUCKET it files into — the decision used to be stamped 4
      // so it would out-rank its own item, which meant newsletters and admin updates survived every
      // priority filter. Fires once per sender, not per message.
      for (const f of (stepEvent.triggersFired || [])) {
        const r = f && f.result
        if (!r || !r.learned_first || !r.sender) continue
        await persist.addEvent({
          kind: 'autofile_learned', source_id: source.id, asof: newMsg.date,
          importance: projImp(r.project_id) || 1,
          address: r.sender, from_address: r.sender,
          category: r.category || null, target_name: r.target_name || null,
          project_id: r.project_id || null,
          summary: 'Learned from this message. Future mail from ' + r.sender +
            ' will be filed to “' + (r.target_name || 'its bucket') + '” automatically, without being read by the AI.',
          msg_id: env.msg_id, account_id: env.account_id, thread_id: env.thread_id,
          subject: 'Now auto-filing ' + r.sender + ' → ' + (r.target_name || r.category || 'bucket')
        }).catch(e => emit({ type: 'persist_error', errors: ['autofile_learned event: ' + ((e && e.message) || e)] }))
      }
      // The user wrote to a sender who was on autopilot, so it was switched off (profiles.js). Its
      // own event: the user needs to know their mail is being read again, and why.
      for (const addr of (stepEvent.unlearned || [])) {
        await persist.addEvent({
          kind: 'autofile_off', source_id: source.id, asof: newMsg.date, importance: 3,
          address: addr, from_address: addr,
          summary: 'You have written to ' + addr + ', so they are no longer auto-filed — their mail is analysed again from now on.',
          msg_id: env.msg_id, account_id: env.account_id, thread_id: env.thread_id,
          subject: 'No longer auto-filing ' + addr + ' (you write to them)'
        }).catch(e => emit({ type: 'persist_error', errors: ['autofile_off event: ' + ((e && e.message) || e)] }))
      }
      // Drift on an ALREADY-learned sender: we auto-filed by the standing decision, but the mail
      // system's own label says this one belongs elsewhere (a bank sending promos, or promos hiding
      // an alert). Free to detect, so surfaced as its own countering event rather than an LLM call.
      // TWO kinds of doubt about an auto-file decision, one surface. Either way the mail WAS filed
      // and the event carries the one-tap "Do not file these automatically" control: acting and
      // then asking beats refusing to act and never asking, which is what the old guard did.
      const mm = stepEvent.workflow_mismatch
      const doubt = stepEvent.workflow_doubt
      if (mm || doubt) {
        const filedPid = filedIn((stepEvent.applied && stepEvent.applied.changes) || [])
        await persist.addEvent({
          kind: 'autofile_mismatch', source_id: source.id, asof: newMsg.date,
          // like the decision itself: ranks with the bucket the mail landed in
          importance: projImp(filedPid) || 1,
          project_id: filedPid,
          address: (newMsg.from && newMsg.from.address) || null,
          from_address: (newMsg.from && newMsg.from.address) || null,
          category: (mm && mm.learned) || null, by_label: (mm && mm.by_label) || null,
          doubt: doubt || null,
          summary: mm
            ? 'Auto-filed as “' + mm.learned + '” (the standing decision for this sender), but the ' +
              'mail system labelled it “' + mm.by_label + '”. This sender may send more than one kind of mail.'
            : 'Auto-filed as decided, but worth a glance: ' + doubt + '. It was filed anyway rather than ' +
              'paying to analyse every message — if that is wrong, one tap stops it for good; ignoring ' +
              'this is a perfectly good answer.',
          msg_id: env.msg_id, account_id: env.account_id, thread_id: env.thread_id,
          subject: (mm ? 'Auto-file may be wrong: ' : 'Auto-filed — confirm? ') + (newMsg.subject || '(no subject)')
        }).catch(e => emit({ type: 'persist_error', errors: ['autofile_mismatch event: ' + ((e && e.message) || e)] }))
      }
      // Store a snapshot of the full body for the email reader (instant, provider-free re-open).
      // Best-effort and non-blocking: the analyser already fetched the bytes, so this is cheap; a
      // failure (or a source without getBodyPayload) must never derail ingestion.
      if (source.getBodyPayload && persist.saveEmailBody) {
        Promise.resolve()
          .then(() => source.getBodyPayload(newMsg))
          .then(payload => payload && persist.saveEmailBody({
            msg_id: newMsg.msg_id, account_id: env.account_id, thread_id: env.thread_id,
            from: newMsg.from, to: newMsg.to, cc: newMsg.cc, subject: newMsg.subject, date: newMsg.date,
            ...payload
          }))
          .catch(e => emit({ type: 'persist_error', errors: ['email_body: ' + ((e && e.message) || e)] }))
      }
      // MESSAGING chunks live in `inputs` BEFORE analysis (the chunk ledger, status 'pending' —
      // that is also why getBodyPayload is null for them: the record already exists). Completing
      // the analysis flips the record to 'analysed' so it leaves the pending queue.
      if ((env.channel === 'messages' || env.channel === 'work') && persist.updateInputFields) {
        await persist.updateInputFields({ account_id: env.account_id, msg_id: env.msg_id }, {
          status: 'analysed',
          attempts: 0,
          last_error: null,
          analysis_event_id: persist.eventIdFor ? persist.eventIdFor(env.account_id, env.msg_id) : null
        }).catch(e => emit({ type: 'persist_error', errors: ['input status: ' + ((e && e.message) || e)] }))
      }
    } else if (!res.ok) {
      const failMsg = (errorEvent && errorEvent.message) || res.error || 'analysis failed'
      // TWO KINDS OF FAILURE, two right answers.
      //
      // A failure ABOUT THIS MESSAGE — the model could not answer even when asked about it alone
      // (too much to weigh up, a reply it could not finish) — tells us nothing about the next
      // message, which is probably a two-line reply. Stopping there would let one awkward email
      // hold up the other forty-six. So: record it (it lands in the retry list and on Events) and
      // carry on; the cursor advances past it, exactly as it does for a skip.
      const aboutThisMessage = /too much to weigh up|EMPTY reply twice|whole output budget reasoning|cut off mid-JSON/.test(failMsg)
      // attempts ride ON the (idempotent) error event — plan() reads them back and stops retrying
      // at MAX_ANALYSIS_ATTEMPTS. env.retry_attempts is set by plan() when this run IS a retry.
      const attempt = (Number(env.retry_attempts) || 0) + 1
      const capped = attempt >= MAX_ANALYSIS_ATTEMPTS
      if (aboutThisMessage) {
        console.warn('[superlazy] giving up on “' + (env.subject || env.msg_id) + '” and moving on: ' + failMsg)
        emit({ type: 'message_abandoned', msg: newMsg, message: failMsg })
        await persist.addEvent({
          msg_id: env.msg_id, account_id: env.account_id, thread_id: env.thread_id, source_id: source.id, asof: env.date,
          kind: 'message', latest_delta: {}, changes: [], via_workflow: null, fetch_rounds: 0,
          cost: 0, subject: env.subject || '', from_address: env.from_address || '', attempts: attempt,
          error: failMsg + (capped
            ? ' — gave up after ' + attempt + ' attempt(s); it will NOT be retried again'
            : ' — skipped so the rest of the mail could be processed; it is retried first next run (attempt ' + attempt + '/' + MAX_ANALYSIS_ATTEMPTS + ')')
        }).catch(e => console.error('error-event save failed', e))
        // a messaging chunk's queue state rides on its inputs record too — stamp the failure there
        // so pendingInputs' own attempts cap agrees with the events-based one
        if ((env.channel === 'messages' || env.channel === 'work') && persist.updateInputFields) {
          await persist.updateInputFields({ account_id: env.account_id, msg_id: env.msg_id },
            { status: 'error', attempts: attempt, last_error: failMsg }).catch(() => {})
        }
        return res
      }
      // Anything else STOPS the run. It is never safe to plow on: the common causes are
      // environmental (LLM credit exhausted, mail token expired, network down) and hit every
      // following message too — which is how one dead credit card used to turn into a hundred
      // silently half-processed emails. So: record the failure (it becomes the retry list — see
      // msgAnalysisStatus — and is visible on Events), then throw a clean stop. The cursor is NOT
      // advanced (bumpAccount never runs), so this exact message is retried on Continue; the user's
      // way past a message that always fails is the Skip button.
      // An ENVIRONMENTAL failure (busy local connector, rate limit, network, credit) says nothing
      // about this message, so it must not spend one of its MAX_ANALYSIS_ATTEMPTS: the counter is
      // rewritten unchanged (never below 1, which is what an old counter-less event reads as).
      const environmental = isEnvironmentalFailure(failMsg)
      await persist.addEvent({
        msg_id: env.msg_id, account_id: env.account_id, thread_id: env.thread_id, source_id: source.id, asof: env.date,
        kind: 'message', latest_delta: {}, changes: [], via_workflow: null, fetch_rounds: 0,
        cost: 0, subject: env.subject || '', from_address: env.from_address || '',
        attempts: environmental ? Math.max(1, Number(env.retry_attempts) || 1) : attempt,
        error: failMsg + (environmental ? ' — not counted against the retry cap' : '')
      }).catch(e => console.error('error-event save failed', e))
      const err = new Error('stopped at “' + (env.subject || env.msg_id) + '” — ' + failMsg)
      err.superlazyStop = true
      err.failure = { msg_id: env.msg_id, account_id: env.account_id, subject: env.subject || '', from_address: env.from_address || '', reason: failMsg }
      throw err
    }
    return res
  }

  // AUTO-RUN: process the queue oldest-first up to autoUntilMs (testing) or fully (production).
  t.runAuto = async ({ onEvent, shouldStop } = {}) => {
    const emit = onEvent || (() => {})
    const stop = shouldStop || (() => false)
    await ensureUserStyle(session, emit)
    while (t.pos < t.queue.length && !stop()) {
      const env = t.queue[t.pos]
      if (env.date >= t.autoUntilMs) break
      // Form a batch: consecutive queued messages from the SAME account, bounded by batch_max and, inside analyzeEnvelopes, by
      // BATCH_MAX_CHARS. batchMax 1 = the pre-batch behaviour, message by message.
      const batch = [env]
      for (let k = t.pos + 1; k < t.queue.length && batch.length < batchNow; k++) {
        const nxt = t.queue[k]
        if (nxt.account_id !== env.account_id) break
        if (nxt.date >= t.autoUntilMs) break
        batch.push(nxt)
      }
      const step = await processEnvelopes(batch, emit)
      const { consumed, results } = step
      // adapt for the NEXT batch of this run: a split (or an outright batch failure) means this
      // size did not work here; a clean multi-message batch earns the way back up
      if (batch.length > 1 && (step.splitHappened || step.batchOk === false)) stepDown('a batch had to be split')
      else if (batch.length > 1) stepUp()
      const n = Math.max(1, consumed)
      const handled = t.queue.slice(t.pos, t.pos + n)
      // advance FIRST: bumpAccount reads t.pos to decide whether the backfill is finished
      t.pos += n
      for (const e of handled) {
        const r = (results || []).find(x => x.msg_id === e.msg_id) || { ok: false }
        await bumpAccount(e, { skipped: !!r.dup, failed: !r.ok })
      }
    }
    const done = t.pos >= t.queue.length
    emit({ type: 'auto_done', processed: session.processed, remaining: t.queue.length - t.pos, done, totalCost: session.totalCost })
    return { remaining: t.queue.length - t.pos, done }
  }

  // ---- INSPECT mode (deferPersist: true) — nothing written until the user says so.
  // inspectNext analyses the next `count` queued messages (consecutive, same account — they go
  // into ONE batched LLM call, exactly as runAuto with batch_max=count would) and stashes the
  // would-be writes on t.pendingPersist. commitPending writes them exactly as production would
  // AND advances pos + the account cursor past every consumed message. discardPending drops
  // them; pos stays, so the same message(s) can be re-run (in this tab after a rebuild, or in
  // another tab with different prefs).
  // NOTE: the in-memory stores (projects/profiles/snapshot) HAVE been mutated by the analysis —
  // after a discard the page must rebuild the runner from the persisted snapshot before re-running.
  t.inspectNext = async ({ onEvent, count = 1 } = {}) => {
    const emit = onEvent || (() => {})
    if (t.pos >= t.queue.length) return { done: true }
    await ensureUserStyle(session, emit)
    t.pendingPersist = []
    t.pendingCacheEvents = []
    t.pendingBatch = []
    const want = Math.max(1, Math.min(Number(count) || 1, 20))
    const batch = [t.queue[t.pos]]
    for (let k = t.pos + 1; k < t.queue.length && batch.length < want; k++) {
      const nxt = t.queue[k]
      if (nxt.account_id !== batch[0].account_id) break
      batch.push(nxt)
    }
    const { consumed, results } = await processEnvelopes(batch, emit)
    // only the consumed prefix is pending (processEnvelopes trims a batch at BATCH_MAX_CHARS)
    t.pendingBatch = batch.slice(0, Math.max(1, consumed))
    return { done: false, envs: t.pendingBatch, results: results || [], remaining: t.queue.length - t.pos }
  }

  t.commitPending = async ({ onEvent } = {}) => {
    const emit = onEvent || (() => {})
    const pend = t.pendingPersist
    const cacheEvents = t.pendingCacheEvents
    const batch = (t.pendingBatch && t.pendingBatch.length)
      ? t.pendingBatch
      : (t.pos < t.queue.length ? [t.queue[t.pos]] : [])
    t.pendingPersist = []
    t.pendingCacheEvents = []
    t.pendingBatch = []
    for (const rec of cacheEvents) {
      await persist.addEvent(rec).catch(e => console.error('cache_refresh event save failed', e))
    }
    for (const p of pend) await persistOne({ ...p, emit })
    // advance exactly as runAuto does: pos first (bumpAccount reads it), then the cursor per message
    t.pos += batch.length
    for (const env of batch) {
      const p = pend.find(x => x.env && x.env.msg_id === env.msg_id)
      const failed = p ? !(p.res && p.res.ok) : true
      await bumpAccount(env, { failed })
    }
    return { remaining: t.queue.length - t.pos, done: t.pos >= t.queue.length, saved: batch.length }
  }

  t.discardPending = () => {
    const n = t.pendingPersist.length
    t.pendingPersist = []
    t.pendingCacheEvents = []
    t.pendingBatch = []
    return { discarded: n }
  }

  // MANUAL stepping (testing): one message per press, as if it just arrived.
  t.stepNext = async ({ onEvent } = {}) => {
    const emit = onEvent || (() => {})
    if (t.pos >= t.queue.length) return { done: true }
    await ensureUserStyle(session, emit)
    const env = t.queue[t.pos]
    const { results } = await processEnvelope(env, emit)
    const r = (results || [])[0] || { ok: false }
    t.pos++
    await bumpAccount(env, { skipped: !!r.dup, failed: !r.ok })
    return { done: t.pos >= t.queue.length, remaining: t.queue.length - t.pos }
  }

  t.skipNext = async ({ onEvent } = {}) => {
    const emit = onEvent || (() => {})
    if (t.pos >= t.queue.length) return { done: true }
    const env = t.queue[t.pos]
    emit({ type: 'skipped', idx: t.pos, total: t.queue.length, msg: { from: { address: env.from_address }, subject: env.subject, date: env.date } })
    // a user-skipped message enters the processed set (deterministic id) — with the >= cursor
    // boundary it would otherwise be re-planned forever
    await persist.addEvent({
      msg_id: env.msg_id, account_id: env.account_id, thread_id: env.thread_id, source_id: source.id,
      asof: env.date, kind: 'skipped', latest_delta: {}, changes: [], via_workflow: null,
      fetch_rounds: 0, cost: 0, subject: env.subject || '', from_address: env.from_address || '', error: null
    }).catch(e => console.error('skip-event save failed', e))
    t.pos++
    await bumpAccount(env, { skipped: true })
    return { done: t.pos >= t.queue.length, remaining: t.queue.length - t.pos }
  }

  t.peekNext = () => (t.pos < t.queue.length ? t.queue[t.pos] : null)
  t.remaining = () => t.queue.length - t.pos
  t.processedSoFar = () => [...t.accounts.values()].reduce((n, r) => n + (r.messages_processed || 0), 0)

  // Fetch the NEXT queued message's full body (for the "next up" preview before Process/Skip).
  // Uses the same thread cache the subsequent Process will hit, so nothing is fetched twice.
  t.peekDetail = async () => {
    const env = t.peekNext()
    if (!env) return null
    const thread = await ensureThread(session, env.thread_id, () => {})
    return thread.byId.get(env.msg_id) || null
  }

  return t
}
