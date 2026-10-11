// config.js — build-time flags.

// The default MODEL for per-message analysis (and for the clean-up) lives in modelDefaults.js.

// Defaults for the welcome screen's day inputs (all user-adjustable there).
export const DEFAULT_HISTORY_DAYS = 6        // how far back to fetch + analyse messages
export const DEFAULT_THREAD_CONTEXT_DAYS = 1 // messages this recent get their COMPLETE thread as context (older ones: window-only)

// ---- batch analysis (see specs/pipeline-walkthrough.md §5–§7) ----------------------------------
// How many queued messages go into ONE LLM call. The fixed overhead of a request (catalog,
// profiles, system prompt) is >95% of it, so batching is the single biggest cost lever:
// ~$0.20/message individually vs ~$0.055 at 10. Kept small because model recall degrades over
// large document sets. 1 = one message per call (the pre-batch behaviour, and the kill switch).
// TEN messages per call by default (2026-08-07). This was 1 for a long time, on the argument that
// prompt caching already amortises the catalog and batching risks all-N-fail. Both halves of that
// changed: the failure paths are now real (ANY batch failure — including a timeout — splits into
// individual retries, and the size ADAPTS down/up per run, see processor.js), and batching cuts
// round trips as well as tokens, which is what makes a backlog drain inside one job budget.
// It is a CEILING, not a promise: processor.js halves it on trouble and climbs back after three
// clean batches, so a bad batch costs a split rather than a stopped run.
// Two caveats that remain true: every message in a batch is judged against the SAME store snapshot
// (no mid-batch update), and BATCH_MAX_CHARS below still trims a batch of long messages.
export const DEFAULT_BATCH_MAX = 10
// …and a character ceiling, so ten long messages can't blow the context budget.
export const BATCH_MAX_CHARS = 60000
// Staleness tiers: how much of a project is sent, by how long it has been quiet (§5).
// { full_days: 0 } disables tiering entirely (always full detail).
export const DEFAULT_STALENESS_DAYS = { full_days: 7, brief_days: 30 }
// An UNEDITED suggested reply older than this stops showing anywhere (user, 2026-09-27: "7 days").
// A draft the user EDITED is theirs and never ages out. Read by expandableProjectView.isLiveResponse.
export const DRAFT_MAX_AGE_DAYS = 7

// New-mail / ingestion coordination (see specs/pipeline-walkthrough.md §2).
export const NEW_MAIL_AUTO_THRESHOLD = 20    // above this, the dashboard shows a cost warning while processing
export const EST_COST_PER_MSG = [0.05, 0.10] // rough per-message LLM cost range (USD), for the warning line
export const LOCK_STALE_MS = 5 * 60 * 1000   // run lock untouched this long = stale (dead holder) and may be taken over. Renewed on every work beat (msg start, each LLM round, completion) — a live run never lets it lapse.
export const STEP_TIMEOUT_MS = 4 * 60 * 1000 // one message's processing (or an envelope fetch) taking longer = a stalled connection/provider → stop the run cleanly instead of hanging.
// INVARIANT: STEP_TIMEOUT_MS < LOCK_STALE_MS. A stuck message is killed (run stops, lock released)
// BEFORE the lock could go stale, so a second process never takes over a message still in flight —
// which is why the single run lock is a sufficient concurrency guard (no per-message claim needed).

// ---- background job: runtime budget ---------------------------------------------------------
// A job run is HARD-BOUNDED by freezr: the run is killed at maxRuntime and its API token expires
// at maxRuntime + 60s. So the job can NEVER be "process everything" — it processes what fits and
// returns { remaining }, and the next run (the schedule tick, or the page firing another on-demand
// run) picks up exactly where this one stopped. Every message is persisted before the next starts,
// so stopping mid-queue loses nothing.
//
// JOB_MAX_RUNTIME must match manifest.json jobs[].maxRuntime (that value drives SCHEDULED runs;
// this one is passed on ON-DEMAND runs). 900s is the AWS Lambda ceiling — don't raise it past that
// or cloud runs will be rejected.
export const JOB_MAX_RUNTIME = '900s'
// THE CLEAN-UP RUN (2026-09-27, user): the scheduled run that carries the weekly clean-up does the
// clean-up FIRST (an opus call, 4–10 min measured) and then the mail check in whatever time is left.
// manifest.json jobs[].maxRuntime is raised to match (it drives SCHEDULED runs; this constant is passed
// on the pages' on-demand clean-up run). Cloud runners clamp to 900s (awsJobRunner) — there the
// clean-up's deadline still fits and the mail share shrinks to nothing; this job resolves LOCAL.
export const CLEANUP_JOB_MAX_RUNTIME = '1800s'
export const CLEANUP_JOB_RUNTIME_MS = 30 * 60 * 1000
// the clean-up call must have RETURNED by this point of the run (no new model round starts past it)
export const CLEANUP_DEADLINE_MS = 20 * 60 * 1000
// INVARIANT: JOB_BUDGET_MS + STEP_TIMEOUT_MS + slack < JOB_MAX_RUNTIME. The budget is only checked
// BETWEEN messages, so a message started just under the budget can still run for a further
// STEP_TIMEOUT_MS. Leaving that headroom is what guarantees the job's own `finally` runs — which is
// what RELEASES THE RUN LOCK. Blow through maxRuntime instead and the lock is orphaned until it
// goes stale (LOCK_STALE_MS), blocking every other checker in the meantime.
// 600s + 240s + 60s = 900s exactly.
export const JOB_BUDGET_MS = 10 * 60 * 1000
// Hard cap on messages per run, independent of the clock — keeps one runaway run from spending an
// unbounded amount on LLM calls before a human sees the cost.
export const JOB_MAX_MESSAGES = 60

// ---- background mode: how often the OPEN PAGE asks for a run ---------------------------------
export const DEFAULT_FOREGROUND_POLL_MIN = 5
// How often a page re-reads the run lock + last-run summary to paint the background status strip.
export const STATUS_POLL_MS = 10 * 1000
// Background mode OFF: the dashboard prompts for a manual check once mail is at least this stale.
export const STALE_MAIL_PROMPT_MS = 30 * 60 * 1000

// ---- AI AGENTS -----------------------------------------------------------------------------
// The agent's display name per provider — the name-only team member on every work item. New
// providers (a ChatGPT-based agent, an IDE assistant…) add ONE row here and nothing else in the
// app names an agent. It lives in config, not in workSource, because the UI needs it too: the
// account picker names the AGENT rather than a mail address, and importing the whole InputSource
// into every page just to read two strings would be absurd.
export const AGENT_NAMES = { claude_code: 'Claude Code', codex: 'Codex' }
export const agentNameFor = (provider) => AGENT_NAMES[provider] || 'AI agent'
// The agent name for an ACCOUNT record: the stored name when formation has written one, else
// derived from the provider it stored. Older records have neither, and fall back to the generic.
export const agentNameOfAccount = (a) => (a && a.agent_name) || agentNameFor(a && a.provider)

// ---- ENVIRONMENTAL FAILURES ---------------------------------------------------------------------
// A failure that says nothing about the MESSAGE: the local connector was busy, a provider rate
// limit, the network, exhausted credit. Such a failure still stops the run (see processor.js) but
// must NOT count toward MAX_ANALYSIS_ATTEMPTS — on 2026-09-12 a single-slot local connector held
// by one long call turned every later message into an instant "busy", three page-triggered runs
// in four minutes burnt the cap, and nine agent turns were retired for good. The page also waits
// ENVIRONMENTAL_BACKOFF_MS before re-firing after one of these, instead of immediately.
export const ENVIRONMENTAL_FAILURE_RE = /busy with another request|rate.?limit|\b429\b|overloaded|\b529\b|too many requests|capacity|credit balance|insufficient_quota|ECONNREFUSED|ECONNRESET|ENOTFOUND|network|fetch failed|token.?expired|sign-?in expired/i
export const isEnvironmentalFailure = (msg) => ENVIRONMENTAL_FAILURE_RE.test(String(msg || ''))
export const ENVIRONMENTAL_BACKOFF_MS = 90 * 1000

// ---- the pending-queue scan (2026-10-04; pipeline-backlog "Stranded pending agent turns") ---------
// Queue-backed sources (agent turns, Slack chunks) find their pending items by paging the `inputs`
// collection newest-first (the one indexed sort) until the page's oldest record is older than a
// FLOOR. The floor is the watermark of the last run that scanned to its floor AND drained its queue
// (nothing pending can be older), never further back than this age — a pending item older than a
// month is stale by any reading, and the page count stays bounded on a big install.
export const PENDING_SCAN_MAX_AGE_MS = 30 * 24 * 3600 * 1000
// The watermark sits this far BEFORE the vouching run's start: items formed during that run have a
// later _date_modified than its start and were queued and drained, so this is pure clock-skew slack
// (tab clock vs server stamps). On a normal day the first page reaches it anyway.
export const PENDING_WATERMARK_MARGIN_MS = 60 * 60 * 1000
