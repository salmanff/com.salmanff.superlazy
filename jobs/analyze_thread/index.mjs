// index.mjs — the analyze_thread BACKGROUND JOB.
//
// freezr runs this server-side with no browser attached: either in-process on the freezr host (when
// an admin has trusted the job) or on the user's own serverless cloud. Either way `freezr` is the
// SAME client the pages use — so this handler drives the SAME ingestion pipeline the browser drives
// (ingest.js → processor.js → engine.js). There is no server-only copy of any of it.
//
// ┌─ READ THIS BEFORE EDITING ANY FILE IN THIS FOLDER ─────────────────────────────────────────┐
// │ BUMP JOB_VERSION whenever you change ANY file in jobs/analyze_thread/ — not just this one.  │
// │                                                                                            │
// │ freezr decides whether a deployed job is stale by hashing index.mjs + package.json +        │
// │ package-lock.json ONLY (cloudJobSource.loadJobIdentitySource). Sibling modules are invisible │
// │ to that hash, and the local runner likewise cache-busts its dynamic import on index.mjs's    │
// │ mtime alone. So editing engine.js or ingest.js WITHOUT touching this file leaves the old     │
// │ code running — silently, with no error anywhere. Bumping the constant below changes this     │
// │ file's bytes, which is what forces the re-deploy / re-import.                                │
// │ Escape hatch if you forget: freezr.jobs.run(name, params, { redeploy: true }).               │
// └────────────────────────────────────────────────────────────────────────────────────────────┘
export const JOB_VERSION = '2026-10-11.1' // default models by tier (modelDefaults.js): analysis = sonnet / ChatGPT flagship (was haiku, whose exact-name match never hit the versioned 'haiku-4'), clean-up = opus resolved at run time (was a hard-coded Claude/opus-5)
// previous: export const JOB_VERSION = '2026-10-10.8' // pre-publish wording: clean-up prompt 0.9, generic examples folded into prompt 0.67, the Action-needed category drops one investment-specific example
// previous: export const JOB_VERSION = '2026-10-10.7' // prompt 0.67: assigning/resolving framing + short section + asker sentence (run C)
// previous: export const JOB_VERSION = '2026-10-10.7' // comment-only: work-specific examples made generic (supplier invoices) before publishing
// previous: export const JOB_VERSION = '2026-10-10.6' // prompt.js COMMENTS only (spec links repointed, case label renamed); SYSTEM_PROMPT byte-identical, PROMPT_VERSION stays 0.66
// previous: export const JOB_VERSION = '2026-10-10.5' // clean-up prompt 0.8 (the EVIDENCE example names "The law firm", not a real firm); one stale spec cite in persist.js
// previous: export const JOB_VERSION = '2026-10-10.4' // comment-only: spec citations repointed after the specs consolidation (8 docs merged into the living ones); stale maintenance header paths fixed
// previous: export const JOB_VERSION = '2026-10-10.3' // comment-only: spec links repointed to specs/analysis-experiments.md after the specs archive; case labels and names anonymised
// previous: export const JOB_VERSION = '2026-10-10.2' // comment-only: analysisSchema.js header says it is live for ChatGPT (engine.schemaFor); whoMapping.js header no longer calls itself deletable on its own
// previous: export const JOB_VERSION = '2026-10-10.1' // pre-publish dead-code cut: unused exports removed from config / llmAudit / reprofiler / responsibilities / sessionDigest (no behaviour change)
// previous: export const JOB_VERSION = '2026-10-04.8' // every query sorts by { _date_modified: -1 } alone: the two-key { _date_modified, _id } sort from .5 fails on Cosmos DB ("order by query does not have a corresponding composite index"); the server-side Recent-cache cap it worked around is fixed in the server
// previous: export const JOB_VERSION = '2026-10-04.7' // thread links can shrink: a moved/merged-away to-do releases the threads only it brought (projectStore.releaseTodoThreads, tombstoned in unlinked_threads so the 3-way merge keeps the removal); reconcile's reassignment + the clean-up's move_todo/merge_project apply it; new housekeeping pass previewOrphanThreads + op unlink_threads sweeps the orphans already in the data
// previous: export const JOB_VERSION = '2026-10-04.6' // subscription prompts are never cut: containedPrompt no longer slices at 1,000; PROMPT_MAX_CHARS 3000 is a refusal threshold (intake denies with a reason); over-length records never reach the model
// previous: export const JOB_VERSION = '2026-10-04.5' // pending scan: stable two-key sort (the single-key sort is served from the server's Recent cache capped at ~100 rows — the .4 scan stopped after one page and stamped the watermark), end = empty page; accountErrors deduped
// previous: export const JOB_VERSION = '2026-10-04.4' // stranded pending items: deep pending scan to a watermark + plan() recovers pending queue items below the cursor; one failing account no longer stops the run (accountErrors)
// previous: export const JOB_VERSION = '2026-10-04.3' // lockText.js: a refused start names the lock holder, its last sign of life and when a dead holder frees the lock
// previous: export const JOB_VERSION = '2026-10-04.2' // clean-up: accounts knob (input window AND catalog scoped to the chosen accounts' projects; closing turn says so)
// previous: export const JOB_VERSION = '2026-10-04.1' // prompt 0.66: a promise made to ME becomes a they_owe_me item
// previous: export const JOB_VERSION = '2026-10-03.1' // automated-mail backstop no longer duplicates a notice the model folded into an existing item (feed row type 'absorbed')
// previous: export const JOB_VERSION = '2026-09-28.1' // project auto-priority reads each to-do's EFFECTIVE priority (the until-due hold counts)
// previous: export const JOB_VERSION = '2026-09-27.5' // config.js gains DRAFT_MAX_AGE_DAYS (UI-read; no job behaviour change)
// previous: export const JOB_VERSION = '2026-09-27.4' // reconcile retires unedited suggested replies superseded by a newer message on their thread; merge counts sent_asof
// previous: export const JOB_VERSION = '2026-09-27.3' // daily or weekly clean-up schedule (daily reads the last day)
// previous: '2026-09-27.2' — Run now takes a windowDays choice; clean-up prompt 0.7 (words, not ids, in user-facing text)
// previous: JOB_VERSION '2026-09-27.1' // the weekly clean-up runs IN the job: maintenance code moved into jobs/analyze_thread/maintenance/; `cleanup` task + the hourly auto run's schedule check (clean-up first, then mail); maxRuntime 1800s
// previous: JOB_VERSION = '2026-09-27.1' // prompt 0.65: WHO HANDLES WHAT — responsibilities move out of the person lines into their own section (cold block for the regular correspondents, volatile turn for the people on the item; assemble.renderWhoHandlesWhat) + the instruction for using it; attribution (1) 'sole addressee' yields to the list, (2) repointed; recipient list is not 'asking a named person'. Measured 8/15 vs 5/15 live.
// previous: export const JOB_VERSION = '2026-09-26.2' // prompt 0.64: profile.responsibilities is a LIST of entries (responsibilities.js), each owned by the model or the USER; a user entry is never rewritten or dropped by the inline analysis, the re-profiler or a clean-up proposal, and renders [USER-SET] in the People block; clean-up 0.6 gains responsibility-overlap candidates and the people-section job that resolves them
// previous: export const JOB_VERSION = '2026-09-26.1' // prompt 0.61: account_for verdict field (required, enforced, applied); cleanup 0.5 trail notes + fetch; parser tolerates trailing commas; INLINE REPLIES: htmlToText marks blockquotes with '> '; a stripped reply reports its dropped quoted lines and keeps full_text; inlineDiff.js compares the quoted region with the thread's earlier messages and renders the sender's inline answers under the body (ask kept as fallback); prompt 0.63 ticked-checklist indicator; stored HTML-only bodies read back as text
// previous: JOB_VERSION '2026-09-25.1' // prompt 0.60: an outcome closes its steps; account-for block widened to linked-project people + owed-by-sender; engine implicit project-detail round; reconcile citation guard
// previous: JOB_VERSION '2026-09-21.1' // prompt 0.59: plans are ONE row in ONE project while a draft and SIZED by the ruler at acceptance; explicit "later" is a to-do; goal example fixed; Claude Edit of a .md captured as a plan patch (sessionDigest.editAsDiff); "plan on record" wording holds in both phases

import { createPersistence } from './persist.js'
import { runIngestion, newJobOwnerId } from './ingest.js'
import { runUserReprofile } from './reprofileTask.js'
import { JOB_BUDGET_MS, JOB_MAX_MESSAGES, STEP_TIMEOUT_MS, CLEANUP_JOB_RUNTIME_MS, CLEANUP_DEADLINE_MS } from './config.js'
import { cleanupDue, scheduleOf, DAILY_WINDOW_DAYS } from './maintenance/cleanupSchedule.js'
import { runCleanupInJob } from './maintenance/cleanupJob.js'
import { analyzeThread } from './analyze.js'

const errMsg = (e) => (e && e.message ? e.message : String(e))

// One line the UI can show verbatim, so a page that only polls the summary can still tell the
// user what happened without re-deriving it from the numbers.
function describe (task, r) {
  if (r.skipped) return r.skipped
  // an agent store that could not be read is the one thing a "quiet" run must not hide
  const formNote = ((r.formErrors && r.formErrors.length)
    ? ' ⚠ Agent store not read — ' + r.formErrors.map(e => e.account_id + ': ' + e.message).join(' | ')
    : '') +
    // an account the run could not list (expired token) — the others WERE checked, so say which one was not
    ((r.accountErrors && r.accountErrors.length)
      ? ' ⚠ Not checked — ' + r.accountErrors.map(e => e.account_id + ': ' + e.message).join(' | ')
      : '')
  if (!r.planned) return 'No new mail.' + formNote
  const label = 'new message(s)'
  const head = r.processed + ' of ' + r.planned + ' ' + label +
    (r.retried ? ' (' + r.retried + ' retried after an earlier failure)' : '') +
    ' processed ($' + Number(r.cost || 0).toFixed(4) + ')'
  if (r.done) return head + ' — complete.' + formNote
  // an error STOPPED the run (no LLM credit, mail token expired, network gone). Say so: the run
  // looks identical to "ran out of time" from the numbers alone, but needs the user to act.
  if (r.failure) return head + ' — STOPPED: ' + (r.failure.reason || 'an error') + '. ' + r.remaining + ' left; the failed message is retried first.'
  if (r.lockLost) return head + ' — another process took over.'
  if (r.budgetHit) return head + ' — ran out of time, ' + r.remaining + ' left for the next run.'
  if (r.capHit) return head + ' — hit this run\'s message cap, ' + r.remaining + ' left for the next run.'
  return head + ' — ' + r.remaining + ' left for the next run.'
}

/**
 * @param {Object} freezr  the job-side freezr client (data, llm, connections.mail — all present)
 * @param {Object} params
 *   task: 'auto' (default — the hourly schedule passes no params) | 'newmail' — both check mail
 *         from the account cursors | 'reprofile' | 'ping' | 'analyze_message'
 *   budgetMs / maxMessages: override the defaults (tests + a caller that knows its own maxRuntime)
 */
export async function handler (freezr, params) {
  const p = params || {}
  // 'ingest_new_mail' is the name the app used before this handler existed — keep it working so an
  // older installed page against a newer job doesn't silently do nothing.
  const raw = p.task === 'ingest_new_mail' ? 'newmail' : (p.task || 'auto')
  // 'backfill' is a legacy alias — runIngestion resolves it (and 'auto') to 'newmail'
  let task = ['auto', 'newmail', 'backfill', 'reprofile', 'ping', 'analyze_message', 'cleanup'].includes(raw) ? raw : 'auto'

  // A cheap "is the deployed code current?" probe — no mail, no LLM, no lock.
  if (task === 'ping') return { ok: true, task, version: JOB_VERSION, at: Date.now() }

  // The original single-message entry point, kept for debugging a prompt server-side. params
  // carries an already-rendered userMessage; nothing in the app calls this today.
  if (task === 'analyze_message') {
    const result = await analyzeThread(freezr, { userMessage: p.userMessage, model: p.model })
    return { ok: true, task, version: JOB_VERSION, output: result.output, meta: result.meta, prompt_version: result.prompt_version }
  }

  const persist = createPersistence(freezr)
  const startedAt = Date.now()

  // User-requested profile update, run server-side so a page refresh can't kill it. The result is
  // fully persisted by the task itself (profile + history archive + feed event); this stamp is
  // only how the requesting page LEARNS the outcome (it polls settings.bg_last_reprofile — the
  // POST /jobs/run response is unusable for the same reason as ingestion's, see below). Its own
  // settings field, NOT bg_last_run: overwriting an ingestion summary would erase a pending
  // more_pending flag the pages' pollers still need to see.
  // No run lock: a reprofile touches one profile record, not the mail cursors — the worst race
  // with a live ingestion run is a last-write-wins on that one record.
  if (task === 'reprofile') {
    let res = null
    let fail = null
    try {
      res = await runUserReprofile({ freezr, persist, address: p.address })
    } catch (e) {
      fail = e
    }
    const summary = {
      at: startedAt,
      finished_at: Date.now(),
      task,
      version: JOB_VERSION,
      address: String(p.address || '').toLowerCase(),
      ok: !fail && !!(res && res.ok),
      outcome: fail ? 'error' : ((res && res.outcome) || 'error'),
      reason: fail ? errMsg(fail) : ((res && res.reason) || null),
      cost: (res && res.cost) || 0,
      token_expired: !!(fail && fail.tokenExpired)
    }
    await persist.stampSettingsFields({ bg_last_reprofile: summary }).catch(() => {})
    return summary
  }

  // THE WEEKLY CLEAN-UP (2026-09-27). An explicit `cleanup` task (a page asking for it, optionally
  // for one project) runs it and returns. The hourly `auto` run checks the schedule
  // (cleanupSchedule.cleanupDue: the user's day/hour in their timezone, once per slot) and, when due,
  // runs the clean-up FIRST and then the mail check below with the time that is left (user: both,
  // not instead). Both take the one shared run lock, so neither ever runs under the other.
  let cleanup = null
  let mailBudgetMs = Number(p.budgetMs) > 0 ? Number(p.budgetMs) : JOB_BUDGET_MS
  if (task === 'cleanup' || task === 'auto') {
    // an explicit weekly `cleanup` (a page with background mode off asking) re-checks the schedule too,
    // so two tabs asking at once run it once; `force` or a projectId skips the check
    const scheduled = task === 'auto' || (task === 'cleanup' && !p.projectId && !p.force)
    const settings0 = scheduled ? await persist.readSettings().catch(() => null) : null
    const due = scheduled ? cleanupDue(settings0 || {}) : { due: true, slot: null }
    if (task === 'cleanup' && !due.due) return { ok: true, task, version: JOB_VERSION, skipped: due.reason }
    if (due.due) {
      cleanup = await runCleanupInJob({ freezr, persist, slot: due.slot, projectId: task === 'cleanup' ? (p.projectId || null) : null, windowDays: (task === 'cleanup' && Number(p.windowDays)) ? Number(p.windowDays) : (scheduled && scheduleOf(settings0 || {}).frequency === 'daily' ? DAILY_WINDOW_DAYS : null), deadlineMs: startedAt + CLEANUP_DEADLINE_MS })
      if (task === 'cleanup') return { ok: cleanup.ok, task, version: JOB_VERSION, cleanup }
      // the mail check gets the rest of the run, with the same headroom rule as config.js states
      const left = CLEANUP_JOB_RUNTIME_MS - (Date.now() - startedAt) - STEP_TIMEOUT_MS - 60e3
      mailBudgetMs = Math.min(mailBudgetMs, Math.max(0, left))
    }
  }

  const owner = newJobOwnerId()
  let result = null
  let failure = null

  if (mailBudgetMs < 60e3) {
    // the clean-up used the run: the next hourly tick checks the mail
    result = { task: 'newmail', skipped: 'the weekly clean-up used this run — mail is checked on the next tick', planned: 0, processed: 0, remaining: 0, done: true }
  } else try {
    result = await runIngestion({
      freezr,
      persist,
      owner,
      task,
      threadContextDays: p.threadContextDays != null ? p.threadContextDays : null,
      eager: p.eager === true, // page-initiated runs skip the chat debounce; scheduled runs keep it
      manual: p.manual === true, // the user PRESSED the button (mode on): agent turns still in progress are analysed too
      // The budget is what keeps the run inside maxRuntime so the `finally` in runIngestion
      // actually runs and RELEASES THE RUN LOCK. See config.js for the invariant.
      budgetMs: mailBudgetMs,
      maxMessages: Number(p.maxMessages) > 0 ? Number(p.maxMessages) : JOB_MAX_MESSAGES
    })
  } catch (e) {
    failure = e
  }

  if (result && result.task) task = result.task // 'auto' resolved to what actually ran

  const summary = {
    at: startedAt,
    finished_at: Date.now(),
    task,
    version: JOB_VERSION,
    ok: !failure,
    planned: (result && result.planned) || 0,
    retried: (result && result.retried) || 0,
    processed: (result && result.processed) || 0,
    notes_drained: (result && result.notesDrained) || 0, // pending notes analysed at the run tail
    form_errors: (result && result.formErrors) || [],    // [{ account_id, message }] agent stores that could not be read
    account_errors: (result && result.accountErrors) || [], // [{ account_id, channel, message, token_expired, reauth_url }] accounts not listed this run — the others were processed
    stranded: (result && result.stranded) || 0,          // pending queue items recovered from below the cursor this run
    remaining: (result && result.remaining) || 0,
    cost: (result && result.cost) || 0,
    // an analysis failure is a normal OUTCOME of a run (ingest.js returns it rather than throwing),
    // so it travels here as data — the pages poll this record to learn why a run stopped early
    failure: (result && result.failure) || null,
    // 'skipped' is NOT a failure: the commonest reason is that a tab or an earlier run already
    // holds the lock, which is the coordination working exactly as intended.
    skipped: (result && result.skipped) || null,
    // remaining > 0 tells an open page to fire another run immediately instead of waiting an hour
    more_pending: !!(result && !result.done && result.remaining > 0),
    token_expired: !!(failure && failure.tokenExpired),
    cleanup: cleanup ? { ok: cleanup.ok, run_id: cleanup.run_id || null, cost: cleanup.cost || 0, error: cleanup.error || null } : null,
    error: failure ? errMsg(failure) : null,
    message: failure ? errMsg(failure) : describe(task, result || {})
  }

  // Best-effort status write-back. This record is how EVERY page learns what a run it did not
  // watch actually did — freezr's POST /jobs/run blocks for the whole run, so pages fire runs
  // without awaiting them and read the outcome from here instead.
  await persist.stampBackgroundRun(summary).catch(() => {})

  // Rethrow real failures so the freezr scheduler counts them (and auto-disables a job that is
  // failing every hour). Two deliberate exceptions report "ok" instead of throwing:
  //  - a SKIPPED run (someone else held the lock) — the coordination working as intended;
  //  - an EXPIRED MAIL TOKEN — a user-fixable condition, not a code failure. Rethrowing it would
  //    let five overnight failures auto-disable the schedule, so the job would STAY dead after
  //    the user reconnected their mailbox. Reporting ok keeps the schedule alive; the failure is
  //    fully visible via the bg_last_run stamp (token_expired) and clears itself on the first
  //    successful run after reconnection.
  if (failure && !failure.tokenExpired) throw failure

  return summary
}

export default { handler, JOB_VERSION }
