# superlazy — Work sessions / Agents (the `work` channel: Claude Code and Codex) (v0.3, 2026-10-10)

`com.salmanff.superlazy`

> **What this is.** The design for digesting the sessions the user runs with an AI coding agent
> (Claude Code and Codex, §7) into the same projects, to-dos, events and viewer as mail, Slack
> and notes. The agent leaves an append-only transcript per session on the user's own disk;
> freezr's `use_file_sys` permission (`freezr_file_access_plan_v1.md` in the freezr server repo's root) lets superlazy
> read it. **Status: Stage 1 LIVE on the user's own (local) freezr server since 2026-09-10** — the
> agent stores are set up on the Setup page (`pages/setup.js` → `pages/workSessionsUi.js`) and every
> Check Messages / background-job run reads them with mail (`jobSource.sourceFromAccounts`); the
> server's local-file-store gate admits the in-process job, so background mode reads them too. Plans
> and task quality (§6) shipped 2026-09-10/11 and were revised through prompt 0.59. Stage 2 (§4) is
> not built. Dev lab: `labs/agentslab.*`. Offline proof `test/verifySessions.mjs`. Pipeline detail:
> `pipeline-walkthrough.md` §15.
>
> Companion docs: `superlazy-inputs.md` (the channel/provider model this slots into),
> `pipeline-walkthrough.md` §14 (the Slack slice — the pattern this copies), `pipeline-backlog.md`
> ("Inputs beyond email"), `superlazy-weekly-cleanup.md` §10.1 (where the forgotten-sessions pass lands).

---

## 0. The model, and the decisions behind it

Emails and chat tell the user what other people want. Sessions tell the user what THEY were doing
about it — and what they left unfinished. **A session is a conversation like an email thread:
each request-and-answer turn is one input item; the turn creates or resolves tasks; the session is
the thread; the modal shows the original dialogue.** The differences from email are optimisations
(what to send the model, how to treat the agent), not a different shape.

**Renamed 2026-09-10 (user).** The user-facing concept is **agents**, not "sessions" — a session is
the transport (the thread), the agent is the thing the user cares about. Changed: the provenance
tag `sessions:<conn>` → **`agents:<conn>`** (migrated on the live data by
`test/backfillAgentSources.mjs`), the dev page `sessionslab*` → **`agentslab*`**, the account
picker now names the AGENT (`🤖 Claude Code`) instead of a mail address that says nothing about
which agent ran, `⌨` → `🤖` everywhere, and "AI session" → "AI agent" in the task-history strip.
DELIBERATELY UNCHANGED (persisted across every project, event and evidence entry, no user-visible
gain in churning them): `channel: 'work'`, the `cc:` thread prefix, and the job-internal module
names (`workSource.js`, `sessionsSource.js`, `sessionDigest.js`) — a *session* is still the right
word for one transcript; only the channel was misnamed.

**Repo provenance 2026-09-10 (user).** A project now records WHICH REPOS feed it, as `repo:<slug>`
entries in the existing `sources` array — no new field. Derived, never authored: an agent thread id
is `cc:<repoSlug>:<sessionId>`, so `persist.addRepoSources(project)` reads the repos straight off
`thread_ids` on every save (idempotent, and the same function the backfill used). A repo stays a
PLACE, never a project (decision 1) — it shows as a quiet `#repo` chip on the card, and as
`· repo: <names>` on the catalog row so the model has a matching signal for items that carry no
participants. `persist.isAccountTag` now gates the "forget this account" delete: only
`email:`/`slack:`/`agents:`/`note:` tags keep a record alive, so a project left with nothing but a
place tag is still deleted.

Decisions taken with the user (2026-09-06/07 — do not reopen by accident):

1. **A session is a THREAD, not a project.** Several sessions serve one effort and one repo hosts
   many efforts. The model files a turn into a project the way it files a mail; the repo is a
   *place* (like a Slack channel), never a project.
2. **The item is ONE TURN** (v0.2, revised from v0.1's whole-session digest): the user's prompt and
   the agent's answer. Turn n's item replies to turn n-1's, so the engine inlines the previous turn
   in full and lists earlier ones as index rows — the email mechanics, unchanged.
3. **The agent is a TEAM MEMBER** named "Claude Code": a name-only participant (the to-do rules
   already allow name-only owners), never a profile. A prompt is an ask the agent owes the user →
   `team_owes`, owner "Claude Code", counterparty ME. The recap resolves it. Work the user defers
   ("later") stays owed to the user in the same bucket. (A plan with no writes after it is NOT
   owed work — §6.2 A.) A question the agent
   asks that the user never answered → `i_owe_them`, owner ME, counterparty the project.
4. **Tool output is never part of an item.** It is >90% of a transcript's bytes and where secrets
   live (a `cat` of an env file, a printed token). The item body is the dialogue: prompt + the
   agent's text. A regex scrub over what remains is the second line of defence. **Cut direction for
   the LLM is the reverse of email:** the prompt keeps its HEAD, the answer keeps its TAIL (the
   recap is at the end). The stored body is (nearly) whole — the viewer shows the dialogue.
5. **Cross-channel linking comes first.** Most session work is progress on to-dos that came from
   people. The prompt tells the model to update THAT to-do (in_progress / resolved with the turn as
   evidence) and to add "tell X it is done", inheriting the ask's importance.
6. **Live turns are held, finished turns queue at once.** A finished turn (the agent's closing text
   arrived) is complete information. An unfinished last turn is held until the session has been
   quiet for 30 min, then queued as-is — "left mid-turn" is itself the information.
7. **No "resume" button.** Session id and title are shown; deep-linking VS Code is not worth it.
8. **Sub-agent transcripts are skipped.** superlazy sessions inside superlazy are fine.
9. **Refinements settled 2026-09-07 (from the first real transcripts):**
   - *Truncation was the wrong worry.* The agent's answers are structured and the closing answer
     recaps the whole turn, so the stored body is the whole prompt + whole closing answer; the
     LLM-facing head/tail cut stays only as a safety cap that rarely fires.
   - *What survives of the dropped detail is an EFFORT record* — `inputs.work_stats` (also on the
     event): duration, tokens in/out/cache, tool calls by name, files changed, lines added/removed
     (a proxy: an Edit's new text counts as added and its old text as removed, a Write's content as
     added), tool-output and thinking volume, models, API errors, continuations, asked_question.
     Rendered as one line everywhere ("42m · 3 files (+120/−15 lines) · 18 tool calls · 21k
     tokens"): the viewer's Work row, the Events row tooltip, the LLM request's `effort:` line.
   - *"sorry, pls cont" is not a new ask.* A continuation prompt (a short continuation phrase, or a
     ≤40-char prompt right after a turn that did NOT end — dropped connection, stopped mid-tool) is
     FOLDED into the turn it continues: the merged turn keeps the original prompt, takes the
     continuation's answer/tools/usage, and notes the folded prompts. Deterministic
     (`buildSession` `mergeContinuations`, default on).
   - *The agent asking a question.* A turn whose closing answer ends with a question (or used
     AskUserQuestion) is marked `turn_kind:'question'`; it stays its own item (the next turn is the
     answer and is read with this one inlined), and the LLM is told so explicitly — an unanswered
     one is `i_owe_them`. Folding Q+A into one item is possible later if two items prove noisy.
   - *Live sessions:* a turn without a closing answer waits while the session file changed within
     the last 30 min (the "still live" threshold on the setup page); then it is queued as-is.
   - *Old turns of a recently-touched session.* Sessions are picked by file mtime; their turns can
     be much older than the first-read floor, and the plan's window drops older envelopes. Live
     checks therefore store such turns as CONTEXT-ONLY items (`status:'skipped'`, `context_only`) —
     in the thread for the model, never queued. The dry run widens its window to the oldest formed
     turn and analyses everything (found 2026-09-07 when a run "stopped" after one session's
     in-window turns: the rest had been filtered, not hung).
   - *Prompts ARE truncated — but only their pasted parts.* The ask is prose; stack traces, logs,
     JSON, tables and code blocks the user pasted are context for the agent. `compactPrompt`
     collapses fenced blocks and runs of ≥3 machine-looking lines to their FIRST line (usually the
     error itself) + a count, at formation (stored body and LLM alike); the raw stays in the
     transcript and in the lab modal; `work_stats.prompt_pasted_lines` counts it.
   - *Git commits.* Commits the AGENT makes inside a session are parsed from the Bash tool result
     ("[branch hash] message" + "N files changed, +X/−Y") and stored on the item (`commits`, also in
     `work_stats`), rendered as a `[commits: …]` footer the prompt guide calls the strongest
     delivery evidence, a Commits row in the viewer and "N commits (hash)" in the effort line. The
     full paths of changed files are stored too (`files_changed_paths`, Files row on hover).
     Commits the USER makes outside a session need read access to the repo's `.git` (reflog) — and
     this user's repos live INSIDE the freezr installation tree, which the fs store refuses to
     mount by design. Options later: a repo outside the tree as its own store (`.git/logs/HEAD`
     gives hash/message/time per commit), or the agent running `git log` in a session.

10. **Resolution discipline (2026-09-07, after the first bootstrap run left 8 of 9 session-born
    tasks open).** Three causes, three fixes, all in the work guide (prompt 0.37) + the request:
    (a) an ask done within its own turn used to be created-and-resolved or left open → an ask the
    recap says is done creates NO task; (b) the agent's closing suggestions, offers and questions were
    turned into tasks for the user → they are NOT obligations until the user takes them up in a
    later prompt (ideas go in the project summary); (c) the user's next prompt is the VERDICT on the
    previous turn — answered or proceeded past → resolved, not taken up → cancelled — and the request
    carries an "## Open items born in THIS session" block (`assemble.renderSessionOpenItems`: every
    open to-do with evidence on this thread) that DEMANDS a per-item verdict every turn.
    *Extended to MAIL the same day (user asked; prompt 0.39):* the block is now
    `assemble.renderOpenItemsToAccountFor`, channel-neutral, with three deterministic lists — raised on
    this thread (all channels), owed BY the sender/authors (they_owe_me / team_owes whose owner is the
    sender), owed by ME to the recipients (i_owe_them whose counterparty is a recipient, when ME wrote
    the item) — capped at 30, in the volatile part of the request (cached prefix untouched). A core
    rule makes the per-line verdict mandatory; the email guide gained "Delivery and resolution on
    mail". *Scoped back 2026-09-08 (user: one bit at a time — the mechanism first, more data later):*
    prompt 0.40 lists only the items THE THREAD raised; the sender-owed and ME-owed-to-recipients lists
    stay implemented but OFF (`assemble.ACCOUNT_FOR_SCOPE`) until the thread-only verdicts have been
    judged on real events. Next steps on the MECHANISM before widening the data: watch whether the
    model actually returns a verdict for every line, whether "open + reason" is overused, and whether
    the cost of the returned to-dos warrants a compact "unchanged" answer form (reconcile change).
    *Refined the same day (user):* create-and-resolve is NOT barred — it is the sparing exception for
    work worth a line in the project's history (a feature shipped, a decision, a commit); routine
    steps still create nothing. (Since prompt 0.42 it is the record of what was done, not an
    exception — §6.1.) And everything is PROVIDER-NEUTRAL (prompt 0.38): the agent's name
    comes from the item (`agent_name`, `workSource.AGENT_NAMES` per provider — Claude Code today,
    Codex etc. later), the body marker is `AGENT (<name>):`, the guide, the viewer's With row, the
    Events row and the evidence labels all read the name off the record.

---

## 1. What is on disk (Claude Code, VS Code entrypoint, v2.1.x)

| Path | What | Used for |
|---|---|---|
| `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` | one append-only transcript per session | the thread |
| `~/.claude/projects/<cwd-slug>/<sessionId>/subagents/` | sub-agent transcripts | skipped |
| `~/.claude/sessions/<pid>.json` (+ `<pid>.<hash>.key`) | live-process registry | "maybe open" flag only; **`.key` files are never read** |
| `~/.claude/plans/<name>.md` | plan-mode outputs | not read — the transcript's `ExitPlanMode` call carries the full plan, on its turn (§6.3) |

Record types and what the turn builder takes: `user` text (human) starts a TURN — harness-injected
tags (`<system-reminder>`, IDE selection, slash-command expansions, cross-session messages,
`isMeta`) are stripped/ignored; `user` `tool_result` is measured, never kept; `assistant` text —
the last text of the turn is the recap; `tool_use` counted per tool, `Edit/Write/…` paths = files
changed, `TodoWrite` = checklist, `ExitPlanMode` = plan; `stop_reason end_turn` closes a turn, a
turn whose last event is a `tool_use` is **stopped mid-tool**, a prompt with no assistant record is
**unanswered**; `ai-title`, `summary` (compaction), `file-history-delta` (changed paths). Every
record carries `cwd`, `gitBranch`, `version`, `timestamp`, `sessionId`. Measured 2026-09-06: 62
sessions, 7 repos, ~140 MB; the dialogue of a whole session is a few thousand tokens.

---

## 2. Data model (built)

- **Channel** `work`, `item_kind: 'agent_turn'`, `provider: 'claude_code'`.
- **Thread id** `cc:<cwd-slug>:<sessionId>`; **item id** `<sessionId>|t<n>` (deterministic —
  re-forming upserts, REVISED marker on re-analysis); `in_reply_to` = turn n-1's id.
- **`inputs` record** (`workSource.inputRecordFor`): `channel:'work'`, `author_address` = ME
  (`me_email` on the account), `participants: [{ address:'', name:'Claude Code', kind:'agent' }]`,
  `participants_kind:'agent_dialogue'`, `title` = session title, `body_text` = the dialogue
  (`sessionDigest.renderTurnBody`: `YOU:` / `CLAUDE CODE:` / `[tools: …]` / `[turn note: …]`),
  `authority:'provider'`, `status:'pending'`, plus `session_id, repo_slug, repo_name, branch, cwd,
  turn_n, turns_total, turn_state (ended|unanswered|mid_tool), turn_kind (ask|question),
  files_changed, tools, plan (legacy one-line title), agent_work (plans + checklist, §6.3),
  work_stats (the effort record, §0.9), session_state,
  session_flags`. Provenance tag `agents:<connectionName>`.
- **Account record** (channel `work`, one per fs connection): `me_email`, `repos { <slug>:
  { tracked, name, first_seen, last_seen_ms } }`, `sessions { <sessionId>: { turns_done, last_ts,
  title, repo, bytes, mtime, state } }` (the per-session high-water marks; an unchanged file is
  skipped by bytes+mtime), `last_sync_ms` (steady-state re-list floor minus a 6 h overlap; not
  advanced by a truncated history pass), `backfill_from` / `history_days` (first read).
- **Events**: one per analysed turn, `channel:'work'`, subject = session title. Evidence entries
  on to-dos: `type:'work'`, `who` = ME. `profiles.recordMessage` is a no-op for work items.

---

## 3. Files (built 2026-09-07)

| File | Role |
|---|---|
| `jobs/analyze_thread/sessionDigest.js` | pure: JSONL → turns; classification; `renderTurnBody` / `splitTurnBody`; secret scrub; whole-session digest (tests) |
| `jobs/analyze_thread/sessionsSource.js` | fs-API reader (`/feps/connections/fs/:conn/list|read`, layout detection incl. Codex, registry) |
| `jobs/analyze_thread/codexAdapter.js` | Codex rollout → session-builder records (provider 'codex', agent "Codex") |
| `jobs/analyze_thread/workSource.js` | the InputSource: formation (`readyTurns`, caps, high-water marks), `listEnvelopes` off pending inputs, `loadThreadRaw`, `getFullBody` |
| `jobs/analyze_thread/jobSource.js` | composite generalised to N children (mail + slack + work) |
| `jobs/analyze_thread/processor.js` | `noDrafts` for work; inputs status flips for work |
| `jobs/analyze_thread/persist.js` | `sourceTagFor` work → `agents:<conn>`; `addRepoSources` (repo: tags) + `isAccountTag` (delete guard); `inputToBodyView` carries repo/turn fields |
| `jobs/analyze_thread/normalize.js`, `profiles.js` | `agent_dialogue` participants; no profile counting |
| `jobs/analyze_thread/assemble.js` | `renderWorkTurn` (`[WORK item — agent session, turn n of N]`, prompt head + answer tail) |
| `jobs/analyze_thread/prompt.js` | `## Channel guide: work` (born 0.36; the current rules are §6.2) |
| `shared/emailViewer.js` (+ `shared/markdownLite.js`), `pages/eventsUi.js`, `shared/renderUtils.js`, `shared/mailTools.js`, `labs/inspectRunner.js` | per-channel rendering / routing; the viewer's plan pane (§6.3) |
| `pages/setup.js` + `pages/workSessionsUi.js` | the production setup path (one block per agent store, §4) |
| `labs/agentslab.{html,js,css}`, `labs/agentslabUi.js`, `labs/agentslabInspect.js`, `labs/agentslabRun.js`, `labs/agentslabRunUi.js` | the dev lab: formation dry run, the turn inspection modal (final view + facts + raw records) and the zero-write chronological run (real processor over an in-memory source + capture persistence) |
| `test/verifySessions.mjs` | offline proof (`--real` walks the real agent stores) |

---

## 4. Rollout

**Stage 0/1 — built and live** (the user's Claude Code store has been read since 2026-09-10; a
Codex store is added the same way, §7). Setting a store up: enable the admin pref `local_fs_access_enabled`;
add a local file store at `/account/resources` rooted at `~/.claude/projects` (not `~/.claude`
itself: on Linux it holds `.credentials.json`; the `projects` layout only loses the live-process
registry, which is a "maybe open" flag and gates nothing — and not the home folder or `/`,
which contain the freezr installation and are refused); re-install superlazy (new
`read_work_sessions` permission) and grant it, picking that store; on the Setup page pick the
store, confirm the ME address, untick any repo to exclude, "Save selection", then "Read data" — or
let the normal check run them. The **Inspect** page (Save / Ignore per item, full wire visibility)
and `labs/agentslab` remain the dev harnesses.

**The zero-write run (built 2026-09-07, step 4 of the page).** "Run through the sessions as if
training, into events/tasks/projects — but save nothing." `agentslabRun.js` drives the REAL
processor (inspectNext + commitPending, same prompt, same batching) over an in-memory source (the
work source's dry-run items served as envelopes/threads/bodies) and a capture persistence (every
write recorded, none sent; reads pass through; `msgAnalysisStatus` reports everything fresh). The
project/profile stores start EMPTY by default (a bootstrap: every project on the board is born from
the sessions — user, 2026-09-07, after a run against the real catalog read as "analysing my
existing events"), or are hydrated from the real data (option "real": turns link to existing
to-dos; the pinned snapshot is adopted only then) — mutated in memory only either way. The page
renders a per-turn timeline (summary, task changes, model output, the LLM exchange, the event as it
would be stored), the projects-and-tasks board as it would end up and the events list — painted
with the app's REAL components (user, 2026-09-07): `eventsUi.renderEventCard` per event,
`renderExpandableProject` per project (task rows included, NEW-this-run outlined), and the real
thread viewer (`emailViewer` + `viewerContext`) configured over the run's in-memory items, so the 🤖
icon opens the turn exactly as it will in production. Driven ONE TURN AT A TIME ("Analyse next
turn") or to the end ("Run all", stoppable); "Reset" discards the run object. This is the review surface for the prompt and the
digest before the real checks are allowed to run; the Inspect page remains the harness that saves.

**Saving a run (built 2026-09-08 — "now we can save the tasks etc to the db").** "Save this run to
the database" commits what the run holds in memory, once, under the ingestion lock (kind
`sessions_commit`): the analysed / errored / skipped turn items as `inputs` (with their event
back-pointer), every captured event (analysis kinds upsert on their deterministic ids), the projects
and profiles the run touched or created (`persistStep`, source-tagged `agents:<conn>`), and the
work account with per-session high-water marks (last ANALYSED turn), cursor and window — so the live
checks continue from there rather than re-analysing. Turns the run never reached are left for the next
check. An empty-catalog run seeds the store's id counters from the real catalog (`projectStore.seedIds`)
so its new projects/tasks never collide with existing ids on save. Card edits made during the run
(resolve, priority) are saved as they stand.

**Production setup path (built 2026-09-08 — user: "the setup process needs to be just like in
prod").** The channel setup is the shared `workSessionsUi.js` (sibling of `slackChannelsUi.js`),
mounted on the Setup page's CHANNELS tab under a "Work sessions" section with the same
save-then-"Analyse now / In the background / Later" offer as Slack, on a sessions-only first-run
welcome (`showWorkOnlyStart`, when `use_file_sys` is granted and a store exists but no mail), and on
the agentslab dev page (step 1). `onboarding.getPermissionState` counts the fs grant as an input
channel. Once saved, every mail check — Check button, background job, schedule — plans the work
account alongside mail (`jobSource.sourceFromAccounts`); Train/Continue on a work row of the Status
tab opens the Channels tab. The lab page keeps only the dev tools (formation preview, zero-write run).

**Setup page reorganised (2026-09-09, user).** The Status tab is now a RESOURCES layout: a left list
of every source — mail accounts, Slack workspaces, AI coding-agent stores — with a state chip
(trained / training / saved / not started / needs re-authorisation / paused), and a right detail
panel: the mail account panel as before, or the channel module fixed to that one Slack workspace
(`renderSlackChannels({ connectionName })`) / that one store (`renderWorkSessions({ only })`), plus
pause/forget. The Channels tab is gone. Repos are read by default: `repos[slug].tracked === false` is
the only exclusion, a repo that appears later is read (and registered) automatically at formation,
and the first-read window is the only cut.

**Stage 1 follow-ups (after the first real items):**
- Tune from real events: `QUIET_MS`, the prompt/answer caps in `renderWorkTurn`, whether quick
  agent questions should fold into the following turn (decision 9).
- Events/Tasks list marks (🤖) are on the Events rows and the viewer; the Tasks page's history strip
  says "· Claude Code".

**Git metadata (kept, not used yet — 2026-09-08).** Each turn item stores its branch and any
in-session commits; the first turn of a session also stores the session-start git snapshot
(`repo_state`: branch, uncommitted files, five recent commits — parsed from Claude Code's context
block, never shown to the model). No commit tasks, no commit tracking: a developer watches their own
commits, and prompt 0.41 tells the model hygiene (commit/push/tests/re-install) is never a to-do.
The data is for Stage 2: a stale session whose changed files are still uncommitted at the next
session start is "work that never landed" — a badge, no AI. Tracked in `pipeline-backlog.md`.

**Stage 2 — the forgotten ones.** Sessions that ended mid-turn or with an unexecuted plan and have
been quiet for weeks: a one-off history pass, capped, age-decayed importance — the D4/L2
"forgotten items" of `superlazy-weekly-cleanup.md` §10.1 with sessions as one more source. Belongs in
the maintenance lab, not in ingestion.

**Live-path refinements (2026-09-11).** A MANUAL check (the user pressing Check Messages is at the
desk and wants the current state) forms with `QUIET_MS: 0`, so the turn in progress is analysed too
(`ingest.js` → `jobSource.sourceFromAccounts({ workTuning })`); polls and the scheduled job keep the
30-minute hold. A turn analysed while still open is recorded as the high-water mark's `open_turn`
and, when its answer lands, re-queued as revision 2 (same msg_id, REVISED marker) so the recap is
never lost. The Setup module has two buttons: "Save selection" (this store only) and "Read data"
(every unread or interrupted channel account — all agent stores and Slack, never mail — in one
chronological pass). A store the job cannot read is reported, not swallowed: `formationErrors()` →
the job summary's `form_errors` → a warning with Retry on the notice strip.

---

## 6. Plans and task quality

What this channel is FOR: the board should remember what the user meant to accomplish, what was
done, and what deserves attention later. Settled with the user 2026-09-10; prompt 0.42 shipped the
rules, 0.44 the plan capture, and 0.57–0.59 revised the sizing. The operative wording is
`## Channel guide: work` in `jobs/analyze_thread/prompt.js`; this section is the intent behind it,
and the prompt's changelog is the history.

### 6.1 Decisions

1. **The agent is a party, and the DIRECTION is what matters.** Work the agent left unfinished —
   including the last steps of a plan the user moved away from — is `team_owes`, WHO = the agent's
   name, counterparty ME. Surfacing that is the point of the channel. The noise was all in the other
   direction: `i_owe_them` items naming the agent ("restart the server", "paste the output", "give
   the go-ahead") are conversational turn-taking recorded as debt. Hence the OUTLIVE test (§6.2 A).
   No stale-gate is needed: a real unfinished step is an obligation the moment the session goes
   quiet; the turn-taking class is simply never created.
2. **The resolved list is a deliverable.** It is the user's record of what was done, each row
   linking to the turn that did it, as a mail-sourced to-do does. Create-and-resolve in one run is a
   feature — at OUTCOME granularity only ("implement the init and watchdog fixes" earns a row;
   "re-run the tests" never does).
3. **Plans reach superlazy through the transcript, with no change to agent behaviour.** Both agents
   already put the full text of any document they author into the transcript, on the right turn,
   inside the existing mount (§6.3). No re-emitting plans into the dialogue, no new mount, no write
   permission, no following file links, no `~/.claude/plans/` scan, no Codex goals database.
4. **The unexecuted-plan flag is diagnostic only.** `classifySession`'s `planUnexecuted`
   (`jobs/analyze_thread/sessionDigest.js`) never creates an obligation: no write after a plan does
   not prove work is owed (research, shell and API work leave no write), and a write does not prove
   completion.
5. **No new categories.** The four directions, the existing statuses and the due-date controls
   carry everything; no "parked", "backlog" or "decision" type. Extraction stays at one constant
   granularity (§6.4).
6. **Checklists are evidence, not a sync.** The agent's checklist is its own bookkeeping, kept
   beside the user's to-dos; the model interprets it. A missing checklist means unknown, not
   "nothing left"; an item disappearing from a later snapshot is neither done nor cancelled.

### 6.2 To-do quality rules

Five rules (A–E), all in the work guide only; mail rendering is untouched.

**A. Evidence of intent; the OUTLIVE test (0.42; hygiene precedence 0.58; deferrals 0.59).** Infer
the intended outcome from the user's request, the surrounding dialogue, an agreed plan and existing
commitments; unfinished work needed for it is tracked even if each step was not separately asked
for. The agent's suggestions, offers and option lists are not intent until the user takes them up
(worthwhile ones go in the project summary). One test decides: *does the obligation outlive this
session?* An act that exists only so the conversation can continue is never a to-do, whoever holds
it. Work still owed when the laptop closes is — the agent's unfinished work (`team_owes`), or a
hand-off only the user can do elsewhere ("create the index by hand", "publish the page",
`i_owe_them`). *0.58:* routine HYGIENE (commit, push, re-run tests, regenerate/re-install the app,
re-trust a job, restart the server, hard-reload, bump a version) WINS over the OUTLIVE test, judged
by the act and not the phrasing — "you'll need to regenerate the app to pick this up" is still
hygiene — unless the user explicitly asks to be reminded. A deterministic keyword net in
`reconcile.js` was considered and rejected (false positives on real work). *0.59:* an explicit
deferral ("later", "park that") IS a to-do, dated by the TIMING rule. **A plan delivered completes
the request for a plan**; it does not by itself commit anyone to carrying it out (the old "plan with
no files changed ⇒ work owed" rule is gone).

**B. Outcomes at a useful scale — the point of the whole exercise.** Everything else here exists
to let the model apply this one. *0.42* said one to-do per outcome, its components as `- ` checklist
lines in the description (they render as tickable lines; INVARIANT 7 carries ticks over verbatim).
*Superseded in its sizing by 0.57, THE GOAL IS THE RULER:* project = a GOAL stated so anyone could
tell whether it was reached (never named after the channel, repo, agent or session — those are
places); to-do = a SUB-GOAL; `- ` line = a STEP. Two tests, judged against THIS project's goal:
the PROGRESS-REPORT test (would the line appear in a progress report to whoever is waiting?) and the
NO-NEARER test (could it finish and leave the goal no nearer?). Three shapes are always steps: a
row naming a mechanism, a row bundling two fixes, a row restating the turn. A project already
carrying many open to-dos is evidence its lines were drawn too low. Split a second to-do only for an
independently useful deliverable, a different owner or its own deadline. *0.59* replaced "a plan's
steps are components of ONE to-do" with the plan lifecycle in §6.3. 0.45 ("one effort per
session") and 0.46 ("1–3 projects per session") were intermediate steps, now folded into 0.57's
goal framing: the session and repo boundaries say nothing about where a goal starts or ends.

**C. Written for returning later.** A concrete outcome title; a description saying what remains,
why it matters and the next action, enough to resume without rereading the transcript. Stated
timing goes into `due_hint` / `due_earliest` / `due_latest`, anchored to when it was said.
**"Later" means about one month** from when it was said, with the user's own words kept in the
description so the date reads as a default, not a commitment (a dateless to-do never resurfaces).
Explicit timing beats the default; dates the user set by hand are never moved; an agent restarting
work or rewriting its checklist never resets the user's dates or urgency; scheduling for later
does not lower intrinsic importance.

**D. Decisions apart from implementation, when useful.** A choice that only unblocks the next
message ("A or B?", answered two minutes later) is turn-taking. A choice that stalls agreed work
until the user acts, across sessions, is a to-do for ME; implementation stays the agent's
(`team_owes`). When in doubt the plan is the guide: a choice the plan depends on is a to-do, a
choice inside a step is not. Once made, resolve the decision and update the implementation — never a
duplicate outcome. Since 0.59 a DRAFT plan is itself carried this way: one to-do owed as the user's
decision on it (`i_owe_them`, WHO = the agent).

**E. Zero new to-dos is a valid turn; closure per obligation.** Closure by judgement, not silence:
0.42 removed the "unmentioned for three turns ⇒ done" shortcut, and every line of the "Open items to
account for" block gets a verdict with a reason (a required `account_for` field since 0.61). A
change of subject or a general "all done" does not by itself close every item; "close this off for
now" closes the current scope while explicitly retained future work stays open with its dates. An
item the session never returns to is more likely finished or abandoned than pending — say which.

### 6.3 Plan capture: from an agent transcript to projects and to-dos

**Where a plan comes from** — one capture path in the shared session builder
(`sessionDigest.buildSession`), markdown only (`isMarkdownPath`: plans and specs live there; code
files are effort, not intent):

| Agent | Transcript record | Captured as (`planDoc` kind / source) |
|---|---|---|
| Claude Code | `ExitPlanMode.input.plan` — the full plan, inline | `plan` / `ExitPlanMode` (also the legacy one-line `plan` title) |
| Claude Code | `Write` of a `.md` — `input.content` is the whole file | `doc` / `Write` |
| Claude Code | `Edit` / `MultiEdit` of a `.md` — `old_string` / `new_string` | `patch` / `Edit`, a readable delta from `editAsDiff` (0.59 — before it, plans revised in rounds by Edit were invisible after their first Write) |
| Codex | `apply_patch` add-file run through `exec` — the ONLY place an added file's text exists (`patch_apply_end` carries an EMPTY diff for an add; the two records are linked by order and path, not `call_id`) | `codexAdapter.js` unescapes the JS-string argument, keeps added markdown bodies by path, and hands them to the following `patch_apply_end` as a synthetic Write → `doc` / `apply_patch` |
| Codex | `patch_apply_end` update of a `.md` — `unified_diff` | `patch` / `apply_patch` |
| Claude Code | `TodoWrite.input.todos` | the turn's checklist (last list of the turn) |

Codex has no planning or checklist tool (it only calls `exec`); its `commentary` messages are
prose intent with no items or ticks. Structured planning is therefore a Claude-only enrichment, and
the pipeline degrades to dialogue plus documents — never requiring an agent to use a planning tool.
If non-plan documents ever prove noisy, the model judges; a path whitelist would encode one person's
repo layout.

**Storage** — additive on the turn's `inputs` record (`workSource.inputRecordFor`):
`agent_work = { plans[], checklist, latest_plan }`. Each plan is stored WHOLE and secret-scrubbed;
`PLAN_DOC_CAP` (64 KiB, against a largest observed plan of ~27k chars) is a guard against a
pathological file, and a cut is marked (`truncated`, `chars`), never silent. `latest_plan` is the
newest plan the session knows AS OF that turn — computed forward, so nothing later leaks into an
earlier turn or a replay.

**What the model sees — hot when written or changed, stale in between** (`assemble.js`): the full
text on the turn that writes it (`## PLAN written this turn`); the delta on a turn that revises it
(`## PLAN document CHANGED this turn`); on every later turn only a one-line `plan on record` reference
that says its parts already live on the to-dos and must not be re-asserted from memory; and the
agent's checklist with `[x]` / `[~]` / `[ ]` marks. The failure this prevents: a three-day-old plan
read on turn 20 re-opening work turns 12–19 delivered.

**How a plan becomes project and to-dos** (prompt 0.59, the guide's USING A PLAN):
- Read it FIRST for matching — an existing project whose goal it serves (same repo as tie-break),
  only then a new one; refresh that project's summary and keywords from the plan's scope. A goal
  already defined elsewhere (a spec pasted as a note, a brief by mail) is kept, not narrowed to the
  session's slice.
- While a DRAFT: exactly ONE to-do in ONE project, named for the plan's outcome, its parts as `- `
  lines, owed as the user's decision (`i_owe_them`, WHO = the agent). A `PLAN document CHANGED`
  turn is a revision round: update that row's lines, never a second row.
- When the user TAKES IT UP: owed work (`team_owes`), SIZED by the goal — a small plan stays one
  to-do; a plan for the whole goal is rewritten into that project's to-dos (the parts the user
  would report progress on become rows, the rest stay lines); only an ambitious plan reaches several
  projects. The draft row is rewritten into that shape, never left beside its parts. A dropped plan
  is cancelled.
- During execution the checklist and dialogue say what is done, never the plan text: a `[x]` ticks
  the `- ` line (or resolves the to-do) that carries that step, wherever sizing put it — no resolved
  twin; `[~]` / `[ ]` are the agent's intent, not the user's obligation; a checklist that shrinks or
  resets completes nothing.

**What the user sees** (`shared/emailViewer.js`): below Tasks the item modal has a Dialogue | 📋
plan pane, one tab per document on the turn, marked *latest plan for this session* or *earlier
version — superseded on turn N*; plans render Formatted by default through `shared/markdownLite.js`
(DOM-only, never `innerHTML`; only http(s)/mailto become links — transcript text is untrusted) with
a Raw toggle; a diff stays raw. Changed files and the plan's path get `open` (a user-defined editor
URL template, Preferences → "Open files in", default `vscode://file/{path}`; shown only when
`renderUtils.serverIsLocal()`) and `copy` (the universal fallback — a missing editor fails
silently). Opening with the OS default app or revealing in Finder would need a server endpoint
shelling out to `open`; out of scope. Search `repo:<name>` (`renderUtils.parseSearch`) is a
repos-only prefix match across projects, to-dos, events and people.

### 6.4 Open questions

- **Which document writes count as plan evidence.** Today: every markdown write, sized by the cap.
  Watch whether large reference documents (a long spec rewritten whole) add noise or cost; the
  preferred remedy is model judgement, not a path list.
- **The guide's wording is tuned on real runs, not agreed on paper** — the zero-write agents-lab run
  (`labs/agentslabRun.js`, every store interleaved by time, empty catalog by default) is the review
  surface; the measure is the user reading the resulting board.
- **Different users want different amounts** (ideas only, nothing to build). One person wants every
  step listed, another supervises many agent runs and wants headlines. The preferred direction is
  NOT to fork the prompt: extract at one constant granularity (outcome to-dos with `- ` components)
  and let the VIEW decide how much to show — instant and reversible, no re-analysis, no split of the
  prompt cache, one prompt to evaluate. Only genuinely extraction-level switches (e.g. "track work I
  do myself") belong in the prompt. Further angles: scope the preference per repo or project (repo
  provenance makes that expressible); learn it from behaviour (a to-do cancelled within a minute of
  appearing is a granularity signal); at high volume the useful output is an exception list
  (stalled efforts, plans never executed, work that never landed — closer to Stage 2 / the
  maintenance review). Constraint on the guide meanwhile: keep granularity rules in ONE place
  (THE GOAL IS THE RULER), phrased so a display control could later relax them.
- **"Later" as a user preference.** The one-month default is built; the preference to change it
  is not.
- **Plan acceptance evidence.** An `ExitPlanMode` call is a submission, not proof of acceptance;
  acceptance is inferred from the user's next prompts (§6.3). Whether to keep explicit acceptance
  evidence (the tool result) is open.

---

## 7. Codex (OpenAI's coding agent) — built 2026-09-08 against a real rollout

Codex 0.153 (VS Code) writes `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, one thread per
file, lines `{ timestamp, type, payload }`: `session_meta` (id, cwd, originator, cli_version),
`world_state` (model), `turn_context`, `event_msg` (`user_message` = the TYPED prompt,
`agent_message`, `task_started` / `task_complete` / `turn_aborted`, `token_count`), `response_item`
(`message` role developer|user|assistant — developer/user carry injected context, assistant carries the
answer with `phase` commentary|final_answer; `custom_tool_call` name `exec` whose input is a JS wrapper
around `tools.exec_command({cmd})`; `custom_tool_call_output` whose text wraps
`{"chunk_id","exit_code","output"}`; older `function_call` shell|apply_patch; `reasoning`),
`token_usage_record` (input / cached_input / cache_write / output tokens per response). Thread titles,
git sha/branch and project grouping live in `~/.codex/state_5.sqlite` — unreadable through the fs
API, so the title is synthesised from the first prompt and the branch is unknown. **Mount
`~/.codex/sessions`, never `~/.codex`: `auth.json` there holds the OpenAI OAuth tokens.**

`codexAdapter.js` translates a rollout into the record shape the session builder already consumes
(`sessionDigest.sessionFromText` dispatches on `session_meta`); everything downstream is unchanged and
the item carries `provider:'codex'`, agent "Codex". `sessionsSource` learned the dated layout — repos
are the distinct cwds of the rollouts touched in the window (each file's first line, cached) — and
`slugOfCwd` gives a Codex session the SAME repo slug (hence thread/provenance scheme) as a Claude
session in that repo. Edits: in 0.15x every applied patch is an `event_msg/patch_apply_end` carrying `changes { path:
{ type: update|add|delete, unified_diff } }` — the adapter turns each file into an Edit/Write tool
use with line counts from the diff (verified on a real two-turn rollout: 2 files, +137/−12 matched
the agent's own `git diff --stat`); shell-made edits without a patch fall back to `parseDiffStat`.
`reasoning` items are encrypted (empty summaries) — counted as thinking blocks, no text. A re-opened
thread repeats `session_meta` (idempotent). Differences that remain: no live-process registry; no
compaction summaries; no plan-mode marker; token totals count cached input per response (as Claude's
do), so a busy turn reads as hundreds of thousands of tokens. Proof: real rollout end-to-end + fixtures in
`test/verifySessions.mjs`.

## 5. Asks of the freezr `use_file_sys` plan (phase 1 built 2026-09-06)

- **Tail / range read** on `GET …/read` (`?offset=&length=` or `?tailBytes=`): steady-state checks
  re-read whole transcripts (10 MB for a long session) to pick up a few new turns. The bytes+mtime
  skip avoids re-reading unchanged files, but a growing file is re-read in full.
- **Exclusions on a local resource** (or narrow mounts): the registry the page uses sits beside
  `sessions/*.key`. The app never reads `.key` files; the store should not offer them.
- **Cloud jobs cannot reach a local store** (localhost-only rule, correctly): the background job
  must run locally (admin-trusted) for this channel; a cloud-located job will report the formation
  error per account and carry on with mail.
- **Git state as a second store** ("touched files still uncommitted") — a later stage.
- The SDK add-on (`freezr.fs.*`) is phase 2; until then `sessionsSource.js` calls the routes through
  `freezr.apiRequest` and lists connections via `/feps/connections/accounts` (`services` ∋ `'fs'`).
