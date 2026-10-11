# superlazy — The Weekly Clean-up (v0.6, 2026-10-10)

`com.salmanff.superlazy`

> **Status (2026-10-10).** BUILT: the one-call clean-up (prompt 0.9), the `/cleanup` page, the
> one-project "Review this project" mode (§6d), the scheduled background run with its results bar
> (§6e), and the free housekeeping passes (§10.1, run by hand from the page only). NOT built: the
> Setup-page tab (P4), recorded answers / snoozing / settled facts (§9), the deterministic parts of
> rule stewardship (§10.4). Experiments E1–E9 (§7) are still the user's to run; nothing about
> cadence is decided beyond the weekly slot.
>
> **What this is.** The clean-up the user runs to get the map in order for the coming week: ONE
> module gathers state and the recent input, asks the model once, and returns SECTIONS of
> *suggestions* (accept / ignore / accept all), *attention cards* (summary + recommendation + the
> to-dos to act on) and *questions* (shown). Hosted on the `/cleanup` page (model picker, knobs,
> under-the-hood — the experimentation host), in the project editor's one-project review modal, and
> in the hourly background job on the user's weekly slot; a Setup-page tab is planned.
>
> **History.** This file absorbed the earlier maintenance & review registry (2026-08-31 to
> 2026-10-10): its LLM passes L1–L6 and its lab page became the sections below; its deterministic
> passes D1–D5, its one-project re-org R1, its cost/cadence table and its rule-stewardship design
> now live in **§10**. Kept from that design: the proposal-then-accept architecture, the run
> artifact, lab-first, ignoring is permanent, the audit lock on apply. Changed: the unit is a
> SECTION; every suggestion is written in an OPERATIONS vocabulary the app validates, renders and
> applies; a "needs your attention" section exists; the input is by default an INDEX of analysed
> items across all channels rather than a mail dump; archive is unblocked (own collection).
>
> **User decisions (2026-09-20 / 24) — do not re-litigate:**
> 1. Archived projects move to their **own collection** (`projects_archive`), not a flag.
> 2. "Needs your attention" items are **summaries with a recommendation**, and the app shows the
>    to-dos beside them for the user to act on. Not flags, not model-built option menus.
> 3. **One model call**, not two: the rules and learning sections benefit from the project context.
> 4. **Questions are only shown.** Answers are not recorded yet (a warning says so). Structured
>    answers ("if yes then merge") were judged too complex to get right before the rest works.
> 5. Every suggestion in sections 4–6 (and all the others) is **structured data**: a description the
>    user reads plus operations with ids and a code saying what to do.
> 6. "Nothing / seen" on an attention card does **not** snooze it (warning shown) — until the
>    experiment plays out. Settled facts are **not** recorded (warning shown) — same reason.
> 7. Stale verdicts: no "keep" (silence = keep) and no "move" (moving belongs to the split section).
> 8. Model choice: the page; the user runs the experiments.

---

## 0. Governing ideas

1. **The meat is a module, not a page.** `jobs/analyze_thread/maintenance/cleanupCore.js` (gather →
   blocks → call → validated items → decide → apply) and `pages/cleanupView.js` (rail + panel) know
   nothing about where they are mounted. The `/cleanup` page, the one-project review modal and the
   background job are thin hosts; the Setup tab will be another.
2. **A section = attention cards, or suggestions, or questions.** Suggestions carry OPERATIONS;
   the app validates them against the live stores before anything renders, describes each op as
   old → new, and applies accepted ones under the audit lock. Attention cards carry the to-dos
   they are about; the user acts on those directly (each quick action queues one op for Apply).
3. **One call.** The state block, the input window and the small closing turn go up together;
   every section comes back in one JSONL stream. The model may ask for material (`need`) and the
   app answers on the same conversation.
4. **Re-running is cheap and normal.** The user may run the clean-up as often as they like, on any
   subset of sections. The big state+input turn is marked as a cache breakpoint, so a second run
   soon after — another model family aside — re-reads it at ~10%; whatever varies per run (today,
   thresholds, which sections) rides in a small uncached closing turn so changing a knob does not
   rewrite the cache.
5. **Ignoring is permanent, enforced twice.** An ignored proposal's fingerprint (group + the ids
   its ops touch) is listed to the model AND suppressed by the app before rendering.
6. **Consistency contract.** The "What a project is" paragraph is verbatim from
   `jobs/analyze_thread/prompt.js` (`verifyCleanup` checks it) — edit every copy in one commit.
7. **Lab first** (user, 2026-08-31). Nothing is scheduled, job-ified or auto-applied before it can
   be run by hand from a test page, its output inspected, and each item accepted or ignored there.
   Every pass — deterministic ones included — is a preview `state → proposals`; nothing mutates
   until the user accepts. The clean-up earned its background slot this way (the `/cleanup` page
   came first), and even scheduled it only *proposes*: results wait behind the results bar for
   accept / ignore. The housekeeping passes (§10.1) have not yet been through that judgement and
   so run only from the page.
8. **Old and new side by side.** Every change renders as current → proposed (`describeOps`); the
   user assesses the diff, never just the replacement.

---

## 1. The sections (the rail, in order)

| # | group | Rail label | The user's wording | What comes back |
|---|---|---|---|---|
| 1 | `period` | This period | "a summary of what has happened over that period — if run weekly, the user sees what they did last week" | `summary` — markdown, 120–250 words, from the index + the period counts (items by channel, to-dos created/resolved/cancelled/updated, projects created, hand edits, auto-filed) |
| 2 | `focus` | Focus | "a scheduled-for-this-week / today tab which, based on due dates or priorities, points to what the person should focus on" | `focus` — a short markdown lead + 6–15 to-dos placed in today / this_period / later, each with a one-line why; fed by the deterministic "Due within the focus horizon" list (open items whose due window has started, ends inside the horizon, or has passed — overdue first) |
| 3 | `attention` | Needs your attention | "something needs my attention cause colleagues have not done it or it is getting out of control" | attention cards: kind (stalled / slipping / heating / blocker / overload), headline, situation, recommendation, project, to-dos, people, evidence. "Seen" dismisses the card for this run |
| 4 | `stale` | Stale tasks | "stale tasks that should be resolved… move or remove" | one proposal per item, exactly one op: `resolve_todo`, `cancel_todo`, `snooze_todo`, `set_todo{importance}` (no "keep" — silence is keep; no "move" — that is the split section) |
| 5 | `archive` | Finished projects | "get rid of old projects that just take space → archive" | `archive_project` (open to-dos close with it; restorable) |
| 6 | `merge` | Similar projects | "multiple similar projects that can be grouped" | `merge_project` |
| 7 | `split` | Overgrown / misfiled | "lots of tasks in a project… move that to a new project" | `create_project` + `move_todo` (peel out), `move_todo` (misfiled), `set_todo{description}` + `cancel_todo` (fold steps into one task) |
| 8 | `people` | People | "profiles that don't fit — suggest updates" | `update_profile`, `set_auto_process`, `set_manual_rank` |
| 9 | `rules` | Standing rules | "rules overlapping or inconsistent…" | `disable_instruction`, `rewrite_instruction`, `add_instruction` + `disable_instruction` (consolidate), `rescope_instruction`; conflicts as questions |
| 10 | `learn` | Learn from my edits | "if I cancel a type of event or assign it…" | `add_instruction`, `set_manual_rank`, `set_auto_process`, or a NOTE (empty ops) for a pattern that cannot be a rule |
| 11 | `questions` | Questions | — | `question` with optional OPTIONS, each a label + ops; choosing one queues a pre-accepted proposal in the section the question serves. Free-text answers still not recorded (warning shown) |
| — | `housekeeping` | Housekeeping | — | page-local, from the deterministic passes (§10.1): `prune_events`, `rebuild_interaction`, `unlink_threads` |

**Every to-do a section mentions renders as THE standard task row** (`shared/renderUtils.js` `taskRowEl`) with
the page's live handlers — tick, re-price, ✏️ opens the task editor, the project name opens the
project modal with its related items — exactly as on the Dashboard and Tasks pages (user,
2026-09-24). Those are ordinary hand edits, recorded and persisted like any other; they are not part
of the clean-up's accept/Apply flow. Attention cards therefore carry no queue buttons of their own.

The rail shows each section's undecided count; a decided section shows ✓. Sections can be ticked
off before a run (the closing turn tells the model which were asked for). The model emits in
`EMIT_ORDER` (stale → attention → focus → summary → the rest; 0.5 put the verdicts FIRST) — decisions first; the rail's order is the
reading order (look back, look forward, then act).

---

## 2. The request — how it is assembled

Same transport as the bootstrap and the earlier review: one streamed `freezr.llm.ask`, JSONL parsed
as it arrives (`createSectionParser`), surrogate ids translated back, cost summed across turns.

### 2.1 Turn layout

```
system prompt        cleanupPrompt.CLEANUP_SYSTEM_PROMPT (v0.3, ~15k chars)   fixed, zero interpolation
turn 1 (user)        CURRENT STATE + INPUT WINDOW — one text block, content-block array,
                     cache_control { type: 'ephemeral' } (provider default TTL, 5 min on Claude)
turn 2 (user)        CLOSING TURN — today, knobs, the sections asked for; uncached, ~500 chars
[turn 3 (assistant)  the model's JSONL — possibly ending in a need line]
[turn 4 (user)       REQUESTED MATERIAL + "continue" — cache-marked; at most 2 such rounds]
[…                   one continuation nudge if the reply stops without a done line]
```

The explicit breakpoint on turn 1 (rather than `cache: true` on the whole request) is what lets
turn 2 change between runs — a knob, a different section list — without invalidating the cached
prefix. Follow-up rounds append to the same conversation, so each re-reads the prefix from cache.

### 2.2 Turn 1, part A — the CURRENT STATE block (`buildStateBlock`, deterministic)

| # | block | source | rendering |
|---|---|---|---|
| 1 | Header | — | `# CURRENT STATE — as the app holds it now` + the id conventions |
| 2 | The user's situation | `settings.business_context` | verbatim |
| 3 | Standing instructions, with usage | `instructions` (all) joined to the window's analysis events: **offered** (`rules_offered` ∋ id), **cited** (`rules_applied` ∋ id), **overridden after** (a graded hand edit on a to-do whose analysis event within the prior 7 days cited the rule); `[USER-EDITED recently]` when created/edited < 14 days | `- [i_03] active · scope sender x@y.com · since 2026-08-22 · offered 14 · cited 9 · overridden after 3 · last offered 2026-09-18` + the text; then **Scope overlaps** (sender ⊂ domain ⊂ all) |
| 4 | Project catalog | `store.all()` active, not merged, by last activity | `catalogRow` (the analyst's own renderer — same bytes), then OPEN to-dos one line each (≤ 40: id · direction · who · imp · USER-SET · due · short), then the most recently CLOSED ones (≤ 8, with status + date) — **the user's rule: closed items matter, capped**. `[BUCKET]` projects (targets of a `file_to_project` auto-process) render as the row + counts only |
| 5 | People | solid, or provisional with imp ≥ 3, or manually ranked; by last seen; ≤ 200 | `renderPersonLine(…, 'brief')` + `[SOLID]/[provisional]`, `[USER-EDITED]` |
| 5b | Period counts | `periodCountsOf(windowEvents, handEdits)` — items by channel, threads, to-dos created / resolved / cancelled / updated (from the analysis events' `changes`), projects created, auto-filed, hand edits | one block of three lines |
| 5c | Due within the focus horizon | `dueWithinHorizon(store, { focusDays })` — open items whose `due_earliest`/`due_latest` has started, ends inside the horizon or has passed; overdue first, ≤ 80 | `- t_31 in p_08 ("Supplier invoices") [i_owe_them · who: … · imp 4] due 2026-09-22 (OVERDUE 2d) · "by Monday" — …` |
| 6 | Gathering dust | D4 `previewForgottenItems` at the knobs | `- t_2f in p_08 ("…") [i_owe_them imp 2] age 41d · quiet 30d — …` |
| 7 | Archive candidates | D3 `previewDormantProjects` | `- p_1a "…" · 14 to-dos all closed · last active 2026-05-02` |
| 8 | Your recent hand edits | `events` `kind: manual_edit`, `source_id: user`, over the edits window (30d), graded by `rulesInput.gradeHandEdits`: PROVEN OVERRIDE (before === the model's baseline), CORRECTION (cancel, direction off my list, bulk cancel per to-do, auto-process switched), EDIT; tick-only description edits dropped | `- e0012 · 2026-09-17 · PROVEN OVERRIDE · priority 4 → 2 on t_31 "Payment approval form" in p_08 "Supplier invoices" · sender billing@supplierco.com` |
| 9 | Earlier clean-up decisions | `maintenance_proposals` ignored / seen / dismissed, 90 days | `- IGNORED 2026-09-08: merge p_0a into p_1b` — fingerprints the app also suppresses on |

### 2.3 Turn 1, part B — the INPUT WINDOW

Two modes, a knob (`cleanup_input_mode`):

- **`index` (default).** `buildInputIndex` over the app's own analysis events in the window — no
  provider fetch, every channel (mail, Slack chunks, notes, agent sessions) — one line per item:
  `- m0042 · 2026-09-18 14:02 · from Alice <alice@x.com> → me@x.com [ME], bob@y.com · <the
  analyst's message summary> · touched: t_31 (updated), t_40 (new) · rules: i_03`, grouped under
  `=== th012 · mail · 3 items · last 2026-09-18 · "subject" · projects: p_08 "Supplier invoices" ===`
  (agent-session threads add `· repo <name>`; the header line counts items per channel, e.g.
  `604 items (mail 590, work 14)`). Slack shows up here only once Slack analyses produce events —
  as of 2026-09-24 the live store has none (Slack ingestion is not live).
  Bodies come on request (`need`) from the `inputs` store (`persist.getEmailBody`,
  `getThreadBodies`); a project's complete list from `renderProjectDetail`. Cost: the index of a
  week is tens of kchars instead of the ~636k of a dump.
- **`full`.** The bootstrap `dumpBuilder` mail dump (bodies capped, [ME] tags, ⚠ INCOMPLETE
  markers), mail only; `need` answers from `fullBodies`. Kept for the comparison experiment (E8).

Why send the window at all, given the to-dos reference their messages: because the sections that
matter most read what the analyst's per-message keyhole could not — a closing sentence that ends a
project, a tone shift across a thread, a colleague going quiet across several items. The index
gives the model the map of what happened; `need` gives it the wording only where it matters.

### 2.4 Turn 2 — the closing turn (`buildClosingTurn`)

```
Today is 2026-09-24 (Thursday). Treat this as the present for every "overdue / quiet for / due soon" judgement.
Run settings: input window 7 days (index of analysed items, all channels) · hand edits over 30 days · focus horizon 7 days ahead · stale = open, importance ≤ 3, older than 30 days and untouched 21 days · archive candidates = no open items and quiet 3 months.
[only when the accounts knob restricts the run:]
This run is restricted to these accounts: me@example.com, Slack — acme. The catalog holds ONLY the projects those accounts fed (12 of 58), with their people, and the input window ONLY their items. Everything else was left out on purpose — their absence is not inactivity, so do not call a to-do or project stale or finished merely because nothing from elsewhere appears here, and propose merges only among the projects shown.
Produce these sections, in this order: stale → attention → focus → summary → archive → merge → split → people → rules → learn → question → done.
Cite ids exactly as given. Keep every JSON line complete. Finish with the done line.
```

### 2.5 The system prompt — exact text of `CLEANUP_SYSTEM_PROMPT` v0.9

The block below is generated from `jobs/analyze_thread/maintenance/cleanupPrompt.js`
(`CLEANUP_SYSTEM_PROMPT`, printed with `node -e`); edit the code, then regenerate — never the other
way round.

<!-- PROMPT:BEGIN -->
```
You are the WEEKLY CLEAN-UP reviewer for superlazy, a dashboard of TO-DOS — what the user owes others, what others owe the user, and what the user's team must handle. A cheaper analyst files each incoming item one at a time, through a keyhole. You have the wide view: the app's whole current state, the user's own recent corrections, and the recent window of what came in. Your job is to help the user get their map in order for the coming week, and to put in front of them the things that need their attention. You propose; the user decides; nothing you write is applied without a click.

## Your input, in this order
1. "# CURRENT STATE" — the app's live state, with REAL ids: the user's situation; their standing instructions, each with how often it fired; the project catalog — every active project with its open to-dos (each with the last note the analyst left on it, when the project moved in the window) and its most recently closed ones; the people they deal with; counts of what happened in the period; the to-dos due within the focus horizon; a "Gathering dust" list of old open items; an "Archive candidates" list; the user's own hand edits over the last weeks, graded; and the decisions they took in earlier clean-ups.
2. "# INPUT WINDOW" — what came in recently. Either an INDEX — one line per analysed item (mail, chat, notes, agent work) with the analyst's one-line summary and the to-dos it touched — or full mail threads. Items carry short surrogate ids (m0042; threads th012). [ME] marks the user's own addresses wherever they appear.
3. A short closing message with today's date, this run's settings and the sections to produce.

## Asking for material
When you need an item's full text, a whole thread, or a project's complete to-do list (closed items included) to judge responsibly, emit a need line and STOP — send nothing after it:
{"section":"need","items":[{"kind":"message_body","msg_id":"m0042"},{"kind":"thread","thread_id":"th012"},{"kind":"project_detail","project_id":"p_08"}]}
The material comes back in the next message and you continue from where you stopped, without repeating lines already sent. Ask early and in ONE batch — everything you will need, before your first proposal — rather than one item at a time; at most two rounds are answered. Do not ask just to be thorough: judge from the summaries when they suffice, and ask when the decision turns on wording you cannot see — tone, a closing sentence, who exactly said what.

## Rules of engagement
- REFERENCE, never invent. Use project_ids, todo_ids, addresses and instruction ids EXACTLY as given in CURRENT STATE. Cite items by their surrogate ids. A line naming an id that does not exist is discarded unread.
- EVIDENCE on everything. Every proposal's description is written for the user — plain words, naming the people and the things ("The law firm confirmed the wire on Tuesday and thanked everyone") — and carries the item ids that support it. Never write a description that only says "per m0042".
- WORDS, not ids, in everything the user reads. Titles, descriptions, headlines, situations, recommendations, questions and option labels name projects, to-dos and people in words — the project's name, the to-do's short description, the person's name — never by their ids (p_41, t_1d6, m0042, e0012, i_03). The user does not know the ids. Ids belong ONLY in the operation fields, the id lists (todo_ids, people, items) and evidence.
- FEW and CONFIDENT beats many. An empty section is a good outcome. Do not fill sections to look thorough: ten suggestions the user ignores teach them to ignore you.
- The user's own work outranks yours. Values marked [USER-SET] or [USER-EDITED], and everything under "Your recent hand edits", are deliberate choices. Never propose reversing a hand edit made in the window. You may propose changing a user-set value only on strong evidence, and say so; the app flags it prominently.
- Earlier decisions stand. "Earlier clean-up decisions" lists what the user ignored before. Do not raise the same suggestion or question again unless this window adds genuinely new evidence, and then say what is new.
- [BUCKET] projects are standing filing bins for automated mail (newsletters, notices, promotions). They are not projects: never candidates for merge, split, archive or restructuring. Their individual items may still be judged stale.
- Silence is not resolution. Never mark an obligation done because nobody mentioned it.
- When you cannot decide but the user could, ASK — as a question. Questions are shown to the user for them to think about; do not expect an answer in this run, and do not make any proposal depend on one.

## What a project is
A project is a coherent line of work with an outcome — something the user would name as "one thing": "client X onboarding", "Q3 reporting", "hiring a designer", "office-lease renewal". It can span several emails/threads and people, has a beginning and an eventual end, and groups the to-dos that move it forward.
A project is NOT: a person (people have profiles, not projects); a standing category or label ("Finance", "Admin"); or a single throwaway to-do — unless that to-do is genuinely its own small effort. Judge membership by usefulness-together — "would seeing these to-dos in one place help the user act on this effort?" — NOT by topic similarity. The same person or topic can legitimately appear across several projects.

## What a to-do is
Every item has a direction: i_owe_them (ME must act), they_owe_me (someone else must act and ME is waiting), team_owes (a team member who is not ME must act), read_only (nobody owes anything; worth reading). "who" lists the OTHER people the item is about — never ME. An obligation belongs on the list of the person RESPONSIBLE for doing it; being copied, or caring about the outcome, is not enough. Importance is 1–5 (5 critical, 1 ignorable), set from content first, then from who is involved.

## How you express a change — OPERATIONS
Every suggestion is a PROPOSAL: a group, a short title, a description written for the user (what will change and why, with names), the evidence, and the list of OPERATIONS the app performs if the user accepts. Operations are the ONLY way anything changes. The vocabulary:
- {"op":"merge_project","source_project_id":"","target_project_id":""} — every to-do of the source moves to the target; the source is retired.
- {"op":"create_project","tmp_id":"np1","name":"","summary":"","importance":3} — a new project; later ops in the SAME proposal may name it by its tmp_id.
- {"op":"move_todo","todo_id":"","from_project_id":"","to_project_id":""} — to_project_id may be a tmp_id from this proposal.
- {"op":"resolve_todo","project_id":"","todo_id":""} — it was done.   {"op":"cancel_todo","project_id":"","todo_id":""} — it is moot or absorbed elsewhere.
- {"op":"snooze_todo","project_id":"","todo_id":"","until":"YYYY-MM-DD"} — resurfaces on that date, lower priority until then.
- {"op":"set_todo","project_id":"","todo_id":"","fields":{"importance":null,"who":null,"direction":null,"short_description":null,"description":null,"due_hint":null}} — only the fields you set; null means unchanged.
- {"op":"create_todo","project_id":"","todo":{"short_description":"","description":"","direction":"i_owe_them|they_owe_me|team_owes","who":[""],"importance":3,"due_hint":null}}
- {"op":"archive_project","project_id":""} — leaves the working set; its open to-dos are closed with it.
- {"op":"rename_project","project_id":"","name":""}   {"op":"set_project_summary","project_id":"","summary":""}
- {"op":"update_profile","address":"","fields":{"summary":null,"relationship":null,"responsibilities":null,"llm_importance":null}} — only the fields you change. summary/relationship are full replacement text. responsibilities is a LIST of strings, one per kind of work — send the list as it should read AFTER your change, leaving out any entry marked [YOURS]: those are the user's own words, they are kept whatever you send, and restating them only duplicates them.
- {"op":"set_auto_process","address":"","project_id":"","disposition":"newsletter|admin|social|promotions"} — file this sender's mail into that [BUCKET] project automatically from now on.
- {"op":"set_manual_rank","address":"","rank":3} — the user's standing 1–5 rank for a person; overrides the learned importance.
- {"op":"add_instruction","scope":"sender|domain|account|all","match":"","text":""}   {"op":"disable_instruction","instruction_id":""}   {"op":"rewrite_instruction","instruction_id":"","text":""}   {"op":"rescope_instruction","instruction_id":"","scope":"","match":""}
A to-do may be moved, resolved, cancelled or archived by at most ONE proposal in the whole run. A proposal with an EMPTY ops list is a NOTE: shown to the user, never applied — allowed only in the learn group, for a pattern that cannot become a rule.

## The sections — what you check, what you may propose
Work through ALL of them. They are numbered by the rail the user sees; EMIT them in the order the OUTPUT section gives — verdicts first.

### 1. NEEDS YOUR ATTENTION  (section: attention — not a proposal)
The user should leave the clean-up knowing what needs THEM this week. Look across the input window and the open to-dos for situations where the app's quiet bookkeeping is not enough:
- stalled — a they_owe_me or team_owes item where the window shows the other party has gone quiet, pushed back, or is visibly not doing it, especially when the user has already asked more than once.
- slipping — a due date passed or imminent with no movement, on something that matters (importance 3 or more, or a high-standing counterparty).
- heating — a thread whose tone has shifted: shorter messages, more people copied in, repeated asks, deadlines invoked, frustration or formality creeping in — on work the user is responsible or accountable for. Ask for the thread when the summaries hint at this and you need the wording.
- blocker — an i_owe_them item where others have asked more than once and the user has not replied.
- overload — an effort accumulating open items faster than they close, or being handled by a colleague in a way the window shows is going wrong.
For each situation give: a headline the user can read in two seconds (at most 12 words); the situation in two or three sentences with names and dates; your recommendation — what you would do now, in one or two sentences; the project, the to-dos involved, the people, the evidence. The app shows the to-dos beside your words so the user can act on them directly. At most 8 situations, the most consequential first. Ordinary work in progress is not a situation. An overdue item the window shows as finished or overtaken is NOT a situation either — it is a stale verdict (section 2); give it there and leave it out of here.

### 2. STALE TASKS  (group: stale)
"Gathering dust" lists old, low-priority open items. For each one you have a view on, ONE proposal with exactly ONE operation: resolve_todo (the window shows it was done), cancel_todo (it is moot — the event moved on, the question was overtaken, the ask withdrawn), snooze_todo (still real but not now — give the date it should resurface), or set_todo with importance (it matters more than its score says). An item you would keep as it is: say nothing. You may also give a verdict on an open item NOT in the list when the window plainly resolves, cancels or overtakes it.
OVERTAKEN BY EVENTS — check this deliberately; it is where the per-item analyst most often fails. For EVERY project the input window touched, read the window's summaries against that project's open list. An outcome reached in the window (a document signed, a payment made, a deal closed, a decision taken) finishes every open item that was a step toward it, whatever its age or importance and however recently it was touched: resolve_todo for each, or cancel_todo when it was overtaken. When a summary HINTS at such an outcome but does not settle it — "sent the signed letter" could be the final version or one more draft — ask for that message's body or its thread with a need line, in your one early batch, before ruling; a wrong resolve costs the user more than a fetch. Loose ends that might remain go as "- [ ]" lines in ONE follow-up to-do (create_todo in the same proposal), never as the old rows left standing.
An item that merely sits in the wrong project is not stale — that belongs under split.

### 3. FINISHED OR ABANDONED PROJECTS  (group: archive)
A project is finished when the input says so — the deliverable landed, the deal closed, "thanks all" — or abandoned when the effort visibly stopped and its open items are moot. One proposal per project, one archive_project op; name in the description the open to-dos that will close with it, so the user sees what they give up. "Archive candidates" lists projects quiet for a long time with no open items — confirm each you agree with; leave the rest unmentioned. Quiet alone is not finished: an effort waiting on a slow counterparty is alive. When you cannot tell, ask.

### 4. SIMILAR PROJECTS  (group: merge)
Two catalog entries are the SAME effort — the same underlying goal, overlapping people, to-dos that answer each other, or one entry created because the analyst did not spot the other. One merge_project op per proposal: keep the better-named entry, or the one with more history, as the target. Not a merge: two efforts with the same counterparty; two efforts on one topic with different outcomes; anything involving a [BUCKET]. If two projects look like one only because two names may be one person, ask instead.

### 5. OVERGROWN OR MISFILED  (group: split)
- Split: one entry holds two or more efforts a user would name separately — create_project for each new effort, then move_todo for each to-do that goes there; unlisted to-dos stay. The common case: a project of routine items in which ONE item has become its own effort — a problem to fix, an escalation, a negotiation — peel that one out into a new project named for the effort and leave the routine where it is.
- Misfiled: a to-do that plainly belongs to a DIFFERENT EXISTING project — move_todo to it.
- Restructure: several open to-dos are steps of ONE outcome — set_todo on the parent with a new description that keeps what is still useful and carries one "- [ ] …" line per absorbed child ("- [x] …" if that child is already resolved), then cancel_todo for each child. Their substance must survive in those lines. Never absorb a [USER-SET] to-do.
Sheer size is not the trigger; incoherence is. Propose only what a user would recognise as "this grew wrong".

### 6. PEOPLE  (group: people)
- update_profile — the stored profile is out of step with what the window shows: wrong relationship, stale responsibilities, wrong standing importance, a summary that misdescribes them.
- set_auto_process — a sender whose mail is plainly automated (notices, newsletters, receipts, portal alerts) and is not yet filed automatically.
- set_manual_rank — only when the user's own corrections show they rank someone differently from the learned importance.
- OVERLAPPING RESPONSIBILITIES — when "Responsibilities claimed by more than one person" lists a kind of work that two or more people's profiles both claim, decide what the window actually shows: if one of them really does own it, update_profile on the OTHERS to drop their claim (send their list without it); if they genuinely share it, make both entries say so in the same words ("… together with <name>"), so the analyst reads one arrangement rather than two competing ones; if you cannot tell from the window, ask it as a question naming both people. Ambiguity here is expensive — the analyst picks a different owner each time and the user's list of who-owes-what stops meaning anything.
Never for [ME]. Not for [SOLID] profiles unless the window contradicts them outright. Identity doubts ("is john.f@… the Jack in these threads?") are questions, not updates.

### 7. STANDING RULES  (group: rules)
The instructions are listed with their usage: offered (the analyst was shown the rule for a matching item), cited (the analyst says it changed the outcome), overridden after (the user corrected the outcome anyway). Tend the set:
- disable_instruction — offered 0 times in the window and older than 4 weeks: dead weight in every request (nothing is deleted).
- rewrite_instruction — it fired and the user still corrected the outcome 3 or more times: wrong or under-specified. Give the new wording.
- consolidate — several rules say the same thing (three per-sender rules that are one domain rule; a domain rule and an all-mail rule with one intent): add_instruction with the one sentence and scope that replaces them, then disable_instruction for each source, in the SAME proposal.
- rescope_instruction — an all-mail or domain rule that only ever fires for one sender: narrow it.
- conflicts — two rules that can match the same item with different verdicts: raise a question; resolving is the user's.
Never touch a rule the user created or edited in the last 14 days.

### 8. LEARN FROM CORRECTIONS  (group: learn)
Each hand edit is graded: PROVEN OVERRIDE (the analyst set a value, the user changed it), CORRECTION (the user cancelled something the analyst created, or moved an item off their own list to someone else's), or EDIT (a change with no analyst baseline). Look for PATTERNS: the same kind of correction on the same sender, domain, mailbox or class of notice, at least 3 times, spanning at least 2 projects or 2 senders. A burst on one project is a project problem, not a policy — leave it. For each pattern, ONE proposal:
- add_instruction — written the way the user would say it to an assistant ("Notices from billing@supplierco.com are priority 2 and belong in Supplier invoices (p_03)."). Choose the NARROWEST scope that captures the pattern: sender, then domain, then account, then all. The scope is the generality dial; choosing it well is most of the skill. The scope decides WHEN the instruction is shown to the analyst, not what it may say: a pattern that is about CONTENT rather than about who sent it ("routine supplier invoices", "anything mentioning the Alpha project") is a legitimate rule at scope 'all' — write the recognisable class into the text. Reach for 'all' only when the pattern genuinely has no sender, domain or account in it.
- set_manual_rank or set_auto_process — when the corrections cluster on one person.
- a NOTE (empty ops) — a pattern you can see but cannot act on: it needs a judgement the user has not made, or a mechanism the app does not have. A content pattern is NOT one of these — it is an 'all'-scope instruction (above). Describe it for the developer.
Cite the hand edits that make the pattern in the evidence. Fewer than 3 instances: propose nothing.

### 9. QUESTIONS  (section: question)
Ask when a one-word answer from the user would let a future clean-up act, or would become a standing fact: who someone is, whether two things are one, whether an effort is over, how a class of mail should be handled. Not for curiosities, and never to hand back a judgement you can make yourself. At most 6. Name the group each question serves. When the answers are actionable, give OPTIONS — each a label the user would click and the operations that follow from it (from the vocabulary above; an option with no operations is a valid "no" or "leave it"). A question whose answer can only be remembered, not acted on, has no options.

### 10. THIS PERIOD  (section: summary)
A short account of the period for someone who was away: what came in and from whom, what got done (the closed to-dos and the period counts tell you), what the user themselves did (their hand edits), what started (new projects), what is still hanging. Markdown, 120–250 words, plain and concrete — names, numbers, dates. No advice here; advice belongs in attention and focus.

### 11. FOCUS  (section: focus)
What the user should give their attention to over the focus horizon (the closing message gives the number of days). Rank open to-dos by what actually decides it: due dates inside the horizon or already passed (the "Due within the focus horizon" list), importance, people waiting on the user, and the situations in your attention section. Place each chosen item in "today", "this_period" or "later" and say in one line WHY it is there. 6–15 items; a full week is not fifty things. Items you place in "later" are ones the user might otherwise pick up too early. A short markdown lead (2–4 sentences) may set the shape of the period.

## OUTPUT — a STREAM of JSON objects, ONE PER LINE (JSONL)
No prose, no code fences, nothing before the first line or after the last. Every line must parse on its own; never wrap an object across lines. Emit in this order — stale, attention, focus, summary, archive, merge, split, people, rules, learn, question — and always the done line last.
{"section":"attention","kind":"stalled|slipping|heating|blocker|overload","headline":"","situation":"","recommendation":"","project_id":"","todo_ids":[""],"people":[""],"evidence":[""]}
{"section":"focus","markdown":"","items":[{"project_id":"","todo_id":"","when":"today|this_period|later","why":""}]}
{"section":"summary","markdown":""}
{"section":"proposal","group":"stale|archive|merge|split|people|rules|learn","title":"","description":"","evidence":[""],"ops":[OP, …]}
{"section":"question","group":"attention|stale|archive|merge|split|people|rules|learn","question":"","why":"","options":[{"label":"","ops":[OP, …]}]}
{"section":"done","counts":{"attention":0,"focus":0,"summary":0,"stale":0,"archive":0,"merge":0,"split":0,"people":0,"rules":0,"learn":0,"questions":0}}
"evidence" holds item surrogate ids (m0042) or, for learn and rules, the hand-edit ids given in CURRENT STATE (e0012). The final line is ALWAYS the done line.
```
<!-- PROMPT:END -->

**Why these words.** "Reference, never invent" plus the app-side validation: the Sep 8 run cited
ids that read well but could not be applied; now a bad id is a visible "not appliable" row, not a
silent failure. "Description written for the user, never 'per m0042'": the Sep 8 reasons were
readable only with the dump open. "Earlier decisions stand" is enforced on both sides (§0.5). The
bucket rule: 512 of the 979 open items sit in three filing bins that the prompt's own definition
says are not projects — restructuring one was the failure mode the old re-org review predicted (§10.2). The
`need` paragraph asks for ONE early batch because every round costs a cache read of the whole
prefix. Each section states what is NOT a candidate: experiments 01 and 09 showed exclusions carry
more weight than inclusions. "Fewer than 3 instances: propose nothing" and "spanning 2 projects or
2 senders" are the rule-stewardship evidence bar (§10.4), unchanged.

---

## 3. Operations — the structured language (`jobs/analyze_thread/maintenance/ops.js`)

Every proposal is `{ group, title, description, evidence[], ops[] }`. The app:

1. **validates** each op against the live stores — unknown project / to-do / address /
   instruction ids are problems (the row renders as "not appliable" with the reason); a to-do
   named under the wrong project is re-homed silently; `tmp_id`s from `create_project` resolve
   within the proposal; a to-do may be moved / resolved / cancelled / snoozed / archived by ONE
   proposal per run (later claims are problems); a fold (set_todo description + cancel_todo
   children) must carry a checklist line per child; USER-SET / USER-EDITED / SOLID / BUCKET
   touches become flags rendered in red; an empty `ops` is a note, allowed only in `learn`;
2. **describes** each op as an old → new row (`describeOps`) — the review surface never shows raw
   JSON;
3. **fingerprints** the proposal (`group|sorted ids`) for suppression.

| op | apply (all under the `audit` lock, one `manual_edit` event each, `source: 'maintenance'`) |
|---|---|
| `merge_project` | to-dos, drafts, participants and thread links to the target; source `merged_into` |
| `create_project` | `store.ensureProject(mintUserProjectId())`; tmp_id → real id for the proposal's later ops |
| `move_todo` | splice + re-home, evidence note, thread links + participants carried, both saved |
| `resolve_todo` / `cancel_todo` | status + `resolved_asof` + evidence entry |
| `snooze_todo` | `due_hint 'revisit by <date>'`, `due_earliest/latest`, `due_demote: 1` (the editor's own "lower until due") |
| `set_todo` | field-wise; `importance` skipped when USER-SET (noted); `who` also sets owner / counterparty by direction |
| `create_todo` | minted to-do with evidence `type: manual` |
| `archive_project` | `maintenance/archive.js`: copy to `projects_archive` (open to-dos cancelled on the copy, `archived_*` stamps), `persist.deleteProject`, `store.remove` |
| `rename_project` / `set_project_summary` | also refresh `llm_name` / `llm_summary` |
| `update_profile` | `profiles.applyReprofile(…, { userRequested: true })` with only the given fields; history snapshot when solid / user-edited |
| `set_auto_process` | `profiles.setAutoProcess` file_to_project, `source: 'user'` (accepted = the user's) |
| `set_manual_rank` | `profile.manual_rank` |
| `add_instruction` | `instructionStore.add` then `author: 'model'`, `proposed_in_run` |
| `disable_instruction` | `status: 'disabled'` — never deleted |
| `rewrite_instruction` / `rescope_instruction` | previous version pushed to `history[]`, `edited_asof` |
| `prune_events` / `rebuild_interaction` / `unlink_threads` | the housekeeping passes (§10.1, page-local): delete the event ids; replace a profile's `interaction_data`; `store.unlinkThread` (tombstoned in `unlinked_threads`) |

Apply order across proposals: stale → attention quick actions → split → merge → archive → people
→ rules → learn → housekeeping, so ids stay valid. A failing op stops ITS proposal only.

---

## 4. Attention cards and questions

**Attention** (`section: attention`, not a proposal): the model summarises the situation and
recommends; the app shows the to-dos it names as rows (priority, short, direction, status, due)
with three quick actions — ✓ done (`resolve_todo`), ✕ cancel (`cancel_todo`), ▲ raise (`set_todo`
importance +1, hidden when USER-SET or already 5). Each click queues a pre-accepted one-op proposal
(group `attention`, shown under the card as "queued for Apply", toggleable). "Seen" marks the
card decided for this run; the same situation returns next run if it persists — deliberately, with
a warning in the section blurb, until the experiment shows whether snoozing is wanted.

**Questions** (`section: question`): shown with "why it matters" and the section they serve;
"Dismiss" only. The blurb warns that answers are not recorded and points to the situation text.

---

## 5. The `/cleanup` page (`pages/cleanup.html/.js/.css`) — the experimentation host

- **Settings** (collapsed): model picker (`shared/modelPicker.js`; "User default" = the app's own choice);
  input window days + mode; hand-edits window; stale thresholds; dormancy months; section
  tick-boxes; **accounts** tick-boxes (2026-10-04). Windows and mode are saved to `settings` on change (they are the defaults every
  later host reads); thresholds are per-run knobs until the experiments settle them.
- **Accounts** (knob `accounts`, `null` = all): one tick-box per account the app knows — the stored
  `accounts` rows (mail connections, Slack workspaces as channel `messages`, agent stores as
  channel `work`), live mail connections not yet stored, and `manual` ("Local notes"). Default all;
  per run, NOT saved — the background job always runs on all. With a restriction, `prepare()` drops the
  window's channel items whose `account_id` is not ticked (hand edits always pass; legacy events with no
  `account_id` are dropped), so the input index, the period counts and the touched-projects set all
  follow it; full-mail mode dumps only the ticked mail accounts. **The catalog is scoped too** (user,
  2026-10-04 — a repos-only run was proposing clean-ups on mail projects): the state block holds only
  the projects whose `sources` provenance carries a ticked account's tag (`persist.sourceTagFor`:
  `email:<addr>`, `slack:<conn>`, `agents:<conn>`, `note:manual` — the page passes `accountTags`)
  plus any project a selected-account item touched in the window (covers untagged legacy records);
  people = those learned from the accounts plus the kept projects' participants; hand edits and
  earlier decisions are kept only when they concern a kept project (or no project at all). Stale /
  archive / due rows derive from that view, so nothing is proposed about an out-of-scope project or
  to-do. Standing instructions are always sent whole. The closing turn adds one line naming the
  ticked accounts, the catalog's n-of-m, that the rest's absence is not inactivity, and that merges
  are only among the projects shown. After an estimate each tick-box shows how many of the window's
  items that account contributed; the estimate line says "restricted to n of m accounts, n of m
  projects in scope"; the past-runs row says "n account(s)".
- **Estimate size & cost** — `core.prepare()` builds every block WITHOUT calling the model, then
  the line under the run bar shows the token count per block (system / state / input / closing),
  the items per channel, and the input cost at the chosen model's price (`modelPicker.selectedPricing`).
  The reply's size is unknown until it returns; the last run's output tokens are quoted as a hint,
  priced at the chosen model. `run()` reuses a fresh preparation of the same knobs, so estimate → run
  costs nothing extra.
- **Run the clean-up** — streams items into the review surface as they arrive; elapsed, and the cost
  split **input (incl. cache) vs output** from `meta.cost` — also in the run line, in Past runs, and in
  the run artifact (`cost_split`, `sizes`).
- **The settings explain themselves**: a help paragraph states what is always sent (the whole map —
  every active project with open + recent closed to-dos, people, rules, situation) and what the
  windows decide (input window = days of incoming history; hand-edits window = days of your manual
  changes for rules/learn; focus horizon = days ahead for Focus); the stale and archive conditions
  are labelled as ANDs.
- **Show pending from earlier runs** — the stranded-proposals fix: every item of the current
  prompt version still `proposed`/`accepted` is re-validated against the live stores and shown
  (also done automatically on page load when any exist).
- **The review surface** (`pages/cleanupView.js`): rail with undecided counts · panel with the
  section's blurb, Accept all / Ignore all, rows · sticky footer with the tally and **Apply**
  (audit lock; results listed; stores reloaded). The page installs the shell's task / project /
  person wiring (`shared/ui.js` providers, `taskOps`, the task editor, the email viewer context, the
  manual-event listener), so every task row is live and every modal is the real one.
- **Under the hood**: the exact CURRENT STATE text, the INPUT WINDOW text, the closing turn, the
  raw JSONL, the streamed thinking, call metrics (model, turns, cost, tokens incl. cache reads,
  sizes, need rounds, suppressed count).
- **Housekeeping**: D1 pruning preview (retention knob = the shared `events_retention_days`
  preference), D2 interaction rebuild and D5 orphan thread links → rows in a Housekeeping section of
  the same surface (§10.1). Previewed on demand only; never stored, never run by the job.
- **Archived projects**: the `projects_archive` list with Restore.
- **Past runs**: one line per run artifact.

Not in the nav. `shared/topbar.js` knows the title. The Setup-page tab (later) mounts `cleanupCore` +
`cleanupView` with no picker and no under-the-hood.

---

## 6. Data

- **`projects_archive`** (NEW, re-install): a `projects` record plus `archived_asof`,
  `archived_reason`, `archived_by` (`cleanup | merge-cleanup | user`), `archived_run_id`; open
  to-dos cancelled on the copy with `change_reason: 'archived with project'`. Never loaded by
  `persist.loadAll`. Restore = `persist.saveProject` + delete the archive record. Revive-on-new-
  activity is out of scope: a new message would create a fresh project and the next clean-up
  offers the merge.
- **`maintenance_proposals`**: one record per ITEM (proposal / attention / question) —
  `section`, `group`, `kind`, `title`, `description`, `question`, `headline`, `data` (the raw
  section, real ids), `fingerprint`, `evidence`, `flags`, `prompt_version`, `status`
  (`proposed | accepted | ignored | seen | dismissed | applied`), `status_asof`, `applied_asof`,
  `apply_note`, `apply_error`. Housekeeping rows are not stored. `pass` is gone.
- **`maintenance_runs`**: + `call`, `input_mode`, `window`, `dump_stats`, `sections`,
  `suppressed`, `need_rounds`, `tokens { input, output, cache_read }`, `knobs`.
- **`settings`**: + `cleanup_window_days`, `cleanup_edits_window_days`, `cleanup_focus_days`,
  `cleanup_input_mode`, `cleanup_last_run_asof`.
- **`instructions`**: `author: 'model'` values; + `history[]`, `edited_asof`, `proposed_in_run`.
- **Removed**: the `maintlab` page and its files, the old review prompt and call, the R1 re-org
  prompt (§10.2), `verifyMaintenance.mjs` (→ `test/verifyCleanup.mjs`).
- **Re-install needed** (new page, new collection, new fields):
  `http://localhost:3000/account/home?devUpdateApp=com.salmanff.superlazy` → "Regenerate App from Files".

---

## 6b. First real run (user, 2026-09-24, prompt 0.3, index mode, claude-opus-5-5)

604 items / 249 threads in the 7-day index (270k chars ≈ 68k tokens); the whole request read
≈ 226k tokens (the state block — 120 projects with open + closed to-dos, ~200 people — is the
bulk); 23.7k output tokens; **$2.01**. Sections: attention 6, stale 34, archive 2, merge 1, split 4,
people 3, rules 0, learn 1, questions 4. No `need` round was used. The cost estimate (§5) exists
because of this run; the state block's per-project caps (40 open / 8 closed) and the 200-people cap
are the levers if the size needs to come down.

## 6c. Prompt 0.5 (2026-09-25) — the signed-contract case

Two opus runs at 0.3 (Sep 24, Sep 25) proposed the right verdicts for the eight contract
to-dos left open in p_02 after the signed letter arrived; two sonnet runs at 0.4 proposed none and
wrote an "overload" attention card calling them overdue. Model and prompt version were confounded
and the request was not audited. 0.5 therefore: (a) adds the OVERTAKEN BY EVENTS check to the stale
section — for every project the window touched, an outcome reached finishes its steps whatever their
age/importance, loose ends folded into one follow-up to-do; (b) tells attention that an overdue item
the window shows as overtaken is a stale verdict, not a situation; (c) emits stale FIRST; (d) the
clean-up (and the re-org button) now write their requests to `llm_audit` like the analysis calls,
so the harness can replay them (E10 below); (e) 2026-09-26: the overtaken check says to FETCH the
message (a need line) when a summary hints at an outcome but does not settle it; the state block
now carries the newest evidence-trail note under each open to-do of every project the window
touched (`buildStateBlock({ touchedProjectIds })`), and the `project_detail` answer (also the
re-org button's input) carries the last three notes per to-do — the same trail the per-item
analyst reads.

| # | question | how | decides |
|---|---|---|---|
| E10 | Which of model / prompt version closed the signed-contract items? | replayed 2026-09-26 (`test/replayCleanup.mjs`, one run per cell): opus 8/8 on both prompts (0.5 as ONE outcome-shaped proposal); sonnet 0/8 + misleading overload card on 0.4, 5/8 on 0.5 | the clean-up runs on opus (user, 2026-09-26); 0.5 kept — it is what makes sonnet usable as a check, and its one-proposal shape is what the user reads. Found and fixed: the JSONL parser dropped a whole opus run written with trailing commas — see specs/analysis-experiments.md (E10) |

## 6d. One-project mode — the project editor's "Review this project" (2026-09-26)

`cleanupCore.prepare({ knobs: { projectId } })` narrows the SAME run to one project: the state block
holds that project only (its participants' profiles, its own stale/due rows, trail notes on every
open to-do), the input index holds the window's items that touched it (30 days by default), the
rules/people/learn sections are off, and `buildClosingTurn({ projectFocus })` adds one line naming
the project and forbidding merges. `pages/reorgReview.js` (`openProjectReview`) hosts it in a modal with `cleanupView` and the
usual accept → Apply path; runs are saved with `call: 'project_review'`. It replaces the separate R1
re-organization prompt (§10.2), which could not resolve to-dos by
design and saw no evidence. Model: `settings.cleanup_model` (Setup → Prefs "Clean-up & review model"; the /cleanup page's picker starts on it and saves changes to it), else opus — never `default_model`, the per-message analysis model.

## 6e. The clean-up in the background (2026-09-27) — BUILT

- **Where it runs.** Inside the one hourly job (`analyze_thread`): the maintenance code moved into
  `jobs/analyze_thread/maintenance/` because freezr zips only the job folder at install; the old
  root-level and `jobs/maintenance/` copies are gone. The page side imports the job modules
  directly; `pages/maintStore.js` is a thin wrapper over `jobs/analyze_thread/maintenance/maintStore.js`.
- **When.** `cleanupSchedule.cleanupDue(settings)`: the user's day and hour (default Monday 05:00,
  `settings.cleanup_schedule { enabled, day, hour, tz }`, tz from the browser, also stamped as
  `settings.user_timezone` by the shell) — once per slot, honoured for 24 h after it. The hourly
  `auto` run checks it; when due it runs the clean-up FIRST and then the mail check with the time that
  is left (user: both, not instead). `maxRuntime` 1800 s (manifest and on-demand `auto`/`cleanup` runs);
  the clean-up must return within 20 min (`CLEANUP_DEADLINE_MS`, no new model round past it).
  Background mode off: the first page that notices the slot fires a `cleanup` job run (the job re-checks
  the schedule, so two tabs run it once).
- **Blocking.** The clean-up (`kind: 'cleanup'`) and a one-project review (`project_review`) hold the
  shared run lock for the whole call, renewed every minute; a mail check already running is waited for
  (up to 3 min), another clean-up is refused. Mail checks see the holder and skip.
- **Telling the user.** The strip shows "Weekly clean-up running … mail checks wait" with a spinner
  (mail checks got the spinner too). A job run stamps `settings.cleanup_last_run { run_id, source,
  finished_at, suggestions, attention, cost, failure, seen:false }`; every page shows a results bar above
  the strip until it is clicked — the click marks it seen and opens the run's results (a modal on the
  shell, `/cleanup?run=` elsewhere). A failed run shows as a red bar with the reason. The cost is on
  the bar (user: no guard yet, show the cost). A page run is stamped seen.
- **Prefs.** "Scheduled clean-up": on/off, every day or every week (then the day), the hour, the next slot and the last run with its cost; "Run the clean-up now" on the last 1 / 7 / 14 / 30 days; "View the last clean-up" (the whole run, decided items included). A DAILY scheduled run reads the last day; a weekly one the page's window (7 days).
- **Model.** `settings.cleanup_model`, else opus (`DEFAULT_REVIEW_MODEL`, in the bundle).
- `test/verifyCleanupJob.mjs` 25/25.

## 7. Experiments — before any cadence decision (on the page, real store)

Method as `specs/analysis-experiments.md` §1; record results there too.

| # | question | how | decides |
|---|---|---|---|
| E1 | Does the JSONL + ops contract hold across models? | same window, index mode, haiku / sonnet / the ChatGPT default, ×2 | malformed lines, "not appliable" rows, continuation needed, cost; whether the content-block `cache_control` turn is accepted by every provider |
| E2 | Is "Needs your attention" worth its space? | the user grades each card useful / not, and each recommendation "what I'd do" / not, over 3 runs | ≥ 50 % keeps 8; else cap or tighten |
| E3 | Do questions earn their slot? | dismissed vs "made me change the situation text" | a section whose questions are all dismissed loses the right to ask |
| E4 | Accept rate per section | the tally after Apply, 3 runs | below ~30 % → tighten that section's prompt or drop it |
| E5 | Cache hit on re-run | run twice within 5 min, same model | `tokens.cache_read` on run 2 ≈ turn-1 size |
| E6 | Learn stays quiet on thin data | 30-day edits window on the real store | expected 0–1; any pattern below N=3 fails |
| E7 | Stale thresholds | 30/21 vs 14/14 | what produces verdicts the user accepts |
| E8 | **Index vs full input** | same week, both modes, same model | proposals and attention cards found by one and not the other; cost ratio; how often `need` was used and whether the bodies changed the verdicts |
| E9 | `need` rounds | count and kinds requested per run | whether 2 rounds suffice; whether the model batches as asked |

Cadence (job vs nudge vs manual) is decided from E4 after three runs — not before.

---

## 8. Phasing

| phase | delivers | status |
|---|---|---|
| P0 | spec | v0.6 — this file |
| P1 | prompt v0.3, ops, rules stats, index builder, call layer with need rounds, apply rewrite, archive collection, core + view, `/cleanup` page, manifest, `verifyCleanup.mjs` | **BUILT 2026-09-24**; prompt now 0.7 |
| P2 | E1, E5, E8, E9 on the page; prompt v0.3 → v0.4 | user |
| P3 | E2–E4, E6, E7 over three weeks | user |
| P4 | Setup-page tab (core + view, no picker) | not built |
| P5 | background job + notification; whatever P3 says about answers, snoozing, settled facts | **BUILT 2026-09-27** (§6e) — the notification is the results bar; the P3 items stay open |

## 9. Known gaps (deliberate, warned in the UI)

- Free-text answers to questions are not recorded; only a chosen OPTION acts (as queued ops). Settled facts are not recorded.
- "Seen" on an attention card does not snooze it.
- `full` input mode is mail-only; `index` covers every channel.
- Content-block `cache_control` turns are Claude's shape; freezr is documented to ignore caching
  on ChatGPT — whether it also tolerates the block shape there is E1's first check.
- Pending items from an older prompt version are not re-shown: "Show pending" filters to the
  current prompt version.
- The old review's business-context recompile and writing-style refresh have no clean-up section
  and no op; neither was carried forward.

---

## 10. Deterministic passes and the one-project review

What the clean-up stands on that is not the model call: the free passes, the one-project mode's
history, what each tier costs, and how far rule stewardship is built.

### 10.1 The deterministic passes (D1–D5)

All in `jobs/analyze_thread/maintenance/deterministic.js`; each is a pure preview over the stores
or the events log and changes nothing. D3 and D4 run inside every `cleanupCore.prepare()` (page,
one-project mode, job) against the run's scoped view of the store. D1, D2 and D5 run only when the
user presses the Housekeeping button on `/cleanup` (`pages/cleanup.js`): their rows join the
Housekeeping section, are never stored, and the job never runs them (§0.7).

| pass | function | finds | apply |
|---|---|---|---|
| **D1** events pruning | `previewEventsPruning` | events whose `_date_modified` is older than `events_retention_days` (default 90; 0 = keep forever; Setup → Prefs and the page knob share it); counts by kind, ≈ size, oldest | one bulk `prune_events` → `applyEventsPruning` (deletes five at a time) |
| **D2** interaction rebuild | `previewInteractionRebuild` | mail interaction stats per address recomputed from the events log from scratch (incremental counters drift across reruns and skipped windows), listing ONLY profiles that differ; also the true reply medians, which only the rebuild can compute. Approximations, shown: only analysed messages count; reply pairing is thread adjacency, not In-Reply-To. Cross-channel profiles keep their seen-dates | `rebuild_interaction` per profile — replaces `interaction_data` |
| **D3** dormant projects | `previewDormantProjects` | active, unmerged projects with no open to-dos and no activity for `dormantMonths` (default 3) | none of its own: the rows are "Archive candidates" in the state block; the model confirms with `archive_project` |
| **D4** forgotten items | `previewForgottenItems` | open to-dos with effective importance ≤ 3, older than 30 days, no evidence for 21 days (page knobs) | none of its own: the rows are "Gathering dust", the stale section's input |
| **D5** orphan thread links | `previewOrphanThreads` (2026-10-04) | per project, each linked thread is CITED (a to-do's evidence names it), TOUCHED (a message on it changed the project) or ORPHAN. Links only ever grew, so a mis-filed or moved to-do left its thread on the wrong project, handing the model that project's list on every new message | `unlink_threads` → `store.unlinkThread`, tombstoned in `unlinked_threads` so the save-time merge keeps the removal |

**Evidence beats a timeout.** On the young store D3 found nothing at any threshold, while the first
model review proposed two archives off the closing sentence of each effort. The model knows an
effort is finished because it read the message that finished it; D3 can only wait for silence. D3
is the backstop for efforts that fade without a closing message. D4 is the only net for old,
low-priority items once the per-message prompts stop carrying them.

Not built: a longer retention floor for some event kinds in D1; a "gathering dust" badge in the
everyday UI fed by D3/D4. (The D3 comment in `deterministic.js` still says its apply waits on the
archive storage decision; that decision was made, see §6 `projects_archive`.)

### 10.2 The one-project review (formerly R1)

From 2026-08-31 to 2026-09-26 the project editor carried a separate re-organization prompt (R1):
one project's full detail in, `split_project` / `restructure_tasks` / `rename` / summary
proposals out. It could not resolve or cancel to-dos and saw no evidence, so it was replaced by the
clean-up restricted to one project (§6d). The wiring today: `shared/projectEditor.js` "⚙ Review this
project…" → `ops.proposeReorg` (`shared/ui.js`) → `pages/reorgReview.js` `openProjectReview` →
`cleanupCore.prepare({ knobs: { projectId } })`, sections `attention, stale, archive, split,
questions`, a 30-day window (`PROJECT_REVIEW_WINDOW_DAYS`); the job accepts the same `projectId`
(`cleanupJob.runCleanupInJob`). `jobs/analyze_thread/maintenance/reorgCall.js` keeps only
`renderProjectDetail` — the `project_detail` answer to a `need` line, and the replay tooling's input.

**Merges are not this mode's job** (settled 2026-09-10, do not re-litigate). It sees one project,
so it cannot judge a duplicate or a misfiling against the neighbours; the closing turn forbids
merges. Merge authority stays with the weekly run's merge section, which holds the whole catalog.
A merge hunch while looking at one project goes through the editor's manual "Merge into another
project…" picker. The fold ("restructure") is best exercised on the few large projects; the large
filing buckets are not projects and are never restructured.

### 10.3 Cost and cadence

What a pass must SEE decides where it can run, and so how often: a pass over the app's own tables
costs nothing and could run unattended; one that reads the state plus the input window costs a
call, and the size of that input is the whole expense.

| tier | must see | runs | cost / run | cadence today |
|---|---|---|---|---|
| 0 | app tables only, no LLM | D1–D5 | free | D3/D4 inside every clean-up; D1/D2/D5 by hand on `/cleanup` |
| 1 | one project + its 30-day items | Review this project | not re-measured since the switch (the old R1 call was $0.05–0.15) | on demand, a button |
| 2 | the whole state + the input window | the weekly clean-up | $2.01 measured on opus (§6b); the state block, not the window, is the bulk | the user's slot (default Monday 05:00), or on demand |

The old plan's separate cheap tier for correction learning is not kept: rules and learn ride the
weekly call because they read better with the project context (decision 3).

**Cache cost of an accepted change.** A sender, domain or account instruction renders in the
per-message volatile block, so accepting one is free. An `all`-scope instruction and the business
context sit in the cached durable block; changing either discards the pin
(`durableSig`, `jobs/analyze_thread/ingest.js`) and costs one re-render of the prefix.

Open (a proposal, not a decision): D1 + D2 + D5 as an unattended sweep once the user has judged
them on the page; D3/D4 as an everyday badge rather than a run; the LLM cadence from E4.

### 10.4 Rule stewardship — the clean-up owns the rule SET

One standing instruction took a class of mail from 0/9 to 9/9 correct, so rules will proliferate
and overlap unless something tends them. Two jobs, run together in one call: **(a) propose rules
from the user's corrections** (the `learn` section) and **(b) tend the rules that exist** (the
`rules` section). The model never counts — `jobs/analyze_thread/maintenance/rulesInput.js` does,
and `cleanupPrompt.js` turns the counts into the rules in §2.5.

Built:
- **Input = the user's own edits only.** `manual_edit` events with `source_id: 'user'`; the clean-up
  writes its own applies with `source: 'maintenance'`, so it never learns from itself. Edits are
  coalesced at write time (a 3 → 4 → 5 fiddle is one record).
- **Graded** (`gradeHandEdits`): PROVEN OVERRIDE (the value before matches the model's baseline
  `llm_importance` / `llm_short_description` / `llm_description`), CORRECTION (a cancel — the model
  never cancels the user's work, so it is always dissent; a direction moved off the user's own list;
  each to-do of a bulk cancel, re-joined to its sender through the store; an auto-process switched;
  a project deleted), else EDIT. A description edit that only ticks checklist boxes is progress,
  and is dropped.
- **Usage per rule** (`instructionUsage`, over the hand-edits window): offered and cited from the
  analysis events' `rules_offered` / `rules_applied`; *overridden after* = a non-EDIT hand edit
  within 7 days of an analysis that cited the rule; created or edited in the last 14 days =
  untouchable.
- **Scope overlaps** (`scopeOverlaps`): a sender rule inside a domain rule, any narrower rule inside
  an `all` rule.
- **What the prompt may do with them:** disable a rule offered 0 times and older than 4 weeks
  (never deleted); rewrite one overridden 3+ times; consolidate (one `add_instruction` +
  `disable_instruction` for each source, in one proposal); narrow an `all` or domain rule that only
  fires for one sender; raise a conflict as a question (resolving is the user's). Learn needs 3+
  instances spanning 2+ projects or 2+ senders (a burst on one project is a project problem),
  picks the narrowest scope, and writes a content pattern as an `all`-scope rule — the scope
  decides WHEN a rule is shown, not what it may say (corrected 2026-09-26, after a real content
  pattern was filed as an unactionable note). Clusters on one person become `set_manual_rank` /
  `set_auto_process`; what the app cannot act on is a NOTE. Ignoring a pattern is permanent.
- **Writes:** `author: 'model'`, `proposed_in_run`, the previous version pushed to `history[]`.
  A global wording change to `jobs/analyze_thread/prompt.js` is a developer action at a
  `PROMPT_VERSION` bump; at run time its equivalent is an `all`-scope instruction.

Not built:
- **Deterministic conflict detection.** Overlaps are listed; whether two overlapping rules give
  different verdicts is left to the model.
- **Scope drift over weeks.** Usage covers the hand-edits window only; "a sender rule whose sender
  stopped mailing" is caught only as offered-0.
- **Proven re-assignment.** A direction change off the user's list grades as CORRECTION by its
  shape, not by a join to the model's recorded choice; *which person* it went to has no model
  baseline (no `llm_owner` in `reconcile.js` `LLM_BASELINE`), so `who` edits grade as EDIT.
