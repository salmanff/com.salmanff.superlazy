# Pipeline walkthrough — the spec

What the mail-analysis pipeline actually does, traced from the code with `file:line`
references. **This document is a living spec**: Parts 1–3 describe current behavior and are
updated whenever the code changes. Everything actionable — known issues, simplification
candidates, and future TODOs — lives in `specs/pipeline-backlog.md`, together with a dated
log of resolved items.

**Current: `PROMPT_VERSION` 0.66, `JOB_VERSION` 2026-10-10.3.** Code references were re-pointed
2026-10-10 after the file re-org (browser code in `pages/`, `labs/`, `shared/`; engine and job in
`jobs/analyze_thread/`; the clean-up in `jobs/analyze_thread/maintenance/`) — **line numbers are
approximate** except in the passages marked *verified 2026-10-10* (batching in §5, the rules
engine in §5a, staleness tiers in §6, the BRIEF merge in §9, and the merged rationale in Part 3),
which were checked against the code that day. Earlier passes: full verification 2026-08-17
(commit `8b74978`), the channel work 2026-08-22, §6 and the tunables registry 2026-09-20.

This document absorbed three older specs on 2026-10-10 — the core-algorithm doc, the
batching/caching/tiers doc and the rules-engine doc. Their mechanics now live in §5, §5a, §6 and
§8; their reasoning in Part 3, "Why the analysis contract is shaped this way", "Why batching, a
cached catalog and staleness tiers" and "Standing instructions and workflows — two mechanisms, on
purpose".

**Prompt history, condensed** (the full changelog is the header comment of
`jobs/analyze_thread/prompt.js`):
- **0.29–0.38** — a channel-neutral core plus one channel guide per input: email (0.29), notes
  (0.30), messages / Slack (0.32–0.35), work / AI-agent sessions (0.36–0.38). 0.31 added flat
  `- [ ]` checklist lines inside a description (invariant 6 carries them over verbatim; the UI
  ticks them via `shared/subTasks.js`; deliberately no reconcile-side guard).
- **0.39–0.47** — "Open items to account for" becomes a core rule; the work-channel guide is
  tuned; 0.47 groups the requirements of one process into one outcome to-do with checklist lines.
- **0.53–0.56** — one `who` list replaces four who-fields (`whoMapping.js`); five mechanisms nothing
  read were removed (`confidence`, `fit_concerns`, `project_drift`, `manual_locked`, the
  mailbox-actions section); one name, *standing instructions*, with the ALL-mail ones cached and
  `rules_applied` measuring them; `to:` recipients get full profiles; the closing
  standing-instruction reminder. Evidence: `specs/analysis-experiments.md`.
- **0.57–0.66** — the goal as the granularity ruler; an outcome closes its steps (0.60); the
  required `account_for` verdict list (0.61); responsibilities as a list the user can own a line
  of, rendered as "Who handles what" (0.64–0.65); a promise made to the user becomes a
  `they_owe_me` item (0.66).

The UI says "to-do" everywhere; code identifiers still say "task". The pipeline ingests mail
(the main walkthrough), manual NOTES (§13), Slack chunks (§14) and agent work turns (§15); the
channel architecture lives in `specs/superlazy-inputs.md` (the reset checklist is in the backlog). Offline
suites: `test/verifyBatch.mjs` (mail, batching, tiers), `test/verifyNotes.mjs` (notes + the
id-adoption guards).

- **Part 1** walks through one new-mail check, step by step.
- **Part 2** is the tunables registry — every arbitrary constant, where it lives, how to change it.
- **Part 3** records settled decisions, so they are not reopened by accident.

> Operational note: `manifest.json` must never be rewritten by a JSON round-trip — it uses a
> compact style (flat objects/arrays inline). Edit it textually. A round-trip produces a
> 1000-line diff.

---

## Part 1 — One new-mail check, start to finish

### 1. How a run starts

The "Check Mail" button exists on the pages that mount `mailTools` (Dashboard, Events,
People, Recent). What it does depends on whether background jobs are available:

1. **Background job (when available).** The button calls
   `freezr.jobs.run('analyze_thread', …)` (`newMail.js:39` `startBackgroundRun`, invoked via
   `backgroundMode.js:166` → `mailTools.js:181`). It is fire-and-forget: only a rejection
   within 4 seconds counts as failure (`START_CONFIRM_MS`, `newMail.js:25`, race at
   `:44-52`); after that the browser learns the outcome by polling the run lock and
   `settings.bg_last_run`.
2. **Foreground (no background capability).** The same pipeline runs in the page
   (`runNewMailCheck`, `newMail.js:65-81`), allowed only on the Dashboard (`index.js:307`
   sets `allowInTab`; gate at `mailTools.js:274-279`), behind a keep-open modal. The setup
   page has its own in-tab entry ("Force resync", `setup.js:649`, `force: true`).
3. **On-demand reprofile** from the People page — a separate task, covered in step 11.
4. **The Inspect page** — a client-side driver with deferred persistence, covered in
   step 12. It is not a job task.

The job entry point is `jobs/analyze_thread/index.mjs`. Its `JOB_VERSION` constant must be
bumped on any `jobs/` edit to force a re-deploy. It accepts six task names —
`auto` / `newmail` / `backfill` / `reprofile` / `ping` / `analyze_message`
(`index.mjs:61`; `ingest_new_mail` is remapped to `newmail` at `:59`; anything unknown
silently becomes `auto`). `auto` and `backfill` both resolve to `newmail` (`ingest.js:200`)
— `backfill` survives only as a legacy alias, and `analyze_message` has no caller (backlog).
The run budget is **10 minutes and 60 messages** (`JOB_BUDGET_MS` `config.js:62`,
`JOB_MAX_MESSAGES` `config.js:65`), inside the job's 900s `maxRuntime` (`config.js:55`,
mirrored in `manifest.json`). `index.mjs:167` deliberately does not rethrow on
`tokenExpired` — the summary carries it instead.

### 2. Lock

Before any mail is fetched or money spent, the run takes a single shared lock record
(`ingestion_lock` in the `locks` collection, `persist.js:333-394`; acquired at
`ingest.js:212-214`). A lock older than 5 minutes (`LOCK_STALE_MS`, `config.js:39`) can be
taken over; the takeover deletes, recreates, waits 2 seconds, and re-verifies
(`persist.js:367-376`). If someone else holds it, the run returns "mail is being processed
elsewhere" and stops.

The lock is renewed on every "beat" — the beat set is `step | step_error | skipped |
msg_start | fetch | building_style | llm_waiting | batch_split | message_abandoned |
batch_formed` (`ingest.js:331-339`) — and released in a `finally` (`ingest.js:440-443`).
During a long LLM call an `llm_waiting` heartbeat fires every 30 seconds
(`engine.js:486-490`), which both narrates progress to the UI and keeps the lock alive.

Two deliberate non-lockers: the on-demand **reprofile task** takes no lock — documented as
intentional, it touches one profile record, not the mail cursors (`index.mjs:82-83`) — and
the **Inspect page** never touches the lock so it can never block or be blocked
(`inspectRunner.js:12-14`; the user coordinates manually).

*Known gap (backlog): a takeover mid-message can duplicate the interrupted run's side
events, because side events have random ids.*

### 3. Deciding what to process (the cursor)

Every stored account is planned (`ingest.js` `resolveAccounts`) — there is no
backfill-vs-newmail selection anymore. The one filter is the user's **pause**: an account
whose record carries `sync_paused: true` (Setup → Status → "Pause syncing", 2026-09-07) is
dropped before the source is built and before planning, so it is not even polled; its cursor
stands still and resuming continues from it. When every account is paused the run returns
`skipped: '… paused — resume it on the Setup page …'` instead of planning nothing. `processor.plan()` (`processor.js:90-185`) builds
the queue:

1. **Probe.** Fetch the newest 50 envelopes to find the "anchor" — the date of the newest
   message (`processor.js:97-99`, wrapped in `withTimeout(…, STEP_TIMEOUT_MS)`).
2. **Window.** `backfillStart = min(stored backfill_from)`, or `anchor − history_days`
   (default 6 days) when nothing is stored. Then, the fix that keeps runs O(new mail):
   `windowStartMs = cursorMin > 0 ? max(cursorMin − RETRY_OVERLAP_MS, backfillStart) :
   backfillStart` (`processor.js:100-110`), where `cursorMin` is the minimum account cursor
   and `RETRY_OVERLAP_MS` is 1 day (`processor.js:12`). So a steady-state run lists from
   **cursor − 1 day**; `backfill_from` survives only as the floor and the cursor-0 fallback.
3. **Fetch.** List up to **2500 envelopes** in that window (`processor.js:115`, with an
   `onScan` progress callback). Under the hood (`liveMailSource.js:95-134`) that is
   `searchMessages` (a `since` is set), paged 100 at a time (`PAGE`, `:12`), max 25 pages
   (`MAX_PAGES`, `:19`), 75-second deadline (`FETCH_DEADLINE_MS`, `:23`), **per
   connection**. Hitting the ceiling surfaces as `plan.truncated` (`processor.js:182`).
4. **Cursor filter.** Keep envelopes with `date >= account.cursor`
   (`processor.js:117-123`). The `>=` is deliberate: a sibling message sharing the cursor's
   exact millisecond gets re-included here and de-duplicated in the next step.
5. **Already-done filter with a retry cap.** One `msgAnalysisStatus` query over the window
   (`persist.js:202-221`, chunks of 100 ids) splits into `done` (dropped) and `errored`.
   Errored messages are re-queued **at the head of the queue** — unless their recorded
   `attempts` have reached `MAX_ANALYSIS_ATTEMPTS = 3` (`processor.js:14,134-145`), in which
   case they are dropped with a console warning naming the count. The attempt counter rides
   on the message's idempotent error event (`processor.js:564-577`), not the account record.
5b. **Stranded queue items (2026-10-04).** For the channels whose envelopes ARE a pending
   `inputs` record (agent turns `work`, Slack chunks `messages` — `QUEUE_CHANNELS` in
   `processor.js`) "pending" is the truth and the cursor is only an optimisation. A pending
   item BELOW the cursor with no analysis event is therefore not "handled", it is **stranded**,
   and is queued at the head like a retry (`strandedCount` on the plan). Two real ways in: the
   pending scan lost sight of it during a mail burst and a newer turn moved the cursor past it;
   or it was formed late — a long agent turn is dated by its prompt, and a shorter turn in
   another session, prompted later but finished first, had already advanced the cursor. Queue-
   channel envelopes are also exempt from the date-window cut for the same reason.
6. The queue is sorted oldest-first (`t.queue = [...retry, ...revised, ...stranded, ...fresh]`).
   If it's empty the run ends (`ingest.js`).

**How the queue-backed sources find their pending items (2026-10-04).** `workSource` and
`slackSource` read them through `pendingScan.js` → `persist.scanPendingInputs`: the `inputs`
collection paged newest-first on `_date_modified` (the one indexed sort), 300 a page, until the
page's oldest record is older than the **floor**. `ingest.js` sets the floor to
`max(settings.pending_scan_watermark, now − PENDING_SCAN_MAX_AGE_MS)`; the watermark is the start
(minus `PENDING_WATERMARK_MARGIN_MS`) of the last UNSCOPED run whose scan reached its floor and
whose queue drained with nothing stopping it early — nothing pending can be older. On a normal day
the first page reaches the watermark (same cost as before); during a backlog a few more pages;
no watermark yet = the whole age-bounded collection once. The old `persist.pendingInputs`
(newest 300, no completeness claim) remains for labs/Inspect. All of these sort
`{ _date_modified: -1, _id: -1 }` (`persist.NEWEST_FIRST`): the single-key sort can be answered from
the server's Recent cache with ~100 rows regardless of `count`/`skip` (backlog "Fetching / cursor"),
and the end of a collection is an EMPTY page, never a short one. "Force resync" on the Setup page
passes `rescan: true`, which ignores the watermark — the manual safety net. Why: a four-day mail
backlog wrote 339 body records in one night and pushed 21 pending agent turns past rank 300, where
nothing could ever queue them again.

**One failing account no longer stops the run (2026-10-04).** `liveMailSource.fetchAllRows`
lists each connection in its own try/catch and records failures (`accountErrors()`: account_id,
message, `token_expired`, `reauth_url`); the composite merges children with `allSettled` and
records a rejected child per account. Only when EVERY connection / child fails is the error
thrown (a single-mailbox install keeps its plain failure). `plan()` keeps failed accounts out of
`cursorMin`/`backfillStart` (a dead account's stale cursor would otherwise drag every run's window
back) and out of the account seeding (nothing stamps them trained or moves their cursor); the run
result and the job summary carry `accountErrors` / `account_errors`, which the processing notice
shows with a Reconnect link. In a page the mail guard no longer redirects on a LISTING failure.

**The cursor is a millisecond receive-date, not a Gmail history token.** It is advanced
after *every* handled envelope — success, skip, or abandoned failure alike (`bumpAccount`,
`processor.js:188-201`) — and saved immediately. One exception: a **stopping** failure
throws before `bumpAccount` runs, so that message's cursor is not advanced
(`processor.js:588-597`). When the queue drains, `bumpAccount` flips
`backfill_done: true` / `status: 'trained'` (`processor.js:199`) — the last vestige of the
removed backfill task, along with the `backfill_from` seed on new account records
(`processor.js:166-167`).

**Drafts are never analysed** — three layers: dropped at fetch (`liveMailSource.js:151-165`
with `draftMarkers` `:324-336`), excluded from loaded threads (`:222`), and skipped
defensively in the processor with a `kind:'skipped'` event so they are never re-planned
(`processor.js:279-291`; `normalize.js:27` sets `is_draft`). A message analysed after being
sent has a different provider id, so it is processed normally.

(`liveMailSource.js:451-462` still carries an unused `getNewer()` date-cursor shim; the
provider-native history-token cursor remains unadopted — backlog.)

### 4. Per-run one-time setup

Before the message loop:

- **One prefs mapper.** `sessionPrefsFrom(settings)` (`ingest.js:44-73`) is the single
  exported mapping from the settings record to session prefs, shared with the Inspect page
  (`inspectRunner.js:55`). It exists because a second hand-rolled copy is exactly how
  `business_context` once silently dropped out of the prompt. It carries
  `business_context`, `analysis_thinking`, `analysis_effort`, `analysis_max_tokens`,
  `analysis_fetch_rounds`, `snapshot_refresh_messages`, `snapshot_max_age_hours`,
  `suggest_replies`, staleness policy, and the cache flags.
- **Writing-style guide.** If `settings.style_guide` is fresher than
  `style_guide_refresh_days` (default 30) it is reused; freshness keys on
  `style_guide != null`, so an **empty** guide (sent-less mailbox) is cached too instead of
  re-asking every run (`ingest.js:296-304`). Otherwise one LLM call builds it from up to 8
  sent-mail samples (`userStyle.js:12-27`, `max_tokens: 500`, thinking off; samples from
  the Sent folder by id with a `from:` search fallback, min 20 chars, capped at 1200,
  `liveMailSource.js:350-400`).
- **Pinned catalog snapshot.** `adoptSnapshotPin` (`ingest.js:142`) loads
  `settings.snapshot_pin` into the session only if **two** stamps match: the pin's
  `prompt_version` equals the current `PROMPT_VERSION`, and its `durable_sig` equals an
  FNV-1a fingerprint over everything rendered into the cold block: `business_context`, the
  third-party app instructions, the ALL-mail standing instructions and the style guide
  (`durableSig`, `ingest.js:93`). Either mismatch rejects the pin **loudly, with the
  reason logged**. So editing the prompt text, the business context or any of those
  instructions invalidates the pin by construction. Applying clean-up proposals clears the
  pin outright (`maintenance/applyProposals.js:347`) — see Part 3 on why.
  The pin is written by the single writer pair `snapshotPinRecord` / `stampSnapshotPin` (`ingest.js:96-111,146-151`), which the Inspect page also uses. What
  the pin is *for*: keeping the snapshot byte-identical across runs, so a run doesn't
  re-render (and re-pay to cache) bytes an earlier run already cached.
- **Cache TTL is 1 hour by default.** `snapshot_1h_ttl !== false` (`ingest.js:70`) →
  `cacheOpt = { ttl: '1h' }` (`engine.js:119`). With hourly checks this gives cross-run
  cache reads a real chance (the provider cache expires by TTL after last use; the old
  5-minute default made cross-run hits essentially impossible).
- **Cache opt-out for single-message runs with no pin** (`ingest.js:284-290`): a run that
  will make exactly one LLM call and has no pinned snapshot would pay the cache-write
  premium with zero chance of a later read — pure loss — so caching is turned off for it.
- The run logs the effective batch ceiling and whether it came from a stored setting or the
  default (`ingest.js:228-232`).

### 5. The message loop

`processor.runAuto` (`processor.js:688-722`) walks the queue oldest-first, forming batches
of consecutive same-account messages.

**Batching is live and adaptive.** The ceiling is `batch_max` (Preferences "Messages per AI
call", default `DEFAULT_BATCH_MAX = 10`, `config.js:47`; choices 1/2/3/5/8/10/15/20,
`prefsTab.js:157-164`). A batch also stops growing past `BATCH_MAX_CHARS = 60,000` chars
(`config.js:49`, enforced `processor.js:292-295`). The **actual** size adapts within the
run (`processor.js:48-67`): `batchNow` starts at the ceiling, `stepDown()` halves it (floor
1) on a batch failure, split, or timeout, and `stepUp()` doubles it back (capped at the
ceiling) after `RECOVER_AFTER = 3` clean multi-message batches. Batch timeouts scale +60s
per extra message (`processor.js:219-224`). A failed batch **splits and retries its
messages one by one** — on *any* failure, not just "too much at once"
(`processor.js:358-375`) — and a missing-entry safety net re-runs any message the model's
batch reply omitted (`processor.js:379-391`).

**The batch contract** (*verified 2026-10-10*). A batch is consecutive queued envelopes of ONE
`account_id` (`runAuto`, `processor.js:688`; the Inspect stepper applies the same cut,
`:745`) — a leftover of the per-account catalog snapshot the batching design started with (the
comment at `processor.js:695` still says so; there is one snapshot today, §7). Every message in
a batch is judged against the same store state — nothing is reconciled until
the reply is back. With more than one message the reply is `{ "message_results": [ … ] }`, one
entry per message in the given order, each a self-contained delta **relative to the state after
the previous entry** (a later message may resolve what an earlier one created), and a message
that changes nothing still gets an entry with its `message_summary`. tmp_ids are scoped to the
whole reply, never per entry: a later entry cites an earlier entry's creation by its tmp_id
instead of re-creating it. With one message the shape is the plain analysis, no wrapper.
`reconcile` then runs once per entry, in order, with the tmp→minted maps SHARED across the
batch (`batchTmpTodo` / `batchTmpProj`, `engine.js:901-938`) — a re-emitted `new: true` with an
already-minted tmp_id resolves to the same item, the defence against the duplication bug that
entry-scoped tmp_ids caused. Each message still gets its own event; the call's analysis cost
is apportioned across them by rendered body size (`engine.js:882-914`) and each event carries
`via_batch` + `batch_size` (`engine.js:1017`). `batch_max: 1` reproduces single-message
behaviour exactly — the kill switch.

For each message (or batch), `engine.processBatch` (`engine.js:546`) does:

**5a. Standing instructions, workflows, and the free short-circuit** (*verified 2026-10-10*).
For every message — short-circuited or not — `session.profiles.recordMessage(...)` runs first
(`engine.js:618`), so interaction statistics are never blind. Then `rulesEngine.preAnalyze`
(`rulesEngine.js:18-50`) does, in this order:

1. **Gather the standing instructions that match** — `instructionStore.matching(sender,
   accountId)` (`instructionStore.js:52-62`): every `active` record with `scope: 'all'`, or
   `sender` equal to the lowercased address, or `domain` equal to the sender's `@domain`, or
   `account` equal to the account the message arrived on. Exact string comparison only; every
   semantic nuance ("about the merger") is the model's job. The result is split in two lists:
   `allMailInstructions` (ride in the cached cold block, §6) and `userInstructions` (the rest,
   ride in this message's volatile block). Records, not text, so each renders with its
   `[i_xx]` id.
2. **Collect the third-party app instructions** — `workflows.workflowInstructions()`
   (`workflows.js:505`): each registry entry's `prompt_instruction` plus one detector line per
   approved app subscription (sorted, so the cold block stays byte-stable).
3. **Decide whether the LLM can be skipped.** A short-circuit is the LAST resort: it is
   considered only when no `sender`- or `domain`-scoped instruction matched and the
   inter-app subscription prefilter did not hit (`subscriptionsCore.subscriptionPrefilterHit`
   — invoices come from exactly the machine senders that short-circuit). `account` and `all`
   instructions do NOT block: they are generic guidance, and letting one force every
   auto-filed newsletter through the LLM would silently defeat auto-processing. Then the
   workflows that have a `shortCircuit` are tried in descending `priority`; the first that
   returns a result wins.

Today the only `shortCircuit` is the `automated` workflow's (`workflows.js:357`): the sender's
profile carries an active `file_to_project` auto-process and `automated_autopilot` is on. The
message is then filed straight into the learned project (or the category's standing bucket) as
a read-only to-do — **zero LLM cost**. There is no straddle guard any more: once a sender
carries the action, their mail files deterministically. Two advisory signals ride on the
result instead of blocking: `doubt` (the address does not look machine-shaped —
`autopilotVeto`, skipped for `locked` or `source: 'bootstrap'` entries) and `mismatch` (the mail
system's own category label disagrees, compared by category family).
`autoprocessDiagnostic` (`workflows.js:127`) names the gate that blocked an auto-process and
rides on the event. A short-circuited message gets no reconcile and no reprofile check (early
`continue`, `engine.js:643`); it counts toward the snapshot budget (`noteProcessedForSnapshot`,
`engine.js:641`) but is deliberately **not** snapshot-touched (`engine.js:626-628`).

Every message that was NOT short-circuited becomes an entry of the one batched call (§6). After
its reconcile (§9), triggers are handled in a fixed order (`engine.js:983-988`): the model's
`triggers[]`, plus any `automated` trigger `inferAutomatedTriggers` synthesises from filing
behaviour; then `backstopAutomatedItem` (which must run before dispatch so `onTrigger` can anchor
to the item); then `rulesEngine.dispatchTriggers` (`rulesEngine.js:56-70`) calls each entry's
`WORKFLOWS[type].onTrigger`. The registry shape and the trigger contract are in §10.

**5b. Thread load and body cleanup.** `ensureThread` (`engine.js:165-177`) loads the whole
thread once per run: filter the envelope cache by thread id; if nothing is cached, fall
back to an unwindowed newest-500 fetch (`liveMailSource.js:200-203`); fetch each body
serially. (`loadThreadRaw` still downloads every body in the thread even though only 1–2
get inlined — lazy fetch is on the backlog.)

Every body then goes through `normalizeMessage` (`normalize.js:11-37`):

1. Prefer the plain-text part; only if absent, convert HTML to text
   (`htmlToText.js` — DOM-based in the browser, regex-based in a job).
2. `prepBody` (`replyStrip.js:87-119`) decides how much of the body to keep:
   - **Forward** (subject `Fwd:` or "forwarded message" marker, `:11-16`) → keep the whole
     body, mark `body_mode: 'whole'`.
   - Otherwise find the first **quote header** ("On … wrote:", "-----Original
     Message-----", French/Spanish/German variants, or an Outlook-style
     `From:`/`Sent:`/`To:` block, `:26-48`) and cut there.
   - **Interleaved reply** — if ≥ 40 chars of fresh text appear *below* quoted lines, keep
     the whole body (the user commented inline) (`:106`).
   - Otherwise drop quoted lines: `body_mode: 'stripped'`.
3. `trimFooters` (`replyStrip.js:71-85`) cuts legal boilerplate / unsubscribe footers, but
   only if the cut point is past 40% of the text (`FOOTER_TAIL_SHARE`, `:69`) and at least
   120 chars survive (`FOOTER_MIN_HEAD`, `:68`).

### 6. Building the LLM request

One request is **three user turns on top of the system prompt**. The first two are cached; the
third changes every call.

```
system prompt            prompt.js  (PROMPT_VERSION 0.66, ~68k chars)   fixed, never re-rendered
turn 1  COLD block       assemble.renderCatalogSnapshot:855             cached, re-rendered weekly
turn 2  HOT block        assemble.renderCatalogSnapshot:855             cached, re-rendered on thresholds
turn 3  VOLATILE block   assemble.assemble:940                          uncached, built per call
```

The two cached turns are sent by `engine.js:662`
(`priorTurns = [durableTurn(snap.cold.text), durableTurn(snap.text)]`). Despite the name,
`session.snapshot.text` holds the **hot block only** — `engine.js:167` overwrites the combined
text returned by the renderer with `r.hot.text`. `durableTurn` (`engine.js:208`) is what attaches
the `cache_control` marker; with caching off it degrades to a plain string turn.

**Why the cold/hot split (2026-09-13).** One durable turn meant every catalog re-render rewrote
all ~85 rows. Splitting it lets a few recently-active rows re-render on the message thresholds
while the quiet majority sits still for a week.

**What it took to actually deliver that (2026-09-19).** The first membership rule — hot = "active
within 7 days" — put 67 of 117 projects in the frequently-rewritten block and 50 in the weekly one,
the opposite of the intent. The rule now lives in `selection.js` and is measured; sizes in
practice, on the live catalog: **cold ~74k chars / 89 projects + 20 profiles, hot ~17k / 28
projects, volatile ~27k**. The prefix total is unchanged by where the split falls — only the
re-write cost moves, which is the whole point (see Part 2).

---

#### The COLD block — turn 1

Everything here is slow-moving. Re-rendered only when it ages out (`SNAPSHOT_COLD_MAX_AGE_HOURS`,
168h, `engine.js:63`) or when the pin is discarded because the rules or business context changed.
Assembled in `renderCatalogSnapshot` (`assemble.js:855`), in this order:

| # | item | source |
|---|---|---|
| 1 | **The user's situation** — durable background, treated as established fact | `settings.business_context` |
| 2 | **Standing instructions** — one heading over two sub-lists: **standing instructions from the user** scoped to ALL mail, each shown with its `[i_xx]` id, and **third-party app instructions** (the numbered trigger actions, including one detector line per active app subscription) | `instructions` collection where `scope === 'all'`; `workflows.workflowInstructions()` |
| 3 | **The user's writing style** | `settings.style_guide` |
| 4a | **Who handles what** (0.65) — the same 20 correspondents' responsibilities, one line per entry (`[USER-SET]` on the user's own), MOVED out of their person lines; the volatile turn carries its own list for the people rendered on the item. The prompt uses it for one decision: whose list an obligation goes on when the item does not say | `assemble.renderWhoHandlesWhat`; `profile.responsibilities` (`responsibilities.js`) |
| 4 | **The people the user deals with regularly** — the top 20 correspondents' full profiles (no longer carrying `handles:` — see 4a), whether or not they are on today's thread | `selection.coldProfileAddresses` |
| 5 | **Project catalog, part 1 of 2** — one row per project NOT in the hot set, plus the line telling the model part 2 follows | `store.catalog([])`, filtered by `selection.hotProjectIds` |

Rows are sorted by `project_id` for byte-identity. A row is `catalogRow` (name, importance, open
count, last active, people, keywords, summary clipped at 400 chars) unless the project is dormant,
which collapses to `catalogNameRow`. Cold membership is **frozen** between cold renders (`coldIds`)
so a project moving from quiet to active does not silently invalidate the cold prefix.

Everything here is covered by the pin's `durable_sig` (`ingest.durableSig`), so editing the
situation, an all-mail instruction, an app instruction or the style guide discards the pin and
costs exactly one re-render.

A cached profile can go stale, so the same override discipline that projects have applies to
people: a profile updated or re-profiled since the cold render is tracked in
`snapshot.touchedPeople` and re-sent **in full** by the volatile block until the cold block is
rendered again; everyone else in the set renders there as a one-line pointer.

#### The HOT block — turn 2

Just one item, and deliberately so.

| # | item | source |
|---|---|---|
| 1 | **Project catalog, part 2 of 2** — one row per project in the hot set: the most active over 2 business days (top 10), the most active over 7 days (top 20), and every starred one | `selection.hotProjectIds` — see the registry in Part 2 |

Re-rendered when any of these trip (`snapshotFor`, `engine.js:106`): the per-channel
message thresholds (25 emails or 100 chat turns, drawn down as a shared budget by
`noteProcessedForSnapshot`, `engine.js:83`), its own age (24h), or a cold re-render — the cold
block precedes it in the prefix, so the hot block must follow it.

#### The VOLATILE block — turn 3

Built fresh every call by `assemble()`, in exact emission order. Everything stable was moved out
in 2026-09-19: there are **no no-snapshot fallbacks left** — the volatile block used to carry a
second copy of the situation, the app instructions and the whole catalog for callers with no
snapshot, and production never has one. What is here is what genuinely varies per message.

| # | item | notes |
|---|---|---|
| 1 | **Now-line** — "Treat the current moment as …" | the batch's clock is its NEWEST message |
| 2 | **Message-handles explainer** | see "short message handles" below |
| 3 | **Batch / thread line** | batch wording when more than one message |
| 4 | **Standing instructions for THIS sender** | `instructionStore.matching(sender, accountId)` minus the `scope: 'all'` ones (those are cached); each shown with its `[i_xx]` id under the same heading the cold block uses, deduped across the batch |
| 5 | **Updates since the catalog snapshot** | current rows for projects touched since the snapshot, plus "no longer active" lines. These OVERRIDE the cached rows |
| 6 | **People on the thread(s)** | `renderPeople`, tiered by role on the message via `selection.RECIPIENT_PROFILES`: senders and every `to:` recipient FULL, the first 2 cc's of each message brief, everyone else one names-only line. Anyone whose full profile is already in the cold block gets a one-line pointer instead, unless their profile changed since. Anyone left in the names-only line can be pulled with `request_more: person_detail` |
| 7 | **Linked projects** — the editable working set | `renderLinkedProjects`, at a staleness tier: FULL or BRIEF (a linked project never drops to DORMANT — see "Staleness tiers" below). The biggest section in the request by far: median 10,349 chars, mean 20,124, max 118,481 over 346 recorded calls |
| 8 | **Channels in this request** | emitted ONLY when the batch carries a non-mail item, for byte-stability |
| 9 | **Per entry: thread index, inlined priors, the new message, and the open items to account for** | repeats once per message in the batch |
| 10 | **No-drafts note** | when reply suggestions are off for this message |
| 11 | **The standing-instruction reminder** | `assemble.instructionReminder`. The LAST thing before the closing instruction. Carries no instruction TEXT — a count, the procedure, and an index of `id — label` — so the detail stays cached and fifty instructions cost ~2.8k chars here, not a re-send. See below |
| 12 | **Closing instruction** | batch or single variant |

**Why the reminder exists (experiment 9, 2026-09-20).** Standing instructions and app subscriptions
live in the weekly cached block, ~100k characters before the message. Measured on 8 real
supplier-invoice emails, haiku acted on them for 2. With the reminder: **8 of 8**. It beat moving the
instruction text itself down next to the message (7/8, and ~8,900 chars a message instead of ~600),
and it beat re-presenting the full criteria beside the message (5/8) — more context next to the
message made things worse in both directions. The wording is PROCEDURAL ("complete your normal
analysis, then check each one … several can apply at once") rather than the emphatic "OBLIGATIONS …
a failure" first tried: the softer version held 8/8 and improved exact-subscription accuracy on both
models. The system prompt carries the matching policy — standing instructions are an ADDITIVE layer
that never replaces the analysis, and a connected app's entry is scoped matching criteria for its own
action only, not authority over anything else.

The **BE BRIEF note** was removed in the same pass. It fired only at the Low context setting and
asked the model to keep its own output short; the setting's label no longer promises it.

Item 9 expands, per message, to: the thread index (one line each: date, from, to, subject,
snippet), the replied-to parent in full, the latest message in full when the thread has forked,
the new message in full, and `renderOpenItemsToAccountFor` (`assemble.js:627`) — the block listing
open items this message bears on, each demanding a verdict.

**What a to-do row shows the model.** Since 2026-09-19 it is `who`, not the stored
owner/counterparty pair: `renderTodoLine` (`assemble.js:242`) and `renderBriefProject`
(`assemble.js:294`) both call `whoTextOf` from `whoMapping.js`, so the vocabulary the model reads
matches the single `who` field it writes back. The `MANUAL_LOCKED` marker and the standing
`drift noted: n/5` line were removed with their mechanisms in the same change.

**Reply context.** A terse reply ("yes", "approved") means nothing without what it answers, and
the answered message is not always the latest (a reply to an older message forks the thread into
a tree). Quoted history is stripped (§5b), so the pointer comes from headers instead:
`liveMailSource` resolves each message's RFC `In-Reply-To` against the thread's `Message-ID`
headers and stores OUR `msg_id` of the parent as `in_reply_to` (`liveMailSource.js:265-270`;
the provider's id and the RFC id differ, so both are kept — `message_id_header` beside
`msg_id`). The index shows `↳ replies to <handle>` per row, so forks are visible; the parent is
always inlined in full ("## The message being replied to"), and when the parent is not the
latest prior message the latest is inlined too ("## The latest message on the thread",
`assemble.js:1112-1117`). Deeper ancestors stay index rows the model can pull with
`request_more: message_body`. Cost: one extra clean body per reply (two on a fork), none for a
thread-opener.

**Staleness tiers** (*verified 2026-10-10*). How much of a project is sent is set by how long it
has been quiet, not by its size. `stalenessTierOf` (`assemble.js:341`) compares the project's
`last_active_asof` with the analysed message's own clock — so a replay of already-processed mail
(stored state newer than the message) renders everything FULL, by construction — against
`staleness_policy` (`config.js` `DEFAULT_STALENESS_DAYS = { full_days: 7, brief_days: 30 }`;
`full_days: 0` disables tiering):

| tier | quiet for | linked project (volatile block) | catalog row (cached blocks / Updates) |
|---|---|---|---|
| FULL | ≤ `full_days` | header, participants with role + role_note, open to-dos in full with evidence lines, recent closed ones, suggested replies — editable in place | `catalogRow`: id, name, importance, open count, last active, people, keywords, summary (400 chars) |
| BRIEF | ≤ `brief_days` | `renderBriefProject` (`assemble.js:368`): header, keywords, participants with role only, every OPEN to-do as one line (`todo_id · direction · short_description · who · status · importance · due`), closed ones as a count. Every open `todo_id` stays visible, so nothing gets duplicated by an unaware model | same as FULL |
| DORMANT | longer | (not reached — see below) | `catalogNameRow` (`assemble.js:457`): id, name, keywords — enough to recognise a revival |
| — | archived | — | absent: `store.catalog` lists only `status: 'active'` projects |

A project linked to a thread in the batch never renders below BRIEF (`assemble.js:978-984` maps
DORMANT to BRIEF): advancing or resolving an existing item must not cost a fetch round.
`renderDormantProject` still exists for callers without that floor, carrying the marker
`[DORMANT — request project_detail before editing]`; the prompt's tier section (`### Project
detail arrives in TIERS`) describes all three.

**What the model may change at each tier.** FULL: anything, as a delta. BRIEF: per existing to-do,
only `status`, `evidence_msg_id`, `change_reason`, `importance` and the due fields
(`due_hint` / `due_earliest` / `due_latest`); reconcile MERGES those onto the stored record and
preserves every field the model was not shown (§9). New to-dos in a BRIEF project are created
normally. Rewriting an item's content, adding items that need full context, or editing
role_notes requires `request_more: project_detail` first. DORMANT (catalog row only): nothing —
invariant 3 forbids editing a list it was not shown, so a revival means requesting the detail.
The engine tells reconcile which projects were rendered BRIEF (`briefProjectIds`,
`assemble.js:985` → `engine.js:936`).

**Short message handles (surrogate ids).** Provider message ids can run to ~140 chars
(Exchange). `createAliasMap` (`assemble.js:93-107`) mints per-request handles `m1, m2, …`
used on every index row, evidence line, reply pointer, and batch key;
`engine.translateHandles` (`engine.js:185-210`) maps the model's reply back to real ids
*before* reconcile or `resolveRequests`, dropping (and logging) handle-shaped ids that were
never minted. Nothing persisted ever contains a handle.

**Size control.** The volatile block must fit the character budget from Preferences
(40k/70k/120k/200k, default 70k — `assemble.js:29-38`) **times the number of messages in the
batch** (2026-09-13; before that one shared budget could never be met by a batch of ten). Assembly renders at level 0,
measures, and re-renders at the next level if over budget, up to level 4
(`assemble.js:718-723`). What each level controls (`LEVELS`, `assemble.js:56-62`):

| Dial | L0 → L1 → L2 → L3 → L4 |
|---|---|
| open to-do detail | full → full → brief → brief (max 40 in full) → one-line only |
| closed to-dos shown | 10 → 5 → 3 → 0 → 0 |
| suggested responses included | yes → no (dropped from level 1 on) |
| people detail | full → full → brief → brief → name-only (the *sender* always stays full) |
| thread-index rows / snippet chars | 60/120 → 50/100 → 40/80 → 25/60 → 15/0 |
| new-message body cap | 24k → 20k → 16k → 12k → 8k chars |
| prior-message body cap | 6k → 5k → 4k → 3k → 2k chars |
| catalog rows in detail (fallback path only) | ∞ → 40 → 25 → 12 → 6 |
| catalog summary chars (Updates rows) | 400 → 240 → 160 → 100 → 0 |

Bodies flagged `whole` (forwards, inline replies) get 3× the body cap (`bodyCapFor`,
`assemble.js:447`); any truncation is marked in-band (`capBodyText`, `:71-78`). Blind spot
(still): the cached snapshot is **outside** this budget — its summaries are fixed at 400
chars regardless of the setting.

**Project drift — REMOVED 2026-09-19.** The model used to return a top-level `project_drift`
score and split suggestion for any linked project with ≥ 4 open items. An audit found it had
fired 5 times ever, raised 0 alerts, and had no consumer. The field, `PROJECT_TUNING`,
`projectStore.recordDriftAssessments`, the event kind, the events-feed glyph and the inspect
panel all went together. See `specs/analysis-experiments.md` §4.

(A `projectsCitingMessages` block exists but is **diagnostic-only** — an automatic
thread-to-project link was tried and reverted because it fed an echo/cost spiral,
`assemble.js:544-554`, `projectStore.js:135`.)

### 7. Prompt caching — the actual formula

Caching is on unless `settings.llm_cache === false`; the TTL is **1 hour by default**
(`snapshot_1h_ttl !== false`), 5 minutes if opted down
(`cacheOpt = llm_cache === false ? null : (snapshot_1h_ttl ? { ttl: '1h' } : true)`,
`engine.js:119`). The cache saves money only while the cached turns stay byte-identical, so
the snapshot is **not** re-rendered per message. Correctness never depends on it being fresh:
every project reconcile touched since the render is re-sent CURRENT in the volatile "Updates"
section, which the prompt says overrides the cached row ("a project in none of them does not
exist") — so re-rendering is purely a cost policy (Part 3).

The durable turn is TWO cached user messages since 2026-09-13 (`assemble.renderCatalogSnapshot`):
a **COLD** block first — the user's situation, the standing and app instructions, the style
guide, the regular correspondents, and every active project NOT in the hot set — then a **HOT**
block — the hot set chosen by `selection.hotProjectIds` (§6). Cold membership is FROZEN between
cold renders (`coldIds`); a cold project touched later gets its current row in the volatile
"Updates" section until the next cold render. Each block carries its own `cache_control`
(system + cold + hot = 3 of the provider's 4 breakpoints), so a hot re-render writes a few dozen
rows instead of the whole catalog. There is ONE snapshot (one pin) for all accounts — the
per-account snapshot of the original batching design was never kept. The blocks are
re-rendered when (`snapshotFor`, `engine.js:106-140`):

```
cold stale = no cold block yet (incl. pin discarded: prompt_changed / rules_or_context_changed / pin_format)
          OR cold render older than 168 hours          (snapshot_cold_max_age_hours, SNAPSHOT_COLD_MAX_AGE_HOURS)
hot  stale = cold stale (the cold block precedes it)
          OR refreshLoad >= 1, where every processed message adds 1/threshold for ITS channel:
          emails (and notes)            1/50   (snapshot_refresh_messages, SNAPSHOT_REFRESH_MESSAGES)
          chat turns (Slack, AI agents) 1/100  (snapshot_refresh_chats,    SNAPSHOT_REFRESH_CHATS)
        — so 25 emails + 50 chat turns is one re-render     (engine.noteProcessedForSnapshot)
     OR render older than 24 hours                    (snapshot_max_age_hours, default SNAPSHOT_MAX_AGE_HOURS)
```

All four thresholds are Preferences-driven (`prefsTab.js`, "Re-cache the catalog after…" and
"Re-cache the quiet part after (hours)");
age is measured on the **wall clock** since the render (`renderedAt`; the analysis-clock rule was
replaced 2026-09-12 — it re-rendered on every day boundary a backlog crossed). The chat threshold
was split out 2026-09-13: the single threshold of 20 fired every second batch of ten. A third
trigger (re-render once a share of projects had been touched) was **removed deliberately**
— the reasoning is preserved in the comment block at `engine.js:43-49` and in Part 3. On
top of the formula, the pin itself is discarded whenever `PROMPT_VERSION` or `durable_sig`
changes (step 4) — so prompt edits and edits to anything in the cold block invalidate immediately.

"Touched" is now split in two (`reconcile.js:104-110,344-346`): `touched_project_ids`
(anything needing persistence) vs `snapshot_touch_ids` (material catalog-row changes only —
project metadata, or an actionable to-do created/changed). A read-only auto-filing persists
but does **not** count as snapshot-touched, so the highest-volume messages never burn cache
writes.

Between runs the rendered bytes persist as `settings.snapshot_pin` and reload next run
(step 4), so the counter (`msgs_since_render` + `refresh_load`) is cross-run ("one cache write
per ~50 emails / ~100 chat turns", not per run). A `cache_refresh` event is logged whenever the
provider reports a cache write (engine → `processor.js` `wrapped`). Its `cost` is the **write
premium only** (`engine.cacheWriteCost`: tokens written × 2x on the 1h TTL / 1.25x on 5m); the
call's remainder is apportioned across the message events, so the two ledgers add up — until
2026-09-13 both carried the whole call cost and the events feed over-reported by ~30%.
`call_cost` carries the whole call. `block` says which block(s) were written — `both` or `hot`
from the render, or a token-count estimate on a rewrite — and `cold_trigger` why the cold block
re-rendered (`first` | `age` | `prompt_changed` | `rules_or_context_changed` | `pin_format`); the
subject spells it out ("Project catalog cached — HOT block only (threshold) · hot 15 projects /
9k chars, cold 69 / 40k"). `trigger` is the hot render's reason (`first` | `threshold` | `age` |
`cold`), or **`rewrite`** when bytes the provider had already cached were written again — its
entry expired (a run landing past the 1h TTL; a cache READ refreshes the timer, so runs ≤55 min
apart never expire it) or something ahead of the catalog in the prefix changed (system prompt,
model).

**Verifying the caching works** is a query, not new instrumentation: every message event
stores the split cache traffic (`spend.cacheRead` / `spend.cacheWrite`,
`engine.js:362-365,704-712`), the reply log warns when caching was requested but no cache
traffic came back (`engine.js:522`), and `test/costReport.mjs:80-90` aggregates
input/output/cache-read/cache-write and prints a reads-vs-writes verdict.

### 8. The LLM call and reply handling

`analyzeThread` (`analyze.js:167-307`) calls `freezr.llm.ask` with: the system prompt as
`context`, `responseType: 'json'`, `max_tokens` from Preferences (default
`MAX_TOKENS = 40000`, `analyze.js:67`; range 4000–64000, `prefsTab.js:139`), thinking off
unless explicitly `true` (`analyze.js:178`; Preferences default off), `effort` (default
`'low'`, `engine.js:124` — whether the freezr layer honors this option is unverified;
backlog), model/provider from `settings.default_model` — the default keeps the user's own
provider and steers only the family (`config.js` `PREFERRED_FAMILY`: Claude → haiku;
`engine.js:298`) — and the cache option. Every
exchange is optionally captured for the Inspect page (`session.exchangeCapture`,
`analyze.js:186-207`).

The reply is parsed leniently (strip code fences, slice the outermost `{…}`,
`analyze.js:16-24`) and classified (`classify`, `analyze.js:76`; per entry `classifyOne`, `:45`)
— the classifier knows the batch shape (`message_results[]`, each entry validated, and a
single-entry reply is rejected when more than one message was asked about):

- **`request_more`** — the model may ask for the full body of a specific prior message
  (`message_body`), the full to-do list of a catalog project (`project_detail`), or the full
  profile of someone sent as a name only (`person_detail`, added 2026-09-20 — the people block had
  invited the ask for months while the kind did not exist, so it came back "could not resolve").
  The engine resolves the request and re-asks, at most
  `MAX_FETCH_ROUNDS = 2` extra rounds by default (0–5 via Preferences, `engine.js:31`). The
  round APPENDS turns — the model's `request_more` JSON as an assistant turn, then a user turn
  carrying **only the resolved detail**; the previous volatile turn moves into `priorTurns`,
  never re-sent — so everything before the new turn re-reads at the cached rate. That is what
  turned the measured 2× cost of a fetch round (the whole prompt rebuilt and re-billed) into
  roughly 1.2×. A requested project's detail is capped: newest 30 open to-dos, 300-char
  descriptions, one evidence line each, closed as a count (`resolveRequests`, `engine.js:453`).
  The rounds are bounded on purpose: the up-front payload should cover nearly every message,
  and if logs show fetches firing constantly the fix is a richer index, not more rounds. One
  round is implicit: a reply that files into a project shown only as a catalog row is re-asked
  with that project's real to-do ids (`unseenProjectIds`, `engine.js:397`; prompt 0.60), allowed
  once even when the user set fetch rounds to 0.
- **Valid analysis** — needs `projects[]`, `latest_delta`, and `todos[]` per project, a
  non-blank `message_summary` (an entry with no items is valid — roughly 40% of real traffic —
  but must still say what the message was, `analyze.js:67`), and one `account_for` verdict for
  every line of the request's "Open items to account for" block (`analyze.js:49-54`).
- **Invalid** — one **repair round**, conversation-style (`analyze.js:236-277`): the bad
  reply is echoed back (unless empty, or bigger than 40,000 chars) with one of three
  instruction texts (empty / thought-itself-out / truncated), `responseType` dropped when
  the reply was empty, and the cap raised to `repairCapFor(cap) = cap × 1.4`
  (`analyze.js:69`). Truncation checks compare against the cap the reply was actually
  generated under (`looksTruncated(res, cap)`, `:75-85`).

A second failure throws. `processor.persistOne` then classifies the error text
(`processor.js:563`): "too much to weigh up / EMPTY reply twice / whole output budget on
reasoning / cut off mid-JSON" → the message is **abandoned** — an error event with an
`attempts` count is written, the cursor advances, the run continues
(`processor.js:568-579`). Anything else records the event and stops the run **without**
advancing the cursor (`superlazyStop`, `:588-597`). Timeouts get a synthetic error event so
the attempts cap can eventually retire them (`processor.js:246-249` → `ingest.js:402-411`).

Tripwires: a warning fires when reasoning tokens come back despite `thinking: false`
(`analyze.js:224-228`), and the reply log flags ≥ 200 thinking tokens
(`engine.js:511-515`); `thinking_tokens` are recorded per message (`engine.js:367-371`).

### 9. Reconcile — applying the model's answer

`reconcile` (`reconcile.js`) is the guard between the model's JSON and the store:

- mints real ids for the model's temporary ones and maps them into `latest_delta`
  (`reconcile.js:353-360`; project tmp ids `:118`, todo tmp ids `:170`);
- clamps importance to 1–5 (`:9-13`), only accepts `YYYY-MM-DD` dates (`:45`), defaults
  unknown directions and response kinds (`:16,58`);
- **never touches** user-locked importance (`importance_locked`). The `manual_locked` invariant
  went with the flag on 2026-09-19 — it was set on 0 of 1,345 stored to-dos, so it protected
  nothing;
- rejects a "resolved" claim with no `evidence_msg_id` **in this reply** and reverts it, logging
  a `rejected` change — on both the BRIEF patch path (`:330-332`) and the full path (`:414`).
  The citation must come from the reply, not the stored record: bootstrap-adopted to-dos already
  carry the id of the mail that raised them;
- for [BRIEF]-tier projects (*verified 2026-10-10*), an existing to-do is PATCHED, not replaced:
  only `BRIEF_EDITABLE` fields are merged onto the stored record (`status`, `evidence_msg_id`,
  `change_reason`, `importance` — unless user-locked — and `due_hint` / `due_earliest` /
  `due_latest`; `reconcile.js:144-145`, applied `:311-340`); every field the model was not shown
  survives. A new to-do in a BRIEF project takes the normal path;
- to-dos the model omitted are kept, not deleted — the reply is a delta, upserted by `todo_id`.
  This is what makes omission safe: a model that under-lists (the original "5 to-dos → 0 in one
  go" wipe) can no longer delete anything; an item leaves the open set only by an explicit
  resolved/cancelled carrying evidence;
- **reassignment moves, never copies**: a `todo_id` returned under a different project is spliced
  out of its old one, and the threads only it brought leave with it
  (`projectStore.releaseTodoThreads`, `reconcile.js:352,402`);
- **applies the `account_for` verdicts** (0.61, `reconcile.js:500-530`): for each listed id the
  reply did not also return as a full object, `resolved` / `cancelled` / `in_progress` sets the
  status with this message as evidence (and links the thread to the project); `open` changes
  nothing; an unknown id is dropped with a warning;
- **never adopts an invented id** (2026-08-22): a `todo_id`/`project_id` that is tmp-shaped
  (`^[np]\d+$`) or matches nothing in the store is a model slip on a NEW item — reconcile mints a
  real id and tmp-maps the slip so later entries in the same reply stay consistent. The old
  adopt-the-string path leaked five `n1` todos + a `p1` project into storage, and a later slip
  citing `n1` MOVED and rewrote a resolved to-do across projects (see the backlog's resolved log);
- **anti-echo / no-op detection** (`:122-127,334-349`): a project entry counts as *touched*
  only when something actually changed (`metaChanged || realChanges.length`, rejected
  changes excluded). An echoed-unchanged project is not linked to the thread, does not get
  `last_active_asof` bumped, and does not enter the updates section — logged and ignored;
- **carry-forward of unseen fields** on existing to-dos: `due_*`, the who-fields
  (owner/owners/counterparty, carried as ONE decision — see `whoListFrom`) and
  `short_description`/`description` are preserved when the model saw only a one-liner; `due_demote` (the user's "lower priority until due"
  hold, read by `dueDates.effImportance`) is USER-ONLY — never rendered to or settable by
  the model, always carried forward from the prior to-do (added 2026-08-27);
- suggested replies are replaced by `(todo_id, kind)` (`:321-328`) — the counterpart of not
  echoing drafts back — and a response's `subject` is preserved on update (`:318`);
- **superseded drafts are retired** (2026-09-27, `retireSupersededDrafts` block before
  `latest_delta`): a message on thread X dismisses every unedited `suggested` reply whose task
  cites thread X and whose `created_asof` is older than this message (stamped `dismissed_asof`,
  `dismiss_reason: 'superseded…'`). A draft this message produced, an `edited` draft, and drafts
  on other threads survive. The UI applies the same rule from the evidence trail
  (`expandableProjectView.isSupersededResponse`) and from the events log for messages that never
  reach reconcile (`viewerContext.retireStaleDrafts`). Proven by `test/verifyDraftRetirement.mjs`;
- **maintains the to-do's evidence trail** — one entry per message that created or changed it,
  carrying the actor (`who`), the model's one-sentence `summary` of that message, its prose
  `reason` (the `change_reason`), and a structured `changed[] = [{ field, from, to }]` diff
  (`pushEvidence`, `diffTodo`). This trail is the task's whole history and travels ON the
  project record, so every history view in the app is query-free;
- **stamps the model's own baseline** onto `llm_importance` / `llm_short_description` /
  `llm_description` (`stampLlmBaseline`), and ONLY for fields the model actually emitted — a
  to-do rendered as a one-liner never saw its description, so an omission must not overwrite the
  baseline. A manual edit never touches these, which makes `importance !== llm_importance`
  exactly "the user overrode the machine" and gives a revert its target;
- returns the per-message diff as `todo_edits`, which `persist.eventFromStep` puts on the event.
  It is deliberately NOT folded into `changes`: `changes` drives the Recent and Events feeds,
  where a priority nudge does not deserve a row of its own.

### 10. The learning loops (what feeds the next prompt)

- **`profile_updates`** → applied to profiles not yet solidified/user-edited
  (`profiles.js`), and filtered to addresses **on this message** (from/to/cc, excluding the
  user's own — `engine.js:950`).
- **`fit_concerns` and the whole profile fit accumulator — REMOVED 2026-09-19.** The model
  was asked for a drift signal on every message and emitted none in 983 analyses, so the fit
  score never moved. The field, `applyFitConcerns`, `markNeedsReview`, the score, the drift
  log, the out-of-sync badge, six tuning constants and the drift re-profile trigger all went
  together. The stored `fit` object is left on old records and read by nothing.
- **Reprofile** (an extra small LLM call, max 2000 tokens, 2 fetch rounds, one repair —
  `profileTuning.js`, `reprofiler.js`): now has ONE automatic trigger, **graduation** (5+
  messages from a still-provisional sender) — plus the on-demand `user_request` from the
  person modal. A sender with an active auto-process is never graduated. It rewrites the
  profile, solidifies it, and learns `user_tone`, which overrides the general style guide.
  *(Engine-fired reprofiles still see only this run's threads — backlog.)*
- **The workflow registry and the trigger contract** (*verified 2026-10-10*). `WORKFLOWS`
  (`workflows.js:279`) is code, not data: each entry is keyed by its action name and colocates
  `keyword`, `priority` (higher decides first; `automated` is 0, the floor),
  `prompt_instruction` (the "if X, emit action Y" line, or null), `onTrigger` (runs AFTER
  reconcile, so minted ids are visible; may be async and heavy) and an optional `shortCircuit`
  (§5a). Adding an action is one registry entry; the automated instruction is BUILT from
  `AUTOMATED_CATEGORIES`, so adding or renaming a category is one list entry and the prompt and
  the code cannot drift. Two entries exist: `automated` and `app_subscription` (priority 50,
  no static line — its detector lines are data-driven, one per approved subscription;
  `onTrigger` writes an idempotent delivery record). `forward_message` / `deep_research` are
  sketched in comments only. The model returns an optional top-level
  `triggers: [{ "type": "<registry key>", "details": { … } }]` — each action's own prompt line
  says which `details` fields it needs (`automated`: `category`, `sender`; a subscription:
  `sub_id` — pinned to the request's subscriptions by an enum in the structured-output schema, `analysisSchema.js:166` — plus `payload`). The
  legacy flat `{ workflow, … }` shape is still accepted; an unknown action name is ignored
  (forward-compatible); one failing `onTrigger` never breaks the message. The model emits
  intent; the app owns the state — a profile's `auto_processes` entry is written only by
  `onTrigger`, never by the model directly.
- **Standing instructions are measured, not trusted.** Each renders with its `[i_xx]` id; the
  reply's `rules_applied` lists the ids the model says changed the analysis. The engine keeps only
  ids actually offered in that request (`engine.js:919-926`), stores `rules_offered` +
  `rules_applied` on the event and the cited ids on the evidence entry of every to-do the message
  touched (`reconcile.js:124-128`). Nothing ACTS on the field: offered-vs-cited is a weak
  self-report, so an instruction that looks load-bearing gets A/B-tested on the replay harness.
- **Triggers → auto-filing.** When the model emits an `automated` trigger, `onTrigger`
  (`workflows.js:294`) may set `file_to_project` on the sender's profile — the thing
  that powers step 5a's free short-circuit. A human-contact veto refuses to learn
  auto-filing for anyone the user has ever written to, unless the address looks
  machine-shaped or the mail system labels it bulk (`autopilotVeto`,
  `workflows.js:91`) — with a carve-out for `locked` / `source: 'bootstrap'` entries.
  Two backstops synthesize the trigger from filing behavior and vice versa
  (`inferAutomatedTriggers` / `backstopAutomatedItem`, `workflows.js:157,177`). The item backstop (`backstopAutomatedItem`) does NOT mint a
  "recovered" item for a message the model folded into an existing item — one that already
  cites it, or a read item an earlier message of the same batch from the same sender created;
  that message gets an `absorbed` feed row ("added to") instead (2026-10-03). Writing to a sender later switches their auto-filing off
  (`profiles.js:82-90,115,127`). `AUTOMATED_CATEGORIES` now has five categories including
  `admin_actions` (importance 3), with a `catFamily` collapse so Gmail's coarse
  `CATEGORY_UPDATES` doesn't false-positive the mismatch check (`workflows.js:28-41`). The
  mail system's own labels (Gmail `CATEGORY_PROMOTIONS` / `_SOCIAL` / `_UPDATES` / `_FORUMS`)
  reach the model as a hint and feed only that advisory `mismatch` flag.
- **`message_summary`** → stored on each to-do's evidence trail (`reconcile.js:76`) and
  rendered as "↳ (handle) summary" lines in future prompts (`assemble.js:231-234`).

### 11. What gets written where

Per message (`processor.persistOne`, `processor.js:410-600` → `persist.persistStep`,
`persist.js:302-321`):

| Collection | What |
|---|---|
| `projects` | upsert per touched project (participants flattened to an array — Mongo forbids dots in keys; `persist.js:51-54`) |
| `profiles` | upsert per address **on this message** (`addrsOf`, `processor.js:26-31,442`) |
| `profile_history` | append-only snapshot when a solidified profile was replaced (`processor.js:422-430`, `persist.js:612-629`) |
| `events` | one event per message with a **deterministic id** (`ev_<msg>_<hash>`, upserted — reprocessing overwrites instead of duplicating; `eventIdFor` `persist.js:170-171`, kinds `ANALYSIS_KINDS = ['message','workflow_short_circuit','skipped']` `:180`). Carries changes, delta, cost splits (`cost_analysis`/`cost_reprofiles`), tokens (input/output/other/cache_read/cache_write/thinking), model, prompt version, summary, body snippet, labels, `autoprocess_blocked`, and a `request_profile` diagnostic (volatile chars, per-section sizes, reduce level, snapshot size, rounds — `engine.js:688-696`, `persist.js:665`) |
| `inputs` | best-effort body snapshot of every analysed item, ALL channels (`processor.js:544-553` → `persist.saveEmailBody`, which since Phase 2 writes an `inputs` record: channel `mail`, authority `provider`, born `analysed`; 256 kB html cap with html→text rescue) — used by the UI and People-page reprofile, **never** by the analysis prompt. Manual notes live here too (authority `canonical` — never pruned; also the pending-analysis queue via `status`). `email_bodies` is LEGACY: read-fallback only (`getEmailBody`/`getThreadBodies`), dropped at the full reset |
| `accounts` | cursor advance after every message (`processor.js:188-201`) |

The same `events` collection also takes the user's own edits, as `kind: 'manual_edit'`. Those
carry a `manual_id` — `todo_id + burst-seq + field` — which `addEvent` upserts on, so a burst of
manual fiddling inside the 60s coalesce window (`ui.js COALESCE_MS`) is ONE record whose `before`
is the value the burst started from and whose `after` tracks the latest, rather than ten rows for
one decision. Analysis events additionally carry `todo_edits` — the field-level diff described in
§9 — held apart from `changes` so it adds no rows to the feeds.

**Write concurrency on `projects` (2026-08-20).** Several writers touch one project — every
open tab plus the analyzer (in-tab or as the background job) — and a record is written WHOLE,
so the layer defends on three fronts (`persist.js`, `projectMerge.js`):

1. **One row per key.** A project new to this process is created on the canonical record id
   `proj_<project_id>` with `upsert: true`, and all writes of one key are serialised through a
   per-key queue (`persist.queued`). Two racing first-time saves can no longer both create,
   which is what forked a project into two rows (backlog Resolved log, 2026-08-20).
2. **Read-and-merge before overwriting.** Every save of a project we have already seen reads
   the stored row and 3-way merges it into the live object against a BASELINE — the ids +
   scalars this process last loaded or wrote (`projectBaseline`). Rules: adopt to-dos/drafts
   another writer added; do NOT resurrect ones missing from our copy but present in our
   baseline (we moved them away); take their version of a shared task only when we did not
   touch it (newest-touch stamp); otherwise keep ours and log the conflict. Every change to a
   draft must STAMP it (`edited_asof` / `dismissed_asof` / `sent_asof` — `respTouchOf`): an
   unstamped dismissal loses to a writer still holding the old copy (the lingering-drafts bug,
   fixed 2026-09-27). The merged result
   is folded back into the live store object, so the UI shows the adopted work.
3. **Healing on load.** `loadAll` folds any pre-existing duplicate `project_id` rows into one
   (union — no baseline exists to infer intent) and tags the extras `dup_retired`, which
   `loadAll` filters out. Nothing is deleted. Profiles get the same by-address dedupe (newest
   row wins, no content merge) and canonical `prof_<address>` ids.

Ids created by the USER (board "+ Add Project", "+ Add" task) are `p_u_<ts><rand>` /
`t_u_<ts><rand>` (`mintUserProjectId` / `mintUserTodoId`), not the per-store counter — two
separately hydrated writers would otherwise mint the same `p_04` for different projects.
`seqOf` ignores ids containing `_`, so these never inflate the analyzer's counters.
Proof: `node test/verifyProjectMerge.mjs`.

Side events are separate rows with **random ids** (still not idempotent — backlog):
`reprofile` (`processor.js`), `autofile_learned` (`:486-500`), `autofile_off` (`:503-511`), `autofile_mismatch` — fired on
either `mismatch` or `doubt` (`:518-540`), `cache_refresh` (`:325-341`).

**Event importance ranks with the bucket (2026-08-17).** Events for mail that was
auto-filed *without being read* rank by the **project** they landed in, not by a hardcoded
value: `workflow_short_circuit` (`processor.js:417,433-435`), `autofile_learned`
(`:486-500`), and `autofile_mismatch` (`:518-540`) all stamp
`importance = project.importance || 1`. Pure system actions (`reprofile`, `cache_refresh`) rank 1. Rationale in Part 3.

End of run: stamp `style_guide` if rebuilt (`ingest.js:416-418`), `stampSnapshotPin`
(`:422`), release the lock + `stampNewMailCheck` in a `finally` (`:440-443`); `index.mjs:157`
stamps `bg_last_run` with the summary the topbar polls for (now carrying `retried`,
`failure`, `skipped`, `more_pending`, `token_expired` — `index.mjs:130-152`).

**The on-demand reprofile task** (People page → `index.mjs:84-106` →
`reprofileTask.runUserReprofile`, `reprofileTask.js:53-100`) is the same reprofiler fed
from persisted events + stored bodies (up to `REPROFILE_EVENTS_CAP = 2000` event rows,
`reprofileTask.js:24`), may overwrite user-edited text (`userRequested: true`), does its own
persistence, takes **no run lock** (intentional), and stamps `settings.bg_last_reprofile`.
The People page runs the same function in-tab when the job isn't available
(`people.js:135-137`).

### 12. The Inspect page — deferred persistence

`inspect.html` / `inspect.js` / `inspectRunner.js` is a debug driver for single messages
with full wire visibility, built to A/B the Preferences dials. It constructs the **exact
production pipeline** — same `sessionPrefsFrom`, same processor/engine path, same pinned
snapshot (`inspectRunner.js:49-69`) — with `deferPersist: true` (`processor.js:36`):
would-be writes queue on `t.pendingPersist` / `t.pendingCacheEvents` / `t.pendingBatch`
(`processor.js:78-80`), stepped by `t.inspectNext` (`:649-667`), then `t.commitPending`
(Save, `:669-691`) or `t.discardPending` (Ignore, `:693-699`). Every LLM exchange —
options, turns, reply, usage — is captured on `session.exchangeCapture` (`engine.js:132`,
filled by `analyze.js:186-207`). It takes **no run lock** by design
(`inspectRunner.js:12-14`) — the user coordinates manually. After a run (Save *or* Ignore)
it pins the durable turn so the cache write that was already paid can be read by the next
run (`inspectRunner.js:83-87`). The cursor never moves.

---

### 13. Manual notes (the notes channel)

The same engine analyses user-typed NOTES (meeting notes etc — `specs/superlazy-inputs.md`).
The differences from mail, end to end:

- **Entry**: the topbar "＋ Add…" chooser (`pages/addFlows.js`, mounted on Dashboard / Events /
  Recent / People) → the note modal (`newNoteModal.js`: title optional — derived from the first
  non-empty line via `deriveNoteTitle`; attendees + project fields have type-ahead; the project
  pick PRE-LINKS the note's synthetic thread so the model edits that project in place).
- **Save is non-blocking**: the modal closes at once; the `inputs` record is persisted FIRST
  (`status:'pending'` — the note can never be lost), then `runNoteIngestion`
  (`jobs/analyze_thread/noteIngest.js`) takes the SAME run lock (kind `note`, stage stamped so
  the status strip says what it is doing, heartbeat renewal every ~15s), builds a source-less
  session, and runs ONE `processBatch` entry (`priorMsgs: []`, synthetic thread `note_<id>`),
  hard-bounded by `STEP_TIMEOUT_MS`. Outcome flashes on the topbar note line.
- **Lock held elsewhere** → the note stays pending and the RUNNING check drains it at its tail
  (`drainPendingInputs`, called from `ingest.runIngestion` before the lock is released; the
  drain query is time-boxed 15s and renews the lock with the note's stage). Failed notes retry
  on later runs up to 3 attempts (`attempts`/`last_error` on the record); the run summary's
  `notes_drained` makes pages refresh even when no mail was processed.
- **Analysis semantics** come from the prompt's notes guide (0.30): author is ME, participants
  are attendees (name-only allowed), decompose aggressively, facts→project summary, never an
  "answer" draft. Attendee profiles count `counts.notes.mentions`, never `messages_from/_to` —
  graduation stays correspondence-only (`profiles.recordMessage` channel switch).
- **Edit = amendment** (viewer "✎ Edit note" → same modal prefilled): revision bump, superseded
  body kept in `prior_revisions`, re-analysis under the SAME `msg_id` so the event upserts and
  the request carries the REVISED marker — reconcile updates the derived to-dos instead of
  duplicating them.

---

### 14. Slack (the messages channel) — code-side built 2026-08-29, NOT yet live

Phase A of the Slack slice (the plan in `~/.claude/plans/` / this repo's inputs spec §4.1) landed
code-side; nothing ingests until the user grants `messaging_read`, re-installs, and runs Stage 0.
The moving parts, end to end:

- **Chunking** (`chunker.js`, pure, offline-tested by `test/verifyMessages.mjs` 40/40): a chat
  input item is a CHUNK of dialogue per STREAM (`slack:<team>:<conv>` main flow; each Slack
  thread `…:<parent_ts>` is its own stream). Live boundary = the check window with the §4.1(b)
  soft debounce (tiny+hot holds, `MAX_HOLD_MS` ceiling); history (cursor-0) chunks per stream
  per day, split at `HISTORY_CHUNK_CHARS`. Chunk id `<stream>|<first msg id>` is DETERMINISTIC —
  re-forming with appended messages upserts (amendment, never duplicate). Adjacent chunks
  (< `ADJACENT_MS`) set `in_reply_to` to the previous chunk, so the engine's parent-inlining
  renders §4.1(a)'s previous-chunk-in-full for free.
- **The source** (`slackSource.js`, same interface as `liveMailSource.js`): conversation roster
  with per-conversation `tracked` opt-in/out on the account record (member channels + DMs
  default in; public channels opt-in), sync-mode dispatch per run — socket-fed `getChanges`
  names changed conversations when `messaging_live` is active, else polling `getNewer` per
  tracked conversation — thread-reply fetch (replies never appear in main history), user
  resolution via `getUsers` (attested emails; mentions rewritten to @names), and **every chunk
  persisted to `inputs` (status `'pending'`) at FORMATION time** — the chunk ledger. Envelopes
  come from the pending records, so retries re-read stored chunks, never re-chunk.
- **The composite** (`jobSource.sourceFromAccounts`): stored accounts split by channel; mail +
  messaging wrapped in one source whose `listEnvelopes` merges both queues **oldest-first** —
  the cross-channel chronology mechanism (one clock, one serialized replay).
- **Processor hooks**: a `channel:'messages'` envelope's inputs record flips to `'analysed'`
  (+ `analysis_event_id`) after persistStep, or `'error'`+attempts on an abandon — so the
  pending queue and the events-based retry cap agree. `sourceTagFor` is channel-aware:
  messaging provenance tags are `slack:<connectionName>` (never the address — it usually equals
  a mail account's).
- **The lab** (`slacklab` page, not in the nav): Stage 0 — roster + opt-in/out, formation DRY
  RUN (deep-copied account record, nothing persisted), chunk transcripts, the user-resolution
  table (id → name/email/bot; NO profile matching — that is Stage 2, against the mail-trained
  store), volume/cost projection, live-capability pill. Its one write is "Save selection"
  (seeds the `channel:'messages'` account record).
- **Channel-aware wiring (fixes, same day):** the freezr connections listing is ONE shared
  endpoint across services, so `mail.listAccounts` returns Slack connections too —
  `liveMailSource.rawAccounts` now keeps only rows whose `services` include `'mail'` (a Slack
  row leaking through is exactly "No use_mail permission covers connection: slack3").
  `sourceFactory.sourceFromAccounts`/`detectSource` ignore `channel:'messages'` records when
  picking the mail source. The startup gate accepts EITHER input permission
  (`onboarding.getPermissionState().inputGranted` = use_mail OR use_messaging); a
  messaging-only install gets its own welcome view pointing at the Slack lab; status-page
  Train/Continue on a messaging row routes to the lab, and Forget tags by channel.
- **Phase B (analysis side) — built 2026-08-29, later the same day.** `PROMPT_VERSION` 0.32:
  a `## Channel guide: messages` (chunk = transcript slice of an ongoing stream; terse
  commitments and ✅/👍 reactions are evidence; attribution is per transcript LINE; @mentions
  assign; a channel is a place, not a project; NO drafts of any kind). `assemble.js` gained
  `renderChatChunk` (`[MESSAGES item — chat transcript]` header + stream/participants lines +
  the transcript; REVISED marker on re-formed chunks; `ITEM_RENDERERS.messages` uses it for both
  new and prior-in-full — so the chunker's adjacency `in_reply_to` inlines the previous chunk
  via the normal parent mechanism). `normalize.js` passes through `channel_data` (per-author
  counts, conv type, first_ts/msg_count) built by `slackSource.inputToRaw`;
  `profiles.recordMessage` counts messages by AUTHOR into `counts.messages.{from,to}` —
  deliberately NOT correspondence (graduation/latency stay mail-only; DM-weighting is a
  Stage-2+ decision). The processor forces `noDrafts` on messages entries.
- **The stepping harness is the INSPECT page** (`inspectRunner` now passes `persist` to the
  composite source): with a saved Slack account, Inspect's `plan()` runs REAL chunk formation
  (pending `inputs` written, stream cursors/tokens advanced), queues the pending chunks
  oldest-first alongside mail, and steps them with Save/Ignore per chunk — that is Stage 1
  (empty store) and Stage 2 (mail-trained store) of the rollout, with full wire visibility.
  Ignore keeps the chunk pending (it re-queues from the ledger, never re-chunks); Save runs
  `persistOne`, which flips the inputs record to `analysed`.
- **PROVIDER AMENDMENTS + THREAD REVIVAL (2026-08-30, live mode):** the activity index's
  per-conversation `edited`/`deleted` message ids are now ACTED ON (`applyProviderChanges`,
  capped 25/run): the stored chunk carrying the id is patched — edited text re-fetched
  (oldest=latest=id), deleted messages tombstoned `[message deleted]` — transcript re-rendered,
  revision bumped, status back to `pending`; the re-analysis upserts the same event with the
  REVISED marker (`normalize` now passes `revised` through; a chunk raw is flagged while
  pending). And a conversation the index says CHANGED whose `getNewer` returns nothing means a
  reply landed on an OLD thread — `sweepRevivedThreads` (last-50 parents, capped getThread
  calls) picks the replies up as thread-stream chunks. POLLING mode retains both gaps by
  design — the index is what makes them cheap. Offline proof: `test/verifyMessagesAmend.mjs`.
- **FOREGROUND CHANNEL TRAINING (2026-08-30):** saving a Slack selection no longer hands the
  history build to an invisible background check. `startup.runChannelTraining` runs the SAME
  check (runNewMailCheck) in the foreground with the processing modal narrating progress (N of
  M, running cost, current item) — mail-bootstrap parity. The messaging-only welcome trains
  right after Save and then opens the dashboard; a save on the CHANNELS tab (live install)
  offers the choice: "Analyse now (watch progress)" vs "In the background" (startBackgroundRun
  when the job is available, else the next check).
- **CHANNEL SETUP IS IN THE APP (2026-08-30):** the Slack conversation-tracking UI is the shared
  `slackChannelsUi.js` module (styles `slackChannels.css`), mounted in three places — the startup
  page's new CHANNELS tab (Status / Rules / Channels / Preferences; later pref changes), the
  messaging-only first-run welcome (inline; saving redirects to the dashboard and the next check
  builds the history), and the slacklab page (now purely the dev dry-run tool). The lab is no
  longer on any user path.
- **THE ROLLOUT SWITCH — RETIRED (2026-08-30, same day, after stage 2.0 validated):** messaging
  accounts are now ALWAYS planned by the normal checks, exactly like mail (stage 2.1 on,
  permanently). The brief `settings.messages_in_checks` flag and its Preferences checkbox are
  gone (a stored value is inert); the chicken-and-egg that killed the switch: a fresh Slack-only
  install has no Status page yet, so the Preferences toggle was unreachable exactly when it was
  needed. Closer observation is still available any time via the Inspect page (step pending
  chunks before a check runs).
  **The drain never analyses chunks either way** (found live 2026-08-29): the run-tail
  `drainPendingInputs` used to process ANY pending input, so a mail check quietly analysed the
  Slack chunks Inspect had formed — context-free (no prior chunks) and around the gate. The
  drain now skips `channel:'messages'` records; chunks are analysed ONLY through the planned
  queue (which carries their stream context).
- **ME across channels**: `meSetFromSettingsAndAccounts` (ingest.js, also used by Inspect)
  unions `settings.your_addresses` with every account record's `account_email`/`me_email` — a
  Slack-only install has no mail-set your_addresses, and direction/ME detection must not go
  blind. The viewer renders a chunk with a Slack header (stream/participants/when), transcript
  body, and NO mail reply bar.
- **The staged test plan (user's numbering, 2026-08-30):** 2.0 (CURRENT) — train on a few days
  of Slack via Inspect stepping, switch OFF; 2.1 — wipe all data, switch ON, verify superlazy
  works SLACK-ONLY end to end (setup → checks → feeds → viewer); 2.2 — wipe, restore mail
  training, verify mail+Slack comingle in one queue; 2.5 — chronology smoke runs (email →
  Slack "done" → email, one check, true order); 3.0 — socket/live-update runs (getChanges
  parity vs polling).
- **2.0 feedback round (2026-08-30, later):** (a) PRESENTATION — chunk titles resolve DM /
  group-DM MEMBER NAMES at formation (`ensureConvNames`: getConversationMembers + users cache,
  cached on the roster entry) → "Slack DM: A, B"; `renderUtils.chatTitle` prettifies legacy
  machine titles ('mpdm-…') at render; feed rows put the conversation title in the sender slot
  (💬) and SKIP the subject line; the viewer header/rail snippets do the same. (b) PROJECT-
  FILTERED VIEWER — `relatedFor`/`openEmailViewer` accept `project_id`: opened from a task or
  project (openTaskEmail, taskEditor history) the SIDEBAR shows only that project's items (a
  chunk often spans projects); the header still names every touched project + a "showing items
  for X only" note; Events-page opens stay unfiltered. (c) BODY-LOOKUP FIX — ensureBody gained
  a thread-ledger fallback (getThreadBodies → pick msg) for open paths that carry no
  account_id, and the live-mail fallback is skipped for `slack:`/`note_` threads. (d) PROMPT
  0.33 — new core section "Arrival order vs real order": sources sync at different moments, so
  judge by ORIGINAL dates (item date, transcript line timestamps, evidence dates); older items
  add context or resolve, never regress newer state; re-read linked projects' existing to-dos
  per item (same obligation from another channel/thread = the SAME to-do).
- **2.0 feedback, round three (2026-08-30; prompt 0.34, JOB .4):** LIVE chunks now ALWAYS inline
  their predecessor (`chunker.formLiveChunk` sets in_reply_to whenever a previous chunk exists —
  the old 10-min adjacency window missed a 12-min request→fulfilment gap, leaving "i put it in
  the same folder" context-free; history chunking keeps the gap rule, since always-inlining a
  whole replay would double its cost for mostly-stale context). The messages guide now says the
  previous chunk is the conversation-so-far, tells the model to request_more OLDER chunks when a
  terse line refers further back, and adds the [files: …] rule: an attachment whose filename
  matches an open request is delivery evidence even when the text is just "here it is".
- **2.0 feedback, round two (2026-08-30):** filtered viewer header claims ONLY the opened
  project ("N items for [chip]"); the selected input's other projects render as an "Other
  related project(s):" chip row above its Tasks (which are themselves filtered to the opened
  project). TASK-ROW ATTRIBUTION is chat-aware: evidence entries now carry `via` (the
  conversation title, stamped by reconcile from engine ctx); `evidenceSummary` flags chat
  entries (type 'messages' / legacy slack: thread ids), prefers the task's owner/counterparty
  over "you" (a chunk's `who` is its first author — often ME), and `evidenceLabel` falls back
  to "— Slack DM: A, B" when no person attributes; hover titles say "open the conversation".
- **Not yet built**: viewer branch (a chunk opens via evidence but renders through the mail
  header today), identity wiring beyond attested emails, bootstrap comingle. Deferred (backlog):
  edited/deleted amendments, reactions automation, polling-mode thread revival, merge UI for
  unattested identities, write scope.

---

### 15. Work sessions (the `work` channel: Claude Code) — built 2026-09-07, live since 2026-09-10

Design + status: `specs/superlazy-sessions.md`. The Slack pattern (§14) applied to the transcripts
an AI coding agent leaves on the user's disk, read through freezr's `use_file_sys` permission
(`read_work_sessions`, connection = a local file store rooted at `~/.claude`):

- **Model (user, 2026-09-07):** a SESSION is a THREAD; each request-and-answer TURN is one input
  item — one email in a thread. Turn n's item has `in_reply_to` = turn n-1's, so the engine
  inlines the previous turn in full and lists earlier ones as index rows. The agent is a TEAM
  MEMBER, a name-only participant "Claude Code" (no profile minted); the user is ME.
- **Formation** (`workSource.js`, over `sessionsSource.js` + the pure `sessionDigest.js`): list
  sessions touched since the cursor for the account's tracked repos → parse → for every turn
  beyond the session's stored high-water mark (`accounts.sessions[<id>].turns_done`) persist an
  `inputs` record `status:'pending'` (`msg_id <sessionId>|t<n>`, thread `cc:<repo-slug>:<id>`,
  body = the YOU / CLAUDE CODE dialogue with tool output DROPPED and token-like strings scrubbed,
  plus a `[tools: …]` footer and `[turn note: …]` lines). A finished turn queues at once; an
  unfinished last turn (unanswered / stopped mid-tool) is HELD until the session has been quiet
  for `QUIET_MS` (30 min), then queued as-is. Caps: 40 sessions, 300 turns, 60 s per run; a
  truncated history pass keeps the account in history mode. Provenance tag `agents:<conn>`.
- **Composite** (`jobSource.js`): generalised to N children — envelopes merged oldest-first across
  mail + slack + work; threads routed by prefix (`slack:` / `cc:`), bodies by channel.
- **Prompt 0.36:** `## Channel guide: work` — a prompt is an ask the agent owes ME (team_owes,
  owner "Claude Code"), the recap is delivery evidence (resolves / in_progress), unanswered agent
  questions are i_owe_them, a plan with no changes is owed work (removed in 0.42), an unfinished turn is never
  resolved; cross-channel linking to the PERSON's original ask comes first (update that to-do,
  add "tell X it is done"); a repo is a place, not a project; NO drafts.
- **Renderer** (`assemble.renderWorkTurn`, `[WORK item — agent session, turn n of N]`): cut
  direction is the REVERSE of mail — prompt keeps its HEAD, answer keeps its TAIL (the recap).
- **Processor hooks:** `noDrafts` for work items; the inputs record flips to `analysed` / `error`
  exactly like a Slack chunk. `profiles.recordMessage` is a no-op for work items.
- **Views:** Events rows read "🤖 Claude Code · <session title>"; the viewer shows Session / Turn /
  Repo / With / When and the dialogue as the body (no reply bar; no live fallback for `cc:`
  threads); task-history entries read "… · Claude Code". Account pickers label the account
  "🤖 Claude Code" (the AGENT, not an address).
- **Setup page** `agentslab` (not in the nav): pick the fs connection, tick repos, Save (seeds
  the `channel:'work'` account with `me_email`, `repos`, the first-read window), and a formation
  DRY RUN listing exactly the turn items a run would queue. The Inspect page is the stepping
  harness (`accountMix` now counts work accounts).
- **Effort record + refinements (same day):** each item stores `work_stats` (duration, tokens,
  tool calls, files, lines ±, thinking/tool-output volume, models, API errors, continuations,
  asked_question) — rendered as one `effort:` line in the request, a Work row in the viewer, the
  Events row tooltip, and copied onto the event. "sorry, pls cont"-style continuation prompts are
  FOLDED into the turn they continue (deterministic, `sessionDigest.buildSession`); a turn whose
  answer ends with a question is `turn_kind:'question'` and the request says so.
- **Prompt compaction + commits (same day):** pasted logs/errors/data in a prompt are collapsed
  at formation (`compactPrompt`: fenced blocks and runs of machine-looking lines → first line +
  count); in-session `git commit` results are parsed onto the item (`commits`, `[commits: …]`
  footer, Commits row, effort line); changed files keep their full paths (`files_changed_paths`).
- **Open items to account for (prompt 0.40, every channel):** beside each new item the request
  lists the open to-dos ITS THREAD raised earlier (`assemble.renderOpenItemsToAccountFor`, cap 30)
  and a CORE rule demands a per-line verdict (resolved / in_progress / cancelled / open + why). The
  fix for tasks outliving their conversations, found on sessions and extended to mail. The
  cross-project lists (owed by the sender, owed by ME to the recipients) are built but OFF
  (`ACCOUNT_FOR_SCOPE`) — mechanism first, more data later (user, 2026-09-08).
- **Zero-write chronological run** (`agentslabRun.js`, step 4 of the page): the REAL processor
  driven as Inspect drives it (inspectNext + commitPending) over an in-memory source (dry-run turn
  items) and a capture persistence (writes recorded, never sent) with the real catalog hydrated in
  memory — timeline + board + events rendered, then discarded. The training review surface.
- **Codex (2026-09-08):** `codexAdapter.js` maps `~/.codex/sessions` rollouts onto the same session
  builder (typed prompts from `user_message` events, `exec` → Bash, `apply_patch` → Edit/Write with
  line counts, `token_usage_record` → usage, `final_answer`/`task_complete` → turn end); the reader
  walks the dated tree and reads each rollout's cwd; `slugOfCwd` = Claude's folder slug, so one repo's
  sessions from both agents share a slug. Mount `~/.codex/sessions` only (`auth.json` sits above it).
- **Offline proof:** `test/verifySessions.mjs` (113 checks: parsing, classification, turn items,
  continuations/questions/effort, normalize + assemble rendering, profile no-op, tag, composite
  routing).

## Part 2 — Tunables registry (every arbitrary constant, where it lives, how to change it)

**Set in** is where to edit the default; **User-adjustable** names the settings field /
Preferences control when one exists (settings fields without a UI can still be set by
writing the settings record directly).

### What each analysis request contains

| Constant | Value | Set in | Used for | User-adjustable |
|---|---|---|---|---|
| Context budget | 70,000 chars PER MESSAGE (choices 40/70/120/200k) × batch size | `assemble.js` `DEFAULT_CONTEXT_CHARS` / `CONTEXT_CHOICES` (`:29-38`); `budget = perMessage × items.length` | volatile-block size; reduction ladder walks until it fits. Since 2026-09-13 the budget scales with the batch — one shared 70k against 10 messages sat at the ladder's floor and was still 49% over | Preferences "Context sent per email" (`analysis_context_chars`) |
| Reduction ladder | 5 levels (see the table in Part 1 §6) | `assemble.js` `LEVELS` (`:56-62`) | what shrinks under budget pressure | no |
| Thread-index rows / snippet | 60 rows / 120 chars (L0) | `assemble.js` `INDEX_MAX` (`:40`) + `LEVELS` | prior-message index size | no |
| New-message body cap | 24,000 chars (L0), ×3 for `whole`-mode bodies | `assemble.js` `LEVELS[].newBody`, `bodyCapFor` (`:447`) | body truncation (marked in-band) | no |
| Prior-message body cap | 6,000 chars (L0) | `assemble.js` `LEVELS[].prior` | replied-to parent / fork body | no |
| Catalog snapshot summary | 400 chars per project row, FIXED at every context setting | `assemble.js` `renderCatalogSnapshot(summaryChars = 400)` (`:492`) / `catalogRow` (`:373`) | durable-turn row size (byte-stable for the cache) | no |
| Evidence lines per to-do | last 3 with summaries + last 2 bare ids | `assemble.js` `renderEvidenceLines` (`:231`) / `renderTodoLine` (`:246-249`) | the to-do's factual memory in the request | no |
| Drift notes shown per person | last 2 reasons | `assemble.js` `profileStageNote` (`:159`) | tells the model what tension is already noted | no |
| Project staleness tiers | full ≤ 7 days, brief ≤ 30, dormant beyond | `config.js` `DEFAULT_STALENESS_DAYS` (`:52`); duplicate `DEFAULT_STALENESS_POLICY` in `assemble.js:307` | how much of a linked project (and a catalog row) is sent; a linked project floors at BRIEF — Part 1 §6 | settings `staleness_policy` (no UI) |
| Closed to-dos shown | newest 10 (L0 → 0 at L3+) | `assemble.js` `LEVELS[].closed` | resolved-item context | no |

### What goes in which cached block — `selection.js`

Every membership formula for the durable turns lives in one module,
[selection.js](jobs/analyze_thread/selection.js), so the split can be tuned and measured without
touching the renderer. **None of these is exposed in Preferences yet**, and the intended end state
is not to expose them one by one but to fold them into a single low / medium / high "how much
context to buy" choice alongside `analysis_context_chars` — see the backlog.

| Constant | Value | Used for |
|---|---|---|
| `HOT_PROJECTS.recentBusinessDays` / `recentTop` | 2 business days / top 10 | the "right now" claim on a hot slot; weekends do not count against a project |
| `HOT_PROJECTS.weekDays` / `weekTop` | 7 days / top 20 | the "this week" claim |
| `HOT_PROJECTS.starImportance` | 4 | importance at or above this is always hot, however quiet |
| `HOT_PROJECTS.starWhenLocked` | true | a user-SET importance (`importance_locked`) is a star at any value |
| `COLD_PROFILES.enabled` / `top` | true / 20 | how many regular correspondents' full profiles ride in the weekly block |
| `COLD_PROFILES.seenWithinDays` | 0 (off) | optional recency filter on that set |
| `RECIPIENT_PROFILES.toDetail` | `full` | how much profile each `to:` recipient gets (was brief until 2026-09-20) |
| `RECIPIENT_PROFILES.ccDetail` / `ccCount` | `brief` / 2 | the first N cc's of each message get this much; the rest stay names-only |

**The recipient tiers, measured** (742 real mail items, per call at batch size 10, against a
~27,000-char volatile block): today 2,923 chars → `to:` full + first 2 cc brief **+734 (+2.7%)** →
all cc brief +1,207 → everyone full +1,849 (+6.8%). The cap is not about bytes — even the
maximalist option is small against a linked-projects section averaging 20,124. It is about where
they go: 76% of mail has 0–1 cc and a 9% tail runs to 27, so sending every cc in full spends the
allowance on mass distributions, the mail where another profile buys least.

"Most active" counts real touches — evidence entries and to-dos created in the window — not the
`last_active_asof` timestamp alone, so a project brushed once does not outrank one worked on daily.

**Why the split is about writes, not reads.** Both durable turns are read at the cached rate on
every call, so moving a project between them changes nothing about read cost — the two blocks are
the same bytes either way. What changes is how often those bytes are RE-WRITTEN: hot on the message
thresholds (~every 9–25 messages in practice), cold weekly, and a cache write costs 1.25–2× the
input rate. Measured 2026-09-19 on the live catalog: the old rule (hot = active within 7 days) put
67 of 117 projects and 39,810 chars in the frequently-rewritten block; the rule above puts 28
projects and 17,203 chars there — a 58% cut per refresh.

### The LLM call

| Constant | Value | Set in | Used for | User-adjustable |
|---|---|---|---|---|
| Output ceiling | 40,000 tokens (range 4,000–64,000) | `analyze.js` `MAX_TOKENS` (`:67`) | max_tokens per analysis call | Preferences "Max output tokens" (`analysis_max_tokens`, `prefsTab.js:139`) |
| Repair-round ceiling | base × 1.4 | `analyze.js` `repairCapFor` (`:69`) | more room when a reply was cut off | scales with the above (⚠ 64k × 1.4 ≈ 90k may exceed provider ceilings — backlog) |
| Analysis effort | `'low'` default | `prefsTab.js:136-138` → `ingest.js:57` → `engine.js:124` → `analyze.js:179` | `opts.effort` on the ask (server-side honoring unverified — backlog) | Preferences "Analysis effort" (`analysis_effort`) |
| Thinking | off by default | `ingest.js:56` (`=== true`), `analyze.js:178` | extended thinking on the analysis call | Preferences (`analysis_thinking`) |
| Fetch (request_more) rounds | 2 (0–5) | `engine.js` `MAX_FETCH_ROUNDS` (`:28`) | extra detail rounds before the model must answer | Preferences "Detail-fetch rounds" (`analysis_fetch_rounds`) |
| project_detail response cap | newest 30 open to-dos, descriptions clipped at 300 chars, 1 evidence line each; closed = count only | `engine.js` `resolveRequests` (`:220-242`) | size of a requested project's detail turn | no |
| Echoable-reply cap | 40,000 chars | `analyze.js` (`echoable`, `:262`) | a bad reply bigger than this is not echoed back on repair | no |
| Thinking-leak tripwire | ≥ 200 thinking tokens flagged; reasoning-despite-off warns | `engine.js:511-515`, `analyze.js:224-228` | detecting thinking billed despite thinking:false | — |
| Reprofile call ceiling | 2,000 tokens; 2 fetch rounds; 1 repair | `profileTuning.js` `REPROFILE_MAX_TOKENS` / `REPROFILE_FETCH_ROUNDS_MAX` (`:39-40`) | the dedicated profile-rewrite call | settings `profile_tuning` (no UI) |
| Reprofiler context sizes | drift: 6 bodies × 1,500 chars; baseline: 5+5 bodies × 1,000 chars; ≤ 8 projects full; 30 index rows | `profileTuning.js:28-37` (`DRIFT_BODIES_MAX`, `DRIFT_BODY_MAX_CHARS`, `PROJECTS_IN_FULL_MAX`, `INDEX_ROWS_MAX`, `BASELINE_*`) | what the reprofile call sees | no |
| Style-guide call | max_tokens 500, ≤ 8 sent samples, ≥ 20 chars each, clipped at 1,200; 20 rows listed per connection | `userStyle.js`; `liveMailSource.js` `loadSentSamples` (`:350-400`, listing bound `:364-368`) | writing-style distillation | no |
| Suggest replies | on by default | `ingest.js:53` (`!== false`) → `processor.js:43` (`draftsOff`) | gates drafts, the style-guide block, and the no-drafts note | Preferences checkbox (`suggest_replies`) |

### Caching (durable turn)

| Constant | Value | Set in | Used for | User-adjustable |
|---|---|---|---|---|
| Re-render after N emails | 50 | `engine.js` `SNAPSHOT_REFRESH_MESSAGES` | cache-write cadence (each email = 1/50 of the render budget) | Preferences "Re-cache the catalog after (emails)" (`snapshot_refresh_messages`) |
| Re-render after N chat turns | 100 | `engine.js` `SNAPSHOT_REFRESH_CHATS` | Slack chunks + agent work turns draw the same budget down at 1/100 each; mixed traffic adds up (`noteProcessedForSnapshot`) | Preferences "…or after (chat turns)" (`snapshot_refresh_chats`) |
| Re-render after age (HOT block) | 24 hours (wall clock since render) | `engine.js` `SNAPSHOT_MAX_AGE_HOURS` | cache-write cadence of the recently-active block | Preferences "…or after (hours)" (`snapshot_max_age_hours`) |
| Re-render the COLD block | 168 hours, or immediately on a rules / business-context change (pin discard) | `engine.js` `SNAPSHOT_COLD_MAX_AGE_HOURS`; `ingest.adoptSnapshotPin` sets `session.snapshotDiscardReason` | the block that should change least sits first in the prefix; its membership is frozen between renders | Preferences "Re-cache the quiet part after (hours)" (`snapshot_cold_max_age_hours`) |
| Pin invalidation | `prompt_version` ≠ current, or `durable_sig` ≠ FNV-1a(business_context + app instructions + ALL-mail standing instructions + style guide); clean-up proposals clear the pin | `ingest.js` `durableSig` (`:93`), `adoptSnapshotPin` (`:142`); `maintenance/applyProposals.js:347` | edits to the prompt or to anything in the cold block invalidate immediately | no (by construction) |
| ~~Touched-share trigger~~ | **REMOVED 2026-08-06** — see Part 3 | `engine.js:43-49` (rationale comment) | — | — |
| What counts as snapshot-touched | material changes only: project metadata, or an ACTIONABLE to-do created/changed; read_only filings and drift assessments persist but do NOT force a fresh catalog row | `reconcile.js` `snapshot_touch_ids` (`:104-110,344-346`) → `engine.js:634` | keeps the highest-volume messages from burning cache writes | no |
| Cache TTL | **1h default** (5m if `snapshot_1h_ttl: false`; off if `llm_cache: false`) | `ingest.js:67-71` (flags) → `engine.js:119` (`cacheOpt`), applied `:496` | provider cache lifetime | settings `snapshot_1h_ttl` / `llm_cache` (no UI) |
| Single-call cache skip | run of exactly 1 message with no pinned snapshot | `ingest.js:284-290` | avoids a cache write that can never pay back | no |

### Profile & project lifecycle

| Constant | Value | Set in | Used for | User-adjustable |
|---|---|---|---|---|
| Profile solidifies after | 5 messages from sender | `profileTuning.js` `MESSAGES_BEFORE_SOLIDIFYING_PROFILE` (`:19`) | graduation reprofile trigger | settings `profile_tuning` (no UI) |
| ~~Profile fit score~~ | REMOVED 2026-09-19 | the accumulator never moved: 0 `fit_concerns` in 983 analyses. `FIT_SCORE_MAX`, `REPROFILE_AT_SCORE`, `SKIP_AUTO_REPROFILE_BELOW_IMPORTANCE`, `DRIFT_LOG_MAX_ENTRIES`, `DRIFT_BODIES_MAX`, `DRIFT_BODY_MAX_CHARS` all went with it | — | — |
| ~~Project drift~~ | REMOVED 2026-09-19 | 5 assessments ever, 0 alerts, no consumer. The whole `PROJECT_TUNING` block went with it | — | — |
| Keywords per project | 10, lowercased | `reconcile.js:138` | catalog row size | no |

### Fetching & the run

| Constant | Value | Set in | Used for | User-adjustable |
|---|---|---|---|---|
| History window | 6 days (first setup) | `config.js` `DEFAULT_HISTORY_DAYS` | cursor-0 accounts only | settings `history_days`; a Status-tab per-account form exists (`statusTab.js:162`) but the setup flow discards its values — see backlog "status tab tidy-up" |
| Cursor overlap | 1 day | `processor.js` `RETRY_OVERLAP_MS` (`:12`) | window starts at cursor − overlap (retry reachability) | no |
| Pending-queue scan | 300/page, ≤ 40 pages, to a floor = max(watermark, now − 30 days) | `persist.js` `scanPendingInputs` (`PENDING_SCAN_PAGE`/`MAX_PAGES`), `config.js` `PENDING_SCAN_MAX_AGE_MS`, `pendingScan.js` | how agent turns / Slack chunks find their pending items (2026-10-04) | no |
| Pending-scan watermark | run start − 1 h, advanced only by an unscoped, scan-complete, drained run | `ingest.js` `advanceWatermark`; `config.js` `PENDING_WATERMARK_MARGIN_MS`; `settings.pending_scan_watermark` | the floor the next scan pages back to; Force resync ignores it (`rescan`) | no (Force resync = manual deep scan) |
| Retry cap | 3 attempts, counter on the idempotent error **event** | `processor.js` `MAX_ANALYSIS_ATTEMPTS` (`:14`); read back `persist.msgAnalysisStatus` (`persist.js:208-220`) | poison messages stop re-billing, visibly | no |
| Thread-context window | 1 day | `config.js` `DEFAULT_THREAD_CONTEXT_DAYS` | messages this recent get full thread + drafts | settings `thread_context_days` (same Status-tab caveat as history) |
| Batch size CEILING | **10**; option list 1/2/3/5/8/10/15/20 (not a free range) | `config.js` `DEFAULT_BATCH_MAX` (`:47`); `prefsTab.js:154-164` | max messages per LLM call, every driver | Preferences "Messages per AI call" (`batch_max`) |
| Adaptive batch: step-down | halve (→1) on a batch failure, split or timeout | `processor.js` `stepDown` (`:48-67`) | keeps a run moving when a size doesn't work | no |
| Adaptive batch: recovery | climb back (×2, capped at the ceiling) after 3 clean multi-message batches | `processor.js` `RECOVER_AFTER` (`:52`) | regains the cheap path once conditions allow | no |
| Batch body cap | 60,000 chars | `config.js` `BATCH_MAX_CHARS` (`:49`) | a batch stops growing past this | no |
| Envelope fetch | probe 50; window 2,500 rows; 100/page; 25 pages; 75s deadline | `processor.js:97,115` / `liveMailSource.js` `PAGE`/`MAX_PAGES`/`FETCH_DEADLINE_MS` (`:12,19,23`) | mailbox listing bounds | no |
| Step timeout | 4 min (job, `config.js:40`), 12 min (tab — hard-coded `processor.js:45`), +60s per extra batch message (`processor.js:219-224`) | see left | stall detection | no |
| Run lock staleness | 5 min | `config.js` `LOCK_STALE_MS` (`:39`) | takeover threshold | no |
| Job budget | 10 min / 60 messages (900s maxRuntime) | `config.js` `JOB_BUDGET_MS` (`:62`) / `JOB_MAX_MESSAGES` (`:65`) / `JOB_MAX_RUNTIME` (`:55`) | background-run bounds | job params override |
| Confirm threshold | > 20 planned messages | `config.js` `NEW_MAIL_AUTO_THRESHOLD` | "are you sure" prompt on big runs | no |
| Cost estimate | $0.05–0.10 per message | `config.js` `EST_COST_PER_MSG` | pre-run estimate shown to the user | no |
| Style-guide refresh | 30 days; an empty guide counts as fresh | `ingest.js:296-304`; Preferences (`style_guide_refresh_days`) | sent-mail re-learn cadence | yes |
| Foreground poll | choices 1/2/5/10/15/30 min, default 5 | `config.js` `FOREGROUND_POLL_CHOICES` / `DEFAULT_FOREGROUND_POLL_MIN` (`:71-72`) | in-tab check cadence | Preferences background block (`prefsTab.js:249`) |
| Status poll / stale-mail prompt | 10 s / 30 min | `config.js` `STATUS_POLL_MS` (`:74`) / `STALE_MAIL_PROMPT_MS` (`:76`) | topbar polling; "mail is stale" nudge | no |
| Thread widening fetch | newest 500 rows when a thread isn't cached | `liveMailSource.js:200-203`; `persist.loadAll` pages at 500 (`persist.js:88`) | thread-load fallback bounds | no |
| Testing flags | `TESTING_STARTUP_PROCESS = false`, `DEFAULT_PROCESS_DAYS = 2` | `config.js:8,13` | gate the manual-stepping mode (`autoUntilMs`) — currently unreachable (backlog: dead code) | no |

### Mail selection

| Rule | Behaviour | Set in | Notes |
|---|---|---|---|
| Unsent DRAFTS are never analysed | dropped at fetch, left out of thread context, and skipped defensively with a `skipped` event if one still reaches the processor | `liveMailSource.js` `draftMarkers` / `listEnvelopes` / `loadThreadRaw` (`:151-165,222,324-336`); `normalize.js:27`; `processor.js:279-291` | Provider-agnostic: Gmail's `DRAFT` label, or the row's parent folder matching the connection's Drafts folder. A skipped draft is never re-planned — and is analysed normally once actually sent (different provider id). |

### Notes (the manual channel)

| Thing | Value | Where |
|---|---|---|
| Retry cap for a failed note | 3 attempts | `persist.pendingInputs` (`maxAttempts`), counted via `inputs.attempts` |
| Drain query time-box | 15 s | `noteIngest.drainPendingInputs` |
| Note-run lock heartbeat | ~15 s throttle | `noteIngest.runNoteIngestion` |
| Per-note analysis bound | `STEP_TIMEOUT_MS` (4 min) | `noteIngest.processNoteInput` |
| Derived-title clip | 70 chars, word boundary | `noteIngest.deriveNoteTitle` |

### Storage & cleanup

| Constant | Value | Set in | Used for | User-adjustable |
|---|---|---|---|---|
| Event body snippet | 800 chars | `persist.js` `BODY_SNIPPET_CAP` (`:13`) | denormalised teaser on events | no |
| Stored HTML cap | 256 kB (text kept) | `persist.js` `BODY_HTML_CAP` (`:14`) | email_bodies size bound | no |
| Reply-strip thresholds | interleave ≥ 40 chars; footer cut past 40% with ≥ 120 chars surviving | `replyStrip.js` `INTERLEAVE_MIN_CHARS` / `FOOTER_TAIL_SHARE` / `FOOTER_MIN_HEAD` (`:68-69,106`) | body cleaning | no |
| Events retention | `events_retention_days` (default 90) | Preferences (`prefsTab.js:114,236`) | **NOT ENFORCED — no pruning code exists (backlog)** | yes (but inert) |
| ~~Reply confidence threshold~~ | REMOVED 2026-09-19 | it had no reader anywhere; the `confidence` field it gated went too | — | — |

---

## Part 3 — Settled decisions (do not reopen by accident)

- **Unknown ids from the model are NEVER adopted** (2026-08-22): reconcile mints fresh ids for
  tmp-shaped or store-unknown `todo_id`/`project_id` values. Regression-tested in
  `verifyNotes.mjs` §5 against the live hijack it fixes; do not "simplify" this back to trusting
  the model's ids.
- **Notes are analysed ON SAVE under the same single run lock** (no pseudo-account, no cursor):
  pending-first persist + save-time run, with the mail run's tail as the fallback drain. The
  lock remains the only concurrency guard.
- **Messages-channel chunk boundaries are settled** ahead of implementation: check-window
  chunks + previous-chunk inlining + a soft debounce — reasoning recorded in
  `specs/superlazy-inputs.md` §4.1 and Next steps №1; don't re-derive gap-based bursts.

- **Only CITED emails are stored** by the bootstrap (bodies + one event each), not the whole
  window (`jobs/bootstrap/adopt.js:295-363`; the setup event says so in as many words,
  `:378`). Changing to "store everything" would require re-bootstrapping. Newsletters/Admin
  buckets look near-empty right after setup and fill from then on.
- **One account at a time.** Every downstream decision — whose mail is "yours", who is
  team, what the cursor means — is per account. Per-account removal works via source tags
  (`persist.deleteAccountData`, `persist.js:492-493`).
- **Re-running setup for an account REPLACES it** (`deleteAccountData` first —
  `setup.js:427,617`), because adoption mints ids past what is stored and would otherwise
  leave two sets of projects for one mailbox.
- **Batching is committed, not dormant** (2026-08-07): `DEFAULT_BATCH_MAX = 10` with
  adaptive step-down/recovery (`config.js:33-47` documents the flip and reasoning). Do not
  quietly revert to 1; the debugging-era value is gone.
- **The touched-share snapshot-refresh trigger was removed** (2026-08-06): a third trigger
  kept overriding the user's cadence settings; the cadence is now exactly what Preferences
  says. Its concern — a growing updates section between renders — is to be answered by
  sending FEWER updates (backlog), not by re-caching more often (`engine.js:43-49`).
- **1-hour cache TTL is the default** — matches the hourly check cadence; the 5-minute TTL
  made cross-run cache reads essentially impossible.
- **Drafts are never analysed** (three defensive layers, see Part 1 §3/§5).
- **Anti-echo is a reconcile contract**: an echoed-unchanged project is a no-op — not
  linked, not bumped, not re-sent as an update (`reconcile.js:334-349`). Its corollary:
  suggested replies and full drafts are never echoed back into prompts (count only).
- **`projectsCitingMessages` stays diagnostic-only** — the automatic thread→project link
  was tried and reverted because it fed an echo/cost spiral (`assemble.js:544-554`).
- **Event importance ranks with the bucket** (2026-08-17): a system action about a
  priority-1 bucket (auto-file decision, mismatch doubt, reprofile, drift note) must not
  out-rank the items it files — otherwise newsletters survive every priority filter. So
  auto-file events stamp the target project's importance (fallback 1) and pure system
  actions stamp 1; the events feed derives the same ranks live for legacy rows
  (`processor.js:410-435`, `eventsUi.eventImportance`).
- **The Inspect page takes no run lock, on purpose** — it is a temporary debug page; the
  user coordinates manually (`inspectRunner.js:12-14`).
- **`manifest.json` is edited textually, never JSON-round-tripped** (compact style).


### Why the analysis contract is shaped this way

*Merged 2026-10-10 from the old core-algorithm spec; checked against `prompt.js` 0.66,
`assemble.js` and `reconcile.js` that day.* The rules themselves are the system prompt
(`jobs/analyze_thread/prompt.js`) and are not repeated here; this is the reasoning behind them,
so a later edit does not undo a choice by accident.

- **The unit of work: one item in, one edited to-do list out.** The model is handed the state as
  of the item's moment (thread so far, running to-do lists, people) and returns what THIS item
  changed — never a list re-extracted from scratch. The reconciled list is the next item's input.
  Several items may share a call (§5), but each keeps its own entry, reconcile pass and event.
- **Projects own to-dos; a thread is transport.** Real work spans threads and channels, so a
  to-do belongs to a line of work. A thread's linked projects are a cached hint that makes the
  common case cheap, not a rule: the model may reassign, pull a catalog project, or start one. A
  project is an outcome the user would name as "one thing" — not a person (people have
  profiles), not a standing category, judged by whether the to-dos are useful together rather
  than by topic. Alternatives toward one outcome (competing quotes, candidates, listings) are ONE
  project named after the choice, or every counterparty becomes its own project. Keywords must
  be precise entities, because generic words never distinguish one project from another in a
  match.
- **Reply with a delta; omission preserves.** Two reasons. Safety: when the model had to return
  whole lists, one under-listing reply wiped every open item; now nothing is deleted by omission.
  Cost: echoing unchanged projects back was a compounding bug (an echo looked like activity,
  kept the project at FULL tier and forced its row into Updates), hence the anti-echo rule.
- **Edit only what you were shown.** The catalog is for discovery. A model editing a list it
  never saw invents its contents; one fetch round paid rarely is cheaper than shipping every
  project in full always. A resolution needs evidence for the same reason: every close must be
  traceable to an item, and reconcile enforces it rather than trusting the prompt.
- **An index, not the history.** Re-sending every prior body was the dominant cost and grew with
  thread length. The running to-do lists already encode what mattered; the evidence trails and
  resolved to-dos are the project's factual memory — which is also why a suggested reply must be
  GROUNDED in that material and never assert a plausible-sounding status it cannot trace.
- **One framing of "now".** The item is treated as having just arrived. The assembler's now-line
  is unconditional (`assemble.js:1014`) so no test-bed "replay" framing leaks into production.
- **People at two levels.** A stable profile (who this person is to the user) and a volatile
  per-project role note (what they are doing here, now) are kept apart so a fast-moving project
  role never overwrites the sticky identity. Team-ness is per project, with no domain seed: a
  shared domain does not make someone the user's team (companies contain many teams), and the
  same person can be team on one effort and external on another. A profile is a prior, not a
  verdict — content wins when they sharply disagree.
- **Direction by who must act next**, not who spoke last; four directions, `read_only` included,
  so FYIs flow through the same machinery instead of a separate score. Importance comes from the
  content first, then from who is involved.
- **One obligation, one to-do; parts are checklist lines.** Near-duplicate to-dos with slightly
  different wording were the commonest complaint; wanting to write text nearly identical to an
  existing to-do is the sign it IS that to-do. Prefer fewer, better items; true noise creates
  nothing.
- **In a forward the inner message is the substance**; the forwarder is transport plus a note
  saying why it was sent.
- **The model proposes; the caller enforces.** Ids, merges, evidence rules, user locks and what
  is persisted are decided in reconcile, never left to the prompt alone.

### Current state lives on entities, history lives on events

*Merged 2026-10-10 from the old core-algorithm spec (its §8.0).* A profile, project or to-do
holds its CURRENT state, not a pile of old versions. What changed and why lives on the EVENT — the
one record per analysed item, which carries the changes, `latest_delta`, `todo_edits`,
`role_changes`, `profile_updates` and the model's notes (`persist.eventFromStep`,
`persist.js:1118`). So "when did this change, and why" is a read of the event log, and a reason is
recorded once, on the event, not smeared across entity fields. Two deliberate exceptions, both
there so history views need no query: a to-do's evidence trail travels ON the project record
(§9), and a replaced solidified profile is archived to the append-only `profile_history`
collection (§11).

Profile updates follow from this: applied in place and eagerly while a profile is still
provisional (after graduation only a re-profile rewrites it — §10, `profiles.js:221`) — the event
log makes a wrong update visible and reversible — while user-set values
(`manual_rank`, user-edited text, `[USER-SET]` responsibilities, `importance_locked`) are never
overwritten by the model. The model judges, the structure records, the user corrects.

### Why batching, a cached catalog and staleness tiers

*Merged 2026-10-10 from the old batching/caching spec (its §1 and §4).* Measured on the
production events log before the change (654 analysed items, opus-family pricing; 101 active
projects, 353 profiles): mean cost $0.135 per item, but **rising with state size** — $0.069 in
the first sixth of processing, $0.20–0.23 in the last two sixths. A `request_more` round
doubled an item's cost ($0.234 vs $0.119) because the whole prompt was rebuilt and re-billed; 14%
of items had one. In a real request, linked-project detail was 29–57% of the bytes, the catalog
of all active projects 29–40%, people 5–7%, the thread index 2–17% — and the item being analysed
about 1%. Every request already ran at reduction level 2 of 4, so content was being degraded on
every call while boilerplate still shipped.

| cause | answer |
|---|---|
| fixed state overhead re-billed once per item | batching (§5): pay it once per call |
| stable content never provider-cached | the cached cold/hot blocks (§6–7) |
| project detail ignored staleness | staleness tiers (§6): quiet projects shrink |

Offline, on the real store (`test/verifyBatch.mjs`): a linked project quiet for 14 days went from
13.9k chars FULL to 3.1k BRIEF (−78%) with every open `todo_id` still visible; moving the catalog
into the cached block cut the volatile block by 56%. Expected economics at the time: ~$0.20 per
item → ~$0.055 batched → ~$0.03–0.04 with the catalog cached.

- **The model never reasons over stale data.** The cached catalog is a transport optimisation;
  correctness comes from the Updates section, which re-sends every touched project's current
  row. Re-rendering is therefore a pure cost policy and follows Preferences exactly (§7).
- **Batches stay small (≤ 10 by default)**: model recall degrades over large document sets.
- **After a restructure, drop the pin — never before.** The clean-up reads the store directly,
  so nothing needs refreshing ahead of it. But applying its proposals (merges, archives,
  renames) can leave the cached catalog describing projects that no longer exist, and the
  Updates section cannot fix that — a merged-away project has no row to override. So applying
  proposals clears `settings.snapshot_pin` (`maintenance/applyProposals.js:347`) and takes the
  shared run lock first (kind `audit`, `:45`), so it never races an ingestion run.

### Standing instructions and workflows — two mechanisms, on purpose

*Merged 2026-10-10 from the old rules-engine spec (its §A–§C and "deliberately deferred").*

- **Do not encode intent as structured conditions and actions.** Either the user clicks through
  cumbersome dropdowns, or the LLM interprets the condition anyway — in which case a rule engine
  buys nothing over handing the model the instruction. So the problem splits in two:
  **standing instructions** are pure prompt text (the model interprets and acts; the app only
  decides which apply, by exact sender / domain / account / all match), and **workflows** are
  app-side algorithms the model never runs — it returns an action name that tells the app which
  one to run (§10). Trigger conditions stay plain language in the prompt; mechanics stay in code.
- **A short-circuit is the last resort.** Skipping the LLM is allowed only when nothing
  higher-priority has a claim on the item: a sender- or domain-scoped instruction, or a possible
  app-subscription match, sends the item through the model with the instruction injected. The
  pecking order is coded precedence in `preAnalyze`, not a declarative framework (§5a).
- **One name, one heading.** The UI's "rules", storage's `instructions` and the prompt's
  "standing instructions" were one feature with three names; the word the user and the model read
  is now *standing instruction* (the collection keeps its name — renaming stored data buys
  nothing). Third-party app instructions sit under the same heading, because to the model both
  are text that outranks its defaults; the policy in the system prompt makes them an ADDITIVE
  layer that never replaces the normal analysis.
- **Where each rides.** A `scope: 'all'` instruction applies to every item, so re-sending it per
  item paid full price for identical bytes: it lives in the cached cold block, covered by
  `durable_sig`, so an edit costs one re-render. Sender / domain / account ones stay in the
  per-item block.
- **Act, then ask.** Putting a sender on autopilot is the stickiest decision in the app, so the
  app refuses to LEARN it for a person-shaped sender. But a stored decision is applied, with any
  doubt surfaced for one-tap review: refusing to apply it sent that sender's mail through the LLM
  for ever, a silent recurring cost with no path to resolution.
- **Deliberately deferred** (hold the over-engineering line): structured rule conditions,
  enforcement hooks and trigger-matcher DSLs (gone, not pending); model-PROPOSED standing
  instructions (`instructions.author` reserves the seam); workflows beyond `automated` and
  `app_subscription` (the registry shape accommodates them); user-editable categories and
  per-category autopilot; a first-sight, label-only short-circuit with no LLM read at all; a
  conditions-builder UI.

### 2026-09-09 — fetch warnings, merge history, project priority

Slack provider errors (including returned error payloads and failures in optional fetches) persist
as account `sync_error` / `token_expired`. The shared status poller reads account warnings and the
page strip keeps them visible until that account completes a successful fetch; an unrelated
successful mail run does not clear them. The strip links to Account Resources and offers a retry.
Manual project merges stamp `action: project_merge`; task history says “merged”, with a fallback
for older merge reasons. Automatic project priority is the maximum open/in-progress item priority,
or 1 when none remain. The shared helper runs on hydration, manual status/priority/add/move/merge
changes, analysis, and after concurrent changes are merged before saving. A manual project lock
preserves its effective priority while its computed priority continues to update.
Regression coverage: verifyMessages (expiry payloads, recovery, merge labels), verifyProjectMerge
(priority drop, override, empty project, reopening, stale hydration), plus verifySessions.
