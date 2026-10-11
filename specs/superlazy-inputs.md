# superlazy inputs — abstracting the pipeline beyond email

_Proposal 2026-08-22, revised same day after review. **STATUS: Phases 1–2 SHIPPED 2026-08-22** (prompt 0.30; per-step history in the backlog's resolved log); **Slack (messages channel) Phase A code-side SHIPPED 2026-08-29** — the §4.1 design implemented as `chunker.js` + `slackSource.js` + a composite jobSource, chunks persisted to `inputs` as the pending ledger, Stage-0 lab page `slacklab`; prompt/renderer (Phase B) and the staged training not yet started — see `pipeline-walkthrough.md` §14 and the backlog's "Inputs beyond email" list. Phases 3–4 (other providers) and the full reset remain open. Companion docs:
`specs/pipeline-walkthrough.md` (the living spec of the current, email-only pipeline),
`specs/pipeline-backlog.md` (issues/TODOs — this doc is referenced from its TODO list),
`specs/pipeline-walkthrough.md` (how a run works now)._

## 0. Goal

Today the pipeline analyses exactly one kind of input: an email. The goal is to make the
**input item** the unit of analysis, so the same projects/to-dos/people machinery digests:

| Channel | Providers (now → later) | Typical items |
|---|---|---|
| **mail** | Gmail (live), Email Cabinet archive (dev) → MS Graph, IMAP | received/sent email |
| **messages** | — → Slack, Telegram, WhatsApp | a message or a short burst of messages in a conversation |
| **notes** | manual (typed in the app) → Granola, Teams meeting notes, Notion | meeting notes, a personal note, a clipped page |
| **calendar** | — → Google/MS calendar | a meeting (before: prep; after: pair with its notes) |

First concrete deliverable: **manually-entered notes** (e.g. meeting notes), entered via an
"+ Add note" button on the dashboard and Events pages, analysed by the LLM the moment they
are saved, filed into projects like any email — and readable later inside the same thread
modal / viewer that shows emails. **No separate notes page.**

Two hard requirements from the user:
- Manual notes are **ingested on save** (no waiting for a background run to notice them).
- Notes are **kept permanently** (archived later, never deleted) — unlike email, where the
  provider keeps the original and our copy is just a cache.

---

## 1. Glossary — the terms this doc uses

- **Input item** (or just *item*): one unit of analysis — one email, one note, one Slack
  message burst, one calendar meeting. What the code today calls a "message". The LLM
  analyses items; projects and to-dos never care what channel an item came from.
- **Channel**: the *family* of input — `mail` | `messages` | `notes` | `calendar`. The
  channel decides how an item is read (does it have recipients? a thread? can you reply
  to it?). Channels are few and stable.
- **Provider**: who supplies items for a channel — Gmail, Slack, Granola, "manual" (typed
  by the user). Providers are many and interchangeable *within* a channel: a Gmail email
  and an IMAP email are the same kind of item; a Granola note and a typed note are too.
  New provider on an existing channel = a new source adapter only; nothing else changes.
- **Item kind** (`item_kind`): a finer label within a channel when reading differs —
  `meeting_notes` vs `note` within notes; `meeting` within calendar. Optional.
- **Source adapter** (today: "MailSource", e.g. `liveMailSource.js`, `archiveSource.js`):
  the module that talks to a provider and returns raw items + envelopes + cursors. The
  interface is documented in `archiveSource.js` (listAccounts / listEnvelopes /
  loadThreadRaw / getNewer / getFullBody …). Generalised name: **InputSource**.
- **Normalizer** (`normalize.js`): turns a source-shaped raw item into the one universal
  item shape the rest of the pipeline consumes (§3). Already exists; gains `channel` /
  `item_kind` and per-channel body prep.
- **Renderer**: the `assemble.js` code that lays an item out inside the LLM request text
  — `from:/to:/cc:/subject:` for an email; `note by / attendees / title` for a note.
- **Channel card**: a short (10–15 line) section **inside the system prompt** that tells
  the model how to read one channel — e.g. the email card carries the reply/fork rules,
  forward semantics and mailbox-action rules that are meaningless for a note. "Card" =
  one self-contained `## Channel: <name>` block of prompt text. Cards live in the system
  prompt (not the per-message turn) because the system prompt sits in the provider's
  cached prefix: a card's tokens are paid roughly once per cache window instead of on
  every single item. The discipline this buys: a card must be short enough to be worth
  its permanent tokens.
- **Universal item shape**: the normalized object every item becomes (§3) — the contract
  between sources and everything downstream.
- **Handles** (`m1`, `m2`…): the short per-request aliases minted by `assemble.createAliasMap`
  that replace long provider ids inside one LLM request. Unchanged by this proposal —
  handles are already channel-agnostic ("m" just means "item" from now on).
- **Durable turn / snapshot**: the provider-cached user message carrying the project
  catalog + business context + auto-process instructions (see `renderCatalogSnapshot`).
  Unchanged; mentioned because channel cards deliberately do NOT go here.
- **Pseudo-account**: an `accounts` record that represents a non-provider source — e.g.
  `account_id: 'manual'` for typed notes — so the cursor/lock/retry machinery in
  `processor.js`/`ingest.js` works without a special path. (Rejected for notes-on-save,
  §6.2, but likely right for future polling channels like Slack.)
- **Canonical vs cache** (storage authority, §5): a *canonical* record is the only copy
  in existence (a typed note) — never pruned, archive don't delete. A *cache* record
  mirrors data whose source of truth is the provider (an email body) — prunable, like
  `email_bodies` today.

---

## 2. Email-coupling audit (full code + manifest sweep, 2026-08-22)

Every file and every app_table was swept for mail assumptions. Summary of what is
genuinely coupled and what merely *says* "email". Verdict codes:
**[word]** wording/rename only · **[card]** move into the email channel card ·
**[branch]** needs a per-channel branch · **[field]** needs a new/changed stored field ·
**[ok]** already channel-agnostic.

### 2.1 The analysis core (`jobs/analyze_thread/`)

| Where | Coupling | Verdict |
|---|---|---|
| `prompt.js` — opening line, "Message handles", to-do `sender`/`owner` docs | says "email message", "Emails are identified by" | [word] — item language; handles unchanged |
| `prompt.js` — "Replies and threading", "Forwards and inline comments", "Mailbox actions", mail-label routing in "Routing read_only items" | genuinely email semantics | [card] — move verbatim into `## Channel: email` |
| `prompt.js` — auto-process / automated-bulk policy | email-only (newsletters, Gmail labels) | [card] |
| `prompt.js` — suggested responses (`to`/`cc`/`subject`) | email-shaped drafts | [card] for the email shape; core keeps the concept (a draft is "a thing the user could send"), each channel's card says what a draft looks like there — notes: no `answer` drafts (nobody to reply to), `delegate`/`reminder` allowed |
| everything else in `prompt.js` (~70%: projects, to-dos, directions, people, tiers, batches, invariants, request_more, drift) | none | [ok] |
| `normalize.js` | raw shape has from/to/cc/subject; reply-strip always runs | [field] add `channel`, `item_kind`; [branch] body prep per channel (notes: `body_mode:'whole'`, never reply-stripped) |
| `assemble.js` | renders `from:/to:/cc:/subject:`; index rows; People block ("sender", "recipients") | [branch] per-channel item renderer + header wording; index rows gain a channel mark for non-mail items. Reduction ladder, caps, snapshot: [ok] |
| `engine.js` | `ensureThread` via `source.loadThreadRaw`; handle translation; profile maintenance | [ok] mechanics; [branch] `recordMessage` call gains channel-aware stats (§8) |
| `analyze.js` | pure LLM plumbing | [ok] |
| `reconcile.js` / `projectStore.js` | evidence entries hard-code `type:'email'` | [field] `type: channel` (ctx already carries a `source` override — barely used) |
| `processor.js` / `ingest.js` | plan() over mail accounts, cursors, `account_email`, batch per account | [ok] for provider channels; manual notes bypass plan() (§6.2) |
| `workflows.js` / `rulesEngine.js` / `autoProcess.js` | Gmail label maps, machine-address regexes, autopilot | [ok] mechanics, but the registry becomes per-channel — and auto-process is NOT a mail-only concept: the autopilot UNIT generalises from *sender* (mail) to *container* (messages: a Slack channel dedicated to news links auto-files to a reading bucket exactly the way a newsletter sender does; bots are the machine-address analogue). Each channel's workflow set + card define its own categories and its own human guard |
| `userStyle.js` | style guide from sent mail | [ok] for now; later add per-channel style (Slack register ≠ email register) |
| `profiles.js` | `interaction_data.messages_from/_to`; `recordMessage` counts any item as mail | [field][branch] per-channel counters (§8) |
| `reprofiler.js` | history from analysed mail | [ok] — history becomes "items involving this person"; notes *help* here |
| `liveMailSource.js` / `archiveSource.js` / `jobSource.js` / `sourceFactory.js` | mail by definition | [ok] — they become the mail channel's adapters behind the generalized InputSource interface |
| `replyStrip.js` / `htmlToText.js` | email-specific text prep | [ok] — used only by the mail normalizer path |

### 2.2 Data model (manifest `app_tables`)

| Table | Coupling | Verdict |
|---|---|---|
| `projects` | `participant_emails`; `sources` tags are `email:<addr>`; `thread_ids`/`partial_threads` | [ok] mostly — participants are keyed by address (an id, not inherently email); `sources` tags gain channel prefixes (`note:manual`, `slack:<workspace>`); thread ids work for any channel via synthetic ids (§4) |
| `profiles` | `address` as key; `interaction_data.messages_from/_to` | [field] per-channel counts (§8); address stays the person key — non-mail channels map their user ids to a person (Slack user → email via profile aliases, later; a name-only attendee stays name-only, §9) |
| `events` | field NAMES say mail (`msg_id`, `from_address`, `to_addresses`, `subject`, `thread_id`) but the *shape* is generic (the data model designed it channel-agnostic) | [field] add `channel`; keep existing field names (renaming stored fields costs a migration and buys nothing — document that `msg_id` = item id, `subject` = title) |
| `email_bodies` | mail cache by name and shape | superseded by `inputs` (§5); kept read-only during migration |
| `accounts` | `account_email`, mail cursors | [ok] — becomes "one record per connection per channel"; `channel` field added; `account_email` generalises to `account_label` (keep old field populated for mail) |
| `instructions` | sender/domain matching | [ok] — matching keys on author id; scope gains channel later |
| `locks`, `settings`, `profile_history` | none | [ok] |

### 2.3 UI layer

| Where | Coupling | Verdict |
|---|---|---|
| `emailViewer.js` | reads `email_bodies` + MailSource fallback; From/To/Cc header; Reply composer; attachments | [branch] §7 — becomes the input viewer: per-channel header + body resolution from `inputs`; Reply/Forward hidden for channels that can't |
| `viewerContext.js`, `messageHistory.js`, `recentUi.js`, `eventsUi.js` | "email" wording; direction marks (← from them / → you sent) | [word] + [branch] small: a note row renders "☰ note" instead of a direction arrow; events already carry `kind` |
| `mailTools.js`, `checkMailPrompt.js`, `backgroundMode.js`, `newMail.js` | mail-check UX | [ok] — they are the mail channel's ingestion UX; notes-on-save doesn't touch them |
| `setup.js` / `bootstrap*` | training from mail history | [ok] — bootstrap stays mail-only; other channels join incrementally after training |
| `index.js`, `events.js` | add-entry points | new "+ Add note" button beside "+ Add Project" (reuses the `newProjectModal.js` modal pattern) |

**Conclusion of the audit**: the deep model (projects, to-dos, people, events-as-spine,
handles, snapshot/caching, reduction ladder, run lock) is already channel-agnostic — the
The original data-model spec explicitly designed events for `email | slack | manual | system`. The
coupling is concentrated in: prompt wording (§3 of the prompt), the item renderer, the
body store, the viewer, and the profile counters. All tractable; none architectural.

---

## 3. The universal input item shape

`normalizeMessage` output today, extended (new fields marked ★):

```js
{
  ★ channel: 'mail' | 'messages' | 'notes' | 'calendar',
  ★ item_kind: null | 'meeting_notes' | 'note' | 'meeting' | …, // finer read hint
  msg_id,                    // provider/native id, or minted for manual items
  thread_id,                 // conversation id; synthetic for items without one (§4)
  date,                      // ms — when it happened (a note: the meeting time, else save time)
  from: { address, name },   // the AUTHOR. A manual note: the user (ME).
  to: [], cc: [],            // participants beyond the author, with per-channel MEANING:
                             //   mail: recipients; notes: attendees (to=[], attendees in cc? NO —
  ★ participants_kind: 'recipients' | 'attendees' | 'channel_members' | null,
                             //   the renderer labels them correctly; a name-only person is
                             //   { address: '', name: 'Sarah (accounting)' } — allowed (§9)
  subject,                   // title (email subject / note title / meeting title)
  labels: [],                // provider labels (mail); [] elsewhere
  is_draft,                  // mail only
  source_ref,                // opaque pointer to full bytes, interpreted by the item's source
  message_id_header, in_reply_to, references,  // mail threading; null/[] elsewhere
  clean_text, body_mode, body_mode_reason, from_html
}
```

Rules: notes are never reply-stripped (`body_mode: 'whole'`); `channel` defaults to
`'mail'` when absent so every existing call site keeps working unchanged.

## 4. Threads and conversations

Every item has a `thread_id` because project linkage (`store.linkThread`), the thread
cache, and the viewer's rail all key on it:
- mail: the provider thread id (as today);
- notes: synthetic `note_<msg_id>` — a one-item thread. If a later note explicitly
  continues an earlier one (a recurring meeting), the UI may link it to the same
  synthetic thread; not required for v1;
- messages: a per-conversation STREAM id — see §4.1, which fleshes this channel out;
- calendar: the event series id.

`ensureThread` needs no change: it calls `source.loadThreadRaw(threadId)`, and each
channel's InputSource answers for its own thread ids. For manual notes the "source" is
the `inputs` collection itself (§5) — a trivial adapter that reads our own records.

### 4.1 The messages channel, fleshed out (Slack first)

**How Slack organises talk.** A workspace contains *conversations*: public/private
channels, 1:1 DMs, and group DMs (you + two colleagues = one group DM, with a
conversation id of its own, just like a channel). Inside a conversation, messages form
ONE flat time-ordered stream. A *thread* is an explicit reply chain anchored on a single
parent message (`thread_ts` = the parent's timestamp) — so yes, a Slack thread IS "a
reply container", it is opt-in, and much real conversation never gets threaded at all:
the main stream just flows, mixing topics. Telegram is simpler still: chats and groups
are flat streams; a reply is a mere pointer to an earlier message, no thread container.

**Mapping to our model:**
- **Stream = our `thread_id`.** A conversation's main stream: `slack:<team>:<channel>`.
  Each Slack thread is its own stream, `slack:<team>:<channel>:<thread_ts>` — a
  genuinely separate mini-conversation deserving its own prior-item index.
- **Input item = a CHUNK of dialogue, not one platform message.** One record per message
  was considered and rejected: a lone "ok" is analytically worthless yet would cost a
  full analysis request, and chat volume runs 10–100× mail volume. A chunk is transport,
  not a unit of meaning (exactly like an email — nobody agonises over where an email
  "ends"): the semantic grouping lives in PROJECTS, where the model already does it per
  to-do. So chunk boundaries only need to be operationally cheap, not smart.
  `msg_id` = `<stream>:<first_ts>`; `date` = the last message's timestamp; the
  constituent messages ride inside the `inputs` record
  (`messages_raw: [{ ts, author, text, edited, reactions }]`).
- **Boundary = the CHECK WINDOW, softened by a debounce** (settled 2026-08-22 — see
  Next steps №1 for the reasoning and the rejected alternative). Each ingestion check
  takes everything new since the stream's cursor and makes it one chunk per stream — no
  open-burst state, no "did the burst close" race, freshness equal to the check cadence.
  Two riders:
  (a) **previous-chunk inlining** — when a new chunk starts within minutes of the
  stream's previous chunk (a mid-conversation cut), that previous chunk is inlined IN
  FULL as context, the exact analogue of "## The message being replied to"; prior chunks
  also form the stream's index like an email thread's prior messages. Context, not
  re-analysis: analysed chunks are immutable history (provider edits go through the §6.4
  amendment flow), so REGROUPING NEVER HAPPENS by construction.
  (b) **soft debounce for hot streams** — if a stream's new content is tiny AND its last
  message is very recent (mid-conversation), the cursor simply does not advance past it
  this check; it rides into the next chunk, bounded by a max-latency ceiling (~15 min).
  The good half of gap-based bursting without its state or races.
- **A chunk may serve several projects** — same as an email: the model files each to-do
  where it belongs, `linkThread` links the stream to EVERY touched project
  (`projectStore.js` keeps a Set per thread), and evidence points at the chunk's
  `msg_id` from any number of projects. No new machinery.
- **Many topics in one group DM over a day** — the same answer email already has: the
  burst is transport, never the unit of work. The model files each to-do into its own
  project (the "one message may span several projects" invariant), and the stream's
  prior-burst index plays exactly the role the email thread index plays. Grouping across
  days and across channels happens where it always did: in projects.
- **The renderer** lays a burst out as a mini-transcript (`time · author: text` per
  line) — one of the per-channel renderers of §1.
- **Reactions are signals** (later, not v1): a ✅/👍 on a request message is resolution
  evidence — the messages-channel analogue of a mailbox action.
- **A channel is not a project** (the way a mail label is not a project) — but a channel
  IS a natural autopilot unit: see the §2.1 workflows note (a #news-links channel
  auto-files to a reading bucket like a newsletter sender does).

## 5. Storage model — the `inputs` collection

One new collection, **`inputs`**: one record per input item, all channels. It plays three
roles at once — (a) the canonical store for items that exist nowhere else (typed notes),
(b) the body cache for provider-backed items (superseding `email_bodies`), (c) the
pending queue for items awaiting analysis.

```jsonc
{
  "_id": "in_<hash(account|msg_id)>",   // deterministic, mirrors events' id scheme
  "channel": "mail | messages | notes | calendar",
  "item_kind": null,
  "provider": "gmail | manual | granola | slack | …",
  "account_id": "connection name, or 'manual'",
  "msg_id": "native/minted item id",
  "thread_id": "…",
  "date": 0,                             // when it happened (ms)
  "author_address": "", "author_name": "",
  "participants": [ { "address": "", "name": "", "kind": "to|cc|attendee|member" } ],
  "title": "",
  "body_text": "", "body_html": null,    // html only where the channel has it
  "labels": [], "attachments": [],       // manifests, not bytes (bytes stay at the provider / files upload)
  "authority": "canonical | provider",   // §1 — canonical: we hold the ONLY copy. NEVER pruned.
  "archived": false,                     // canonical items are archived, never deleted
  "status": "pending | analysed | error | skipped",  // the queue role; provider items are written
                                         // post-analysis so they are born 'analysed'
  "analysis_event_id": null,             // back-pointer to the events record once analysed
  "captured_asof": 0,                    // provider items: when the snapshot was taken
  "sources": ["note:manual"]             // per-account removal tags, same union-add as projects
}
```

Decisions and reasoning:
- **One collection, not one per channel.** The viewer, the thread rail, message history
  and future search all want "the items behind this project" regardless of channel; one
  collection makes that one query. Channel-specific fields are few enough to coexist.
- **`authority` instead of two collections.** The retention question ("can this be
  pruned?") is per-record, not per-table: a typed note is canonical; a Granola-synced
  note is provider-backed; both are `channel:'notes'`. Pruning code touches only
  `authority:'provider'` records. User's retention requirement is the `archived` flag on
  canonical records — an archived note leaves the working set but never the database.
- **Mail flows through `inputs` too.** Every analysed email writes an `inputs` record
  with `authority:'provider'` (the provider keeps the original; ours is a prunable
  snapshot) — one body store, one id scheme, one viewer path for every channel.
- **No migration: full reset.** The app currently has one user and a reset is planned
  anyway, so `email_bodies` is simply DROPPED from the manifest and the viewer reads
  `inputs` only. Old mail needs no manual import — the provider still holds it, and the
  normal bootstrap/backfill re-fetches the history window into `inputs` exactly as it
  originally captured into `email_bodies`. (The previous draft's fallback-chain note was
  the no-reset alternative — keep the old table readable while new captures write to
  `inputs`; the reset makes it moot. Rejected either way: `email_bodies` for mail forever
  + `inputs` for the rest — permanently two body stores for one viewer concern.)
- **`events` unchanged in shape**, plus a `channel` field. The event stays the spine;
  the input record holds the content, the event holds what it *caused* (the data model's
  trigger/effect split survives intact). `events.msg_id` = `inputs.msg_id`.
- **`accounts`** gains `channel` (existing records imply `'mail'`). Manual notes need no
  accounts record in v1 (§6.2); polling channels (Slack, Granola, calendar) will get one
  each, and `processor.plan()` then treats them exactly like mail accounts — that is
  where the pseudo-account idea properly lands.
- **Indexing caution** (freezr rule 9): only `_id`/`_date_modified` are reliably indexed.
  Queries by `thread_id`/`status` work on the current backend but the manifest note must
  flag them; the pending-queue query can equivalently scan recent `_date_modified` since
  pending items are by construction recent.

## 6. Ingestion

### 6.1 Provider channels (mail today; Slack/Granola/calendar later)
Unchanged: cursors per account, `processor.plan()`, batching, the run lock, retries, the
background job. Each new provider = one InputSource adapter; `plan()` iterates accounts
whatever their channel.

### 6.2 Manual notes: analyse on save
The user's requirement: hitting Save analyses the note immediately. Flow:

1. Save button → write the `inputs` record (`status:'pending'`, `authority:'canonical'`,
   author = ME, synthetic thread) — **persist first**, so the note is never lost even if
   analysis fails.
2. Acquire the run lock (same lock as a mail check — one analysis at a time, and pages
   already display lock-holder progress). If a run is in flight: the note stays pending
   and the UI says "will be analysed when the current check finishes" — the current
   run's driver drains pending inputs before releasing the lock (one extra query in the
   run-loop tail), so "immediately" degrades gracefully to "within the current run".
3. Analyse through the existing engine: a batch of ONE entry (`processBatch` with a
   single item — batching notes with mail saves little and muddles attribution), no
   drafts of kind `answer`, `noDrafts` NOT set (delegate/reminder drafts are wanted).
4. Persist as usual (projects/profiles/event with `channel:'notes'`), set the input's
   `status:'analysed'` + `analysis_event_id`.
5. Optional but recommended: the Add-note modal offers a project picker; a chosen
   project pre-links the synthetic thread (`store.linkThread`) so the model edits the
   right list in place instead of guessing from the catalog.

Why not a pseudo-account + cursor: a typed note has no "what's new since the cursor"
semantics — it is pushed, not polled. Wiring it through `plan()` would add account
bookkeeping for zero benefit. The queue-role of `inputs.status` gives retries: a note
whose analysis failed shows in the UI as pending/error and can be re-run.

### 6.3 Batching policy per channel
mail: as today (adaptive up to `DEFAULT_BATCH_MAX`). notes: 1. messages (later): burst-
grouped by conversation+time-window before batching. calendar (later): 1.

### 6.4 Edits and revisions (notes are not immutable)

The first draft leaned "v1 notes are immutable — edit = archive + re-enter". That dies
on contact with the providers: Granola revises notes after the fact, Notion pages are
edited continuously, Slack messages get edited and deleted. Revision is a property of
the inputs model itself, not a notes nicety:

- `inputs` gains `revision` (int, from 1), `content_hash`, `edited_asof`. An edit — the
  user saving changes to a manual note, or a provider sync seeing a changed hash — bumps
  `revision`, replaces the body, and re-queues the item (`status:'pending'`). For
  `authority:'canonical'` records the superseded body is kept (a `prior_revisions`
  array — the retention promise covers what the user wrote); provider-backed records
  just overwrite, since the provider owns their history.
- **Re-analysis is an AMENDMENT, not a fresh item.** Same `msg_id`, so the analysis
  event UPSERTS over the old one (the deterministic event-id scheme already does this).
  The request marks the item: "REVISED — an earlier version was already analysed;
  to-dos whose evidence cites this item derive from that version; update, resolve or
  cancel them rather than re-creating." The linked projects arrive in full and the
  evidence trails name the derived to-dos, so reconcile's update-by-todo_id does the
  rest. (This amendment framing is a small addition to the email card era's prompt —
  it belongs in the channel-neutral core, since every channel can revise.)
- **Debounce continuously-edited sources**: re-ingest only when the content hash changed
  AND a minimum interval has passed (or the provider signals "final", e.g. a finished
  Granola summary) — a Notion page being live-typed must not trigger an analysis per
  sync tick.
- Manual notes therefore get an ordinary **Edit** affordance in the viewer from v1 —
  cheaper than an archive-and-re-enter dance, and it is the same code path the
  providers force us to build anyway.

## 7. Viewing — one viewer, every channel

`emailViewer.js` generalises (rename can wait; internally it becomes the input viewer):
- **Body resolution**: `inputs` → live source (attachments, pruned provider copies).
- **Header block per channel**: mail: From/To/Cc/Date/Subject (as today). notes:
  "Note · title · date" + attendees line. calendar: time/location/attendees.
- **Actions per channel**: Reply/Forward/compose only where the channel supports it
  (mail; later messages). Notes get Edit (which archives the old version… v2 question)
  and Archive. The viewer already receives a context object — it gains
  `capabilities: { reply: bool, … }` derived from the item's channel.
- **The left rail** (snippets of the projects' other items) is already id-driven; note
  items appear in it with a channel glyph. This satisfies "the note can be viewed in the
  thread modal" — a note IS a (one-item) thread in the same modal, and reachable from
  any project it filed into.
- `messageHistory.js` rows: direction mark becomes channel-aware (notes show a note
  glyph instead of ←/→).

## 8. Profile machinery — per-channel counters

Today `interaction_data.messages_from/_to` drive graduation (PROVISIONAL → SOLID after
N messages) and the behavioural prior line. Notes must not pollute that: being mentioned
in meeting minutes is not correspondence, and a note author is always ME.

Change `interaction_data` to per-channel counters, keeping the old fields as the mail
pair (no migration of existing records):

```jsonc
"interaction_data": {
  "messages_from": 0, "messages_to": 0,          // mail (existing, unchanged meaning)
  "counts": {                                     // ★ per-channel, additive
    "messages": { "from": 0, "to": 0 },
    "notes":    { "mentions": 0, "meetings_shared": 0 },
    "calendar": { "meetings": 0 }
  },
  …reply-latency stats unchanged (mail-only for now)
}
```

Rules: **graduation counts correspondence only** (mail now; messages when they land) —
notes/calendar never trigger it. Notes DO feed `profile_updates` and re-profile history
(minutes are excellent evidence of responsibilities), so `recordMessage` gains a channel
switch: mail path unchanged; notes path bumps mention counters and skips latency stats.

## 9. People and identity across channels

Two separate problems live here.

**Name-only people** (a note names "a colleague from accounting" — no address). The prompt
already allows a NAME as a to-do `owner`/`counterparty`. v1 policy, deliberately
conservative: attendees typed with an email are normal participants (profiles apply);
name-only attendees are carried on the item and in to-do text; **no profile is minted**
(profiles are keyed by address; a name stub would collide and rot).

**Channel identities** (is a Slack user the same person as an email address?): the principle,
what shipped and the open design live in `pipeline-backlog.md` → "Inputs beyond email" →
"People and identity across channels".

## 10. Prompt changes (Phase 1, the enabling move)

1. Terminology pass over the ~70% neutral core: "message" → "input item" (handles,
   invariants, output shape untouched — `msg_id`/`evidence_msg_id` field names stay).
2. New short core section: inputs arrive from channels; each request states which
   channels it contains; per-channel reading rules are in the channel guides (cards).
3. `## Channel: email` card: the four genuinely-email sections moved verbatim
   (threading/forks, forwards/inline comments, mailbox actions, automated-bulk/label
   routing) + the email draft shape. Byte-for-byte meaning-preserving move.
4. (Phase 2) `## Channel: notes` card, ~12 lines: author is the user; participants are
   attendees (may be name-only); mine for commitments — who agreed to what, decisions,
   dates; decompose aggressively (many to-dos per note is normal, unlike email);
   decisions/facts that are not tasks go into the project summary, not read_only items;
   no `answer` drafts ever (nothing to reply to); `delegate`/`reminder` drafts welcome
   (e.g. sending the action list to an attendee); no labels, no auto-process.
5. `PROMPT_VERSION` bump (invalidates pinned snapshots — intended, as with 0.22).

Volatile-turn change: the request header names the channels present ("This request
contains: 1 notes item — see the Notes channel guide."). Email-only requests should
render byte-identically to today wherever possible to preserve cache hits within a
snapshot period.

## 11. Phasing

- **Phase 0 — this spec.** Agree the item shape, `inputs` schema, and card approach.
- **Phase 1 — prompt + plumbing abstraction, zero new channels.** Prompt restructure
  (§10.1–3), `channel` field threaded through normalize/evidence/events, per-channel
  branch points stubbed (renderer, recordMessage) with mail as the only channel.
  **Regression gate**: Inspect page + `test/verifyBatch.mjs` show email analysis
  unchanged before anything new is added. Abstract-then-extend, never both at once —
  otherwise a behaviour change in mail analysis is unattributable.
- **Phase 2 — manual notes end to end, on a fresh start.** The planned full reset
  happens here: `inputs` collection replaces `email_bodies` in the manifest (mail
  capture switches over, §5), then the notes path — Add-note modal (index + events
  pages, beside "+ Add Project"), on-save ingestion (§6.2), edit-as-amendment (§6.4),
  notes channel card, viewer branch (§7), evidence/events with `channel:'notes'`,
  per-channel profile counters (§8).
- **Phase 3 — polish.** Project pre-link in the modal, delegate drafts to attendees,
  archive UI for notes, note editing semantics.
- **Phase 4 — external providers.** Granola/Notion (notes), Slack/Telegram (messages,
  incl. burst grouping + person aliasing), calendar. Each = InputSource adapter +
  normalizer mapping + card (if the channel is new) + an accounts record with cursors.

## 12. Open questions

Moved to `pipeline-backlog.md` → "Inputs beyond email" → "Open questions from the inputs spec"
(items 1–3 were settled when built; the open ones are calendar semantics, chunk debounce and
note revision retention).

## 13. Next steps

1. **Chunk boundaries for the messages channel — CONCLUDED (2026-08-22), pending
   real-data validation in Phase 4.** Decision: check-window chunks (each ingestion
   check turns everything new per stream into one chunk) with previous-chunk inlining
   for continuity and a soft debounce for hot streams — full design in §4.1. Reasoning:
   a chunk is transport, not meaning — projects are where grouping intelligence already
   lives (a thread links to a SET of projects; to-dos scatter per merits), so boundaries
   should be operationally cheap. Rejected: gap-closed bursts (waits out an active
   conversation, needs open-burst state, reopening races) and LLM-decided boundaries
   (spends intelligence where transport suffices; invites regrouping of already-analysed
   history, which the immutable-chunk rule forbids). The "+ overlap window" variant
   became previous-chunk INLINING — context without double-analysis.
2. ~~Phase 2 (manual notes end to end)~~ — SHIPPED 2026-08-22 and verified live, plus
   several post-plan additions (non-blocking save UX, optional derived titles, retry cap,
   the shared "＋ Add…" entry point). Next implementation slice: Phase 3 polish or the full
   reset (backlog: The full reset — checklist), whichever the user wants first.
3. **Calendar + identity-alias designs** stay open (see specs/pipeline-backlog.md, Open questions from the inputs spec) — each is its own small spec
   before its Phase 4 slice.
