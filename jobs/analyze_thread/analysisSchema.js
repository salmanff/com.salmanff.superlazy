// analysisSchema.js — a JSON Schema for the analyser's reply, for NATIVE structured output.
//
// IN PRODUCTION FOR ChatGPT ONLY (engine.schemaFor). ChatGPT gets this schema on every analysis
// call because it fixes its one systematic failure: dropped msg_ids, 5 of 15 batches without it,
// 0 of 17 with it. Claude never gets it: Anthropic refuses it (see THE HARD LIMIT below) and
// haiku doesn't need it. Runs: specs/analysis-experiments.md (E4).
//
// WHAT A SCHEMA CAN AND CANNOT SAY. It encodes STRUCTURE only: which fields exist, their types,
// the enums, and — the point of the exercise — that every batch entry carries a `msg_id` drawn
// from exactly the handles that were asked about. Everything semantic stays where it is: the
// prompt decides WHO owes what, and analyze.classify() still rejects an entry with a blank
// message_summary, checks the entry count, and so on. Do not weaken classify() because this
// exists; JSON Schema proves shape, not truth.
//
// THE STRICT-MODE COMPROMISES, MADE EXPLICIT. OpenAI's strict mode (and Anthropic's constrained
// decoding) require every property to be listed in `required` and `additionalProperties:false`
// on every object. The reply contract in prompt.js relies on OMISSION in several places, and the
// schema cannot express omission, so it maps each case to something it can express. A ChatGPT
// reply therefore differs from the prompt's contract in these places, and reconcile accepts both:
//
//   contract ("omit it")                       schema here                 how reconcile copes
//   ------------------------------------------ --------------------------- ----------------------------------
//   omit `keywords` to keep them               keywords: array | null      null is not an array → kept
//   omit `owed_by_me_because` off i_owe_them   enum | null                 null ignored
//   omit `todo_id` on new / `tmp_id` on old    both string | null          falsy handled
//   omit `responses` / `profile_updates` /     required arrays, may be []  empty handled
//     `triggers` / `notes` when nothing to say
//   participants: a MAP keyed by address       an ARRAY of { address,      the array is normalised to the
//                                              role, role_note }           map on arrival (reconcile.js)
//   triggers[].details: free-form per action   { category, sender,         every field nullable; sub_id is pinned
//                                              sub_id, payload }           to the request's subscriptions
//
// The two shapes a strict schema simply cannot hold are the address-keyed map and the free-form
// details object. Both are re-shaped above. That is the price of strict mode; for ChatGPT the
// measurements said it is worth paying.
//
// JSON SCHEMA SUBSET. Written for the intersection of what the two providers accept: `type`,
// `enum`, `properties`, `required`, `additionalProperties:false`, `items`, `anyOf` for anything
// nullable that is not a plain scalar, `type: [X, 'null']` for nullable scalars.
// No `pattern`, `format`, `minimum`, `maximum`, `$ref` — the app's own checks cover those.
// PROBED LIVE 2026-09-19 (one feature per call, each on its own model id): Anthropic accepts the
// type-array nullables and anyOf, but REJECTS `minItems`/`maxItems` and an `enum` that contains
// null. OpenAI accepts all of them. So the batch array carries no count bounds — classify()
// enforces the entry count, as it always has — and a nullable enum is spelled
// anyOf [ {type:'string', enum:[…]}, {type:'null'} ]. Both providers take that form.
//
// THE HARD LIMIT, verbatim from Anthropic on the full schema: "Schemas contains too many
// parameters with union types (29 parameters with type arrays or anyOf). This causes exponential
// compilation cost. Reduce the number of nullable or union-typed parameters (limit: 16)."
// That is the collision: OpenAI strict mode FORCES every optional
// field to be nullable; Anthropic CAPS nullable fields at 16; the contract has 29 optional
// fields. As written, this schema is accepted by OpenAI and refused by Anthropic. And the union
// count is not even the last wall: a variant cut to 15 unions was refused with "The compiled
// grammar is too large" — Anthropic bounds the whole grammar, not just the nullables. What DOES
// fit (probed on haiku): the core shape alone — projects, to-dos, summary, delta — at ~2.7k chars
// and 13 unions, i.e. without `responses`, `profile_updates`, `triggers` and `notes`. So the
// route to Anthropic would be a slimmer CONTRACT, not a cleverer schema — and since haiku needs
// no schema to get the shape right, Claude is simply not sent one (engine.schemaFor).

const str = { type: 'string' }
const nstr = { type: ['string', 'null'] }
const bool = { type: 'boolean' }
const int = { type: 'integer' }
const nint = { type: ['integer', 'null'] }
const nnum = { type: ['number', 'null'] }
const strEnum = (values) => ({ type: 'string', enum: values })
// NOT `enum: [...values, null]` — Anthropic rejects a null inside an enum (probed 2026-09-19)
const nEnum = (values) => ({ anyOf: [{ type: 'string', enum: values }, { type: 'null' }] })
const arr = (items, extra = {}) => ({ type: 'array', items, ...extra })
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] })
// every object: all properties required, nothing extra — strict mode's two rules
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })

export const DIRECTIONS = ['i_owe_them', 'they_owe_me', 'team_owes', 'read_only']
export const TODO_STATUSES = ['open', 'in_progress', 'resolved', 'cancelled']
export const OWED_BY_ME_BECAUSE = ['asked_directly', 'my_responsibility', 'usually_passed_on_to_me', 'stepping_in']
export const PARTICIPANT_ROLES = ['me', 'team', 'external']
export const RESPONSE_KINDS = ['answer', 'delegate', 'reminder']
export const RESPONSE_STATUSES = ['suggested', 'dismissed']
// person_detail added 2026-09-20: the people block has always invited the model to "ask with
// request_more" about a collapsed cc, but the kind did not exist — the request came back as
// "could not resolve", a wasted round-trip. Now it resolves.
export const REQUEST_MORE_KINDS = ['message_body', 'project_detail', 'person_detail']

const todo = obj({
  todo_id: nstr,
  tmp_id: nstr,
  new: bool,
  short_description: str,
  description: str,
  importance: int,
  direction: strEnum(DIRECTIONS),
  owed_by_me_because: nEnum(OWED_BY_ME_BECAUSE),
  who: arr(str), // one person or several, lead first; [] for read_only (prompt 0.53)
  status: strEnum(TODO_STATUSES),
  evidence_msg_id: nstr,
  due_hint: nstr,
  due_earliest: nstr,
  due_latest: nstr,
  change_reason: nstr
})

const response = obj({
  response_id: nstr,
  tmp_id: nstr,
  new: bool,
  todo_id: str,
  direction: strEnum(DIRECTIONS),
  kind: strEnum(RESPONSE_KINDS),
  to: arr(str),
  cc: arr(str),
  subject: nstr,
  body: str,
  reminder_at: nnum,
  status: strEnum(RESPONSE_STATUSES),
  change_reason: nstr
})

// The contract's address-keyed map, as the array a strict schema can express (see header).
const participant = obj({ address: str, role: strEnum(PARTICIPANT_ROLES), role_note: nstr })

const project = obj({
  project_id: nstr,
  tmp_id: nstr,
  new: bool,
  name: str,
  summary: str,
  importance: int,
  keywords: nullable(arr(str)), // null = keep the existing list (the contract's "omit")
  participants: arr(participant),
  todos: arr(todo),
  responses: arr(response)
})

// responsibilities: the model sends the LIST of what this person handles, one line per kind of work.
// Spelled as a nullable ARRAY rather than array|string so the union COUNT is unchanged (it was a
// nullable string) — this schema is already over Anthropic's 16-union limit, see the header. A model
// that sends one string instead is still accepted at runtime: responsibilities.js normalizes either
// shape. Entries the USER wrote are never in the model's gift to change, so a proposal only ever
// refreshes the model's own lines.
const profileUpdate = obj({
  address: str,
  summary: nstr,
  relationship: nstr,
  responsibilities: { type: ['array', 'null'], items: str },
  llm_importance: nint,
  reason: nstr
})

// details is the union of every registered action's fields, because strict mode forbids
// additionalProperties and a trigger for action A must still validate. `payload` is a STRING
// holding JSON: a subscription's payload shape is defined by the requesting app, so it is
// free-form by construction and no strict schema can express it. subscriptionsCore parses it.
//
// MEASURED, 2026-09-20 (experiment 7): without sub_id and payload here, a constrained model still
// emits app_subscription triggers — it just cannot fill them. One case produced ELEVEN
// {category, sender} husks and zero deliveries, where the same model unconstrained produced one
// correct 82-field delivery. Every ChatGPT subscription delivery was broken from 2026-09-19 until
// this line was fixed. When adding an action, add its fields HERE too.
const triggerWith = (subIds) => obj({
  type: str,
  details: obj({
    category: nstr,
    sender: nstr,
    // pinned to the subscriptions this request actually carries, when they are known
    sub_id: (subIds && subIds.length) ? nEnum(subIds) : nstr,
    payload: nstr
  })
})
const trigger = triggerWith(null)

const latestDelta = obj({ new_todo_ids: arr(str), resolved: arr(str) })

// one verdict per line of the request's "Open items to account for" block (prompt 0.61)
export const ACCOUNT_VERDICTS = ['resolved', 'in_progress', 'cancelled', 'open']
const accountForEntry = obj({ todo_id: str, verdict: strEnum(ACCOUNT_VERDICTS), reason: str })

// The fields of ONE analysis — a single reply's root, or one batch entry minus its msg_id.
const entryProperties = (subIds) => ({
  projects: arr(project),
  message_summary: str, // required and non-null; classify() additionally rejects it blank
  latest_delta: latestDelta,
  // nullable: only requests that carry an account-for block demand it, and classify() is what
  // enforces the per-id coverage — the schema only pins the entry shape
  account_for: nullable(arr(accountForEntry)),
  // the ids of the standing instructions that ACTUALLY changed this analysis (prompt 0.54).
  // Plain strings, not an enum of the ids offered: an enum would add one union per call for a
  // field nothing acts on, and Anthropic's union budget is already the binding constraint.
  rules_applied: arr(str),
  profile_updates: arr(profileUpdate),
  triggers: arr(triggerWith(subIds)),
  notes: nstr
})

const requestMoreItem = obj({ kind: strEnum(REQUEST_MORE_KINDS), msg_id: nstr, project_id: nstr, address: nstr })

/**
 * The reply schema for one request.
 * @param {object} o
 * @param {string[]} o.expectMsgIds  the handles (m1, m2, …) of the messages this request asks about
 * @returns {object} a JSON Schema
 *
 * Two shapes are possible per request, and neither provider allows a top-level anyOf, so the root
 * is one object carrying both branches, exactly one of them non-null:
 *   batch (2+ messages):  { message_results: [entry with msg_id]  | null, request_more: [...] | null }
 *   single message:       { ...the analysis fields, each nullable, request_more: [...] | null }
 * A reply that fills both, or neither, is structurally valid here and is caught by classify().
 */
export function analysisSchema ({ expectMsgIds, subIds } = {}) {
  const handles = Array.isArray(expectMsgIds) ? expectMsgIds.map(String).filter(Boolean) : []
  const requestMore = nullable(arr(requestMoreItem))

  if (handles.length > 1) {
    const entry = obj({ msg_id: strEnum(handles), ...entryProperties(subIds) })
    // no minItems/maxItems: Anthropic rejects them (probed 2026-09-19). The msg_id enum still
    // pins WHICH handles may appear; classify() pins HOW MANY entries there are.
    return obj({
      message_results: nullable(arr(entry)),
      request_more: requestMore
    })
  }

  const single = entryProperties(subIds)
  const props = {}
  for (const [k, v] of Object.entries(single)) props[k] = k === 'notes' ? v : nullable(v)
  props.request_more = requestMore
  return obj(props)
}

/** Every object reachable from the schema, for tests that assert a rule holds everywhere. */
export function walkObjects (schema, out = []) {
  if (!schema || typeof schema !== 'object') return out
  if (Array.isArray(schema)) { schema.forEach(s => walkObjects(s, out)); return out }
  if (schema.type === 'object') out.push(schema)
  for (const v of Object.values(schema)) if (v && typeof v === 'object') walkObjects(v, out)
  return out
}
