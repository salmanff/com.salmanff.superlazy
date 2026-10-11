# Analysis experiments — the method, and what it decided

_Written 2026-10-10 as the clean record of the September 2026 experiments (prompt 0.53 → 0.66).
The raw write-ups and every real case stay private in the gitignored `testConfidential/`. This
document describes people only by role ("a colleague", "the service provider") and reports only
counts._

**In one paragraph.** Replaying real recorded requests through the real API, one variable at a
time, settled most of the analyser's design. Where an obligation lands is fixed by stating the
attribution principle at the top of the prompt, not by app code that rewrites the model's answer,
and not by raising thinking or effort. A burst of identical notices collapses into one item only
if the prompt says so. Haiku matched or beat sonnet on every scored question at about a quarter of
the cost, so it became the default, and no ChatGPT model tested substitutes for it. A standing
instruction is the most reliable lever there is. Where text sits in the request matters as much as
what it says. And several fields the model was filling in had no reader, so they were removed.

Sections are labelled **E1–E11**, so code comments can cite them as
`specs/analysis-experiments.md (E4)`. There is no E8.

---

## 1. The method

Take a request the app really sent, reconstruct it byte for byte from the `llm_audit` recording,
change exactly one thing, send it again through the real route, and score the reply mechanically.

**Why byte for byte.** A real request is about 95,000 characters: the system prompt, a cold cached
block of quiet projects, a hot cached block of active ones, and a volatile turn carrying the new
mail. The answer depends on all of it. A hand-built fixture that recreates "roughly that situation"
answers a different question. So does a subagent asked to "act like the model".

**Why at least three repeats.** The model is not deterministic on these judgements. The same
eight-message batch produced four, eight and nine new items on three identical runs. The most
expensive mistake in this work was concluding from clean single runs that the production settings
were at fault; a proper control at production settings showed the model failing a third of the
time at every setting. A four-call sample cannot separate a 60 percent arm from a 25 percent one.

**Count what a run PRODUCED, not only what it got wrong.** A model that returns nothing passes
every "did it put this on the wrong person?" check.

### The tools today

| tool | answers |
|---|---|
| `test/regression/run.mjs` | after any prompt change, did anything that used to work break? A fixed battery against a frozen snapshot, with a baseline and a regressed/improved diff. See `test/regression/README.md`. |
| `test/replayArms.mjs` | one stored request under several arms (prompt or context variants). |
| `test/replayLevels.mjs` | one CASE across several successive messages ("given the earlier miss stands, does THIS message catch it?"). |
| `test/liveArms.mjs` | the real engine against today's store (read-only client), so the user's own corrections and the current context are in the request. |
| `test/replayCleanup.mjs` | the weekly clean-up as of a past moment. |

All of them take `--dry`, which builds and saves every request and sends nothing. Read those before
spending. Cases, fixtures and arm wordings live in `testConfidential/`.

### Things that will bite you

- **Changing `effort` invalidates the whole cached prefix.** The first call after a change writes
  the full ~50,000-token prefix again. Group runs so that happens once.
- **A replay can come back as `request_more`.** Production had already spent its detail rounds on
  the request, so a replay must either resolve the round or be told rounds are unavailable.
  Otherwise the run is unscoreable.
- **Name the provider on every run, not only the family.** A family means nothing on its own.
- **Explicit cache breakpoints are Claude-only.** Other providers reject the content-block shape and
  cache automatically anyway.
- **A run on a local CLI connector (`--via local`) reports zero cost**, and that is correct. The
  CLI also takes its system prompt in argv, capped well below superlazy's, so the prompt travels
  as the head of the user turn. Good for wording and placement questions. For cost, cache or
  schema questions, use the server route.
- **A stored request is frozen on the day it ran.** It cannot see corrections made since. That is
  what `liveArms` is for (E11).
- **Cost is real.** A sonnet call on a full request is roughly five cents, haiku one and a half.
  Price a grid before launching it.

---

## 2. The starting state (live store, 2026-09-17)

| | |
|---|---|
| open items | 979 |
| of those, read-only | 623, with 512 in three standing buckets |
| open to-dos from one automated mailer | 346, one per notice |
| open "I owe" items whose owner is not the user | 54 of 275 (20 percent) |
| messages with the user on Cc only that still minted an obligation on them | 9 of 87 |
| active projects | 111, up 36 in seven days |
| messages carrying no ME tag at all | 186 of 473 (39 percent) |

Three problems sit in that table. Obligations went to the user when somebody else owed them.
Repeated notices exploded into one to-do each. And projects were created at about five a day,
including duplicates of standing buckets the model had just been shown. The 39 percent with no ME
tag was a configuration hole: a second personal address and two shared mailboxes were not listed
as the user's. That has been fixed. It mattered more than any prompt change, because the model was
deciding who owes what with its most important signal missing.

---

## 3. The experiments

### E1 — Who an obligation belongs to, and repeated notices (2026-09-17/18)

**Cases.**
- A1: a colleague asks outside counsel for input, with the user on Cc.
- A2: the service provider sends a draft to two team members, with the user on Cc.
- B: eight identical portal notices in one batch.

**Measured.**
- At production settings, A1 was put on the user a third of the time. Raising thinking or effort
  fixed nothing, and changing effort invalidates the cache.
- The burst produced eight items on every run, every model, every setting.

**Findings.**
- **State the attribution principle up front.** An obligation goes to whoever is responsible for
  doing it. It is the user's only when they are asked directly, responsible by role or history,
  habitually passed it, or stepping in on something consequential. Placed straight after the
  prompt's opening paragraph, this took A1 from 33 percent wrong to 6 of 6 correct.
- **Require a reason on every obligation put on the user.** With the reason, 7 of 7 correct;
  without it, 4 of 10, with 6 wrongly on the user. The field is load-bearing, not monitoring.
- **One process, one item.** A rule that instances of one process become checklist lines on a
  single item fixed the burst on sonnet and haiku.
- **A standing instruction is a reliable lever.** One sentence saying a notice class belongs to the
  service provider went from 0 of 9 to 9 of 9, with no regression on neighbouring items.
- **Things that did NOT work.**
  - A per-message envelope cue under the header.
  - An invariant saying direction and owner must agree. It backfired: the model rewrote the owner
    to the user with an invented justification.
  - An app-side guard that rewrote the model's verdict. It was built, measured, then deleted with
    all its markers; the prompt is the fix.

**Still open.** Right owner, wrong label: the model names the right person and still writes "I
owe". There is no net for this now.

### E2 — Does the catalog's project summary drive matching? (2026-09-19, 140 runs)

**Design.** Ten recorded over-creation cases, with the catalog rows rewritten three ways: full
summary, first sentence only, and no summary.

**Finding.** Stripping all 25,250 characters of summary moved sonnet and haiku in opposite
directions, which is noise. Name, keywords, people, open count and recency carry matching.
Over-creation is mostly message-driven: some messages genuinely match nothing.

**Ground truth.** On the one provable-duplicate case, haiku was right 6 of 6 and sonnet 5 of 6. So
production duplicates come from a roughly one-in-six tail on a decision taken about a hundred times
a week. That argues for resolving the closed set of standing-bucket names in code.

### E3 — Is there a ChatGPT equivalent of haiku? When is an empty answer an error? (2026-09-19)

**Measured.** "Usable on the first try", meaning the reply survives `analyze.classify` without a
repair round:

| model | usable first try |
|---|---|
| haiku-4 | 9 of 9 |
| gpt-5 | 4 of 6 |
| gpt-5-nano | 4 of 9 |
| gpt-5-mini | 2 of 9 |
| gpt-5.6-terra | 1 of 9 |
| gpt-5.6-luna | 0 of 9 |

The two models said elsewhere to be haiku's and sonnet's counterparts were the worst performers.

**Findings.**
- **Every ChatGPT model omits `msg_id` on batch entries**, including full-size gpt-5. Haiku never
  did. The cheap ChatGPT tiers also ask for detail rounds they were told were unavailable, or
  return nothing.
- **Decision:** `PREFERRED_FAMILY` (`jobs/analyze_thread/config.js`) lists Claude only. Any other
  provider keeps its own default rather than being handed an untested model. The user's own pick
  always wins.
- **Empty answers.** 306 of 757 real analyses create no item, and the prompt asks for exactly that.
  Zero of 757 omit the message summary. So **a blank `message_summary` is the error signal**, not
  an empty item list. `analyze.classify` rejects it and the repair round fixes it.

### E4 — Does native structured output fix the batch-contract failures? (2026-09-19)

**Measured.** With a JSON Schema, ChatGPT's `msg_id` omission went to zero: 17 of 17 runs, against
5 of 15 control runs dropping one. Nulls per to-do roughly doubled under strict mode. Detail-round
requests did not change, which confirms that is a prompt problem.

**Anthropic refuses this schema.** It has 29 nullable or union fields against a cap of 16, and the
whole grammar is size-bounded too. A trimmed core contract (projects, to-dos, summary, delta,
`request_more`) does fit. A schema forks Claude's cache rather than breaking it.

**Decision:** send the schema to ChatGPT, never to Claude, always, with no setting. That is
`engine.schemaFor`, the one provider-aware rule in the code. Reconcile accepts the schema's array
form of `participants` and stores the contract's map. **Correction from E7:** the schema's
`triggers[].details` shape originally forbade subscription payloads. The schema was fixed so a
delivery can pass through.

### E5 — Does a standing instruction still work from the CACHED block? (2026-09-19, local, $0)

**Context.** Prompt 0.54 moved every all-mail standing instruction from the per-message turn into
the cached block. That saves cost, but the instruction then sits ~100k characters before the
message.

**Measured** with a mechanical, countable rule: 38 of 38 message results obeyed it from the cached
block, against 28 of 28 from the per-message turn. The move stands.

**Side finding.** `rules_applied`, where the model names the instructions that changed its
analysis, is model-dependent:
- Codex cited 53 of 53.
- Haiku obeyed 43 of 43 but cited only 10 of 43.

**Read the field as a floor, never a count.**

### E6 — Do richer recipient profiles change which project a message lands in? (2026-09-20)

Prompt 0.55 gave `to:` recipients full profiles and promoted the first cc's.

**Measured.** 12 percent of entries changed between arms, against 10 percent between two runs of
the same arm: no measurable effect. The catalog's participant lists appear to do the
address-matching already.

**Decision:** the user kept the change as a judgement call. Its cost is known (+734 characters per
call, under 3 percent of the volatile block); its benefit is unproven. Do not cite it as
evidence-backed.

### E7 — Do subscriptions still get delivered after the switch to haiku? (2026-09-20)

**Context.** Third-party app subscriptions depend on the model emitting an `app_subscription`
trigger. No trigger means no delivery, and no error either.

**Measured.**
- Four real supplier-invoice emails, replayed locally: the trigger fired on 4 of 16 runs. The same
  model on the same email fired on one run and not the next, which is unreliability rather than a
  capability ceiling.
- Metered, haiku fired 2 of 4, with payloads richer than production's.

**Shipped bug found.** The structured-output schema forbade a trigger's `sub_id` and `payload`, so
**every ChatGPT delivery since E4 had arrived as an empty husk**: 0 usable with the schema, 3 of 4
without. Fixed in `analysisSchema.js`.

**Smaller defect.** One model named a payload field differently from the contract. Payload keys
must follow the subscription's contract.

### E9 — Why instructions and subscriptions get ignored, and what fixes it (2026-09-20, ~90 calls, 8 emails)

**Finding.** **Placement, not capability.** The instructions sit in the cached block, far from the
message. A short reminder appended at the END of the volatile turn fixed it: a must-obey header, a
count, and an index of `sub_id — label`, with no instruction text repeated. Haiku went from 2 to 8
of 8. The reminder lifts a floor; it does not raise a ceiling.

**Measured.**
- A bigger model did not help: an Opus-class model scored 4 of 8.
- Detection and action moved together in every run, so a miss is a judgement failure, not a
  compliance one.

**Shipped as** `assemble.instructionReminder` (prompt 0.56). It is built from the live registry so
it cannot drift, and 50 subscriptions stay under 4k characters.

**Scoring lesson.** The subscribing app's own prompt is the specification. Emails whose payload is
sparse (a portal notice, "see attached") are exactly what the app asked to be told about. Dropping
them as "ungradeable" nearly inverted the result.

### E10 — Stale steps after an outcome: one case replayed at four levels (2026-09-26)

**Case.** A multi-step contract matter. A signing message should have closed eight open steps.
Production closed none and created a twin.

**Levels.**
- L1: the outcome message itself.
- L2: a reply.
- L3: an indirect congratulation.
- L4: a long briefing full of new asks.

**Measured and shipped, by prompt version.**
- **0.60, "an outcome closes its steps".** Combined with a widened "open items to account for"
  block and an implicit project-detail round, L1 went from 0 to 6–7 of 8. The fair ceiling is 7,
  because one step legitimately survives the signing.
- **0.61, required `account_for`.** The model either worked the whole account-for block or skipped
  it entirely, and the skip was invisible. So `account_for: [{ todo_id, verdict, reason }]` became
  a required output field. `analyze.classify` rejects a reply that omits a listed id, and reconcile
  applies the verdicts. After this, every listed id got a verdict on every run.
- **0.62, "judge the LINE, not the project".** The remaining failure was judgement: a step that was
  done was kept "open" because the wider effort continued. This sentence moved the reply level
  from erratic to 7, 6 and 6 of 8.

**Inline replies.** When the user answers questions between quoted paragraphs, the answers used to
be stripped with the quote. `inlineDiff.js` now renders a "## Inline answers in this message"
section under the body, and the model reads them every time.

**Still open.** Even then, the model ticks every checklist line and keeps the to-do in progress for
the counterparty's next step. An objective rule — a to-do whose every checklist line is ticked is
done — is the candidate fix.

**The weekly clean-up is the net for the rest.** Replayed as of the failing week:
- On opus, both prompt versions closed all eight. The 0.5 prompt did it as one outcome-shaped
  proposal.
- On sonnet, 0.5 went from 0 to 5 of 8.
- It also found a parser bug: the parser rejected a model that wrote its lines as a JSON array.

### E11 — What makes a class of work land on the colleague who owns it (2026-09-26/27, 166 calls)

**Case.** Routine supplier-invoice to-dos kept landing on the user, who kept moving them by hand. The
store had them split across five owners. The responsible colleague's profile already described
that responsibility, and it rode in the cached block of every request. The information was present
and unused.

**Arms**, each changing one thing:
- a standing instruction;
- the profile text rewritten as an assignment;
- that text plus a prompt clause saying a colleague's responsibilities can take an obligation off
  the user's list;
- a roster block;
- several terse, human-typed one-liners.

**Findings.**
- **Two mechanisms route; neither is a wording trick.** On the discriminating cases:
  - the profile paragraph with the clause, 14 of 16;
  - the standing instruction, 5 of 6;
  - the control, 0 of 5.
- **Both halves of the paragraph mechanism are needed.** The long text without the clause scored
  2 of 6, and a short text with the clause about 1 of 6.
- **A one-line, human-typed responsibility does not route**, however it is worded: pronoun, joint
  phrasing, or an explicit "not the user's". Six variants gave one result. The roster lost too.
- **Routing and importance are separate problems.** Only the standing instruction, which states an
  importance, changed importance.
- **The live store is the biggest lever.** Running the real engine against today's store showed
  that a project's existing history decides routing where it exists, which a stored replay cannot
  see. A dedicated section helps where there is no precedent.
- **A recipient list is not "asking a named person".** Treating it as one scattered items
  addressed to colleagues; fixing that wording recovered them.
- **Escalations (an overdue chaser) need their own mechanism.** The escalation sentence never fired
  and was dropped.

**Shipped.**
- **0.64:** `profile.responsibilities` became a list of entries owned by the model or the user
  (`responsibilities.js`).
- **0.65:** a "Who handles what" section with its instruction.
- **Follow-up:** "Add as standing instruction" on a person's card (`responsibilityInstructions.js`),
  because a standing instruction is what routes reliably on haiku.

**Still open.**
- How long must a responsibility entry be before it routes? Bisect the working text.
- Should importance have its own mechanism?
- An approval request addressed to the user plausibly IS the user's; re-judge it before counting
  it as a miss.

---

## 4. Decisions that came out of this, in one place

| decision | from |
|---|---|
| The attribution principle goes up front; every obligation on the user carries a reason. | E1 |
| No app-side code rewrites the model's verdict. | E1 |
| One process, one item; instances are checklist lines. | E1 |
| Leave thinking and effort alone. | E1 |
| Default to the provider's small fast model; only Claude gets a family preference. | E1, E2, E3 |
| A blank message summary is an error; an empty item list is not. | E3 |
| Structured output goes to ChatGPT only (`engine.schemaFor`). | E4, E7 |
| All-mail standing instructions live in the cached block; a reminder index goes last in the volatile turn. | E5, E9 |
| `rules_applied` is a floor, never a count. | E5 |
| Outcomes close their steps; `account_for` is required; judge the line, not the project. | E10 |
| Responsibilities are a list; a standing instruction is the reliable router. | E11 |
| **Cache membership is about WRITES, not reads.** Only the frequently rewritten block's size matters; the measured rule (`selection.js`) put 58 percent fewer bytes in it. Stable text belongs in the cached block wherever it came from: the situation, all-mail instructions, app instructions, the writing-style guide. | measured 2026-09-19 |

### Removed because nothing read them

- `confidence` on to-dos and replies.
- The "be brief" note.
- Three no-snapshot fallbacks that never ran in production.
- The whole profile fit accumulator: `fit_concerns`, zero ever emitted.
- `project_drift`.
- `manual_locked`, set on none of 1,345 items.
- `owners[]` as a model-filled field. The stored field stays, fed by `who`.
- The mailbox-actions prompt section.
- The app-side ownership guard.

### Re-shaped

- The four who-fields became one `who` list. `whoMapping.js` translates it to the stored fields.
- The two "new for me" flags are now derived by reconcile from the to-dos it actually minted.

### Granularity: the goal is the ruler (0.57–0.59)

**Problem.** In the work channel, to-dos landed at the size of a TURN, so one project collected
about 130 step-sized rows.

**What shipped.**
- A project is a GOAL. It is never named after a channel, repo, agent or session, because those
  name a place, and a place has no finish.
- A to-do is a sub-goal and a checklist line is a step, each judged against this project's goal.
  Two tests decide: the progress-report test and the "no nearer" test.
- A floor of three resolved to-dos is shown at every rendering tier.
- 0.58: routine hygiene wins over the "outlive" test.
- 0.59: a plan is one row while it is a draft, and is sized by the ruler on acceptance.

**Not measured.** There was no control arm, so the effect of the prompt and of the resolved floor
cannot be separated. The arm machinery (`promptVariants.js`, `promptOverride`) is in place.

## 5. Still open

These are tracked in `pipeline-backlog.md`.

- Right owner, wrong label (E1).
- No false-negative fixtures. Nothing measures obligations that never reached the user's list.
- Standing-bucket names belong in code (E2).
- Trim the 25k-character catalog summary.
- The importance scale is barely used at the top: 5 appears twice in 1,345 items.
- An objective "all checklist lines ticked → done" rule (E10).
- Bisect the length of a responsibility entry (E11).
- Does the goal framing help mail as well as the work channel?
- The notes channel never sets a goal.
- Cross-session duplicates have no text-match floor.
