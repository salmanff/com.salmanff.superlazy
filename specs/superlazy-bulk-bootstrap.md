# superlazy — Bulk Bootstrap (the first-run map from one large pass) (v0.2)

`com.salmanff.superlazy`

> **Status: BUILT — the first-run flow of the Setup page.** Doc revised 2026-10-10 to describe
> what exists. Prompt: `BOOTSTRAP_PROMPT_VERSION` **0.6** (`jobs/bootstrap/bootstrapPrompt.js`).
>
> **What this is.** Setting up superlazy does not feed history through the per-message engine one
> email at a time. It sends the whole history window to ONE strong model in ONE large request and
> gets back **the map**: a business-context briefing ("your situation"), projects with their open
> to-dos, people profiles, senders to auto-file, and the model's own open questions. The user
> corrects it over as many rounds as they like, then saves it into the real stores. From that
> moment the per-message engine (`jobs/analyze_thread/engine.js`) maintains everything.
>
> **Why.** Project formation is a global clustering problem that a one-by-one loop solves
> greedily: each step sees one message plus a name-only catalog, so early mis-splits compound.
> Profiles have the same flaw. One pass over the whole window fixes both, produces the context
> briefing (which *requires* the global view), and costs a fraction of the per-message loop (§6).
>
> **Files.**
> - `jobs/bootstrap/dumpBuilder.js` — builds the mailbox dump (§3) and the surrogate↔real id maps.
> - `jobs/bootstrap/bootstrapPrompt.js` — the system prompt + refinement-turn builder (§4, §5).
> - `jobs/bootstrap/bootstrapCall.js` — the streamed LLM calls: first pass, refinement, resume (§2.2, §5).
> - `jobs/bootstrap/adopt.js` — saves the reviewed map into the real stores (§2.3).
> - `pages/setup.js` (flow) + `pages/bootstrapUi.js` (run bar + review rendering) + `pages/bootstrap.css`.
> - Offline check: `node test/verifyBootstrap.mjs` (dump determinism, surrogate-id round trip,
>   the prompt's verbatim sync with `analyze_thread/prompt.js`, JSONL streaming/continuation/resume,
>   the Setup page's html↔js↔css contract).
>
> **History.** The flow began (2026-08-02) as a standalone test page, `bootstrap.html/.js`, which
> persisted nothing; it was folded into the Setup page and the standalone page was deleted on
> 2026-10-10, as was a never-used job stub (`jobs/bootstrap/index.mjs`). The planned periodic
> re-run ("audit", old §7) became the weekly clean-up — see §7.

---

## 1. The two-layer model: map vs ledger

| | The MAP (bulk bootstrap — this spec) | The LEDGER (per-message engine) |
|---|---|---|
| Produced by | One large streamed call over the whole window, plus correction rounds | One call per message (or batch) |
| Contents | Business context, projects with their live to-dos, profiles, roles, autofile senders, open questions | To-dos + deltas, evidence trails, events, suggested replies, autofile learning |
| Update cadence | Once, at setup (re-runnable per account; saving again replaces that account's data) | Every new message |
| Failure mode guarded against | Greedy/keyhole clustering, cold-start profiles | Missed obligations |

**The bootstrap DOES extract to-dos** (since prompt v0.3) — its point is to constitute the working
project + to-do lists so the app is usable from day one. The scope guard is on the TIME axis: it
extracts every obligation **still live at the end of the window** (plus reads worth keeping) and
is forbidden from reconstructing completed history (an item raised and satisfied inside the window
is omitted; the project summary carries it if it matters). After setup the per-message engine is
the only maintainer of the lists, and the weekly clean-up is the net for anything missed.

**Output transport: a JSONL STREAM, not one JSON object** (since v0.3). The model emits one
self-contained JSON object per line — `business_context`, `me`, one per `autofile`, per `project`
(carrying its `todos`), per `profile`, per `question`, per `fetch_request`, and a final `done` line
with its own counts. Three reasons: (1) one malformed line costs one section, never the whole reply
(the single-object contract once failed with "not an object" after a full run); (2) sections render
AS THEY ARRIVE; (3) a truncated reply keeps everything already parsed, and the missing `done` marker
flags the cut. The parser (`analyze_thread/maintenance/sectionParser.js`) skips and counts
unparseable lines; spend is recorded and shown even when a call fails.

---

## 2. The Setup flow

### 2.1 What the user sees (`pages/setup.js`, `pages/bootstrapUi.js`)

1. **Gate.** If `use_mail` / `use_llm` are not granted, or no mail account is connected, Setup
   shows the welcome with the fix link.
2. **Pick.** ONE mailbox, a history window in days (default `DEFAULT_HISTORY_DAYS`, 2–120), a model
   (`shared/modelPicker.js`; default = the user's freezr default), and an optional free-text **seed
   context** that goes into the dump header (§3).
3. **Run.** "Read & analyse my mail" builds the dump (§3) and immediately runs the first pass. A
   sticky **run bar** is the only status surface: spinner, plain-language phase ("Fetching your
   mail…", "Done — please review"), elapsed time, running cost and call count.
4. **Review** — tabs that fill as sections stream in, rendered in the app's own entity identity
   (`shared/renderUtils.js`: importance badges, direction discs, initials avatars) so what the
   user learns here transfers to the dashboard. Each tab offers one correction. Corrections are
   QUEUED as plain-text notes for the next round (§5) — none changes the map locally, so a
   correction only takes effect once a round has been sent:

| tab | the correction |
|---|---|
| Your situation | edit the text — the user's wording is authoritative and is what gets saved |
| Projects | free-text notes (merge / split / rename) sent with the next round |
| People | **"This is wrong"** → an inline note, queued as a correction |
| Not worth reading | **"Read this sender"** queues "do NOT auto-file this sender" |
| Questions | answer fields (or "Ignore the questions"); alias nominations from the `me` section appear here with a "One of these is not me" correction |
| Under the hood | per-call diagnostics (cost, tokens, cache write/read), the dump as sent, the raw reassembled map, and the model's reasoning, kept for review |

5. **Correct** — "Send my answers" runs a refinement round (§5): answers, notes and edits go
   together, the model re-emits the full map, and the tabs re-render. Repeatable.
6. **Save** — "Save and start using SuperLazy" runs adoption (§2.3) with a step checklist. If this
   account was set up before, the user is asked to confirm a REPLACE: that account's projects,
   people and autofile senders are deleted first (`persist.deleteAccountData`), other accounts'
   data is kept. Nothing is written to the stores before Save.

### 2.2 Run mechanics (`jobs/bootstrap/bootstrapCall.js`)

- Browser-tab call via `freezr.llm.ask` with `streamBack: true`, `cache: true`, no `responseType`
  (the reply is JSONL text, parsed line by line as it streams). Ids are translated surrogate → real
  per section as it arrives.
- **Stall timeout 20 minutes** (`BULK_TIMEOUT_MS`) — a dump-sized call legitimately runs minutes.
- **Output budget 64k tokens** (`MAX_OUTPUT_TOKENS`), retried once at 8k for models that reject
  it. Thinking shares `max_tokens` with the answer: a 30k budget consumed by reasoning once
  truncated the map mid-stream — hence the large budget AND the emission order that puts the short
  independent sections (`business_context`, `me`, `autofile`) first.
- **`onThinking` is wired, not just `onDelta`.** freezr sends no `thinking` parameter unless the
  caller passes one, so the provider default applies, and recent Claude models think by default —
  for minutes, before the first answer character. The run bar therefore shows *waiting → thinking
  → writing* on a 1-second ticker that starts before the first byte, and the reasoning is kept in
  the Under-the-hood tab (which also says so when a model returned none).
- **An interrupted exchange is resumed, not lost.** A missing `done` marker (ran out of room) and a
  mid-stream failure (dropped connection, expired token, exhausted credit) are handled the same:
  sections already streamed are kept, the turn is billed and shown, the conversation is preserved,
  and the result is flagged `incomplete`. Up to 2 automatic continuations (`MAX_CONTINUATIONS`)
  happen inside one call — a continuation turn names what has already arrived ("projects=7, last:
  …; do NOT repeat"); **"Continue where it stopped"** (`resumeBootstrap`) is the manual, unlimited
  equivalent. Every turn's cost is summed into one figure (`mergeMeta`).
- No run lock: nothing is written until Save.

### 2.3 Adoption — `jobs/bootstrap/adopt.js` (`adoptBootstrap`)

Writes records **indistinguishable from the ones the per-message engine writes** (same id minting
via `projectStore`, same to-do / profile / auto-process shapes), so the first new email finds a
store it can reason about:

- **projects** — one per mapped project (`status_guess: done` → archived), ids minted past
  anything already stored; participants with roles (the user's own addresses forced to `me`);
  threads linked; threads that began before the window recorded as `partial_threads`; created /
  last-active dates taken from the evidence messages, not from the moment of saving.
- **to-dos** — in `reconcile.js`'s shape, dated by the email that raised them, with a
  `type: 'bootstrap'` evidence entry carrying `msg_id` + `thread_id` so the ✉ button opens the
  right mail. Importance recomputed the way the engine does.
- **profiles** — one per mapped person, deliberately PROVISIONAL (`solidified_asof: null`), so
  ordinary analysis can refine them; plus one per autofile sender, carrying the standing
  `FILE_TO_PROJECT` auto-process (`source: 'bootstrap'`), so their next message short-circuits
  before any LLM call.
- **settings** — `your_addresses` (the chosen mailbox only — alias nominations are shown, never
  auto-applied), `business_context` (the user's edited text), the engine's default dials,
  `default_model`, `training_wip: false`, `bootstrap_asof`, `bootstrap_cost`.
- **account** — marked trained, with the **cursor set one millisecond past the newest message in
  the window**: everything the bootstrap read is behind it, everything newer is ingested normally.
- **events + bodies** — one summary event, plus an event and a stored body for each message the
  map actually CITED as evidence (not every message in the window), so evidence chips open real
  mail and an empty-looking feed reads as a decision.

The `business_context` is then attached to every per-message analysis request (`engine.js` →
`assemble.js`, "the user's situation").

*Known gap:* the prompt asks for `responsibilities` as a LIST; adoption currently stores it as a
single responsibility entry (the list joined into one string).

---

## 3. The dump format (`dumpBuilder.js` → `buildDump`)

**Markdown/plaintext, not JSON** — JSON-escaping bodies bloats tokens ~15% and models read mail
better as formatted text. **Deterministic** (identical inputs → identical bytes) so the provider
prompt cache can hit and runs can be diffed.

```
# MAILBOX DUMP for bulk analysis
User addresses (ME): user@example.com
Accounts: user@example.com
Window: 2026-07-05 → 2026-08-02 (28 days) · 312 messages · 41 threads
Note: msg/thread ids in this dump are short surrogates — cite them exactly as given.

## Seed context from the user
<verbatim seed text, or "none provided">

## Current state
none — this is a first run.

=== THREAD th001 · 6 messages · last active 2026-08-01 ===
Subject: Q3 board deck
--- msg m0001 · 2026-07-28T09:14Z
From: partner@example.org (A. Partner)  To: user@example.com [ME]  Cc: analyst@example.org
Labels: INBOX
<body — reply-stripped, footers trimmed, capped, "…[truncated N chars]" marker>
--- msg m0002 · 2026-07-28T11:02Z
From: user@example.com [ME]  To: partner@example.org
↳ replies to: m0001
...
```

Rules:
- **Window anchored to the newest message** (as `processor.plan` does), `historyDays` back. Only
  the window is fetched — never a thread's pre-window history. Fast path: the source's
  `loadWindowRaw` (window-only, ~6 parallel lanes; a serial per-thread hunt once took 4 minutes for
  7 days). Sources without it (the archive) fall back to pooled per-thread loads.
- **Group by thread; threads most-recently-active first; messages oldest-first inside a thread.**
- **Surrogate ids** (`m0001`, `th001`), separate namespaces for messages and threads (single-message
  Gmail threads reuse the message id as the thread id). Provider ids run ~150 chars and evidence
  citations repeat them hundreds of times in the OUTPUT — the expensive tokens; surrogates roughly
  halved output cost. The returned `maps` translate back (`translateIds`, and per section in
  `bootstrapCall.js`).
- **`[ME]` tagging** on every occurrence of a declared address. **ME is the mailbox being read** —
  not a setup question (a free-text "other addresses" box was removed: it asks a first-time user to
  recall aliases before seeing anything, and a typo silently mis-tags every message). The model
  NOMINATES aliases from the mail in its `me` section, on evidence of the user SENDING from them;
  the review shows only addresses not already declared.
- **⚠ INCOMPLETE thread marker.** A thread whose earlier messages fall outside the window is
  flagged in its header (`· ⚠ INCOMPLETE: N earlier message(s) … NOT shown`); detected from the
  pooled fallback's counts or from an in-reply-to / References parent that did not resolve. The
  prompt tells the model not to read such a thread's first visible message as a beginning.
- **`↳ replies to:`** appears only when the parent is itself in the dump.
- **Provider labels** printed as-is when present — the cheap autofile signal, and the only
  read/sent hints the dump carries (no separate read/sent markers).
- **Bodies: strip BEFORE truncating.** `normalizeMessage` runs `prepBody` (reply-strip + legal
  footer / disclaimer trim) on every body; only then are caps applied (truncating first once cut
  new content while keeping boilerplate). Caps: `BODY_CAP` 2,500 chars; bulk-labelled mail
  (`promotions|newsletter|social|updates|forums`) `BODY_CAP_BULK` 800; **whole-mode** messages
  (forwards, inline-comment replies — marked `[WHOLE BODY: reason]`) get 3× (`WHOLE_MULT`).
  Untruncated bodies are kept in `fullBodies` to answer `fetch_request`s (§5).
- **Graceful degrade past `DUMP_CHAR_CAP` (800k chars ≈ 200k tokens):** first bulk bodies shrink
  to ~60 chars, then every body is capped at 1,200; `stats.degraded` says which, and
  `stats.overCap` flags a dump still too big. Whole threads are never dropped. Chunk-and-merge is
  deferred until a real mailbox forces it.
- **Attachments:** not printed; only a `has_attachments` flag is carried into `msgMeta` for adoption.
- **Returned stats** (shown in the review): messages, threads, partial threads, truncated /
  whole-mode / bulk-capped counts, chars, estimated tokens, window bounds, and `newestMs` — the
  date of the last message actually included, which adoption turns into the account cursor.

---

## 4. The bootstrap prompt (`bootstrapPrompt.js`)

Exports `BOOTSTRAP_PROMPT_VERSION` (**0.6**; 0.5 dropped the never-read `confidence` field, 0.6 made the responsibilities example generic) and
`BOOTSTRAP_SYSTEM_PROMPT`. The prompt text in that file is authoritative; this section records its
design and output contract.

**Consistency contract:** the "What a project is" paragraph is copied VERBATIM from
`jobs/analyze_thread/prompt.js` — the two prompts must never disagree about what a project is; any
edit happens in both files in the same commit (`test/verifyBootstrap.mjs` checks it).

Design intent:
- **Two readers, stated explicitly.** The BUSINESS CONTEXT is written FOR another model — the
  per-message analyst that will later see one email at a time through a keyhole; that framing
  selects durable, decision-relevant facts (who is the boss, the recurring cycles, what the acronyms
  mean). Everything else — projects, to-dos, profiles, autofile senders — is FOR THE USER, named
  and worded the way the user would.
- **Evidence, not vibes.** Every project, to-do, profile and autofile proposal carries
  `evidence_msg_ids`.
- **A question never excuses a gap.** Every field carries the model's best judgement ("appears
  to"), even where it also asks.
- **Fewer, better projects** — the usefulness-together test, named after the OUTCOME, usually
  5–20 for a window like this, finished/dormant ones marked rather than omitted.

Sections the model produces:
1. **Business context** — ~150–350 words of markdown: who the user is (every hat), the team and
   what each person handles, key external parties and the user's stance to each, recurring rhythms,
   domain vocabulary, the 3–5 dominant efforts. No judgements of character, no personal matters.
2. **Project skeletons** — name, one-line summary (the project's memory), importance 1–5, 3–7
   concrete keywords, participants with role `me|team|external` + `role_note` (decided by what
   people DO; a shared domain is a weak hint), `thread_ids`, `status_guess`, evidence.
   **2b. To-dos** — every obligation still live at the window's end, plus reads worth keeping:
   `short_description`, `description`, `direction` (`i_owe_them|they_owe_me|team_owes|read_only`),
   `owner`, `counterparty`, importance, `status` (`open|in_progress`), `due_hint` +
   `due_earliest/due_latest` anchored on the evidencing message's date, evidence. Multi-part asks
   decomposed; completed history omitted; templated live asks never dropped.
3. **People profiles** — address, name, 1–2 sentence summary, relationship, `responsibilities`
   (a LIST), `llm_importance` 1–5, optional `tone_note`, evidence. Never the user's own addresses.
4. **Autofile candidates** — machine-generated bulk senders: `{ sender, category:
   newsletter|admin|social|promotions, reason, evidence }`. Decided PER SENDER, all or nothing: any
   message that could need the user (money, a deadline, a signature) disqualifies the sender. The
   model must not ask the user to split a sender's mail.
- **Open questions** — up to 8, only where the answer changes filing, roles or importance.
- **`me`** — only addresses NOT already declared, only on evidence of the user sending from them;
  omitted when there is nothing to add.
- **Incomplete threads** — handling of the ⚠ marker (§3).
- **Fetch requests** — up to 10 messages whose full body would materially change the map; the
  model still emits its complete best-judgement output now.

**Output: JSONL, one object per line, in this order** — `business_context`, `me`, `autofile`…,
`project`… (most important first, each carrying `todos`), `profile`…, `question`…,
`fetch_request`…, `done` (with the model's own counts). The order is a robustness contract: if the
budget runs out, the tail is what is lost, and the reader can resume from where it stopped.

Field alignment: `project` lines map onto `projectStore` records and `profile` lines onto profile
records, so adoption (§2.3) is a mapping, not a translation. `tmp_id` (`p1`…) is replaced by minted
ids at adoption.

---

## 5. Refinement — repeatable correction rounds (`buildRefinementMessage`, `refineBootstrap`)

Each round appends one user turn to the SAME conversation and streams the model's full re-emitted
map (same JSONL contract), so the review simply re-renders. The user turn (`## Refinement round`)
carries:
- the business context as edited by the user (authoritative where it differs);
- the answers to the open questions (or "none given — keep your best judgements");
- further instructions — the free-text box plus the queued per-section corrections (§2.1);
- the full bodies of any `fetch_request`s from the previous output (up to 10, resolved from the
  dump's `fullBodies`).

The model is told to fold the answers in everywhere they matter, keep the user's wording, drop
answered questions, ask at most 3 NEW questions, and not emit fetch requests again.

Because every call passes `cache: true`, the dump and earlier turns re-read at ~10% of the input
rate — but only within the provider's default **5-minute** cache lifetime (the code does not request
a 1-hour TTL). A round sent after a longer pause re-pays the dump's input at full rate.

A failed round pops its unsent user turn (the provider requires alternation) and re-queues the
user's corrections, so nothing is sent twice or lost.

---

## 6. Cost & size envelope

- Dump: chars/4 ≈ tokens. **Measured (first live run):** 334 messages / 205 threads over 25 days →
  536k chars ≈ 134k tokens, before reply-stripping and surrogate ids (expect ~90–110k with them).
  Fits every current 1M-context model with headroom.
- First pass on an Opus-tier model ($5/M in, $25/M out): ≈ $0.70 in + ~$0.55 out ≈ **$1.25** at
  those volumes; the output was id-bloated then, and surrogate ids roughly halve it. Thinking
  tokens bill as output. A refinement round inside the cache lifetime re-bills the dump at ~10%
  (≈ $0.10) plus fresh output. A premium tier is roughly ×2.
- The per-message loop for the same window: `EST_COST_PER_MSG × messages` ≈ $17–34 — the
  comparison that justified the design.
- Real numbers come from each call's `meta.cost` and are shown per call in Under the hood; the
  saved total is `settings.bootstrap_cost`.

---

## 7. Periodic re-calibration — superseded

Superseded by the weekly clean-up: see `specs/superlazy-weekly-cleanup.md` (proposals, the apply
lock, and the run record formerly sketched here and in the former §7.1 live there).

---

## 8. freezr-side dependency

Prompt caching (`freezr.llm.ask(…, { cache: true })` or `{ cache: { ttl: '1h' } }`) is built in
freezr: it marks the end of the request's messages as a cache breakpoint, and cached-token counts
and costs are reported in `meta.tokensUsed.other` / `meta.cost.otherCost`. The prefix must be
byte-identical between calls — another reason the dump is deterministic (§3).

---

## 9. Out of scope (deliberately)

- Chunk-and-merge for windows that exceed the dump cap (defer until a real mailbox forces it).
- Running the bootstrap as a background job (the job stub was removed; the flow needs the user's
  review anyway).
- Any change to the per-message engine, its prompt, or live ingestion.
