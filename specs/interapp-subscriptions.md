# Inter-app email subscriptions — internal design (v3)

> **Status: IMPLEMENTED (v1, live since 2026-09-02).** Doc revised 2026-10-10 to describe the code.
> - **The public contract is `app-comms.md`** (app root) — request / status / delivery shapes,
>   the requester's manifest, consumer rules, limits. This file is superlazy's INTERNAL design
>   behind that contract and never restates the wire shapes.
> - Code: `jobs/analyze_thread/subscriptionsCore.js` (job-side: detector lines, prefilter,
>   delivery records, flush), `pages/subscriptionsData.js` (browser: intake, lifecycle, prefilter
>   suggestion), `pages/connectedTab.js` (the Setup & Prefs → Connected apps tab). Wiring:
>   `workflows.js` (`app_subscription` entry + `workflowInstructions`), `rulesEngine.preAnalyze`,
>   `ingest.js` (load at run start, flush at run tail), `assemble.instructionReminder`,
>   `analysisSchema` (sub_id pinning). Test: `node test/verifySubscriptionPrompt.mjs`.
> - Manifest: `app_services` → `app-comms.md`; permissions `msg_subscribers` (`message_records`
>   on `subscription_deliveries`) and `share_originals` (`share_records` on `inputs`,
>   `email_bodies`, `files`); collections `subscriptions` and `subscription_deliveries`.
> - Settled direction: transport is **freezr inter-app messaging (`recipient_app`) + app-scoped
>   `share_records`**; no new freezr permission types; the requester's contract is **a prompt plus
>   one checkbox** (include the original); all semantic consent happens inside superlazy.

---

## 1. The example that drives the design

An invoice app (say `com.example.invoices`) deals only with invoices. superlazy already reads and
LLM-analyses all mail. The invoice app asks superlazy: *"send me every email containing an invoice
or receipt — return JSON with vendor, amount, currency, due date — and include the original
email."* The user approves that request **inside superlazy**, and the invoice app then receives a
stream of structured results (plus shared originals) without ever holding a `use_mail` grant.

Generalises to any app subscribing to any semantic slice of mail: booking confirmations, intro
emails, receipts…

---

## 2. freezr server findings — done

The freezr server work this design needed is done: messages can be addressed to another app of the
same user (`recipient_app`, readable via `freezr.messages.getAppMessages`; no `contact_permission`
for same-user sends), and `share_records` accepts an app-scoped grantee (`grantees:
['app:<appId>']`). The original server analysis is no longer kept here.

---

## 3. Design overview

Roles: **provider** (superlazy), **requester** (another app of the same user). Everything travels
as inter-app messages; originals travel as app-scoped record shares referenced from the delivery.

```
requester app                          superlazy
     │  (1) request message                 │
     │  { prompt, include_original }        │
     ├───────────────────────────────────►  │  intake when the Connected apps tab opens
     │                                      │ (2) user approves on that tab
     │  (3) status message {approved}       │
     │  ◄───────────────────────────────────┤
     │                                      │ (4) analysis: detector line in the cached
     │                                      │     turn; match → app_subscription trigger
     │  (5) delivery message                │     → delivery record → flush
     │  { payload, email_meta, shared }     │
     │  ◄───────────────────────────────────┤
     │  (6) reads the shared email record   │
     │      via app-scoped share_records    │
```

Two consent layers, deliberately separate:

1. **freezr grants (transport consent)** — the requester's `message_records` on its own request
   table; superlazy's `msg_subscribers` (send back) and `share_originals` (share originals).
   Nothing about *what* flows is decided here.
2. **Provider approval (content consent)** — each request is shown on the Connected apps tab with
   the requester's server-verified app id, its label, the **prompt verbatim**, and whether it asked
   for originals. Nothing is delivered until the user approves there.

---

## 4. The wire contract

**The wire contract is `app-comms.md`** (§4–§7 there: requester manifest, the two-field request,
status and delivery messages, reading shared originals). Internal notes only:

- Requester-facing statuses are `approved | denied | paused | revoked`; internally `active` maps to
  `approved` (`statusForRequester`). A requester cancellation (`record.status = 'cancelled'`) is an
  internal `cancelled` status with no reply.
- Status messages and deliveries are both sent under `msg_subscribers`, with `table_id`
  `<superlazy>.subscription_deliveries`.
- `shared.email_body.table_id` is whatever table the snapshot was found in — `inputs` today,
  `email_bodies` for old installs — which is why the contract tells requesters never to hardcode it.

---

## 5. Required freezr changes — done

Both changes (`recipient_app` routing; the (user, app) grantee for `share_records`) are in the
freezr server. Remaining server-side wishes: wake-on-message (an `on_message` job trigger, so
neither side has to poll) — not built.

---

## 6. superlazy implementation

### 6.1 Collections

**`subscriptions`** — one record per request, `_id` = `sub_id` =
`sub_<fnv(requester_app + '|' + request_ref)>` (deterministic, so re-reading a message is a no-op):

```jsonc
{ "sub_id": "sub_ab12",
  "requester_app": "com.example.invoices",   // the message's server-verified app_id, never the payload
  "request_ref": "<requester record_id>",
  "service": "email_subscription",
  "label": "Invoices",                        // ≤ 60 chars
  "prompt": "…",                              // containedPrompt(): whitespace flattened, " → ’, NEVER cut
  "include_original": true,
  "requested_hash": "…",                      // fnv(prompt | include_original) as last requested
  "approved_hash": "…", "approved_asof": 0,   // set on approval
  "prefilter": { "subject_keywords": [], "attachment_types": [], "from_domains": [], "has_attachments": false },
  "status": "active",                         // pending | active | paused | denied | revoked | cancelled
  "status_reason": null,                      // shown on the card (and sent with denials)
  "stats": { "delivered": 0, "last_delivery_asof": null },
  "created_asof": 0 }
```

**`subscription_deliveries`** — one record per (subscription, matched email), `_id` =
`delivery_id` = `del_<sub_id>_<fnv(account_id|msg_id)>`; `status: pending_send | sent | dropped`;
carries `payload`, `email_meta` (incl. `account_id`), `shared`, `created_asof`, `sent_asof`. The
record is the source of truth; the message is the transport.

### 6.2 Request intake + approval (`subscriptionsData.js`, `connectedTab.js`)

- **Intake** (`intakeRequests`) runs when the **Connected apps tab is opened** (re-run on every
  visit). It reads `freezr.messages.getAppMessages({ count: 100 })`, keeps messages from another
  app, addressed to superlazy, with `record.service === 'email_subscription'`, mirrors each into
  `subscriptions`, and marks processed messages read (failures stay unread and retry).
  - New request → `pending` (or `denied` at once, see below).
  - **Prompt over `PROMPT_MAX_CHARS` (3,000)** → REFUSED, never cut: `denied` with a reason naming
    the length and the limit, sent back in a status message.
  - Changed `prompt`/`include_original` (hash mismatch) → back to `pending` with "edited by the
    requesting app". A hash that differs only because an older version cut prompts at 1,000 chars
    is recognised (`legacyCutHash`) and re-asked with an honest reason.
  - `record.status === 'cancelled'` → `cancelled`.
- **Approval card**: requester id, label, prompt verbatim, what it will receive, the prefilter
  editor (§6.4) with **"Suggest pre-filter"**, Approve / Deny. Active and paused cards show the
  delivered count, Save pre-filter, Pause/Resume, Revoke.
- **Lifecycle** (`setStatus`): every approve / deny / pause / resume / revoke updates the record
  and sends one status message (best-effort; a failed send is logged, not retried). Editing the
  prefilter is superlazy's own dial — no re-approval, no status message.

### 6.3 Detection — wrapping the requester's prompt

- `loadActiveSubscriptions(freezr)` runs once per ingestion run, **before** the durable signature /
  snapshot pin (`ingest.js`); active, in-limit records only, sorted by `sub_id`.
- `subscriptionPromptLines()` emits one detector line per active subscription, appended by
  `workflowInstructions()` so it rides the **cached durable turn**; `ingest.durableSig` hashes
  `workflowInstructions()`, so a subscription change re-pins the snapshot exactly once. The line
  quotes the label and the contained prompt and says: if and ONLY IF the current message matches,
  add `{ "type": "app_subscription", "details": { "sub_id", "payload" } }` — payload exactly as the
  request asks, as an object or the same object as JSON text; judge the current message only; never
  change the normal analysis.
- `assemble.instructionReminder` lists every active `sub_id` + label at the END of each request
  (the cached block is far back; measured on real subscription mail, a small model acted on the
  lines far more reliably with the reminder).
- `analysisSchema` pins `sub_id` to an enum of the active ids, so a hallucinated id is unrepresentable
  under strict output; free-form payloads arrive as JSON text there and `parsePayload` restores the
  object (non-JSON text is delivered as `{ text }`).
- Blast radius of a hostile prompt: quotes neutralised, whitespace flattened; `dispatchTriggers`
  ignores unknown action types; the `app_subscription` handler skips any `sub_id` that is not active.

### 6.4 The short-circuit blind spot — the prefilter

Autopilot senders never reach the LLM — and invoice-like mail is exactly what lands on autopilot.
The requester contract stays two fields; the fix is internal: each subscription can carry a cheap
deterministic **prefilter** (`subject_keywords`, `from_domains`, `has_attachments` +
`attachment_types`). In `rulesEngine.preAnalyze`, `subscriptionPrefilterHit(newMsg)` returning any
hit **blocks the short-circuit** (as a sender-scoped instruction does), so the LLM judges the real
condition. No hit ⇒ autopilot proceeds.

The prefilter is set by the user on the card. **"Suggest pre-filter"** (`derivePrefilter`) makes one
small LLM call that proposes values into the editor; it is optional, not automatic — a subscription
approved with an empty prefilter only sees mail that reaches the LLM anyway (the card says so).
Edits apply from the next mail check.

### 6.5 Delivery

1. **`app_subscription.onTrigger` → `deliverSubscriptionMatch`** (in `dispatchTriggers`, after
   reconcile): if the delivery record already exists, stop (idempotent across retries and lock
   takeovers); else write it `pending_send`. When the subscription does NOT include originals, send
   the message immediately (best-effort) and mark it `sent`.
2. **`flushPendingDeliveries`** runs at the **tail of every ingestion run** (job and tab) and again
   when the Connected apps tab opens. For each `pending_send` record: drop it (`dropped`) if the
   subscription is no longer active; if originals were approved and not yet shared, find the body
   snapshot (`inputs`, falling back to legacy `email_bodies`) and `shareRecords` it to
   `app:<requester_app>` under `share_originals` — sharing waits for the flush because the snapshot
   is persisted after dispatch; send; mark `sent`; bump `subscriptions.stats`. Failures stay
   `pending_send` and retry on the next flush; the requester dedups on `delivery_id`.
3. **Attachments are NOT shared yet**: `shared.files` is always `[]` (TODO v1.1 in
   `subscriptionsCore.js` — it needs the bytes uploaded into superlazy's files area while a mail
   connection is available).

### 6.6 Ongoing visibility, revocation, retention

- **Visibility**: the Connected apps tab — per-card status, reason, delivered count, and a line
  with the flush result. No events-feed entries or digest rows are emitted for approvals or
  deliveries (not built).
- **Revoke**: from the card (with a confirm). The status message goes out and the detector line
  drops on the next run; **already-shared records are not taken back** (the confirm says so). A
  "revoke past shares too" option is not built.
- **Retention**: no sweep is built. Shared snapshots stay shared until un-shared by hand.

## 7. Security considerations

- **Requester identity**: the message `app_id` is enforced against the sender's token server-side —
  unforgeable; `requester_app` is taken from it, never from the payload.
- **Double consent**: freezr grants say "may message / may share"; superlazy approval decides
  *what*. The enforced gate is the **subscription record** (`status`, `include_original`), read at
  dispatch and again at flush — never the LLM output or the raw request — so neither prompt
  injection nor a post-approval edit widens what ships (an edit returns the record to `pending`).
- **Exfiltration = condition width** ("everything mentioning passwords"). Mitigations: prompt shown
  verbatim at approval; a hard length ceiling (refusal, not truncation); delivery records as an
  audit trail with counts on the card; one-tap pause / revoke.
- **Share minimalism**: per-record grants only, to the (user, requester-app) pair; no table-wide
  reads.
- **Payload opacity**: the payload is transmitted verbatim and never executed or rendered as HTML by
  superlazy.

## 8. Reference requester (minimal)

A requester needs one `message_records` permission, a `subscription_requests` collection, and a
page that sends the request, shows "waiting for approval in superlazy", polls `getAppMessages`,
handles every status, dedups deliveries on `delivery_id` into its own collection, and reads shared
originals by the `table_id` carried in the reference. The build checklist is `app-comms.md` §9.

## 9. Open questions

1. **Payload size cap.** `app-comms.md` promises ~64 kB; the code does not enforce one yet.
2. **Retention.** `app-comms.md` says shared originals are retained ~90 days, then unshared and
   swept; no sweep exists. Build the sweep, or change the contract.
3. **Un-share on revoke**: keep past shares readable (current behaviour) or offer / default to a
   claw-back?
4. **Attachment sharing** (§6.5.3) — the remaining v1.1 piece.
5. **Intake timing**: requests are only picked up when the user opens the Connected apps tab.
   Should ingestion runs (or a wake-on-message trigger, §5) also do intake?

*Settled since v2:* the `app_services` manifest block ships; the tab is named "Connected apps";
account-scope narrowing at approval was not built (a subscription covers every account superlazy
reads).

---

*Section map (v2 → v3): §2 server findings, §4 wire contract and §5 server changes reduced to
pointers (wire shapes → `app-comms.md`); §6.1 now covers both collections; Appendix A (the
collections-only fallback transport) removed — the messaging transport is live.*
