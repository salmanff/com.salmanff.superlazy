# Pipeline backlog — known issues, simplifications, TODOs

Companion to `specs/pipeline-walkthrough.md` (the spec). Everything actionable lives here;
the spec describes only current behavior. This file absorbs the old walkthrough Parts 2–4,
the open items from the retired next-steps list, and (2026-10-10) the still-open parts of the
retired future-notes, ingestion-coordination and inputs-plan docs plus the "still open" list of
`specs/analysis-experiments.md` §5.

**Last verified against the code: 2026-10-10, PARTIALLY** (commit `90210b2` + uncommitted tree).
That pass checked only the items merged in that day (the "Inputs beyond email", "Mail actions",
"Drafts & reminders", "People & interaction stats", "Analysis quality" and "Standing
instructions" entries, Data growth 0a, Known issue 1.4 and TODO 14) against `pages/`, `shared/`,
`jobs/analyze_thread/` and `jobs/bootstrap/`. Everything else was last checked item by item when
it was written (the full sweep was 2026-08-22), so line numbers cited elsewhere may have drifted.
Fixed items move to the Resolved log at the bottom; they are not annotated in place.

---

## 0. Open design decisions

1. **Wrap the context tunables into one low / medium / high preference.** (User, 2026-09-19.)
   `selection.js` now holds the hot/cold membership formulas — how many projects ride in the
   frequently-rewritten block, how many profiles ride in the weekly one — and `assemble.js` holds
   the per-message context budget. None of the `selection.js` numbers is exposed in Preferences,
   and the decision is **not** to expose them one by one: they should fold into a single "how much
   context to buy" choice (the way `analysis_context_chars` already offers Low / Balanced / Longer
   / Max), so one control moves projects, profiles and everything else together and the user reads
   one price rather than six dials. Until then, every such constant is listed in the tunables
   registry (`pipeline-walkthrough.md` Part 2) and carries its measured cost in a comment.
2. **Recipient profiles — the premise is still the open question.** (User, 2026-09-20.) The 0.55
   tiers (`to:` full, first 2 cc brief) were shipped on the instinct that thin recipient profiles
   cause project mis-assignment. The competing explanation costs nothing to remember: catalog rows
   already carry each project's participant addresses, so address-matching needs no profile at
   all — a profile only adds something when the address is in NO catalog row, or when several
   projects share people and the role is what separates them. **Experiment 6 (2026-09-20) found no
   measurable effect**: 12% of entries filed differently between arms against a 10% run-to-run
   noise floor, and over-creation unchanged. The tiers were kept anyway as a cheap judgement call
   (+734 chars/call) — do not cite them as evidence-backed. If mis-assignment is still a problem,
   look at how catalog rows are matched, not at the people block.
3. **Is the 20-profile cold block worth its tokens?** It was switched on for QUALITY, against the
   arithmetic (it costs ~1,400 chars-equivalent per call and saves ~450 — see the numbers in
   `selection.js`). The claim to test is that the model recognises someone MENTIONED in a body
   rather than sitting on the thread. Nothing measures that yet.
4. **Standing-instruction usefulness.** `rules_applied` (prompt 0.54) records which instructions
   the model says changed an analysis, and the event carries `rules_offered` beside it. The ratio
   is the metric; it measures nothing until the user actually writes some instructions (there were
   zero stored on 2026-09-19). A self-report is a weak signal — if one instruction ever looks
   load-bearing, A/B it on the replay harness rather than trusting the citation.
   **Read the count as a floor, never as a count.** Measured (experiment 5), per message result:
   both models obeyed the instruction 100% of the time (Codex 53/53, haiku 43/43), but Codex put an
   id in `rules_applied` 53/53 times and haiku only 10/43 — it usually emits the field and leaves
   it empty. Clarifying the prompt wording did not fix it. Since haiku is the default production
   model, an instruction showing zero citations may simply have been used by a model that did not
   say so. Caveat on the experiment itself: the probe rule changed the summary's FORMAT, not a
   judgement, so an empty `rules_applied` may be correct rather than a miss — a judgement-shaped
   rule with a scorer that can detect the change is still needed to settle it.

---

## 0c. Routing work to the right person — what 0.65 left open (2026-09-27)

Background: specs/analysis-experiments.md (E11). Shipped: responsibilities as a managed
list (0.64) and the "Who handles what" section + instruction (0.65), 8/15 vs 5/15 live.

1. **Escalations have no mechanism.** A chaser for a missed payment routes by whoever is visibly
   involved — sender, a cc'd colleague, or the user — not by the list, and a clause asking for a
   second "make sure it is resolved" item for the user fired 0 times in 6 runs. The user's choice
   (2026-09-27) is: owner keeps it AND the user gets their own item. Candidate: a standing
   instruction (the one lever that reliably moved behaviour in experiment 1).
2. **History is the strongest router and it ages out.** An email whose supplier already has open items
   on the responsible colleague routes to them with no prompt help (3/3); that precedent comes from the account-for block
   (0.60) and the linked project. Resolved items leave the context after a few per project and
   archived projects vanish, so a lesson learned from history can quietly disappear — the list is
   the durable copy. Worth a clean test: flip the precedent items in memory and watch the routing follow.
3. **Misroutes compound.** 12 of 57 supplier-invoice to-dos sat on the user; every one is precedent for
   the next. The clean-up should look for one kind of work assigned inconsistently and propose a
   bulk reassignment (it already reviews overlapping RESPONSIBILITIES, not yet inconsistent OWNERS).
4. **One supplier's invoices go to a second colleague, 5 of 6, with and without the list.** Consistent enough to be the
   store's own precedent. Correct or not is the user's call — open.
5. **Importance is untouched by routing.** Only a standing instruction moved it (9/11).
6. **Measured on haiku, single-message requests.** Production batches; a batched confirmation is
   still to do. The harness for it is `test/liveArms.mjs` (read-only client, real engine, live store).

## 0a. If third-party app instructions start degrading the analysis

**Not a problem today** (2026-09-20) — four subscriptions, and the measured behaviour is adequate:
luna catches 5 of 5 real matches unaided, haiku 5 of 5 once the closing reminder is in, terra needs
the required-schema-field variant. But every app instruction currently rides in the SAME request
that does the user's analysis, so the failure mode at scale is that they crowd each other and the
analysis both. Two escape routes, explored but NOT built, to reach for if that starts happening:

**(a) Two-step: flag, then work.** The main analysis returns only the match — `{ sub_id }`, no
payload — and a second, focused call does the extraction for the matched message. Measured support:
a focused call with the FULL (unstripped) email produced 136-138 payload fields against 11-14 from
the in-request path, and adding that same full text to the main request made MATCHING worse (8/8 →
7/8 in-request, 5/8 → 3/8 in a dedicated call, both models, consistent direction). The two jobs want
opposite inputs — quoted tables are the content extraction needs and noise that matching trips over
— which is the argument for splitting them.

**(b) App instructions as their own request.** All the app subscriptions sent together in one small
call per message, each answered independently, with the analysis request carrying none of them.
Measured: haiku 5/5 with ZERO false positives (against 5/5 with three false positives when the
reminder pushes it in-request); luna 5/5 either way. Cost ~4,100 chars, about 2.5% of what the
message already costs. It also removes untrusted third-party prompt text from the request that
decides the user's to-dos, which is a better trust boundary than any wording fix.

Both routes separate APP instructions from the user's own STANDING INSTRUCTIONS, and that split is
the point. They are different things: an app's entry is scoped matching criteria that must never
touch the analysis; a user's instruction ("group all such-and-such into this project") is meant to
specialise the analysis itself. One prompt sentence cannot describe both honestly.

**Before adopting either, run the full evaluation** — the numbers above are 5 positives and 3
negatives, one run each. Codex's review named what is missing and it is right: three repeats per
case, a confusion matrix across the three subscriptions, true negatives from unrelated mail,
forwarded originals and replies quoting the same table, and routing scored separately from payload
extraction. Everything measured so far is indicative, not decisive.

**Measurement warnings, learned the hard way in that session:**
- Production's own deliveries are NOT ground truth. Distribution drafts and document-upload notices
  were delivered to the supplier-invoice app with `payload: null`; scoring against them manufactured a
  "ChatGPT is missing emails" problem that did not exist (luna was correctly declining them).
- A harness that silently substitutes when it cannot find what it wants will produce confident
  wrong numbers. Three separate bugs did exactly that: unresolved `request_more` scored as "did not
  flag", unparseable JSON scored as "no detection", and message 1 of a batch scored as the target
  message. Each needs a hard failure, not a fallback.

---

## 0b. The haiku default vs the subscription apps — RESOLVED, with a caveat

**Opened and closed 2026-09-20.** The alarm was that switching the per-message default to haiku
would silently stop feeding a third-party supplier-invoice app: replaying real supplier-invoice emails, the
trigger fired on 2 of 8, and twice haiku analysed the email correctly and simply did not emit it.

Two corrections retired most of it:

1. **Three of those eight should never have been delivered.** Distribution drafts and a
   document-upload portal notice are not supplier invoices (user, 2026-09-20). Production had delivered
   them with `payload: null`. Scored against real positives only, the picture is haiku 2/5 → **5/5**
   with the closing reminder, luna **5/5 with no changes at all**, sonnet 4/5, sol 4/5.
2. **The local-CLI measurement understated haiku.** superlazy's 57k system prompt exceeds the CLI's
   32k argv cap, so it travelled as a user turn; on the metered API haiku did markedly better.

What remains true: **terra (the ChatGPT sonnet-equivalent) catches 0 of 5 untouched** and needs the
required-schema-field variant (§0a, built in the harness, not shipped) to reach 5/5. And the
reminder that takes haiku to 5/5 also makes it flag all three non-matches — accepted deliberately
(user: "it is okay to send false positives").

No model-routing change is needed. The "raise subscription mail to sonnet" plan is explicitly NOT
supported: sol, the Opus-equivalent, scored 4/5 — below luna, the cheapest model tested.

---

## 1. Known issues (correctness — current, verified)

### Lost updates: a hand-closed to-do silently reverts (found 2026-10-10)

Three to-dos the user closed by hand are open again with NO event recording a reopening: t_17g
(cancelled 27 Sep), t_l9 and t_mo (closed 4 Oct). On the same project, two later analyses (29 and
30 Sep) each logged t_17g's importance going 3 → 4 — the second should have seen 4. Both point to a
writer saving a STALE copy of a project record over newer changes (last write wins: the background
job's or another tab's in-memory store vs the user's edit). Not yet traced to the writer. Detection
recipe: compare `manual_edit` status events with the current status and look for reopenings in the
events log (none = lost update).

### Haiku 5.5 cost reads $0 (found 2026-10-10)

The server's Claude connector (adapters/llmConnectors/anthropic.mjs) has no price entry for
`claude-haiku-5-5` (its table stops at claude-haiku-4-5), so calls on family `haiku-5` report
$0.00. Add the price before switching the app's default model to Haiku 5.5.


### Thread ↔ project association — audit 2026-10-04 (user: "project threads showing unrelated threads" after a clean-up). Items 1, 4, 5 FIXED (JOB_VERSION 2026-10-04.7); 2 and 3 OPEN

**Fixed 2026-10-04 (same day):** (1) `messageHistory.projectHistoryEntries` and `viewerContext.
relatedFor` link by thread id for MAIL only (`isMailThreadId`: not `slack:` / `cc:` / `note_`);
chat items reach a project through evidence / changes alone. (4) links can shrink:
`projectStore.unlinkThread` / `releaseTodoThreads` (+ record-level twins for ui.js) release the
threads a moved to-do alone brought, tombstoned in `project.unlinked_threads`; `projectMerge`
merges tombstones 3-way (ours stand; theirs stand unless our baseline had it and we cleared it =
a real re-link) and subtracts them from the thread_ids union; hydrate subtracts too. Applied in
reconcile's two reassignment paths, the clean-up's `move_todo` / `merge_project` (threads MOVE off
the retired source) and ui.js `moveTodo` / `mergeProject`. (5) the Messages tab paints the loaded
log, then replaces it with `persist.loadEventsForProject` (mail threads by id, evidence msg ids,
`changes.project_id`) via `appStore.loadProjectEvents` (cached per load). Offline proof: the
scratchpad `unlinkCheck.mjs` run (13 checks) + verifyProjectMerge / verifyCleanup / verifyNotes /
verifyMessages / verifyUnlinked green. Existing orphan links in live data are NOT swept — see
the proposed clean-up pass below.

**BUILT 2026-10-04 (user asked): the clean-up housekeeping pass for existing orphans** — D5
`previewOrphanThreads` in `maintenance/deterministic.js` (one events scan: thread → projects a
message on it changed; per project each linked thread is cited / touched / ORPHAN), the
`unlink_threads` op (ops.js validate/describe/fingerprint; applyProposals releases via
`store.unlinkThread`, tombstoned, one manual_edit event `field: 'threads'`), wired into the
clean-up page's free housekeeping button (one proposal per project, chat streams counted in the
description). verifyCleanup D5 block: 8 checks (137 total green).


How a thread gets attached to a project: `store.linkThread(threadId, pid)` in `reconcile.js` (a
project entry that changed something real, line ~476; an `account_for` verdict, line ~524 — NEW in
a6ce4fa), `projectStore.addReadOnlyTodo`, `noteIngest`, and the clean-up's `move_todo` /
`merge_project` (`maintenance/applyProposals.js`). `project.thread_ids` is UNION-ONLY: nothing ever
removes a link (`projectMerge.mergeStored` unions, `store.remove` is the only unlink). Readers:
the project card's Messages tab (`messageHistory.projectHistoryEntries`: evidence msg_ids OR
`thread_ids` OR `changes`), the viewer opened from a project (`viewerContext.relatedFor`), and the
request's linked projects (`assemble.js`). Four ways an unrelated thread lands on a project:

1. **A chat stream id is a whole channel.** `chunker.js` stamps every Slack chunk with
   `thread_id = streamId` (the conversation's main flow, or one Slack thread). One chunk filed into
   project X links the ENTIRE channel to X; `projectHistoryEntries` then lists every chunk of that
   channel on X's Messages tab, and `relatedFor`'s `touches` seeds its project list from the same
   id. `relatedFor` already guards the message list (`sameMailThread` — "chat streams stay
   project-filtered"); `projectHistoryEntries` and `touches` have no such guard. Fix: for a
   non-mail channel, count a thread only through evidence msg_ids / `changes`, never `thread_ids`.
2. **`account_for` verdicts link the message's thread to the OTHER project** (reconcile ~524,
   shipped in a6ce4fa with prompt 0.61). The block deliberately lists open items from other
   projects (ACCOUNT_FOR_SCOPE: linked people + owed-by-sender), so a message about Y that the
   model reads as closing an old item in X now puts Y's thread on X — permanently (see 4) — and
   every later message on Y's thread gets X's full list in its request. A wrong verdict is
   therefore self-reinforcing. Proposal: record the verdict's evidence on the to-do but do NOT
   `linkThread` for verdicts (the to-do's evidence already carries the msg/thread for the UI).
3. **A real `todo_id` echoed inside another project's `todos[]` is a MOVE** (reconcile ~350 /
   ~400: `prior.project !== p` → reassign, evidence trail and all). The model sees other
   projects' to-do ids through the account-for block and request_more detail, so one slip drags
   a to-do — and the emails behind it — into the wrong project. The 2026-08-22 guard only covers
   tmp-shaped / unknown ids; a valid foreign id still moves. Proposal: a move from a project that
   was NOT in this request (neither linked nor pulled) is rejected (`type: 'rejected'`) unless the
   entry says so explicitly (`moved_from`).
4. **Links never shrink.** Moving a to-do (clean-up `move_todo`, UI `ui.moveTodo`, the model's
   'moved') links its threads to the destination but leaves them on the source; a mis-filed thread
   stays on the wrong project even after the user corrects every to-do. Proposal: after a move,
   drop a thread from the source when none of its remaining to-dos cite that thread in evidence
   (and make `mergeStored` honour an explicit removal — e.g. a `thread_ids_removed` tombstone —
   instead of re-unioning the stored copy).

5. **The Messages tab only sees the LOADED events log.** The shell loads the newest 1,000 events
   by processed time (`appStore.js` EVENTS_BASE_CAP); `projectHistoryEntries` walks only those,
   and its empty text says so ("…in the loaded events log"). Every clean-up op writes an event
   (`applyProposals.js` — one per `set_todo` field), the hourly job writes cache_refresh rows, and
   every analysed/auto-filed message is one more — so an old thread's message events fall off the
   bottom while a thread linked yesterday (a verdict, a move) sits at the top. That reproduces the
   live report exactly ("the correct thread was not there any more and a new thread showed up")
   with NO store corruption. Fix: the tab should fetch by thread, not scan the window — query
   `events` for `{ thread_id: { $in: project.thread_ids } }` / the evidence msg_ids on demand
   (persist already reads `inputs` by thread for the viewer), or at least top the log up via
   `app.ensureEventCoverage` to the project's oldest evidence asof before painting.

Also noted, not a bug: `liveMailSource` uses the provider threadId (Gmail's is per-mailbox and
stable); `(no-thread):<msg id>` fallbacks are per message; agent sessions are `cc:<repo>:<session>`;
notes are `note_<msg id>` — none of those collide. The viewer's temporary raw-id debug line
(`emailViewer.js`) and the Inspect page's "directly linked projects" line are the tools for
confirming which of the four a live case is.

### Stale suggested replies — FIXED 2026-09-27 (user: "old suggested replies should disappear")

Two causes. (1) Dismissals were never stamped, so the background job's 3-way merge kept its
older `suggested` copy and the draft came back after every job save. Now every draft change is
stamped (`dismissed_asof` / `edited_asof` / `sent_asof`, all counted by `respTouchOf`). (2) A draft
only died when its task closed or YOU replied — a newer message from anyone else left it up.
Now a newer message on the draft's thread retires an unedited draft (reconcile, evidence rule,
events rule — see walkthrough). Measured on live data 2026-09-27: 6 of 26 live drafts retire
by thread activity. The rest (quiet threads, open tasks) are covered by an AGE cut the user
chose: an unedited suggestion older than `DRAFT_MAX_AGE_DAYS` (config.js, 7) stops showing
(`isAgedOutResponse`, display-side). Edited drafts never age out or get superseded (user).

**Send-account incident, 2026-09-27:** a fallback that picked "the only read-write mail
connection" when a draft's account was unknown sent a reply on a work (Outlook) thread
from the user's personal mail account. Removed: the account now comes from the message's event, a
same-thread event, or the project's `email:` source matched to the connection's address — else
sending is off with a reason. The composer always shows a From line.

### Inline replies — FIXED 2026-09-26, final design: COMPARE with the earlier messages (user)

The ask-for-the-body design below stayed as the FALLBACK; measured on the API it fired 2 of 6 times on
haiku. The primary path is now deterministic and format-independent (`jobs/analyze_thread/inlineDiff.js`):
a stripped reply's quoted region is compared, line by line, with the earlier messages of the thread
(the replied-to message, or all prior messages) — lines normalised first: quote marks off, whitespace
collapsed, case and trailing punctuation dropped; a line is "known" when it appears in the earlier
text as a whole line or as a run of it (re-wrapping), quote-marked lines are always known, client
boilerplate (headers, dividers, "you don't often get email", disclaimers) is skipped. What remains is
what the sender typed inside the quote: rendered under the body as "## Inline answers in this message
(N)", each passage under the quoted paragraph it answers. Works for Apple Mail / Gmail (blockquotes)
AND Outlook (no marks; divider + From: block) — `test/verifyInline.mjs` covers both plus a plain reply.
On the real counsel reply it yields exactly the three answers under their three questions.
Corpus check (2026-09-26, the 70 stored mail bodies / 22 replies with a quoted region): after a
COVERAGE guard (the quoted region must be ≥ 50 % recognised, else the earlier message is not in
storage and nothing is claimed), a CONTEXT requirement (an addition must sit under a recognised quoted
paragraph — text at the top of the region is the start of a quoted message we do not hold, usually
the user's own sent reply quoted back), banner/invite/sign-off filters, and a sentence-boundary
normalisation ("week.Hope" = "week. Hope"), the comparison fires on 0 of the 22 ordinary replies and
still finds the 3 answers of the inline one. A SECOND corpus — the Email Cabinet archive on disk, a
personal Gmail account replied to mostly from Outlook: 431 messages, 33 multi-message threads, 85
replies with a quoted region — first fired on 14 of 85, all on quoted SIGNATURE material rendered
differently by the quoting client ("name<mailto:name>", "[cid:image…]", "<image004.png>", "Sent from
Outlook for iOS", a sign-off glued to a name). Fixed by stripping link / image / address artefacts
before comparison, a signature ZONE (from a sign-off line to the next quote header, never an answer),
contact-line patterns, and a floor of three words of prose per addition: 0 of 85 fire, the inline case
still yields its 3 answers. Cost when it fires: a few hundred characters. Re-check both corpora after a
week of mail (`scratchpad/inlineCorpus.mjs`, `inlineArchive.mjs` in the session notes). The flag
then says the rest of the quoted part matched and is optional to fetch. The prompt's email guide says
the section IS the message's substance, no request needed.

#### (superseded) design: the model asks

An HTML reply answered INLINE (Apple Mail: the sender's paragraphs between `<blockquote type="cite">`
blocks, the "On … wrote:" header inside the first block) reached the model as its top note only:
htmlToText emitted the quoted chain with no quote marks, replyStrip cut at the header, and nothing
told the model that anything was left out. The user's three answers to counsel (entity type, name,
address; 2026-09-24 17:51) were never seen; the analyst summarised the mail as "ready to move
forward" and the clean-up, reading that summary, reported the details as unconfirmed.

Design (user, 2026-09-26): NO heuristic promotion of "inline" messages to whole bodies — no rule is
reliable across mail clients and guessing wrong is costly either way. Instead:
- htmlToText renders blockquote lines with a "> " prefix, one per nesting level (DOM and no-DOM
  paths), so a quoted chain reads as a text client would render it;
- replyStrip still strips, but REPORTS `quoted_dropped` (lines left out), recognises a quote header
  or footer opener that arrives quote-prefixed, and normalize keeps `full_text` (the whole text,
  footers trimmed) whenever something was dropped;
- the request renders a stripped reply with "[quoted history not shown: N line(s) — request this
  message's body (message_body, handle mX) if the text refers to it]" and the single-message header
  now names the message's handle;
- the prompt's email guide says: when the visible text refers to what is below it ("answers below",
  "see inline", replies marked by initials or colour), ask for the full body BEFORE judging, and read
  each unquoted passage beneath a quoted paragraph as the answer to it;
- engine.resolveRequests answers message_body for the new message with `full_text` (flagged FULL
  body, quoted lines start with ">"), and processBatch registers the batch's messages so the request
  resolves; persist.inputToBodyView converts an HTML-only stored body to text so the clean-up's need
  line gets words.
`test/verifyInline.mjs` (17 checks: marks, counts, stripping unchanged for ordinary replies, the
flag, the ask → full body → resolve round trip). Replay case `test/cases/p-inline.json`
(the real request, audit kmsoJxb10VY6oqID) measures whether haiku asks. Not covered: Outlook-style
inline answers (no blockquote — delimited by a divider + From: block, answers marked only by colour
or tags); the model can still ask, the flag still shows, but the answers carry no quote marks.

### Stale steps after an outcome — the signed-contract case (2026-09-25) — FIXED in code, replay pending

Eight contract to-dos in p_02 stayed open after email arrived saying task was done (Sep 22). Three
causes, read off `llm_audit` (fixtures: exchanges `o5XfNcEIKmKqxrAf` the outcome mail on a NEW thread,
`ATJKLoEotxyq4OOH` the counterparty's reply, `Mox8HTgxgX571a47`, `WCbHCOpwyzyehzoH` a third party on another new
thread, `ExMCIxDoSyLyuHE9`, `UFrOUh34QtIXTloq`, `BmtBYiytcI8mHT5i`, `oNxdNMrg1lJ9Mha4`):
1. the new thread was UNLINKED, so p_02 was a catalog row only; the model resolved an INVENTED id
   (`review-contract`) and reconcile's id-adoption guard minted it as a blank resolved row
   (t_18y) — fixed by the engine's implicit project_detail round (invariant 3 enforced) and the
   reconcile citation guard. Same gap for every Slack thread, every note, every first session turn;
2. on the reply the full list was shown but the account-for block was thread-scoped (0.40), so only
   the thread-born line got a verdict — fixed by `ACCOUNT_FOR_SCOPE` linkedPeople + owedBySender
   and prompt 0.60's "an outcome closes its steps";
3. the re-org button forbids resolving by design; the clean-up caught it on opus/0.3 and missed it
   on sonnet/0.4 (cleanup prompt 0.5 + audit). Scored replay of the fixes at each level is the next
   step (the replay tools; see specs/analysis-experiments.md E10).


1. **Automatic reprofiles are starved of history.** The engine-side reprofile reads only
   threads loaded *this run* (`historyFromSession` over `session.allById`,
   `engine.js:299`, `reprofiler.js:78-92`) — usually one thread. Graduation reprofiles,
   which exist to learn `user_tone` from ≥3 user samples, almost never have them; only the
   People-page path (`historyFromEvents`, sole caller `reprofileTask.js:71`) gets real
   context. Fix candidate: feed the engine path from persisted events + bodies too.
2. **Reprofile cost is double-counted in reports.** The cost is embedded in the message
   event (`engine.js:664,700-702` → `persist.js:663-670` as `cost` + `cost_reprofiles`)
   *and* written as a standalone `reprofile` event (`processor.js:455-462`);
   `test/costReport.mjs:35-36` sums every event with `cost > 0` with no `kind` filter, so
   totals overstate spend and the per-message mean (`:77,85`) is skewed. Fix in
   costReport: exclude side-event kinds, or stop embedding.
3. **Side events aren't idempotent.** Only `message` / `workflow_short_circuit` / `skipped`
   get deterministic upsert ids (`ANALYSIS_KINDS`, `persist.js:180-188`). `reprofile`,
   `project_drift`, `autofile_*`, `cache_refresh` rows get random ids
   (`processor.js:325-341,455-540`), so a message re-processed after a lock takeover — or
   an Inspect discard/commit cycle re-emitting pending cache events
   (`processor.js:340` vs `:678-680`) — duplicates them. `actionEventIdFor` already exists
   (`persist.js:172`) but has no caller.
4. **Inert settings.** `training_mode` is still inert: displayed (`prefsTab.js` "Training
   mode: …"), never written, and its help text advertises per-account training windows "set on
   the Status tab" that don't exist. Implement or remove. (Re-checked 2026-10-10: the other two
   are gone. `reply_confidence_threshold` was removed with `confidence` in 0.53.
   `events_retention_days` now drives the clean-up page's D1 pruning proposal,
   `maintenance/deterministic.js previewEventsPruning`. It runs lab-first from /cleanup and is
   not scheduled yet; see TODO 14.)
5. **`opts.effort` is unverified against the freezr API.** `analyze.js:179` passes it,
   fed from the "Analysis effort" pref — but `freezr-context.md` documents effort only
   *inside* `thinking` for ChatGPT, not as a top-level ask option. If freezr drops it, the
   pref is a silent no-op. Verify server-side (or in the freezr repo) and either wire or
   remove.
   **RESOLVED 2026-09-17 — verified end to end, it works.** freezr
   `cepsfepsApiController.mjs:3653` reads `options.effort` and forwards it on both the
   streaming and plain paths; `adapters/llmConnectors/anthropic.mjs:402` / `:1290` map it to
   Anthropic's native `output_config: { effort }` (with probe-and-degrade if a model rejects
   it). The pref is live. The replay experiment (`specs/analysis-experiments.md (E1)`)
   points at `thinking:false, effort:low` as the cause of the "I owe" mis-assignments — the
   production A/B is to raise it and watch the cc-only→i_owe_them rate.
6. **Repair-cap overshoot at high max_tokens.** Preferences allow `analysis_max_tokens` up
   to 64,000 (`prefsTab.js:139`) and the repair round silently asks for cap × 1.4
   (`analyze.js:69`) ≈ 90k — likely above provider output ceilings. Clamp the repair cap.
7. **Doc/code mismatch in profile drift.** `profileTuning.js:13-14` claims "a single
   full-magnitude decrement" also triggers a reprofile; `engine.js:284` has no such branch.
   Fix the comment or add the branch.
8. **Stale caching comment.** `analyze.js:142-144` claims the cache option "breakpoints the
   system prompt + each user turn"; freezr places ONE breakpoint at the end of the messages
   (`freezr-context.md`). The `assemble.js` half of this item was fixed; this comment
   remains misleading.
9. **Stale engine header.** `engine.js:3-4` still claims it "replaces the near-identical
   loops that used to live in runner.js and liveRunner.js" — both still exist (see §2B).
10. **Test honesty.** `verifyBootstrap.mjs` still "verifies" wiring by string-matching
    source text (57 `readFileSync` sites; e.g. `:594-595` regex-tests `adopt.js` for
    `business_context` — it would pass if the real wiring at `ingest.js:63` were deleted;
    `:669` regex-tests `DEFAULT_BATCH_MAX = 10`). Convert wiring checks to behavioral ones
    (build a session with a stubbed source, assert the assembled prompt contains the
    section). `verifyBatch.mjs` is genuinely behavioral — keep and extend it.

---

## 2. Where to simplify

### A. Delete confirmed-dead code (safe, mechanical — re-verified 2026-08-17)

- `liveMailSource.js:451-462` `getNewer` — still no caller (supplanted by §3.1 if adopted).
- Processor manual-stepping: `stepNext` (`processor.js:702`), `skipNext` (`:714`),
  `processedSoFar` (`:733`), `peekDetail` (`:737`), and `processEnvelope` (`:210`, only
  caller is `stepNext`). **Note: `peekNext` (`:731`) is now LIVE — the Inspect page calls
  it (`inspect.js:72,300`) — do not delete it.** The `processDays`/`autoUntilMs` machinery
  (`processor.js:75,114,181,609,617`) is permanently disabled (`ingest.js:263` and
  `inspectRunner.js:77` hardcode `processDays: null`) along with
  `TESTING_STARTUP_PROCESS` / `DEFAULT_PROCESS_DAYS` (`config.js:8,13`).
- `index.mjs:68-71` `analyze_message` task — its own comment admits nothing calls it; it is
  the only reason `analyze.js` is imported there.
- `assemble.js`: unused `extraDetail` param (`:525`; the *reprofiler's* `extraDetail` is
  live — don't confuse them), unused `singleCtx`/`parent`/`forkLatest` (`:593-595`; the
  real path re-derives via `ctxOf` at `:665`), the `userMessage`/`volatileBlock` alias
  (`:726-729` — engine reads only `volatileBlock`), the unused `extra` field on ladder
  levels (`:57-61`).
- Unused exports: `newMail.js` `estCostRange`/`newOwnerId`/`runBackgroundCheck` (only
  `ingest.js` uses `estCostRange`, via its own import), `instructionStore.js:55` `textsFor`,
  `profiles.js:154` `isProvisional`, `reprofiler.js:16` `REPROFILE_PROMPT_VERSION`,
  `backgroundMode.js:99` `setForegroundPollMinutes` / `:131` `mailIsStale`.
- Commented-out workflow registry entries (`workflows.js:425-441`,
  `forward_message`/`deep_research`) if they aren't coming back soon.

### B. Decide the fate of the four engine drivers

`processor.js` (production), `runner.js` (thread-replay lab), `liveRunner.js` (chrono page), and
`inspectRunner.js` (inspect page) are four loops around the same engine. The new
`inspectRunner` is the model to copy: it **wraps** `createProcessor` (deferPersist mode)
and reuses `sessionPrefsFrom`/`adoptSnapshotPin`/`stampSnapshotPin` instead of duplicating
the loop. replay/chrono persist nothing, have drifted (chrono has its own autopilot
checkbox), and are still registered pages (`manifest.json`). Either retire both pages, or
reduce them to thin wrappers the way inspectRunner is. This is still the single biggest
LOC/complexity win. (2026-09-22: the model-re-running page moved from /replay to
/threadreplay — `threadreplay.html` / `threadreplay.js`, unchanged otherwise — because
/replay is now the DEMO page, which replays the RECORDING (events + the to-dos' evidence
trails) with no engine at all. The demo shares no code with these four drivers.)

### C. Deduplicate small helpers

- `fmtDate` ×3 with **two different formats** (`assemble.js:80` and `reprofiler.js:20`
  with " UTC", `engine.js:103` without — exported but nobody imports it) — pick one.
- `resolveRequests` ×2 (`engine.js:213`, `reprofiler.js:297`).
- `coerce` ×2 (`analyze.js:16`, `reprofiler.js:279`); `snippet` ×2 (`assemble.js:397`,
  `reprofiler.js:28`); repair-round logic ×2 (`analyze.js:234-283` conversation-style,
  `reprofiler.js:342` string-append style).
- To-do rendering ×3 (assemble's two sites already collapsed into `renderTodoLine`;
  `engine.js:233-237` and `reprofiler.js:160` remain separate).
- `DEFAULT_STALENESS_POLICY` (`assemble.js:258`) duplicates `DEFAULT_STALENESS_DAYS`
  (`config.js:34`), reaching the session by two routes (`ingest.js:64` vs `engine.js:118`).

### D. Unify reprofile persistence

Engine-fired reprofiles are persisted by the processor (`processor.js:422-430,455-463`);
user-requested ones by reprofileTask (`reprofileTask.js:82-98`) — same job, two
implementations, **different archive conditions** (processor requires `solidified_asof`;
reprofileTask also accepts `user_edited`). One `persistReprofile(persist, before, result)`
helper would remove the divergence.

### E. Remove the backfill residue

The backfill task is gone (`ingest.js:200` maps it to newmail), but residue survives:
the legacy alias in `index.mjs:60-61`; `backfill_from`/`backfill_done` fields still
written/read (`processor.js:100,166-167,199`; `jobs/bootstrap/adopt.js:285-286`;
`setup.js:124,573,579`; `manifest.json` schema entries). `backfill_from` is load-bearing
(window floor + cursor-0 fallback); `backfill_done` is written but no longer selects
anything. Check the live DB for legacy records before renaming/removing.

---

## 3. TODO list

### Prompt-regression suite (2026-09-30 — built; follow-ups open)

`test/regression/` + gitignored `testConfidential/` now hold a standing battery replayed against
a FROZEN store snapshot through the current prompt (see `test/regression/README.md` and
`specs/analysis-experiments.md §1`, last section). Built and dry-verified (11 cases, byte-identical
requests across runs); the first live baseline run is still to be done (`--reps 3 --accept`,
~$0.70 metered or $0 via `--via local`). Open follow-ups:
- **Work-channel and Slack cases.** The suite exercises the mail path only; agent-session cases
  (granularity, plan capture, decide-turns) need the session/composite entry points wired in.
- **Multi-message batches.** One message per request today; the burst-collapse class is only
  half-testable without batching neighbours the way production does.
- **Levels-style cases** (a miss baked in, does a later message catch it) stay on
  `test/replayLevels.mjs` with the legacy case files in `testConfidential/cases/legacy/`.


> **Maintenance-shaped items are consolidated (2026-08-31): the Data-growth item 0 (dormant-project
> archiving), 11 (style guide), 12 (business-context lifecycle), 14 (events pruning), and 16 (the
> weekly review) are now designed together in `specs/superlazy-weekly-cleanup.md` §10 — one pass
> registry, one proposal object, one lab-first review UI (plus two new passes: project
> re-organization and forgotten-items surfacing). That spec is authoritative for their design;
> the entries below remain as index stubs.**

### Data growth / archiving

0. **Archive dormant projects (and decide: archiving vs indexing).** Projects/todos accumulate
   forever and `persist.loadAll` downloads every project on every page load — fine today, a
   ceiling eventually. Proposal: move projects with no open tasks and no activity for N months
   out of the default working set, loaded on demand ("show archived"). **Open question — two
   ways to cut it:**
   - *Separate collection* (`projects_archive`): works on any backend regardless of indexing,
     but adds a migration step and two-collection bookkeeping (unarchive on new activity).
   - *`archived: true` flag + query filter*: far simpler, but relies on querying a non-indexed
     field. The "only `_date_modified`/`_id` are reliably indexed" constraint may have been
     overweighted — it was observed on the user's Azure backend specifically (2026-08-18);
     verify whether flag queries are actually a problem on the target backends before choosing.
   Related: the events log has the same growth curve. The UI side is now handled by windowed
   loading (2026-08-18: `createEventsLoader` — pages load per timeframe window / capped with
   "Load older ↓", nothing downloads the whole log any more). Storage-side pruning exists as the
   clean-up page's D1 proposal (TODO 14); archiving old events, rather than deleting them, is
   still open.

0a. **Keyword retrieval: reactivation and similar-project precedent** (from the retired
   future-notes doc, §7). Projects carry `keywords` (3–7 tags the model maintains, lowercased,
   capped at 10 in `reconcile.js`), and catalog rows render them for matching (`assemble.js`).
   The retrieval half is not built:
   - **Reactivation.** When a request is assembled, search stored projects, including completed
     or archived ones, by keyword overlap with the new message, and surface the matches in the
     catalog. A returning effort then re-attaches to its old project instead of spawning a new
     one. This only matters once projects leave the catalog, so it lands with item 0.
   - **Similar-project precedent.** Give the model a finished lookalike as precedent: how it was
     structured, and who did what.
   - **UI search.** Find or filter projects by keyword. No page does this today.
   At this scale overlap can be a plain query over the keywords array; no embeddings are needed.
   Querying a non-indexed field has the same caveat as item 0.

### Inputs beyond email

- **POTENTIAL PROJECT — fold mail's first read into the chronological ingestion (user, 2026-09-11).**
  Today a mailbox's first read is the bulk BOOTSTRAP (`jobs/bootstrap/*`: one big model pass over
  the history window, correction rounds, adopted as a whole via `adopt.js`), while Slack workspaces
  and agent stores are first-read through the ordinary chronological ingestion — and since
  2026-09-11 all saved-but-unread channel accounts are read together in ONE oldest-first pass
  (`setup.js afterChannelSave`), with later saves chained at any run's end (`chainUnreadReads`). A
  new user who presses mail, then Slack, then Codex therefore gets: bootstrap → one chronological
  pass over Slack + Codex → steady state where everything interleaves. The open question is whether
  mail could join that first pass instead of bootstrapping, so the whole history is one
  chronological stream. Not a small change: the bootstrap exists because a mailbox's first read is
  the largest and noisiest input, and its review-then-adopt loop is what makes the result trustworthy
  (`superlazy-bulk-bootstrap.md`). Decision for now (user): KEEP bootstrapping for mail. Revisit
  once the channel-only chronological first read has been judged on real Slack + agent history.

_→ **Work sessions (the `work` channel — Claude Code transcripts via freezr `use_file_sys`): Stage 1 basics BUILT 2026-09-07, live since 2026-09-10** — one input item per request-and-answer TURN, the session is the thread, the agent is a name-only team member; `workSource.js` + `sessionsSource.js` + `sessionDigest.js`, composite generalised, prompt 0.36 work guide, viewer/events rendering, setup page `sessionslab`; walkthrough §15; offline proof `test/verifySessions.mjs` 73/73. Design + open items: `specs/superlazy-sessions.md`. Needs the user to add a local file store at /account/resources (root `~/.claude`), re-install, grant `read_work_sessions`, save repos on the page, then step on Inspect._

_→ **Work sessions — DEFERRED: the git signal (2026-09-08).** Branch, in-session commits and the session-start git snapshot (branch, uncommitted files, five recent commits — `sessionDigest.parseGitSnapshot`, stored as `inputs.repo_state` on a session's first turn, NOT shown to the model) are KEPT as metadata. Decided NOT to build: a special "commit" task kind or any commit-tracking the developer already does themselves; the guide (prompt 0.41) says engineering hygiene is never a to-do unless explicitly asked. Where the data should be used LATER: the Stage-2 forgotten-work pass — a stale session whose changed files are still in the next session-start status list = 'work that never landed', a metadata badge, no AI (`superlazy-weekly-cleanup.md` §10.1, D4). Also possible then: commits-since-last-session by diffing consecutive snapshots of the same repo; a repo outside the freezr tree could be mounted for its reflog._

0. **Channel-agnostic input items — Phases 1–2 SHIPPED 2026-08-22** (channel plumbing +
   manual notes end to end, verified live; see the Resolved log). What REMAINS open here:
   - **The full reset**: drop `email_bodies` and delete the LEGACY fallbacks. See "The full
     reset — checklist" below.
   - **Phase 3 polish** (archive UI for notes, delegate-drafts-to-attendees niceties) and
     **Phase 4 providers** (Granola/Notion notes, Telegram messages, calendar) — spec §11.
   - **Identity aliasing across channels** (Slack user ↔ email). See "People and identity
     across channels" below.
   - **Open questions from the inputs spec** (calendar, chunk debounce, note revisions). See
     below.

1. **Slack (messages channel) — Phase A code-side SHIPPED 2026-08-29** (chunker + slackSource
   + composite jobSource + inputs-ledger wiring + the slacklab Stage-0 page; walkthrough §14;
   `test/verifyMessages.mjs` 40/40). Staged rollout remaining, in order:
   - ~~User: grant + re-install + Stage 0~~ — DONE 2026-08-29 (chunks verified building).
   - ~~Phase B~~ — SHIPPED 2026-08-29: prompt 0.32 messages guide, `renderChatChunk`,
     `channel_data`, `counts.messages` profile branch, noDrafts on chunks; verifyMessages
     55/55. The STEPPING HARNESS is the Inspect page (composite source with persist): plan()
     forms real pending chunks and steps them Save/Ignore — use it for Stage 1 (empty store)
     and Stage 2 (mail-trained store).
   - **The staged test plan (user's numbering, 2026-08-30).** The interim rollout switch was
     RETIRED the same day (a fresh Slack-only install couldn't reach Preferences to flip it):
     messaging accounts are ALWAYS planned by the normal checks now; Inspect remains the
     step-one-at-a-time observation path.
     - ~~2.0~~ — DONE: stepped chunks through Inspect; three feedback rounds landed
       (presentation, project-filtered viewer, prompt 0.33/0.34, always-inline predecessor).
     - **2.1 (CURRENT)** — wipe all data, re-save the roster: verify superlazy works
       SLACK-ONLY (no mail account at all): startup flow, checks (button + background job),
       feeds, viewer.
     - **2.2** — wipe, restore mail training: verify mail + Slack comingle in one oldest-first
       queue.
     - **2.5** — chronology smokes (email obligation → Slack "done" → email, one check, true
       order, cross-channel resolution by evidence).
     - **3.0** — socket mode: live-update runs; getChanges-vs-polling parity on one window.
     - **Bootstrap comingle — DROPPED (user, 2026-08-30).** The settled final shape: mail trains
       one-pass (bootstrap review), Slack trains sequentially through the per-chunk engine —
       always. Slack-in-the-dump was considered and parked: the incremental join against the
       mail-formed map works well enough, and the review UX for weeks of chat transcripts was
       never designed. Revisit only if cross-channel project formation proves weak in practice.
   Deferred by design (v1 logs, doesn't act): edited/deleted-message amendments+tombstones
   (getChanges already delivers the ids in live mode), reaction-driven auto-resolution
   (rendered inline as evidence only), polling-mode revival of OLD threads (replies are
   invisible to getNewer on the main stream; live mode's index covers it), write scope /
   Slack drafts, channel-as-autopilot.

#### The full reset — checklist

(From the retired inputs plan, §0.) Phases 1–2 ran on the existing dataset. The only compat code
is the `email_bodies` read-fallback, marked `// LEGACY-EMAIL_BODIES — delete at reset`. Nothing
forces the reset. The user runs it when they choose, after their other pre-reset changes. No
migration script is needed.
- [ ] Delete the two `LEGACY-EMAIL_BODIES` fallback blocks in `persist.js` (the single-body and
      per-thread readers fall back to `email_bodies` after `inputs`).
- [ ] Delete the `email_bodies` fallback in `subscriptionsCore.js` (the include-original
      snapshot lookup, "checked second for old installs").
- [ ] Drop `email_bodies` from the forget-all / forget-account collection lists in `persist.js`
      and from the "stored message(s)" tally in `setup.js`. Fix the comments that still name it
      (`persist.js` body-store caps, `reprofiler.js`, `liveMailSource.js` body snapshot).
- [ ] Remove `email_bodies` from `manifest.json` `app_tables`.
- [ ] Nothing to do for the `'email'`/`'mail'` evidence names: no synonym helper was ever
      needed (no reader compares them), and legacy `type:'email'` entries go with the data.
- [ ] Then forget-all / drop collections, re-install
      (`/account/home?devUpdateApp=com.salmanff.superlazy` → "Regenerate App from Files"), and
      re-bootstrap. Mail history re-fetches from the provider into `inputs`; there is no manual
      import.

#### People and identity across channels

(From `superlazy-inputs.md` §9.) **Principle:** identities stay separate unless there is an
authoritative or user-confirmed link. People sometimes keep identities apart on purpose, and a
wrong merge is worse than no merge. **Shipped 2026-08-29:** Slack's attested path. `slackSource`
resolves authors and mentions to the profile email (`getUsers`) when the chunk is formed, so
those people land on their existing profile with no merge step. **Open:** people without an
attested email (the workspace withholds the scope, or Telegram: phone/handle only). Today they
appear as a `slack:<id>` address with no profile (`profiles.js` calls this "a later slice"). The
design:
- a channel-scoped, first-class profile keyed `slack:<id>` / `telegram:@handle`, which
  accumulates counters normally;
- profiles gain `aliases: [{ channel, id, display }]`;
- a later link MERGES the channel profile into the canonical one: counters summed, alias
  recorded, and the channel key kept as a tombstone pointer so old evidence still resolves. The
  link is the user confirming "this is that person" in the person editor, or an attested email
  appearing.
- A merge is always user-confirmed, except in the provider-attested case. The People page needs
  nothing until the first non-email profile exists.

#### Open questions from the inputs spec

(From `superlazy-inputs.md` §12. Items 1–3 there were settled when built: a note's project pick
is a pre-link hint, not a constraint; the source tag is `note:manual`; the events `msg_id` name
stays.)
- **Calendar channel semantics.** Analyse before the meeting (for prep), after it (paired with
  notes), or both? This needs its own card and a short spec before its Phase 4 slice.
- **Chunk debounce tuning.** The soft debounce is built with guessed values: `chunker.js`
  `CHUNK_TUNING` (TINY_CHARS 240, HOT_AGE_MS 5 min, MAX_HOLD_MS 15 min). A Slack thread stream
  debounces exactly like a channel's main stream. Settle both against real Slack data once the
  channel is live (stage 2.x above).
- **Prior-revision retention for notes.** `newNoteModal.js` appends every superseded body to
  `prior_revisions`, with no cap. Keep all, or the last N? It is cheap either way; decide when
  note records get large.

### Mail actions (not yet built)

Reading what the user DOES in the mailbox (marks read, flags, moves, archives, trashes, spams)
is phase 2 of the retired ingestion-coordination design. Phase 1 of that design (deterministic
event ids, the timer-free run lock and its stale takeover) is built and described in
`pipeline-walkthrough.md` Part 1 §2 and §11. Items 0–1 are the newer decisions (2026-08-22 and
2026-09-19); where they disagree with the design notes in item 2, they win.

0. **Decide marked_read semantics BEFORE building mailbox-action ingestion.** The old prompt
   rule (a "marked_read" input resolves a read_only "to read" item) went out with the
   mailbox-actions section in 0.53 and never fired. The user flagged (2026-08-22) that
   server-side read is a weak consumption proxy: phone notification previews, mark-all-read
   sweeps and other clients all set it spuriously. Choose deliberately: only explicit individual
   reads (never bulk sweeps), downrank instead of resolve, or no effect at all. Either way it
   never touches obligations, only read_only items.

1. **Mailbox actions belong in the main to-do list, not in their own prompt section**
   (user, 2026-09-19). The prompt's "Mailbox actions (not just new messages)" section was
   REMOVED in 0.53. No source emits an action, so it had never fired, and it spent ~400
   characters of the model's attention on a case that could not arise. The user's instruction
   was that the capability, when built, arrives through the normal to-do path, not as a parallel
   input kind with its own rules. Re-read item 0, decide the semantics, then wire the action as
   an ordinary input item. Do not restore the old section.

2. **Phase-2 design notes still worth keeping** (July 2026; read them through items 0–1):
   - **Two id families.** An analysis event is `ev_<msgid>_<hash(account|msgid)>`, exactly one
     per message. Its existence is what stops double-analysis, and that part is live. An action
     event is `evact_<msgid>_<action>_<hash(account|msgid|action|changeId)>`, one per provider
     change. Many can exist per message (read → unread → read is three). It is replay-safe:
     Gmail redelivers history on overlapping tokens, and a replayed change lands on the same id,
     so the handler checks that the evact record does not already exist before it applies
     anything. `persist.actionEventIdFor` implements the id and has no caller. The manifest
     already declares `events.action` / `events.effects`, `accounts.sync_token` and
     `settings.mail_action_policy` for it.
   - **The loop.** Each account keeps a `sync_token` from `connections.mail.getNewer`.
     `messageAdded` goes to the normal analysis path (skip TRASH/SPAM/DRAFT adds). Label, read and
     delete changes go to the action path. When the token has expired (Gmail ~7 days) or there is
     none yet, fall back to today's window re-fetch + cursor + processed-set, then re-seed. The
     cursor stays as the safety net; this overlaps "Adopt the provider-native cursor" under
     Fetching / cursor. `liveMailSource.getNewer` is still a stub with no caller (§2A).
   - **Metadata never goes to the LLM as a new message.** A move must never be read as new mail.
     A misclassified re-add still hits the per-message `ev_` id and is skipped. The OLD design
     applied actions in a deterministic handler with no tokens at all. The 2026-09-19 decision
     (item 1) instead routes them through the ordinary to-do path, so decide whether that path
     is deterministic (reconcile-style) or model-read before building. If the model ever
     reconsiders a message because the user flagged it, that is an explicit separate request,
     not a side effect.
   - **Provider change → action → suggested default effect:**

     | Provider change | Action | Suggested default |
     |---|---|---|
     | UNREAD removed / isRead=true | `marked_read` | see item 0 (no longer a default ON) |
     | STARRED / IMPORTANT added | `flagged` | bump the linked to-do/project importance |
     | moved to TRASH / `messageDeleted` | `trashed` / `deleted` | resolve read_only items; drop pending suggested replies |
     | moved to SPAM | `marked_spam` | sender signal into the automated-sender workflow |
     | INBOX removed (archive) | `archived` | treat as read/done (pref, for archive-everything users) |
     | other user label add/remove | `moved_folder` | record only |

     Each action event stores `effects: [{ todo_id, change }]`, so the feed can say "you read
     X → 2 items marked read". `marked_read` / `flagged` could also feed `interaction_data` via
     the D2 rebuild; idempotent ids keep them from double-counting.
   - **Prefs:** `settings.mail_action_policy` = `{ marked_read_resolves, flagged_bumps,
     trashed_resolves, spam_learns_sender, archive_means_done }`, each a boolean in a
     "Mailbox signals" group on Preferences. Declared in the manifest, with no UI or reader.
     Revisit the `marked_read_resolves` default under item 0.

### Vocabulary

0. **The CODE still says "task" where the UI now says "to-do"** (2026-09-19). Every user-visible
   string was converted — 124 in the page modules, the three HTML views, the job-path summaries,
   and the `recent` page's title, which is now "To-dos". What was deliberately NOT touched is the
   identifiers: file names (`taskEditor.js`, `taskSort.js`, `subTasks.js`), CSS classes
   (`.task-row`, `.task-meta`, `.task-hist*`, `.chip-task`, `--task-check-on`), module functions
   (`createTasksView`, `taskRowEl`), and the stored field names. Those are a wide mechanical
   rename touching JS, CSS and the manifest together, with no user-visible benefit, so they want
   their own change rather than riding along with a wording pass. The manifest's `files[]`
   descriptions still say "task" wherever they name one of those identifiers, which is correct
   until the rename happens.

### Fetching / cursor
- **Server: Recent cache answers paged single-key sorts short (2026-10-04).** `{ _date_modified: -1 }`
  alone + `count` 300 returns 100 rows and `skip` past them returns 0 (observed on `inputs`).
  superlazy works around it with the two-key sort everywhere; the server should fix the cache gating
  (`appTableCache.mjs` `_isEmptyOrDateSort` / `isDefaultSort`) so a Recent hit never returns fewer than
  `count` when the table holds more. Until then never write a new pager with the single-key sort.
  (Note this was subsequently fixed server side)

1. **Adopt the provider-native cursor**: `connections.mail.getNewer` history tokens per
   account, with the date-window scan surviving only as the expired-token fallback
   (Gmail's window is ~7 days — fine for hourly checks). Deletes most of `processor.plan`.
   The 1-day-overlap window (done) removed the urgency; this is now a simplification, not
   a correctness fix.
2. **Fetch thread bodies lazily**: build the index from envelope metadata (already in the
   row cache); download only the bodies that get inlined (parent, fork-latest, new);
   `request_more` fetches the rest on demand. Today `loadThreadRaw`
   (`liveMailSource.js:198-237`) downloads every body in the thread.

### Prompt structure / caching

3. **Shrink the system prompt.** It has grown to 33,095 chars ≈ 8,300 tokens
   (`prompt.js:23`) — the largest block re-read (at cached rates) on every call. Measure
   which sections are load-bearing (suspects: `AUTOMATED_CATEGORIES` descriptions, worked
   examples); split by volatility. Cache-correctness constraint: no per-run interpolation
   (currently satisfied — it is a plain constant). Use the Inspect page + costReport
   section profile to measure before/after. `verifyBatch.mjs` must still pass.
4. **Consider moving the style guide into the durable turn.** Business context and the
   workflow instructions moved (0.22); the style guide is 30-day-stable but still rides the
   volatile block on every drafting message (`assemble.js:620`). Moving it means adding it
   to `durableSig` so edits invalidate the pin. Standing instructions stay volatile — they
   are matched per-sender.
5. **Prune the catalog**: full rows only for projects with open owed/owing to-dos;
   recently resolved (~2 days) as a one-line "recently closed" row; older resolved
   title-only or omitted (recoverable via `request_more`). Rows currently never leave.
6. **The task-send policy (strawman — decide before implementing).** Today the full tier
   sends ALL open to-dos and the newest 10 closed, reduced only under budget pressure. A
   months-old project accumulates junk; the model needs full detail only where THIS message
   might advance the item — a one-liner suffices to prevent duplicates. Proposed: three
   send levels per to-do — **full** / **line** / **omit** (covered by a count note) —
   per-type parameters in one `settings.task_send_policy` object:

   | Type | full when | line when | omit when |
   |---|---|---|---|
   | Action to-dos (i_owe_them / they_owe_me / team_owes) | evidence touched within `action_full_days` (14) OR due within 7 days OR importance ≥ 4 — and always the newest `action_full_min` (10) | every other open action, capped at `action_line_max` (30) | beyond the cap: "… and N more open items (request_more for the list)" |
   | Reads (read_only) | never (a read IS a one-liner) | created within `read_line_days` (2), capped at `read_line_max` (10) | older/beyond: "… N unread FYI items exist" |
   | Closed (resolved/cancelled) | never | resolved within `closed_line_days` (2), capped at `closed_max` (5) | older: "… N older resolved items — they are DONE, do not recreate" |

   Notes: (a) the WITHIN-project analog of the project-level staleness tiers; composes with
   them and the reduction ladder; (b) every omitted set keeps a count note; (c) open
   ACTIONS are never omitted silently; (d) all knobs in one settings object, UI later.
7. **Updates-section policy.** The volatile "Updates since the catalog snapshot" section
   re-sends a row for EVERY project touched since the render (`engine.js:460`
   `updateIds: [...snap.touched]`), which grows between renders (~100 tokens per project
   per message). Candidate: send only rows for projects relevant to THIS message (linked,
   or named in its analysis). Measure the section's size first — the instrumentation
   exists (`request_profile` sections on events; Inspect page; `costReport.mjs:96-108`).

### LLM call tuning

8. **Thinking default ON**, Preference becomes the off-switch (`ingest.js:56`,
   `prefsTab.js:129`). The per-message thinking-token counts are already recorded, so the
   cost is measurable.
9. **Revisit `max_tokens: 40000`** using the actual output-token distribution from events
   (and clamp the repair cap — issue §1.6).
10. **Verify `effort` reaches the provider** (issue §1.5) before tuning it.

### Style guide & business context

11. **Rethink how the writing-style guide is built** (today: one LLM call over ≤8 sent
    mails, cached 30 days, `userStyle.js`). Candidates: more/better-chosen samples
    (per-recipient tone pairs), rebuild on user edit, or fold into the reprofiler's
    `user_tone` machinery so per-person tone and global style stop being two systems.
12. **Manage the business-context lifecycle**: written once by bootstrap (including
    time-bound parts like "Top of mind in this window") and never refreshed; the only edit
    path is the bootstrap refine box. Decide the refresh cadence/trigger and build an
    editor. (An edit now correctly invalidates the cached pin via `durable_sig` — the
    missing piece is the editor and the cadence.) Related: the weekly review (§4.2) wants
    to recompile it.

### Drafts & reminders

- **Reminders never fire** (from the retired future-notes doc, §1 `reminder_mode` and §6). A
  `reminder` draft carries `reminder_at`, and the project card shows it
  (`expandableProjectView.js`, ⏰). Nothing acts on that date: there is no scheduled send, and
  the draft is not resurfaced. Cheapest first step: resurface the draft when `reminder_at`
  passes. Sending on schedule needs the composer's send path plus a scheduled job. The
  deferred pref was `reminder_mode`: surface-only by default, scheduling opt-in.
- **Reply phrasing variants + a phrasing pref** (future-notes §5a, deferred). The model
  returns three variants per suggested reply (e.g. formal / warm / terse) as
  `variants: [{ label, body }]`, with `body` the chosen one. A user "phrasing" pref picks the
  default and is fed into the prompt so drafts skew that way. UI: a phrasing toggle on the draft
  card. Weigh it against what exists (the per-person "your tone with them" note overrides the
  style guide per draft) and against the output-token cost of three drafts per reply.

### People & interaction stats

(From the retired future-notes doc, §3.) Regeneration is BUILT: the clean-up page's D2
housekeeping pass (`maintenance/deterministic.js previewInteractionRebuild`) recomputes each
address's mail stats from the events log. It also stores true reply-latency medians, which the
People page prefers over averages (`peopleData.js`). Still open:
- **It runs only on demand** (lab-first, /cleanup). Scheduling belongs to the maintenance spec.
- **Two approximations it already discloses:** only ANALYSED messages have events, and reply
  pairing is thread adjacency, not the true In-Reply-To parent the live counter uses.
- **More nuance:** reply RATE (what share of their asks the user answers, and vice versa),
  thread-initiation balance, and recency-weighted volume so dormant contacts decay.
- **Consumption:** the People page sorts by volume, activity, open items and rank
  (`peopleData.SORTS`), not by responsiveness. A reply rate could calibrate `reminder_at`.

### Analysis quality — open from the experiments

The "still open" list of `specs/analysis-experiments.md` §5, one line each. The evidence lives
under the E-label cited.
- **Right owner, wrong label** (E1). The model names the right person and still writes "I owe".
  Nothing catches it. Two fixes are already ruled out: a direction/owner invariant in the prompt
  (it backfired) and an app-side guard that rewrites the verdict (deleted; see §4 decisions).
- **No false-negative fixtures** (§1 method, regression suite). Nothing measures obligations that
  never reached the user's list. Add cases whose correct answer is an item production missed.
- **Standing-bucket names belong in code** (E2). A roughly one-in-six miss on a decision taken
  ~100×/week mints a duplicate of a standing bucket. Only the no-LLM short-circuit resolves
  buckets by name today (`workflows.js`, `AUTOMATED_CATEGORIES[].bucket`). Reconcile could
  resolve a new project named like a bucket into the existing one.
- **Trim the catalog summaries** (E2). Stripping all 25,250 characters of summary made no
  measurable difference to matching. The user declined summary-less brief rows on 2026-09-13
  (context loss), so this is a decision to re-take with E2's evidence, not a mechanical cut.
- **The top of the importance scale is unused** (§2 starting state). 5 appears twice in 1,345
  items. Recalibrate the scale's definitions, or decide whether importance needs its own
  mechanism: in E11 only a standing instruction moved it.
- **"All checklist lines ticked → done"** (E10). The model ticks every line and keeps the to-do
  in progress for the counterparty's next step. The candidate is an objective rule. It must
  live in the prompt or the clean-up, not as code that overrides the model (E1 decision).
- **Bisect the length of a responsibility entry** (E11). The long assignment paragraph plus the
  clause routes 14 of 16, and a one-liner never routes. Find the shortest text that works. Also
  re-judge "approval request addressed to the user" cases before scoring them as misses. See §0c.
- **Does the goal framing help mail as well as the work channel?** (§4 granularity, 0.57–0.59).
  It shipped with no control arm. The arm machinery (`promptVariants.js`, `promptOverride`) is
  ready.
- **The notes channel never sets a goal** (§4 granularity). So the goal ruler has nothing to
  size a note's to-dos against.
- **Cross-session duplicates have no text-match floor** (§4 granularity, work channel). When
  the same to-do is raised in a second agent session, only the model's judgement catches it.
  No deterministic near-identical-text check backs it up.

### Standing instructions

- **Try an instruction before adopting it; promote with consent.** Replay a proposed standing
  instruction against recent mail (the replay harness / regression battery) and show what it
  would have changed before the user adopts it. Add a consent-gated path for promoting a
  user's own rule into the shipped defaults. (From an archived v1 rules spec. The usefulness
  metric is §0 item 4.)

### Debug / observability

13. **Email-modal debug toggle**: raw stored body vs the recomputed `prepBody` trimmed view
    (deterministic — no schema change), so trim quality can be eyeballed. Consider a
    third-party reply-parsing library only after seeing real failures. (Also: remove the
    temporary raw provider-id debug line, `emailViewer.js:185-189`, once the thread-linking
    bug is closed.)
14. **Events pruning — schedule it.** Built lab-first as the clean-up page's D1 housekeeping
    proposal (`maintenance/deterministic.js previewEventsPruning` / `applyEventsPruning`, driven
    by `events_retention_days`, default 90). It still only runs when the user presses the
    housekeeping button. Scheduling it is the maintenance spec's call
    (`superlazy-weekly-cleanup.md` §0, lab-first rule).

### Carried over from the retired next-steps list (still open)

15. **The email modal treats one stored message as a whole thread.** The rail is built from
    stored bodies and only falls back to the live thread when **nothing** is stored
    (`emailViewer.js:559-563`); after setup a thread usually has exactly one stored message
    — the cited one — so the user sees a truncated conversation with no indication.
    The thread-is-short signal is knowable and free: RFC 822 `References`/`In-Reply-To` —
    `dumpBuilder.js` already computes `startsEarlier` → `partial_threads`, stored per
    project (`adopt.js:144`) and **displayed nowhere**. Approach: offer "Load the rest of
    this thread" → `loadLiveThread` → merge by `msg_id` (stored view wins); either persist
    `in_reply_to`/`references` on `email_bodies` (schema change, re-install) or always
    offer the control and hide it when the fetch finds nothing new; surface
    `partial_threads` on the project card. Done when: a cited email opens to the whole
    conversation or an honest control; a complete thread shows no dangling affordance.
16. **The weekly review — audit + questions + learnings + recompiled context.** One
    scheduled pass (Monday morning) that re-reads the week's decisions with a stronger
    model, catches misfilings, surfaces what it could not settle, folds in answers, and
    recompiles the business context. One feature, not four — one bootstrap-shaped pass
    (~$0.20–0.60/week) reusing `dumpBuilder`, the JSONL streaming contract, and the
    questions-tab UI. **Design decisions already settled — do not re-litigate:**
    - The bar for asking: the answer must become a **standing rule** (maps onto an
      `instructions` record). One-off questions don't qualify.
    - Two learning stores, no new one: entity/who's-who facts → `settings.business_context`;
      sender handling → `instructions` (its `author` field already anticipates
      "suggested-by-model, accepted by user").
    - Unanswered questions are stored but MUST NOT be compiled into the context (the
      context holds settled facts only).
    - A third resolution state: **settled by evidence** — closable without the user seeing
      it.
    - User edits survive recompilation (reuse the `user_edited` immutability pattern).
    - Ignoring is a permanent, valid answer; questions age out.
    - Recompiling invalidates the cached prefix — fine because it is scheduled.
    **Do the cheap check first**: look at what the real bootstrap run actually asked; if
    most would be answered by a few lines of business context, the higher-value feature is
    prompting the user to enrich the context. **Fast path stays**: act-and-surface for
    individual decisions (built), weekly review for structural questions.
    Blocker noted in `jobs/bootstrap/index.mjs`: `dumpBuilder.js` imports from
    `../analyze_thread/`, which a job bundle cannot reach.
17. **Auto-file: open questions left deliberately undecided** (all three still open,
    `workflows.js` unchanged):
    - Is `source: 'bootstrap'` really user-backed? It exempts a sender from the address
      heuristic on **implicit** consent (`workflows.js:97-100`). Stricter: bootstrap marks
      kept senders `locked: true` — but locking freezes the disposition so the model can't
      refine newsletter→admin on its own.
    - Should ignoring a doubt N times settle it? It currently re-raises per message
      (`workflows.js:342-347`). Auto-confirming matches "ignoring is a valid answer", but
      silently promoting silence to consent is exactly the pattern to be careful with.
    - The heuristic is weak: `MACHINE_LOCAL` (`workflows.js:63`) is a word list over the
      LOCAL PART only — a bulk sender on a machine-looking subdomain (`interactive.<publisher>.com`)
      counts for nothing.
18. **Preferences for the remaining dials**: `llm_cache`, `snapshot_1h_ttl`,
    `staleness_policy` are read with safe defaults and have no UI. (`batch_max` and the
    snapshot cadence got theirs.) Honest labels; quote real numbers from a week of running.
19. **Per-account "Rebuild cache" button** — the one unbuilt piece of the snapshot-pin
    sketch.
20. **Status tab tidy-up**: `statusTab.js:119-166` still renders the old
    history-days/thread-days/model/context form whose values the setup flow discards
    (`setup.js:539-542`). Remove the fields or wire them as the setup view's starting
    values. May be subsumed by the new `bootstrap.html` page replacing the startup training
    flow.
21. **freezr core: pricing is LLM self-reported** (outside this repo).
    `info_freezr_account_llmpricing` is populated by asking a model what it costs; observed:
    `claude-fable-5` stored at $1/$5 (real: $10/$50), `claude-opus-5` absent. App-side
    mitigations are in place (`modelPicker.js`: refresh on stale/gap, "price unknown"
    labels, raw token counts printed per call). The real fix belongs in freezr (an official
    pricing source or signed-off table). Check whether the 2026-08-03 session's freezr-repo
    changes (anthropic.mjs streaming-usage merge; pricing returned on both ask paths) were
    committed.

---

## 4. Resolved log

### 2026-10-10 — Three retired design docs merged here; what they still carried that was already done

The still-open parts of the future-notes, ingestion-coordination and inputs-plan docs now live in
§3 (Data growth 0a, Inputs beyond email, Mail actions, Drafts & reminders, People & interaction
stats). Dropped as already done or obsolete, checked against the code:
- the reply-confidence threshold and the confidence-gated surfacing behind it. `confidence` was
  removed in 0.53; nothing reads it.
- prefs now built: `your_addresses`, the model picker, `style_guide_refresh_days` (30-day style
  cache, `ingest.js`), `suggest_replies`, `batch_max` (was "message cap"), per-account Pause
  syncing (was "included connections"), `events_retention_days` (D1).
- `prune_aggressiveness`, dropped. The automated categories, buckets and `automated_autopilot`
  cover it.
- per-relationship tone: the "your tone with them" note is built.
- the `interaction_data` rebuild and medians (D2).
- durable persistence, the "Part 1 / Part 2" framing, the batching / cache / snapshot /
  footer-trim cost levers, and multi-channel projects. All built.
- a real send for drafts: the composer is built.
- full-email prefetch for drafts: the viewer reads stored `inputs`. Thread completeness is
  TODO 15.
- the request_more cap / tool-calling seam: it is a note, not an action.
- the phase-1 idempotency/lock design, now in the walkthrough. Its per-message claim was
  removed in July.
- the inputs plan's Phases 1–2: shipped (entry below).
- the "Bootstrap comingle rides the full reset" and duplicate "Stage 2.5/3" lines in the Slack
  item. Comingle was DROPPED by the user on 2026-08-30.

### 2026-10-04 — Thread links can shrink; chat stream ids no longer pull a channel onto a project; the Messages tab fetches by thread (JOB_VERSION 2026-10-04.7)

See "Thread ↔ project association" under Known issues for the mechanism and what remains (2:
account_for verdict linking, 3: foreign-id moves — to be done next).

### 2026-10-04 — Clean-up changes showed as "you resolved …" in the To-dos page's "since last night"; the WHO filter trio added there

`applyProposals.js` records every accepted clean-up proposal as a `manual_edit` (source
'maintenance'), and both pages classified any `manual_edit` as the user's own hand. One shared
classifier now (`eventsUi.eventWho`: manual / auto / superlazy; `isMaintenanceEdit`): a clean-up
change is SuperLazy's (it proposed it), renders as "the clean-up resolved …" with a 🧹 disc on the
digest and as "Clean-up on Superlazy" on the Messages page, and the To-dos page's bar carries the
Events page's three WHO buttons. With one pressed, the digest, the Messages tab and the timeframe
window itself (`windowedTodoIds`, fallback off) count only that actor's events. "Last night" was
midnight at the start of YESTERDAY (up to 48h); it is now the most recent 6pm, never more than 24h,
still on PROCESSED time (`filterBar.sinceMsForPreset`, `recentData.processedClock`) — user,
2026-10-04.

### 2026-10-04 — Subscription prompts were silently cut at 1,000 characters (JOB_VERSION 2026-10-04.6)

`containedPrompt` (subscriptionsCore.js) sliced every requester prompt at 1,000 chars, at intake AND
at injection, with no warning to anyone. All three supplier-invoice prompts are 1,156–1,315 chars, so
the tail of each "Return JSON" spec never reached the model: it invented payload field names (37
distinct keys across 26 "call made" deliveries; admin-summary rows say `ccy` 17× vs the spec's
`currency` 4×). Detection was unaffected (the matching criteria come first), which is why nobody
noticed. The approval screen showed the user the cut text, so what was approved was itself
incomplete. User decision: NEVER cut — "if the user accepts the prompt, they accept it"; warn and
refuse instead. BUILT: no slice; `PROMPT_MAX_CHARS = 3000` is a REFUSAL threshold — intake stores
an over-length request as `denied` with a reason naming length and limit (Connected tab + status
message to the app); `setSubscriptions` drops over-length records defensively; intake recognises a
stored prompt that WE cut (hash equals the 1,000-cut hash) and completes it with the reason "an
earlier version had cut this text… approve again" instead of "edited by the app". Contract
(app-comms.md §5) says ≤ 3000, never cut. Effect on the user: the three supplier-invoice subscriptions
go back to pending on the next Connected-tab visit, with their full text, for one re-approval each.
Test: test/verifySubscriptionPrompt.mjs.

### 2026-10-04 — Stranded pending agent turns + one failing account stopped every run (JOB_VERSION 2026-10-04.4)

Symptom: the user said "great. thanks. done" in a Claude Code session and the task it closed
stayed open. Both turns of that session had been formed as `inputs` status `pending` at 19:07 and
were NEVER analysed (0 events) — 34 pending agent turns in all, none of them visible to any run.
Two mechanisms, both verified on live data: (A) `persist.pendingInputs` read the newest 300 input
records by `_date_modified`; a four-day mail backlog wrote 339 body records overnight, the 21
turns dropped past rank 300, and the next formed turn (09:41) moved the localClaude cursor past
them — `plan()` only queued `date >= cursor` or items WITH an error event, so pending-without-event-
below-cursor had no path back, ever. (B) born below the cursor: an envelope's `date` is the prompt
time but a turn is formed when it ENDS; a long turn (t26, prompted 12:31, formed 12:49) lost to a
short turn in another session (prompted 12:33, analysed 12:37 → cursor 12:33). The clean-up could
not catch either — it indexes analysis EVENTS only. The checklist line about OpenAI pricing was
not what blocked closure.
FIXED: `persist.scanPendingInputs` + `pendingScan.js` (page the indexed sort to a floor;
`ingest.js` floor = max(watermark, now − 30 d); the watermark advances only after an unscoped run
that scanned to its floor and drained — `settings.pending_scan_watermark`); `plan()` queues
`QUEUE_CHANNELS` items below the cursor with no event at the head (`strandedCount`) and exempts
them from the date-window cut; Force resync passes `rescan: true` (watermark ignored). SEPARATE
FIX same day: one account whose mail token had expired threw out of `fetchAllRows` → the composite's
`Promise.all` → `plan()` → the whole run (every account) until the user re-authorised. Now per-
connection / per-child isolation with `accountErrors()`; `plan()` excludes failed accounts from the
window arithmetic and the seeding; notices name the skipped account with a Reconnect link; the
page guard no longer redirects on a listing failure. Test: `test/verifyStranded.mjs` (21 checks).
First run on the new code pages the whole 30-day collection once and analyses the 34 stranded
turns (a few dollars; Oct 3 content lands a day late). Walkthrough §3 updated.
FOLLOW-UP the same evening (JOB_VERSION 2026-10-04.5): the first .4 run planned 9, found 1
stranded and STAMPED the watermark — the scan had stopped after one page of 100. Cause is a
**freezr SERVER quirk, not superlazy**: a query sorted by EXACTLY `{ _date_modified: -1 }` can be
answered from the datastore's Recent cache (`adapters/datastore/cache/appTableCache.mjs`,
`_isEmptyOrDateSort` / `isDefaultSort`) with the ~100 records it holds, whatever `count` asked
for, and `skip` beyond them returns nothing. Measured on `inputs`: count 300 → 100 rows; the same
with `_id: -1` added, or ascending, → 300. Projects/profiles/events happened to page fully today,
but the cache state decides, so EVERY superlazy pager now sorts `{ _date_modified: -1, _id: -1 }`
(`persist.NEWEST_FIRST`; cleanupCore, deterministic, reprofileTask, archive, maintStore,
recentData, subscriptionsData) and the scan treats only an EMPTY page as the end. This also means
the old `pendingInputs` "newest 300" was really newest 100 all along. The watermark was reset to 0
by API. FOR THE SERVER SESSION: Recent should not answer a query whose `count`+`skip` exceeds what
it holds (or should fall through when the single-key sort is paged) — see also §3 TODO below.

### 2026-10-04 — Lock refusals name the holder and say when a dead one frees the lock (JOB_VERSION 2026-10-04.3)
A Prefs "Run now" clean-up was running in-process when the dev server restarted; the job died
without reaching its `finally`, so the run lock stayed behind as an orphan for the 5-minute stale
window and the /cleanup page's Run reported only "another run holds the processing lock (cleanup)"
— indistinguishable from a live run and read as a failure. Nothing was stamped (no failure, no
cost), because the failure path never executed. FIXED — new `jobs/analyze_thread/lockText.js`
(pure): `describeLockHolder` says who holds the lock (background / other tab / Inspect / agents
lab), its stage, when it started, its last sign of life (`_date_modified`) and how long until
`expires_at` frees it if the holder has died; once lapsed it says the next start takes over. Used
by cleanupCore (page and job), agentslabRun, and the mail-tools status note (`lockReleaseHint`).
Still open: a job killed with its server leaves no record at all — a startup sweep that marks an
orphan lock's run as failed (and stamps `cleanup_last_run` with `failure`) would make it visible.

### 2026-10-03 — Burst collapse was being undone by the automated-item backstop (JOB_VERSION 2026-10-03.1)

Found by the regression battery (`batch-burst`). In a batch of five near-identical portal notices,
the model collapsed them into ONE item — message 1 created it, messages 2–5 either updated it or
returned nothing — and `backstopAutomatedItem` then minted a "recovered" item for each of 2–5,
because an update writes no `changes` entry and an empty entry looked like "filed nothing". The
backstop now treats a message as filed when an item already cites it, or when an earlier message
of the same batch from the same sender created a read item (the message is added to that item's
evidence); either way it gets an `absorbed` feed row ("added to …" on Recent, "folded into it" on
Events). Online: Sonnet 2/3 → 3/3 saved-item collapse, Haiku 0/3 → 2/3 (the remaining Haiku miss is
the model itself writing five items). `test/verifyBackstop.mjs` covers both shapes and that the
other paths are unchanged. Likely a large share of the 230 items in "Admin - Action needed".


### 2026-09-19 — Native structured output, ChatGPT only (JOB_VERSION 2026-09-19.2)

freezr gained an additive `structuredOutput` option (provider-neutral: Claude `output_config.format`,
ChatGPT `text.format` + the Chat Completions fallback, the local Codex CLI `--output-schema`; strict
parsing; capability-gated; a rejected SCHEMA is a 400 with the provider's wording and never a verdict
on the model). Measured on the recorded cases (`specs/analysis-experiments.md (E4)`): with a
schema 0 of 17 ChatGPT runs dropped a `msg_id`, against 5 of 15 without; nulls per to-do roughly
doubled (strict mode writes every optional field); Anthropic REFUSES the schema (29 nullable fields
vs its cap of 16, plus a grammar-size ceiling) and haiku was 9 of 9 without one; a schema forks
Claude's cache rather than breaking it. DECISION (user): send it to ChatGPT and not to Claude, always.
Wired as `engine.schemaFor` beside `ensureModel` (which now records `session.provider`);
`analysisSchema.js` builds it per call, pinned to the batch's handles; it rides into detail and
repair rounds; reconcile normalises the schema's array form of `participants` to the stored map;
the audit record keeps name+size+hash, not the schema. Claude path byte-identical. Superlazy cannot
see local Codex resources without the server env var `SHOW_LOCAL_AGENT_IN_APPS=true` (creator-only
policy). Pre-existing bug noted: naming a provider the app cannot see silently routes to Claude
with a stale default model id (404).

### 2026-09-19 — Dead-mechanism cut, one `who`, haiku by default (prompt 0.53)

Two weeks of replay experiments and the clean-up they justified. Full write-up, method and
findings: `specs/analysis-experiments.md`.

REMOVED (each a field the model filled with no reader at the other end, or machinery hanging off
one): `confidence` on to-dos, replies and profiles, plus the never-read reply-confidence
preference · `fit_concerns` and the ENTIRE profile fit accumulator — fit score, drift log,
out-of-sync badge, the drift re-profile trigger in `maintainProfiles`, `applyFitConcerns`,
`markNeedsReview`, six tuning constants, the People-block fit line, the person-editor and
people-page renderings, and the review prompt's needs_review filter (0 emitted in 983 analyses;
graduation re-profiles are untouched) · `project_drift` — the prompt field, `recordDriftAssessments`,
the event kind, the events-feed glyph, the inspect panel, `PROJECT_TUNING` (5 assessments ever, 0
alerts, no consumer) · `manual_locked` — the invariant, the renderings, every initialiser (set on
0 of 1,345 items) · the prompt's mailbox-actions section (see §3). NOT removed: `owners[]`, which
is live in the UI (joint owners in the task editor, People-page matching) and is now filled from
`who`.

CHANGED SHAPE: the model now emits ONE `who` — a LIST, usually one person, several when genuinely
joint, lead first — instead of sender/owner/owners[]/counterparty. Storage is unchanged and
`jobs/analyze_thread/whoMapping.js` is the only translation, writing exactly the shape the task
editor writes (owner = lead, owners[] = the list; counterparty comma-joined for i_owe_them), dated
and deletable. Covered by verifyMessages §11. `new_for_me` / `new_for_team` are derived in reconcile from the directions of the
to-dos actually minted, instead of being asked for and trusted — six events had claimed news for
the user with nothing created. The dead `Array.isArray(ld.new_for_me)` test in `messageHistory.js`,
which meant that chip had never once rendered, is fixed. The prompt now uses one word per thing:
to-do, checklist line / component, run.

DEFAULT MODEL: the user's own default PROVIDER is kept and only the FAMILY is steered, to the small
fast one — `config.preferredFamilyFor`, resolved once per session by `engine.ensureModel`. ONLY
CLAUDE IS LISTED (→ haiku). Six ChatGPT models were replayed against the same cases
(`specs/analysis-experiments.md (E3)`). Scored as "usable with no repair round":
haiku-4 **9/9**, gpt-5 4/6, gpt-5-nano 4/9, gpt-5-mini 2/9, gpt-5.6-terra 1/9, gpt-5.6-luna
**0/9** — and luna/terra are precisely the two named elsewhere as haiku's and sonnet's
counterparts. THE BIGGEST SINGLE DIFFERENCE: every ChatGPT model, full-size gpt-5 included, omits
`msg_id` on batch entries, which classify() rejects — haiku filled it on all 9. The rest split
into asking for a detail round when told none was available (luna 6/9, mini 4/9, terra 2/9) and
returning nothing (nano 5/9, plus 19 spurious projects). Full gpt-5 handles the JUDGEMENT well —
the only model to get the A2 class right, twice of two — but at ~2x cost and ~3x latency, so it is
not a small-fast swap. Do not add a family entry for a provider nobody has replayed these cases
against.

EMPTY RESULTS: `analyze.classify` now REJECTS any analysis entry whose `message_summary` is blank,
and the repair round fixes it like malformed JSON. An entry with NO ITEMS stays valid — 306 of 757
stored analyses create nothing and the prompt asks for exactly that shape — but 0 of 757 omit the
summary, so a blank one means the model did not read the mail rather than finding nothing owed.
This converts the worst failure mode (silence the user never learns about) into a visible repair.
`classify` is exported for this; covered by verifyMessages §13. Haiku matched or beat
sonnet on every scored experiment at about a quarter of the cost, with no malformed JSON. A provider
that does not offer the family, an unknown provider, or a failed ping all fall back to freezr's own
default — the app never names a model the user's provider may not have. The user's own pick still
wins. Covered by verifyMessages §12; the weekly review will get its own setting.

Versions: PROMPT_VERSION 0.53, JOB_VERSION 2026-09-19.1, BOOTSTRAP_PROMPT_VERSION 0.5.
Re-install needed to reach the background job. Suites green except the two pre-existing
verifyTaskHistory band-layout checks and verifyBootstrap's "rejected legacy shape retries as
adaptive".

**2026-09-11 — Mail task quality (prompt 0.47, JOB_VERSION 2026-09-11.1).**
Shared task rules now group requirements of one process into one outcome task with checklist
components (e.g. account opening), replacing automatic splitting of multi-part asks and follow-up
questions. Distinct outcomes, owners or separately tracked deadlines can still warrant separate
tasks. Mail can record meaningful outcomes first encountered as completed directly as resolved,
reusing an existing task when available. The shared and assembled account-for instructions retain
an outstanding item's existing open/in_progress status, with a reason, rather than defaulting it
back to open. Proposal/commitment, delivery-scope and draft-grounding additions remain deferred
pending observed model failures. No historical task migration or live model evaluation.


**2026-09-07 — Per-account "Pause syncing" + the Setup page URL.** The Setup & Prefs page
moved from `/startup` to `/setup` (files renamed `setup.html/.js/.css`, `setupUi.js`; every
link, the topbar key and the page guards follow). Status tab: each stored account (mail,
Slack, work) gets a Pause syncing / Resume syncing toggle that flips `accounts.sync_paused`
(+ `sync_paused_at`) on the stored record; the row shows a PAUSED chip in place of its
state chip. `ingest.js resolveAccounts` drops paused records BEFORE `sourceFromAccounts`
and before `processor.plan`, so the in-tab check, the background job and Inspect all skip
them without a single provider call; all-paused returns a distinct `skipped` message.
JOB_VERSION 2026-09-07.8, zip rebuilt.

**2026-08-22 — Rules UI at every scope + account-scoped rules (spec:
now `pipeline-walkthrough.md` §5a).** The `instructions` collection existed with
sender/domain/all matching and prompt injection, but the ONLY UI was the person modal's
hard-coded scope=sender form. Now: a RULES tab on Setup & Prefs (`rulesTab.js` — list all
active rules with scope chips, add/remove at any scope) and the spec'd "apply to everyone
at this domain" checkbox on the person modal, whose list now shows every rule affecting the
sender (domain/all read-only there). New `account` scope (match = stored `account_id`):
`instructionStore.matching(sender, accountId)`, accountId threaded env → processor entries
→ `processBatch` → `preAnalyze`/`autoprocessDiagnostic`. Account/all rules are guidance
only (do NOT block the no-LLM short-circuit); sender/domain rules still force the AI read
(the blocking filter is now an explicit scope allowlist). JOB_VERSION 2026-08-22.9, zip
rebuilt. NOTE: structured domain-level auto-file (no-LLM filing by domain) was considered
and deferred — a free-text domain rule achieves it via the LLM; profile `auto_processes`
stay on the profile (learning lifecycle, merge cleanup).

**2026-08-22 — inputs/notes channel, Phases 1–2 (spec: `superlazy-inputs.md`; the per-step
plan is retired, and its open reset checklist is now under "Inputs beyond email" → "The full
reset — checklist").** Phase 1: prompt 0.29 channel restructure +
`channel` threaded through normalize/evidence/events — mail requests proven byte-identical
(HEAD-code vs new-code fixtures over the same datastore). Phase 2: the `inputs` collection
(all channels; canonical vs provider authority; pending queue), notes end to end — topbar
"＋ Add…" chooser on every page, note modal (optional title derived from the first line,
type-ahead attendees/project, project pre-link), NON-BLOCKING save (modal closes at once;
status rides the topbar line + the run lock's progress.stage), on-save analysis under the
run lock with heartbeat + `STEP_TIMEOUT_MS` bound, mail-run-tail drain (time-boxed, retry
cap 3 with `attempts`/`last_error`), edit-as-amendment (revision bump, event upsert, REVISED
marker), per-channel profile counters (graduation stays correspondence-only), viewer note
header + ✎ Edit, feed wording, `notes_drained` in the run summary so pages refresh on
note-only runs. Also landed alongside: project DESCRIPTION editing in the project editor
with `llm_name`/`llm_summary` machine baselines (restore links) and manual_edit events;
run-tail hang-proofing after an orphaned-lock incident (timeouts around the drain + each
note). Offline suite: `test/verifyNotes.mjs` (39 checks). Prompt 0.30; `email_bodies` is
legacy read-fallback until the reset.

**2026-08-22 — the n1/p1 id-leak + cross-project todo hijack (found via the first manual
note).** `reconcile` ADOPTED unknown ids the model invented: a new item slip-emitted as
`todo_id:"n1"` (instead of `tmp_id`) was stored WITH that id (five `n1` todos and one `p1`
project accumulated), and a later slip citing `n1` MATCHED a leaked record — a resolved
to-do from an unrelated project was "moved", rewritten and reopened, dragging its email
evidence trail with it (user report: a note "associated with a completely different email
thread"). Fix: id-adoption guards in `reconcile.js` — a tmp-shaped id (`^[np]\d+$`) is NEVER
a match key, and an id matching nothing in the store is minted fresh, never adopted (both for
todos and projects; slip-ids are tmp-mapped so later entries in the same reply stay
consistent). Regression tests: `verifyNotes.mjs` §5 reproduces the live hijack. Data
repaired via dev API (backup in scratchpad): hijacked todo restored as a proper new task
(draft re-pointed), duplicate/leaked `n1`s re-id'd or removed, `p1` → real id. Zero
tmp-shaped ids remain in storage.

**2026-08-21 — project board tidy-up (user).** The △ moved from the right-hand controls to the
END OF THE PROJECT NAME (it edits that text; the task rows had already lost theirs, which made
the project one look stranded); the TODAY tag went with it. The whole-project "✓ resolve all"
left the title band — a TAB is the scope people mean — and each tab's bulk bar now offers
"✓ resolve all N" **and** "✕ cancel all N" (`ui.projectBulkOps.setAll`, one manual_edit event
carrying every change plus one evidence entry per task; cancelled is deliberately not resolved).
"Check Mail" left the FILTER bar, where it implied the filters had something to do with it — the
topbar's mail tools already own it. The project editor's task list, selection checkboxes and bulk
resolve were deleted as a thinner duplicate of the card behind the modal.

**2026-08-21 (later) — three follow-ups.** (a) The revert-to-the-model's-priority offer was
invisible: it was gated on a manual evidence entry carrying an importance diff AND a stored
`llm_importance`, neither of which exists on any pre-existing task. Moved to the task modal's
Priority row beside its "set by you" note, and re-gated on the thing that is actually true —
`importance_locked`. `revertImportance` now ALWAYS releases the lock, and restores
`llm_importance` on top when one is stored — ONE action, ONE label: "↩ revert to automated
priority 3". With no stored reading the label drops the number and the value waits for the next
analysis.

  `llm_importance` is stamped only when the analyzer next reads a task, so pre-existing to-dos
  simply have none until they are re-analysed and no legacy handling was added for that. The
  numberless form of the button remains for the case that is NOT legacy: a hand-added task is
  `importance_locked` with no machine reading and always will be, so pressing it releases the
  lock and lets the model price the task on its next read.

  **FREEZR SERVER BUG found while testing this (reported upstream, not fixed here).** The new
  `llm_importance` refused to appear even after "Regenerate App from Files", while
  `bg_last_run.version` correctly reported the bumped `JOB_VERSION` — entry file new, siblings
  old. Cause: `adapters/jobs/localJobRunner.mjs` cache-busts its dynamic `import()` with
  `?v=<mtime>` on `index.mjs` ONLY; Node resolves that module's static imports without the query,
  so `reconcile.js` / `persist.js` come from the process ESM cache and keep running old code
  until a server RESTART. Any future change under `jobs/` will hit this. Workaround: restart the
  server. Suggested fix: materialize into a versioned directory
  (`users_jobs/<app>/<name>@<stamp>/`) so every file gets a fresh URL.

  (b) A project card's people line stays one
line while collapsed (the grey bar must stay a bar) and wraps freely once expanded. (c) The
task-row checkbox is drawn by hand rather than via `accent-color`, which paints the native
SOLID tick that reads as the ✅ emoji; it now matches `.done-mark` (white box, coloured border,
coloured check). Fenced in `entities.css` as "TASK CHECKBOX — EXPERIMENT": `--task-check-on`
switches green↔blue, deleting the block restores the native control on the line below it.

**The draft-reply pill bug (same day).** The pill counted `liveResponses`, but the tabs bucketed
by `response.direction` — a copy taken when the model drafted the reply. Change the task's
ownership afterwards and that copy goes stale: the pill promised a draft, the tab holding its
task didn't show it, and the tab that would have often had no open tasks so `defaultTab` never
landed there. Fixed by making the draft live WHERE ITS TASK lives (`dirOfResponse`), with
anything unrecognised falling back to a real bucket rather than none, and by deriving both the
pill and the tabs from ONE exported function (`draftsByDirection` / `draftCountOf`) so they
cannot diverge again. Proof: `test/verifyTaskHistory.mjs` §16.

Fixed since the 2026-08-05 review (moved here from the old Parts 2–4; see git history for
detail):

- **2026-08-21** — **a task's own history was incomplete, and the LLM's reading was
  unrecoverable.** Two holes. (a) `ui.editTodo` — the △ task editor's rename / details / due /
  ownership / direction edits — recorded a `manual_edit` event but appended NOTHING to
  `todo.evidence`, so exactly the manual changes a user would look for were missing from the
  task's own trail (and left the record looking older than it was to `projectMerge.touchOf`).
  (b) Nothing preserved what the MODEL had set, so once a user edited a priority or a
  description there was no way to tell machine reading from human override, or to revert.
  Fixed:
  1. **All manual to-do field changes stamp evidence**, via one path — `ui.recordTodoChange`
     (status / priority / text / due / ownership). Each entry carries a structured
     `changed[] = [{ field, from, to }]` alongside the prose reason.
  2. **Bursts COALESCE.** Within `COALESCE_MS` (60s) of the last change to a to-do, further
     changes fold into the SAME evidence entry — its reason regenerated from the NET change —
     and, per field, the same event record, upserted on a `manual_id` that `persist.addEvent`
     honours. Ten rephrasings of a description are one line; a 3→4→5 nudge reads "priority 3→5".
     A burst that nets out to nothing says so rather than claiming a change.
  3. **The model's own values are stamped** onto `llm_importance` / `llm_short_description` /
     `llm_description` (reconcile `stampLlmBaseline`), only when the model actually emits the
     field. `importance !== llm_importance` IS "the user overrode this", and the baseline is the
     revert target.
  4. **The per-message field diff rides on the event** as `todo_edits`, deliberately SEPARATE
     from `changes` — which drives the Recent/Events feeds, where a priority nudge does not
     deserve its own row. Nothing renders it yet; it exists so the detailed change view can be
     built later without re-deriving anything.
  Surfaced: the task modal grew a **History** section (whole trail, newest first, each
  email-backed entry opening that exact message in the thread viewer), and the task row's meta
  line became the FIRST and LAST entries as one left-aligned comma-separated line, with a
  "+ N more" (N = total − 2) between them when there is a middle. The row's right-hand side was
  reordered to **project · due · priority · ✕** with priority at the far right and only the ✕
  beyond it (so a column of rows lines up), the △ and the far-right "modified" date retired (the name opens the editor; the
  strip carries the dates), the priority arrows enlarged and unhidden — `.sl-v2` had them
  `visibility: hidden` until row hover, which was the other half of "hardly visible" — and the
  "set by you" dot moved INSIDE the badge as an absolutely-positioned corner mark, since as a
  sibling span it widened the control and stepped the arrows in and out of line row by row.
  A manual priority override now offers **"revert to N"** on its history entry
  (`taskEditOps.revertImportance`): restores `llm_importance` and clears `importance_locked`,
  handing the field back to the model — the first thing the new baselines actually buy.
  Finally, `taskRowEl` gained `showDirection`: lists that MIX directions (the Events page's task
  rows, the project card's and the Tasks page's "All tasks" archives, and the tasks behind one
  email in the viewer) put its ☑️/📥/👥/📖 mark at the very front of the row — left of the
  checkbox — since nothing else there says whose obligation it is. Direction-scoped tabs keep it
  off; the tab is the label. In a row the mark is size-normalised (the tab bar's larger "I owe"
  disc would step the checkbox column out of line).
  The arrows ended at **28px, no pill, hidden until the row is hovered** — big enough to hit,
  quiet enough to sit on every row; the box stays badge-height so the glyph never changes row
  height, and `visibility` (not `display`) keeps the badge from shifting. `:focus-visible`
  reveals them too, since keyboard users never hover.
  Note `expandableProjectView.impControl` is a SECOND copy of this control (the project header's
  dots variant) and had the same sibling-dot bug; both now anchor the dot inside the display and
  must stay in step. Clicking a task's name
  now opens the task modal, like the △. All of it reads `todo.evidence`, which travels on the
  project record — **zero extra queries**. Proof: `node test/verifyTaskHistory.mjs` (56 checks).
  JOB_VERSION 2026-08-21.1.

- **2026-08-20** — **project records could FORK, and a save could clobber another writer.**
  Reported symptom: a hand-created project's tasks vanished a few hours later; re-entered, then
  the old version and the new one alternated between loads. Cause: `persist.upsert` created a
  record whenever its `project_id → _id` map had no entry, and the "+ Add Project" flow fired
  three first-time saves at once (create event → manual-event listener, priority event → listener,
  plus the direct `projectOps` save) — each saw an empty map and each created a row. Two rows with
  `project_id: p_27` resulted (confirmed in the datastore: same `_date_created` second, 6 tasks in
  one, 5 in the other); `projectStore.hydrate` keeps whichever row comes last, and row order
  follows `_date_modified`, so the board flipped between versions while edits landed on one row.
  Second, latent cause: `project_id` came from a per-store counter (`mintProjectId`), so two
  writers that hydrated separately (a tab and the analyzer/job, or two tabs) could mint the SAME
  id for DIFFERENT projects. Fixes:
  1. **Canonical record ids** — a new project record is created on `proj_<project_id>` with
     `upsert: true` (the pattern the events collection already used), so racing creates land on
     one row instead of forking. Legacy rows keep their random `_id`s; no migration.
  2. **Per-key write queue** — every write of one natural key runs after the previous one
     (`persist.queued`), so two saves can never both see "no record yet".
  3. **Read-and-merge before every project write** — `projectMerge.mergeStored` folds the stored
     row into the live object against a BASELINE (what this process last loaded/wrote): it adopts
     to-dos/drafts another writer added, never resurrects ones we moved away, takes their version
     of a task only when we didn't touch it, and keeps ours (flagging the conflict) when both did.
     This closes the older lost-update hazard: a tab open for hours no longer overwrites what the
     analyzer added in the meantime.
  4. **Healing on load** — `healDuplicateProjects` folds pre-existing duplicate rows into one
     (union: with two rows there is no baseline to infer intent, and losing a task is worse than
     keeping a stale one) and tags the extras `dup_retired` so they never load again. Nothing is
     deleted. User-visible consequence for the incident above: `p_27` comes back with all 11
     tasks — both entry attempts — so the near-duplicates must be cancelled by hand once.
  5. **User-minted ids** — projects and tasks created in the browser use `p_u_<ts><rand>` /
     `t_u_<ts><rand>` (`mintUserProjectId` / `mintUserTodoId`), unique by construction and
     excluded from the sequence counters (`seqOf` skips ids containing `_`).
  Profiles got the same treatment minus the content merge (canonical `prof_<address>` ids,
  newest row wins on duplicate addresses). Proof: `node test/verifyProjectMerge.mjs` (19 checks,
  incl. `healDuplicateProjects` run read-only over the real stored projects).
  Known limitation: the per-task tie-break is the newest TOUCH stamp
  (`max(evidence.asof, resolved_asof, created_asof)`); a writer that changes a task without
  stamping evidence can still lose to an older-looking edit. JOB_VERSION 2026-08-20.2.
  *Narrowed 2026-08-21*: the one writer that did this — `ui.editTodo` (rename / details / due /
  ownership) — now stamps evidence AND `edited_asof`, so every to-do mutation in the app moves
  the touch stamp. See the task-history entry below.

- **2026-08-20** — prompt 0.28: the "One obligation, one task" POLICY rule — before creating a
  to-do the model must scan the linked projects' existing items (open and resolved) for one
  covering the same underlying obligation and AMEND it (rewording its description is explicitly
  encouraged) instead of creating a near-duplicate; a separate task only when the obligations
  complete independently. Tasks kept re-appearing with nuanced wording differences even after
  the 0.27 batch tmp_id fix. JOB_VERSION 2026-08-20.1.
- **2026-08-19** — foreground poll actually polls: `backgroundMode.js pollMs()` had a
  `Math.max(60, minutes)` floor — a 60-MINUTE minimum that silently turned the
  "check every `foreground_poll_minutes` while a page is open" cadence into hourly. Floor is
  now 1 minute. Automatic fires also re-read `settings.newmail_last_check` right before
  starting (`runNow({ ifStale: true })`), so several open tabs collapse to one check per
  interval. Suggested-reply drafts are now retired DURABLY (`status: 'dismissed'`, persisted)
  once the events log shows the user replied on the thread after the draft was made
  (`viewerContext.retireStaleDrafts`, run on every events load) — they used to keep
  resurfacing on project cards, which only test "task still open".

- **2026-08-06** — `business_context` wired into the prompt AND moved into the cached
  durable turn; single prefs mapper `sessionPrefsFrom` created so it can't silently drop
  again. Touched-share snapshot trigger removed. Project drift implemented. REPLAY now-line
  replaced with one neutral wording. Durable-turn caching: pin + `durable_sig`
  invalidation.
- **2026-08-07** — trainer.js → processor.js; batching committed (`DEFAULT_BATCH_MAX = 10`,
  adaptive step-down/recovery, split-on-any-failure, missing-entry net, prefs UI);
  `processed` double-count fixed (dedup by msg_id); mixed-age `noDrafts` fixed (per-entry
  flags); new-mail window starts at cursor − 1 day (`RETRY_OVERLAP_MS`); retry cap
  (`MAX_ANALYSIS_ATTEMPTS = 3`, visible give-up); "message not found in its thread" now
  writes a real error event; `profile_updates` filtered to message participants;
  1-hour cache TTL made the default; snapshot cadence moved to Preferences
  (`snapshot_refresh_messages` / `snapshot_max_age_hours`); repair-round truncation check
  uses the generating cap; `request_more` no longer re-sends the volatile block;
  project_detail responses capped; drafts excluded at three layers; surrogate message
  handles (m1, m2…) with translate-back before reconcile (prompt 0.26); anti-echo no-op
  detection + `snapshot_touch_ids` split in reconcile; people block tiered
  (sender full / to-brief / rest one line); style guide skipped when no-drafts; empty style
  guide cached; cache-effectiveness aggregation in `test/costReport.mjs`; people-page
  reprofile runs in-tab when the job is unavailable.
- **2026-08-17** — Inspect page (deferred persistence, exchange capture, no lock, pin after
  run); event importance ranks with the target bucket (uncommitted at time of writing).
- **2026-08-19** — Batch to-do duplication fixed (prompt 0.27): tmp_ids were scoped per
  ENTRY, so a batched back-and-forth thread had no way to reference the to-do an earlier
  entry created and re-created it once per message. tmp_ids are now scoped to the whole
  reply (cite the earlier tmp_id as todo_id/project_id); engine shares the tmp→minted-id
  maps across the batch's reconcile calls (`engine.js` per-entry loop, `reconcile.js`
  ctx.tmpTodo/tmpProj), and a re-emitted `new:true` with an already-minted tmp_id resolves
  to the existing item as a defence against the old slip. Regression checks in
  `test/verifyBatch.mjs` §5b; spec updated (now `pipeline-walkthrough.md` §6).
- From next-steps: **surrogate ids** (item 2, done); **cross-run snapshot persistence**
  (item 6, done except the Rebuild button → §3.19); next-steps' "State" section claims that
  went stale (`DEFAULT_BATCH_MAX = 1`, 141 checks, `trainer.js`, `setup.html` as the
  setup page) are superseded by the spec.
- **2026-08-25** — Light SUB-TASKS (prompt 0.31, JOB_VERSION 2026-08-25.2): descriptions may
  carry flat `- ` checklist lines for minor components of one obligation; `- [x]` = crossed
  off by the user; INVARIANT 7 = carry lines over verbatim on rewrites, never un-cross, tick
  only on clear evidence. UI side (subTasks.js, taskRowEl): hover-on-name slides the
  description open, checkboxes tick in place and persist as a description manual_edit that
  page listeners deliberately don't repaint on. OPEN ITEM (deferred by user): no
  reconcile-side stickiness guard for `[x]` states — prompt-only; add the guard (re-apply
  user ticks to matching lines after a model rewrite) if ticks get clobbered in practice.
  Same open question applies to user-edited description text generally.


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


### 2026-09-12 — provider-cache cost diagnosis

Measured from 202 analysis calls in `events` (Sep 3–12): the base prompt is stable and the pinned
durable turn does hit (~43k tokens read per call), but 4.78M of 6.37M tokens written to cache were
the per-message VOLATILE turn — the freezr Anthropic adapter puts a breakpoint on the last message
too, and with the app's 1h TTL that write bills at 2x; only 16 of 155 hit calls ever re-read it.
Full-prefix misses (32) were all 1h-TTL expiry between hourly runs (one was a model switch).
FIXED (JOB_VERSION 2026-09-12.2): durable-turn age policy now measured on the wall clock
(`renderedAt`, pinned as `rendered_at`) — the message-clock rule re-rendered the snapshot 8 times in
one 26-call backlog run. FIXED server-side: the connector passes Anthropic's `cache_creation` TTL
split through and llmCostService prices 1h writes at 2x (was 1.25x for all → in-app cost
under-reported vs the console). FIXED (JOB_VERSION 2026-09-12.3): the durable turn is sent as a
content block carrying its own `cache_control` (engine.durableTurn); the freezr Anthropic adapter
now has an EXPLICIT mode — caller-placed markers → system breakpoint only, no automatic marks on
the last messages — so the volatile turn is no longer cache-written on every call (request_more /
repair rounds re-send it at 1x instead). Inspect page labels the breakpoint (`turns[].cached`).
OPEN: (2) TTL policy: 1h only when a next touch within the hour is likely (foreground), 5m for scheduled
runs; shrink the stable prefix (70k-char system prompt, 58k-char catalog) which scales every
miss and read; (3) volatile block averages 47k chars (message 20k, thread index 13.6k, linked 9.5k).

**2026-09-12 (later)** — REQUEST AUDIT LAB (dev tool, JOB_VERSION 2026-09-12.4). `settings.llm_audit`
(toggle: page button, or `superlazy.audit(true|false[, days])` in the Setup page console) makes the
engine persist every LLM exchange verbatim into the new `llm_audit` table via a sink
(jobs/analyze_thread/llmAudit.js) hooked into analyze.js's capture path (`onExchange`; failures
recorded too). The cached durable turn is stored once per distinct content as a blob; records are
pruned after `llm_audit_days` (default 3) at the start of each audited run. Page `requestauditlab`
groups exchanges into runs → request chains (analysis + request_more detail + repair rounds, keyed
by an engine-generated chain_id) with a per-part cost table (cached read, new input, cache write
1h/5m, output), the exact turns sent, reply, thinking and raw usage. EQ PRICING (eqPricing.js):
calls on $0 local connectors (ClaudeLocal / CodexLocal) are priced as the same model via the API
price list from freezr.llm.ping() and shown as "eq" — on the audit page and on the events feed
(cost slot + day totals). NOT covered by the audit: re-profile calls, bootstrap, maintenance
review, due-date and subscription prefilter calls (only the per-message engine's exchanges).


### 2026-09-13 — cache-write cadence, batch budget, events-ledger double count

Read from the Request Audit Lab records (14 calls, $2.14 billed): cache WRITES were $0.82 (38%).
Two of the four writes were `trigger: threshold` — `snapshot_refresh_messages` 20 against batches of
10 fires every second call ($0.15 per ~25k-token catalog write at the 1h 2x rate); one was the
hourly job landing 61 minutes after the last touch (a cache read refreshes the TTL timer, so ≤55 min
apart would have hit); one was a cold start. The volatile turn of a 10-message agent batch was
104k chars against a 70k budget at the ladder's FLOOR (level 4) — the ladder's caps are per message,
the budget was per request, so every long batch was silently `overBudget`. And the events ledger
reported $2.82 for the $2.14 billed: `cache_refresh` events carried the whole call cost while the
same call's message events carried it too.
FIXED (JOB_VERSION 2026-09-13.2): (a) two refresh thresholds by channel — emails 50
(`snapshot_refresh_messages`, was 20) and chat turns 100 (`snapshot_refresh_chats`, new; Slack +
AI agents), accrued fractionally (`engine.noteProcessedForSnapshot`, pinned as `refresh_load`),
both on Preferences; (b) the context budget is per message × batch size (`assemble.js`);
(c) `cache_refresh.cost` = write premium only (`engine.cacheWriteCost`), `call_cost` = the call,
message events get the remainder; a write of already-cached bytes now logs its own event with
`trigger: 'rewrite'` (TTL miss / prefix change) instead of hiding in a message's cost.
NOTE: a stored `snapshot_refresh_messages: 20` keeps winning over the new default — raise it in
Preferences. (b) means batches now build at level 0 unless something genuinely huge arrives;
the reduction that made them fit before came from the ladder's floor, not the budget.
OPEN: intra-batch dedup in `assemble.js` (measured on the 10-message batch: the same thread's
prior-message index emitted 7 times = 13.4k chars, "message being replied to (full)" 23.4k chars
mostly re-sending a batch member, open-items boilerplate ×10 = ~5k — ~21k of 104k chars);
catalog prefix strategies (split hot/cold blocks with their own breakpoints, brief tier that is
actually brief, static blocks into the system prompt); freezr scheduler `hourly` → 50 min
(`features/jobs/services/scheduledJobsService.mjs:10`, user) so scheduled runs stop landing past
the 1h TTL.

**2026-09-13 (later) — catalog split into COLD and HOT cached blocks** (JOB_VERSION 2026-09-13.2,
PROMPT_VERSION 0.48). Measured cached turn: business context 2.9k + catalog 48.1k (84 rows, median
565 chars, 79 active in September so tiering never bit) + auto-process rules 8.9k = 59.9k chars ≈
24.8k tokens → $0.15 per 1h write. Now `renderCatalogSnapshot` returns `{ cold, hot }`: COLD =
context + rules + rows quiet >7d, weekly (`snapshot_cold_max_age_hours`, Preferences) or on a
rules/context change (pin discard reason → `cold_trigger`); HOT = the rest, on the message
thresholds; membership frozen between cold renders (`coldIds`), touched cold projects ride the
Updates section meanwhile. Two `durableTurn`s (cold first); pin stores `cold`; old-format pins are
discarded once. `cache_refresh` events carry `block` ('both' | 'hot' | estimate on a rewrite),
`cold_trigger`, hot/cold sizes; the subject names the block. Declined by the user: brief-tier rows
without summaries (context loss), row trimming. Prompt wording for the two parts updated (§ "The
catalog may arrive as a SNAPSHOT plus UPDATES"). Suites: verifyNotes/Messages/Sessions/ProjectMerge/
Maintenance green; verifyBootstrap's "rejected legacy shape retries as adaptive" check and
verifyTaskHistory's two band-layout checks fail independently of this work.

### 2026-09-16 — "Too many requests" after a prod restart (auth rate-limiter)

The 429 is freezr's AUTH-FAILURE limiter (`middleware/requestLogger.mjs`), not the per-user API
limiter. Its real limit was `AUTH_RATE_LIMIT.MAX_ATTEMPTS_PER_IP = 3` per minute (the class default
of 20 is overridden in `common/startup/constants.mjs`), then a 5-min block on every request from
the IP — and blocks were never logged (`onBlock` was a no-op). A failure counts only for
"token not found" / "token mismatch" / "sessionMismatch"; an expired token does not. Every login
mints a new `session.device_code`, so after a re-login every still-open tab's token fails with
"token mismatch" until its page reloads. The status poller's tick read lock + settings + account
warnings in PARALLEL = exactly 3 counted 401s = instant block; the 5-min backoff and every
visibilitychange probe repeated the burst. The background job is NOT involved: in-process jobs go
through `adapters/jobs/internalApiClient.mjs`, which never mounts the request logger / auth guard.
FIXED — freezr: limits raised to 20/min (IP and device); a same-user mismatch from a previous
login session throws `code: 'stale_session'` and is not counted (`tokenHandler.mjs`,
`basicAuth.mjs` API path); blocks logged at auth level with the triggering request
(`startupSequence.mjs`); `isCloseToExpiry` un-inverted (was `now − 1 day`, so tokens were never
renewed early). superlazy `backgroundMode.js`: settings is read FIRST on its own, so a dead
sign-in costs one 401 per tick and the other reads never start; forced (visibility) probes at most
once per minute (`AUTH_FORCE_PROBE_MIN_MS`). Needs the prod server restarted on the new code and
superlazy re-deployed there.
