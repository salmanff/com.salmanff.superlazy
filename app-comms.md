# app-comms: com.salmanff.superlazy

> **What this file is.** The inter-app communication contract for `com.salmanff.superlazy`
> ("superlazy"), written for an LLM (or developer) building ANOTHER freezr app that wants
> to communicate with it. Drop this file into your app project alongside
> `freezr-context.md` and follow both: freezr-context tells you how to build a freezr
> app; this file tells you how to talk to superlazy. It describes only the public
> contract — never superlazy's internals.
>
> **Status: LIVE.** The freezr server supports `recipient_app` message routing and
> app-scoped `share_records` grants (verified by integration tests), and superlazy
> implements the service (request intake, approval lifecycle, and delivery — see
> `app_services` in its manifest.json).
>
> contract_version: 0.1 · app: com.salmanff.superlazy · updated: 2026-09-02

---

## 1. What superlazy is, in one paragraph

superlazy connects to the user's mail accounts, reads incoming email, and runs an LLM
over every message to maintain projects, to-dos, people profiles, and summaries. Because
it already analyzes all mail, it can act as an **email gateway for other apps**: your
app subscribes to a semantic slice of the user's email ("all invoices", "all booking
confirmations") and receives matching results — without your app ever requesting
`use_mail` access of its own.

## 2. Services offered

| service | version | what it does |
|---|---|---|
| `email_subscription` | 1 | Ongoing: for every incoming email matching your prompt's condition, superlazy sends you the LLM's answer to your prompt, and optionally shares the original email + attachments. |

There is no request/one-shot service yet (no "search past mail once"); a subscription
starts delivering from approval time forward. (Historical backfill may be offered
later — do not design against it.)

## 3. The trust model — read this first

1. **freezr grants are transport-only.** Your app declares one `message_records`
   permission (to send messages). The user granting it does NOT mean superlazy will
   send you anything.
2. **The real consent happens inside superlazy.** Your subscription request is shown
   to the user in superlazy's UI — your app's identity (server-verified, you cannot
   spoof it), your prompt **verbatim**, and whether you asked for originals. The user
   approves, denies, narrows scope, or later revokes there. Design your app to handle
   `denied`, `paused`, and `revoked` gracefully and to explain to the user where to
   approve (superlazy → Setup & Prefs → Connected apps).
3. **Write your prompt for the human, not just the LLM.** A narrow, plainly-worded
   condition ("emails containing an invoice or receipt") gets approved; a broad or
   creepy one ("all emails mentioning money") gets denied. The prompt is your
   application for trust.

## 4. What your app must declare (manifest)

One permission. `<your.app.id>` is your own app id.

```jsonc
"permissions": [
  { "name": "msg_superlazy",
    "type": "message_records",
    "table_id": "<your.app.id>.subscription_requests",
    "description": "Send email-subscription requests to superlazy. You approve or deny each request inside superlazy." }
]
```

And one collection to hold your request record(s):

```jsonc
"app_tables": {
  "subscription_requests": {
    "description": "Subscription requests sent to superlazy (one record per subscription).",
    "schema": {
      "service":          { "type": "String", "description": "'email_subscription'" },
      "label":            { "type": "String", "description": "Short name shown to the user" },
      "prompt":           { "type": "String", "description": "Condition + return format, shown verbatim" },
      "include_original": { "type": "String", "description": "true/false — also share email + attachments" }
    }
  }
}
```

Keep a second collection for your own copies of deliveries (see §7 — deliveries are
retained by superlazy only temporarily).

## 5. The request — two fields

A request is a record in YOUR `subscription_requests` collection, sent to superlazy as
a message. The contract is deliberately minimal:

- **`prompt`** (string, ≤ 3000 chars, single paragraph, no markdown): states BOTH the
  matching condition AND the format you want back. superlazy passes it to its LLM
  wrapped in its own instructions and returns the LLM's output to you verbatim. Ask
  for JSON if you want structure — you are responsible for parsing what comes back.
  The text is never cut: a longer prompt is refused — the request lands as `denied`
  with a reason naming the length and the limit (status message + the user's
  Connected-apps tab). Shorten it and send it again.
- **`include_original`** (boolean): if true (and the user approves it), each delivery
  also shares the original email record and its attachments with your app.

Example — an invoice app:

```javascript
const request = await freezr.create('subscription_requests', {
  service: 'email_subscription',
  service_version: 1,
  label: 'Invoices',
  prompt: 'Emails containing an invoice, bill, or receipt for a payment the user made or owes. ' +
          'Send back JSON: { "vendor": string, "amount": number, "currency": string, ' +
          '"due_date": "YYYY-MM-DD" or null, "invoice_number": string or null, ' +
          '"kind": "invoice" | "receipt" | "reminder" }.',
  include_original: true
})

await freezr.messages.send({
  recipient_id: freezrMeta.userId,          // same user
  recipient_app: 'com.salmanff.superlazy',  // inter-app routing
  messaging_permission: 'msg_superlazy',
  table_id: freezrMeta.appName + '.subscription_requests',
  record_id: request._id,
  record: request                           // payload rides in the message
})
// note: no contact_permission — it is not required for same-user inter-app sends
```

Prompt-writing rules:
- One condition per subscription. Two concerns = two subscriptions.
- State the return format explicitly and keep it flat JSON. Ask for `null` (not
  omission) for absent fields.
- Do not ask the LLM to do anything other than judge THIS message and produce the
  return payload — instructions like "also summarize other emails" are ignored or
  will get the request denied.
- Expect false negatives. superlazy only forwards what its LLM judges a match; if
  recall matters, say so in the prompt ("when uncertain, include it and set
  `"kind": "uncertain"`").

Editing a subscription: update your request record and re-send the message with the
same `record_id`. Any change to `prompt`/`include_original` sends the subscription
back to pending — the user must re-approve. Cancel by sending the same message with
`record.status = 'cancelled'`.

## 6. What you receive — messages from superlazy

Poll your message inbox (there is no push yet — poll on page load and/or from a
background job):

```javascript
const { messages } = await freezr.messages.getAppMessages({ count: 50 })
// Returns messages your app SENT plus messages ADDRESSED to it. Keep only
// superlazy's (app_id is server-verified as the sender's app):
const inbound = messages.filter(m => m.app_id === 'com.salmanff.superlazy')
```

Each message's `record` field is one of:

**Status** — lifecycle changes for your subscription:

```jsonc
{ "service": "email_subscription", "kind": "status",
  "sub_id": "sub_ab12",
  "request_ref": "<your request record _id>",
  "status": "approved",   // approved | denied | paused | revoked
  "reason": null }
```

Surface `denied`/`revoked` to your user with a pointer to superlazy's Connected-apps
tab. Do not retry a denied request unchanged.

**Delivery** — one matching email:

```jsonc
{ "service": "email_subscription", "kind": "delivery",
  "sub_id": "sub_ab12",
  "delivery_id": "del_sub_ab12_9f3c21",   // DEDUP KEY — see below
  "payload": { /* the LLM's output to YOUR prompt, verbatim — parse defensively */ },
  "email_meta": { "from": { "address": "…", "name": "…" }, "subject": "…",
                  "received_at": 1766120000000, "msg_id": "…", "thread_id": "…" },
  "shared": {                              // only if include_original was approved
    "email_body": { "table_id": "com.salmanff.superlazy.inputs", "record_id": "…" },
      // a record REFERENCE — read it via ITS OWN table_id (do not hardcode the table name;
      // superlazy may serve it from a different collection over time)
    "files": [{ "file_id": "…", "filename": "…", "mimeType": "…", "sizeBytes": 0 }]
  } }
```

**Hard rules for consumers:**
- **Dedup on `delivery_id`.** Deliveries MAY be re-sent (retries are how superlazy
  handles failures). Keep a processed-ids set; upsert into your own collection keyed
  by `delivery_id`.
- **Parse `payload` defensively.** It is LLM output. It should match the format your
  prompt asked for, but treat missing/malformed fields as data, not exceptions.
- **Copy out what you need promptly.** Shared originals are retained by superlazy for
  ~90 days, then unshared and swept. Store your own copies (your parsed rows, and any
  file bytes you need long-term) in your own collections/files.
- `email_meta.msg_id`/`thread_id` are opaque provenance strings — you cannot fetch
  mail with them (you have no mail grant). Use them for display/dedup only.

## 7. Reading shared originals (when `include_original` is on)

Shared items are granted to your app via app-scoped `share_records` under superlazy's
permission `share_originals`. Read with the standard cross-app vocabulary:

```javascript
// the email snapshot record (subject, body text/html, attachment manifest) — always address it
// by the table_id CARRIED IN THE REFERENCE, never a hardcoded name
const ref = shared.email_body
const body = await freezr.read(ref.table_id, ref.record_id, {
  owner_id: freezrMeta.userId,
  permission_name: 'share_originals'
})

// an attachment file (e.g. the invoice PDF)
const url = await freezr.utils.tokenizedFileUrl(shared.files[0].file_id, {
  requestee_app: 'com.salmanff.superlazy',
  requestee_user_id: freezrMeta.userId,
  permission_name: 'share_originals'
})
const pdfBlob = await (await fetch(url)).blob()
```

If you render `body_html`, follow freezr-context's "Rendering email safely" pattern
(sanitize + Shadow DOM) — it is untrusted external content.

## 8. Timing, guarantees, and limits

- **Latency:** deliveries follow superlazy's mail-processing cadence — typically its
  hourly background job, or sooner when the user has superlazy open. There is no SLA;
  do not build flows that assume minutes.
- **Ordering:** not guaranteed. Order by `email_meta.received_at` yourself.
- **Coverage:** matching starts at approval. Emails processed before approval are not
  delivered. Mail on superlazy's "autopilot" fast-path is checked via a cheap
  prefilter the user reviews at approval — extremely atypical matches (e.g. an
  invoice with no invoice-like words or attachment) can be missed.
- **Volume:** if your condition matches large volumes, expect the user to pause you —
  superlazy shows delivery counts with a one-tap pause.
- **Payload size:** capped (~64 kB). Ask for compact formats.

## 9. Checklist for the requester app builder

1. Declare the `message_records` permission (§4) + your two collections.
2. Build: send request → show "waiting for approval in superlazy" → poll inbox →
   handle status → ingest deliveries (dedup!) → copy out originals you need.
3. Handle every status, including revocation arriving at any time.
4. Never request `use_mail` "as a fallback" — defeating the purpose of this contract
   is the fastest way to a deny.

---

*Convention note: any freezr app can offer inter-app services by shipping its own
`app-comms.md` at the app root and pointing to it from an `app_services` key in its
manifest — `"app_services": { "description": "<one-line summary of the services>",
"contract": "app-comms.md" }`. One contract file documents ALL of an app's services. Format: status/version header → what the app is →
services table → trust model → requester manifest block → wire shapes → consumer
rules → timing/limits. Contract only; no provider internals.*
