// assemble.js — PERMANENT core. Build the analysis request for ONE new message:
// people, per-thread roles, the FULL to-do lists of the project(s) this thread is linked to,
// a lightweight catalog of OTHER active projects (with participants), an INDEX of the thread's
// prior messages (not their bodies), the replied-to parent in full (plus the thread's latest
// message in full when the reply forks past it), and the new message in full — plus any detail
// the model asked for via request_more. DOM-free and freezr-free.
// See specs/pipeline-walkthrough.md §6.

import { seedRoster, roleOf } from './roles.js'
import { fileToProject } from './autoProcess.js'
import { splitTurnBody, effortLine, agentMarker } from './sessionDigest.js'
import { whoTextOf, whoOf } from './whoMapping.js' // 2026-09-19 shim — render the `who` the model writes
import { inlineInsertions, renderInlineInsertions } from './inlineDiff.js'
import { hotProjectIds, coldProfileAddresses, RECIPIENT_PROFILES } from './selection.js'
import { responsibilitiesForPrompt, entriesOf } from './responsibilities.js'
import { activeSubscriptions } from './subscriptionsCore.js'

// ---- size caps -------------------------------------------------------------------------------
// EVERY section of this request used to be unbounded, and each one can blow up independently:
//   · a body — a long Outlook "RE:" chain replyStrip couldn't recognise arrives as one 115,000-char
//     body (fixed in replyStrip, but the cap has to exist anyway);
//   · the LINKED PROJECTS block — the full to-do list of every project on this thread, with each
//     to-do's description, evidence trail and suggested replies. A long-running matter with a few
//     hundred to-dos is 100k+ characters on its own. This is what produced a 114,783-char request
//     from a 409-char email;
//   · the CATALOG — every other active project;
//   · the PEOPLE block — a profile paragraph per participant, and a big thread has many.
// So each section is capped, and a whole-request budget tightens ALL of them together until the
// request fits. Every cut is MARKED in-band, so the model knows it is seeing part of something and
// can ask for the rest with request_more instead of silently reasoning over a fragment.
// Default input budget in CHARACTERS (~4 chars per token, so ~17k tokens ≈ 5c of input on Sonnet —
// matched to the app's "5-10 cents per email" expectation). Overridable per user: prefs
// .analysis_context_chars, surfaced on the Preferences tab. Bigger = the model sees more of your
// history per message and costs more; smaller = cheaper and blinder.
export const DEFAULT_CONTEXT_CHARS = 70000
export const CONTEXT_CHOICES = [
  { key: 'low', chars: 40000, label: 'Low (least expensive)' },
  { key: 'balanced', chars: 70000, label: 'Balanced (default)' },
  { key: 'longer', chars: 120000, label: 'Longer' },
  { key: 'max', chars: 200000, label: 'Max (most expensive)' }
]
const INDEX_MAX = 60 // prior-message index lines (the most recent ones)

// ---- the reduction ladder --------------------------------------------------------------------
// LEVEL 0 is everything. If the request exceeds the budget, the next level is built — and so on.
// Each level gives up the LEAST valuable thing still present, by relevance tier rather than by
// cutting text mid-sentence:
//   · suggested replies (irrelevant to a history build) and resolved to-dos go first — history;
//   · then per-to-do prose shrinks, then the evidence trail, while every todo_id stays visible so
//     the model can never duplicate an item it simply could not see;
//   · the catalog gives up summaries, then becomes a name+id list — enough to match a project and
//     pull it with request_more, which is the only thing the catalog is for;
//   · people stay LISTED at every level (dropping a participant is a factual error) but lose their
//     profile prose; the sender and the user keep full detail always;
//   · the thread index drops its oldest whole lines and shortens snippets;
//   · bodies are the one genuinely prose-shaped thing, so they are character-capped — with the cut
//     marked in-band, and the newest part kept (a reply's own text is at the top).
const LEVELS = [
  { openDetail: 'full', openFull: Infinity, closed: 10, responses: true, catalogDetailed: Infinity, catalogSummary: 400, people: 'full', indexMax: 60, indexSnippet: 120, newBody: 24000, prior: 6000, extra: 24000 },
  { openDetail: 'full', openFull: Infinity, closed: 5, responses: false, catalogDetailed: 40, catalogSummary: 240, people: 'full', indexMax: 50, indexSnippet: 100, newBody: 20000, prior: 5000, extra: 20000 },
  { openDetail: 'brief', openFull: Infinity, closed: 3, responses: false, catalogDetailed: 25, catalogSummary: 160, people: 'brief', indexMax: 40, indexSnippet: 80, newBody: 16000, prior: 4000, extra: 16000 },
  // closed never reaches 0 (2026-09-20). Two rules depend on seeing RESOLVED to-dos — "scan the
  // linked projects' existing to-dos (open AND resolved) before adding new:true" and "the resolved
  // list is the user's record of what was done" — and 139 of 322 work-channel runs were rendering
  // at these two levels with closed: 0, i.e. obeying them was impossible. Resolved rows render as
  // one-liners, so a floor of 3 costs a few hundred chars against a ~58k volatile block.
  { openDetail: 'brief', openFull: 40, closed: 3, responses: false, catalogDetailed: 12, catalogSummary: 100, people: 'brief', indexMax: 25, indexSnippet: 60, newBody: 12000, prior: 3000, extra: 12000 },
  { openDetail: 'oneline', openFull: 0, closed: 3, responses: false, catalogDetailed: 6, catalogSummary: 0, people: 'name', indexMax: 15, indexSnippet: 0, newBody: 8000, prior: 2000, extra: 8000 }
]

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// Character truncation, marked in-band. Used ONLY for message bodies (prose, where the top matters
// most); structured sections reduce by dropping whole units instead — see the ladder above.
const capBodyText = (text, n) => {
  const s = String(text || '')
  if (s.length <= n) return s
  return s.slice(0, n) +
    '\n\n[… TRUNCATED by SuperLazy: this body is ' + s.length.toLocaleString() + ' characters; the first ' +
    n.toLocaleString() + ' are shown. It is most likely a long quoted reply chain — the earlier messages of ' +
    'this thread are listed separately above, and you can ask for any of them with request_more.]'
}

function fmtDate (ms) {
  try { return new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' } catch (e) { return String(ms) }
}

// ---- SHORT MESSAGE HANDLES --------------------------------------------------------------------
// Provider message ids are enormous — an Exchange id is ~150 chars ("AQMkAGNmYTI2…AAAA=="). They
// appear on every index row, every evidence line, every reply pointer, and the model has to ECHO
// them back in evidence_msg_id (so they cost OUTPUT tokens too). On a long thread the ids alone
// outweighed the message summaries they annotate.
// So every request mints its own tiny handles — m1, m2, … assigned in first-render order — and
// engine.js translates them back to real provider ids before anything is stored. Same pattern the
// one-pass bootstrap already uses (jobs/bootstrap/dumpBuilder.js surrogate ids + translateIds).
// The handles live ONLY inside one request: nothing persisted ever sees them.
export function createAliasMap () {
  const toAlias = new Map()   // real id -> mN
  const toReal = new Map()    // mN -> real id
  let n = 0
  const aliasFor = (realId) => {
    const id = String(realId || '')
    if (!id) return '?'
    if (toAlias.has(id)) return toAlias.get(id)
    const alias = 'm' + (++n)
    toAlias.set(id, alias)
    toReal.set(alias, id)
    return alias
  }
  return { aliasFor, toAlias, toReal, get size () { return n } }
}
// A no-op map, so a caller that wants real ids (tests, the replay pages) needs no branching.
const IDENTITY_ALIAS = { aliasFor: (id) => String(id || '?'), toAlias: new Map(), toReal: new Map(), size: 0 }

const addrsOf = (list) => (list || []).map(x => x && x.address).filter(Boolean)

function participantsOf (messages) {
  const set = new Set()
  for (const m of messages) {
    if (m.from && m.from.address) set.add(m.from.address.toLowerCase())
    for (const a of addrsOf(m.to)) set.add(a.toLowerCase())
    for (const a of addrsOf(m.cc)) set.add(a.toLowerCase())
  }
  return [...set]
}

const isMe = (addr, roster) => roleOf(addr, roster) === 'me'

// Compact duration for the People block: '35m', '4h', '2d'.
function fmtDur (ms) {
  const m = Math.round(Number(ms) / 60000)
  if (m < 60) return Math.max(1, m) + 'm'
  const h = Math.round(m / 60)
  if (h < 48) return h + 'h'
  return Math.round(h / 24) + 'd'
}

// One-line interaction summary from a profile's observed stats (volume + responsiveness) —
// gives the model a behavioural prior alongside the LLM-written profile text.
function interactionNote (d) {
  if (!d) return ' (seen 0x)'
  const bits = [`seen ${d.messages_from || 0}x`]
  // median when the maintenance rebuild has computed one (outlier-immune), mean otherwise
  const themMs = d.reply_median_ms_by_them != null ? d.reply_median_ms_by_them : (d.replies_by_them ? d.reply_ms_by_them / d.replies_by_them : null)
  const userMs = d.reply_median_ms_by_user != null ? d.reply_median_ms_by_user : (d.replies_by_user ? d.reply_ms_by_user / d.replies_by_user : null)
  if (d.replies_by_them && themMs != null) bits.push(`replies to you ~${fmtDur(themMs)} (${d.replies_by_them}x)`)
  if (d.replies_by_user && userMs != null) bits.push(`you reply ~${fmtDur(userMs)} (${d.replies_by_user}x)`)
  return ` (${bits.join('; ')})`
}
// Only the user's own address carries a tag; everyone else's team/external role is the
// model's per-project call (a shared domain is a weak hint, not a verdict).
const meTag = (addr, roster) => (isMe(addr, roster) ? ' [ME]' : '')

// Per-person maintenance-stage note (see prompt.js "How the profile gets MAINTAINED"):
// PROVISIONAL people invite free profile_updates; SOLID people show their cumulative fit
// score plus the last drift notes, so the model can tell already-noted tension from new.
function profileStageNote (p, tuning) {
  const t = tuning || {}
  const target = t.MESSAGES_BEFORE_SOLIDIFYING_PROFILE || 5
  if (!p.profile.solidified_asof) {
    const n = Math.min((p.interaction_data && p.interaction_data.messages_from) || 0, target)
    return `; PROVISIONAL (${n}/${target} messages — refine the profile freely via profile_updates)`
  }
  return '; SOLID (grounded from full history — do not rewrite it inline)'
}

// detail: 'full' | 'brief' | 'name'. Everyone on the thread is always LISTED (an unlisted person
// reads as "not on this thread", which is a factual error) — leaner levels drop the profile prose,
// never the person. The sender and [ME] keep full detail at every level: the sender is who this
// message is being judged by, and the model needs the user's own identity to assign directions.
// opts.handles === false leaves the "; handles: …" segment OUT: the analysis request shows
// responsibilities in their own "Who handles what" section instead (prompt 0.65 — see
// renderWhoHandlesWhat). Every other caller (the clean-up, person_detail rounds) keeps them inline.
export function renderPersonLine (p, roster, tuning, detail, opts = {}) {
  const withHandles = opts.handles !== false
  if (isMe(p.address, roster)) {
    return `- ${p.display_name || p.address} <${p.address}> [ME] — this is the USER; you analyse on their behalf (no profile applies)`
  }
  const pr = p.profile || {}
  const rank = p.manual_rank != null ? (p.manual_rank + ' (manual)') : (pr.llm_importance + ' (llm)')
  const head = `- ${p.display_name || p.address} <${p.address}> importance ${rank}, ${pr.relationship || 'unknown'}`
  if (detail === 'name') return head
  // the sender's learned automated-mail category, from their file_to_project auto-process
  const fileEntry = fileToProject(pr)
  const disp = fileEntry && fileEntry.details && fileEntry.details.disposition
  // responsibilities is a LIST (responsibilities.js); entries the USER wrote carry [USER-SET] so
  // the model can see which lines are not its to rewrite
  const respBrief = responsibilitiesForPrompt(pr, { max: 120 })
  const resp = responsibilitiesForPrompt(pr)
  if (detail === 'brief') {
    return head + `; ${clip(pr.summary, 200)}` +
      (respBrief && withHandles ? `; handles: ${respBrief}` : '') +
      (disp ? `; disposition: ${disp}` : '')
  }
  return head + `; ${pr.summary || ''}` +
    (resp && withHandles ? `; handles: ${resp}` : '') +
    (pr.user_tone ? `; your tone with them: ${pr.user_tone}` : '') +
    (disp ? `; disposition: ${disp}` : '') + interactionNote(p.interaction_data) +
    profileStageNote(p, tuning)
}

// "Who handles what" (prompt 0.65, specs/analysis-experiments.md (E11)). Responsibilities
// used to sit inside each person's line, where the model read them as biography; now they are a
// list of their own, which the prompt's "Who handles what" instruction tells the model how to use.
// Lines are MOVED here, not copied (renderPersonLine with handles:false), so the request does not
// grow. `people` is [{ p, detail }]; a 'brief' person's text is clipped exactly as their person line
// used to clip it, so this is the same content the confirming run measured, relocated.
export const WHO_HANDLES_COLD_HEAD = '## Who handles what \u2014 the user\u2019s division of labour'
export const WHO_HANDLES_VOL_HEAD = '## Who handles what \u2014 people on this item not in the list above (or changed since it)'
export function renderWhoHandlesWhat (head, people) {
  const rows = []
  for (const { p, detail } of (people || [])) {
    if (!p || !p.profile) continue
    const pr = p.profile
    const lines = detail === 'brief'
      ? [responsibilitiesForPrompt(pr, { max: 120 })].filter(Boolean)
      : entriesOf(pr).map(e => e.source === 'user' ? e.text + ' [USER-SET]' : e.text)
    if (!lines.length) continue
    rows.push('- ' + (p.display_name || p.address) + ' <' + p.address + '>\n' + lines.map(t => '  \u00b7 ' + t).join('\n'))
  }
  return rows.length ? head + '\n' + rows.join('\n') : ''
}

// People are tiered by their ROLE ON THIS MESSAGE, not uniformly:
//   · senders (keepFull) — full profile: their relationship and history are what the analysis is
//     judged against;
//   · direct recipients (`to`) — brief: enough to judge who owes what;
//   · CC'd only (and prior-thread participants) — a single collapsed line of addresses. A 30-person
//     CC used to cost 30 profile paragraphs; nobody's standing changes because they were CC'd.
// `detail` from the reduction ladder still caps everyone (it can only make lines shorter).
function renderPeople (profileArr, roster, tuning, { detail = 'full', keepFull = [], brief = [], cached = [], changed = [], collect = null } = {}) {
  if (!profileArr.length) return '(no participant profiles)'
  const lower = (x) => String(x || '').toLowerCase()
  const always = new Set((keepFull || []).map(lower))
  const briefSet = new Set((brief || []).map(lower))
  // `cached`: addresses whose FULL profile already sits in the cold block of the cached prefix, so
  // repeating it here would buy nothing. `changed`: the ones updated since that block was rendered —
  // their cached copy is stale, so they are re-sent in full and OVERRIDE it, exactly as a touched
  // project's row does in "Updates since the catalog snapshot".
  const stale = new Set((changed || []).map(lower))
  const inPrefix = new Set((cached || []).map(lower).filter(a => !stale.has(a)))
  const RANK = { name: 0, brief: 1, full: 2 }
  const cap = (want) => (RANK[want] <= RANK[detail] ? want : detail)
  const lines = []
  const minor = []
  for (const p of profileArr) {
    if (isMe(p.address, roster)) { lines.push(renderPersonLine(p, roster, tuning, 'name')); continue }
    if (inPrefix.has(lower(p.address))) { lines.push(renderPersonLine(p, roster, tuning, 'name') + ' — full profile in the regular-correspondents list above'); continue }
    // with `collect`, responsibilities leave the line and are gathered for the "Who handles what" list
    const rp = (d) => { if (collect && d !== 'name') collect.push({ p, detail: d }); return renderPersonLine(p, roster, tuning, d, { handles: !collect }) }
    if (always.has(p.address)) { lines.push(rp(cap('full'))); continue }
    if (briefSet.has(p.address)) { lines.push(rp(cap('brief'))); continue }
    minor.push(p)
  }
  if (minor.length) {
    lines.push('- also on the thread (CC / earlier messages — no profile detail sent; ask with ' +
      'request_more only if one of them matters here): ' +
      minor.map(p => p.display_name ? p.display_name + ' <' + p.address + '>' : p.address).join(', '))
  }
  return lines.join('\n')
}

function renderResponseLine (r) {
  const to = (r.to || []).join(', '); const cc = (r.cc || []).length ? `  cc: ${r.cc.join(', ')}` : ''
  const when = r.kind === 'reminder' && r.reminder_at ? ` send-on ${fmtDate(r.reminder_at)}` : ''
  return `    [${r.response_id}] (${r.kind}, for ${r.todo_id || '?'}, ${r.status}${when}) to: ${to || '—'}${cc}\n        "${(r.body || '').replace(/\s+/g, ' ').trim()}"`
}

// Evidence trail lines: the last few one-line summaries of the messages that touched this
// to-do — its factual memory (drafts that state facts must be grounded in these).
// Exported for engine.js's project_detail resolution, so requested catalog projects carry
// the same trail as linked ones.
export function renderEvidenceLines (t, indent, max = 3, alias = IDENTITY_ALIAS) {
  return (t.evidence || []).filter(e => e.summary).slice(-max)
    .map(e => `${indent}↳ (${e.msg_id ? alias.aliasFor(e.msg_id) : '?'}) ${String(e.summary).replace(/\s+/g, ' ').trim()}`)
}

// detail: 'full' | 'brief' | 'oneline'. The HEAD is never dropped — it carries the todo_id, which is
// what lets the model update this item instead of creating a duplicate of it.
function renderTodoLine (t, detail = 'full', alias = IDENTITY_ALIAS, roster = null) {
  const ev = (t.evidence || []).map(e => e.msg_id).filter(Boolean).map(id => alias.aliasFor(id))
  // 2026-09-19: show the `who` the model now writes — one person or several, comma-separated —
  // not the stored owner/counterparty fields (see whoMapping.js; this goes back to a plain field
  // read after the storage migration).
  const who = whoTextOf(t, (a) => isMe(a, roster))
  const head = `  [${t.todo_id}] (${t.direction}, ${t.status}, importance ${t.importance}${t.importance_locked ? ' USER-SET (do not change)' : ''}) "${t.short_description || ''}"` +
    (who ? ` — who ${who}` : '') + (t.due_hint ? ` — due ${t.due_hint}` : '')
  if (detail === 'oneline') return head
  if (detail === 'brief') {
    return head + (t.description ? `\n      ${clip(t.description, 240)}` : '') + (ev.length ? `  {evidence: ${ev.join(', ')}}` : '')
  }
  const sums = renderEvidenceLines(t, '      ', 3, alias)
  // handles already shown on the ↳ evidence lines below are NOT repeated in {evidence:}
  const shown = new Set((t.evidence || []).filter(e => e.summary).slice(-3).map(e => alias.aliasFor(e.msg_id)))
  const bare = ev.filter(id => !shown.has(id)).slice(-2)
  return head + `\n      ${t.description || ''}` + (bare.length ? `  {evidence: ${bare.join(', ')}}` : '') +
    (sums.length ? '\n' + sums.join('\n') : '')
}

// ---- staleness tiers (specs/pipeline-walkthrough.md §6) -----------------------------------
// A project's DETAIL is set by how long it has been quiet, not by how big it is. Measured cause:
// linked-project detail was 29-57% of every request, sent in full however cold the project was.
// Tier is computed against the analysed message's own `asof`, so replays tier correctly.
export const DEFAULT_STALENESS_POLICY = { full_days: 7, brief_days: 30 }
// Standing instructions and third-party app instructions are the same thing to the model: text
// that outranks its defaults. They share one heading so a rule reads identically whether it rode in
// the weekly cached block (scope 'all') or in this message's volatile block (scope sender/domain/
// account). The [i_xx] id is what lets the model name the rule it actually used (rules_applied).
// The reminder that closes every request. It carries NO instruction text — only the count, the
// obligation, and an index of what exists — so a user with fifty standing instructions pays ~2.8k
// characters here rather than re-sending the lot. The detail stays in the cached block.
export function instructionReminder (allMail, workflows, subscriptions) {
  const lines = []
  for (const r of (allMail || [])) {
    if (r && r.text) lines.push('- ' + (r.instruction_id || 'i_?') + ' — ' + String(r.text).trim().slice(0, 60))
  }
  for (const s of (subscriptions || [])) {
    if (s && s.sub_id) lines.push('- ' + s.sub_id + ' — ' + String(s.label || s.requester_app || '').trim().slice(0, 60))
  }
  const wf = (workflows || []).length
  const n = lines.length + wf
  if (!n) return ''
  return [
    '## STANDING INSTRUCTIONS — CHECK EACH ONE BEFORE YOU ANSWER',
    'There ' + (n === 1 ? 'is 1 standing instruction' : 'are ' + n + ' standing instructions') +
    ' in the earlier message(s) of this conversation. Complete your normal analysis, then go back to ' +
    'each one, check it against THIS message, and merge in the effects of every one that matches. ' +
    'Several can apply at once. One that does not match has no effect.',
    lines.length ? 'They are:\n' + lines.join('\n') : ''
  ].filter(Boolean).join('\n')
}

export const INSTRUCTIONS_HEADING = '## Standing instructions — apply the ones that match this message, and name any you actually used in "rules_applied"'
export const instructionLine = (r) => '- [' + (r.instruction_id || 'i_?') + '] ' + String(r.text || '').trim()

const DAY_MS = 24 * 3600 * 1000

export function stalenessTierOf (project, asof, policy) {
  const p = policy || DEFAULT_STALENESS_POLICY
  const full = Number(p.full_days) || 0
  const brief = Number(p.brief_days) || 0
  if (!full) return 'full' // policy disabled — everything full detail (pre-tier behaviour)
  const quietMs = Math.max(0, (Number(asof) || Date.now()) - (Number(project.last_active_asof) || 0))
  if (quietMs <= full * DAY_MS) return 'full'
  if (!brief || quietMs <= brief * DAY_MS) return 'brief'
  return 'dormant'
}

const isOpenTodo = (t) => t.status === 'open' || t.status === 'in_progress'
// Rank open to-dos for "which do we detail first": importance, then recency.
const todoRank = (a, b) => (b.importance || 0) - (a.importance || 0) ||
  (Number(b.created_asof) || 0) - (Number(a.created_asof) || 0)

// The block the model EDITS IN PLACE, so it is the last to lose content — but a matter with hundreds
// of to-dos cannot go in whole. Reduction is by RELEVANCE TIER, never by cutting text mid-sentence:
//   openDetail     how much of each open to-do is shown ('full' → 'brief' → 'oneline')
//   openFull       how many of the open to-dos get openDetail (ranked by importance+recency); the
//                  remainder drop to one line, so every todo_id is still present and nothing gets
//                  duplicated by an unaware model
//   closed         how many resolved/cancelled to-dos are shown (newest first); the rest are counted
//   responses      whether suggested replies are included at all (irrelevant when noDrafts)
// BRIEF tier: header + participant ROLES + every open to-do as one line. Enough to resolve or
// advance an item (reconcile merges those fields by todo_id — see reconcile.js briefProjectIds);
// rewriting content requires request_more. No descriptions, evidence, resolved items or drafts.
function renderBriefProject (p, roster = null) {
  const parts = Object.entries(p.participants || {}).map(([a, v]) => `${a} [${v.role || '?'}]`).join('; ')
  const open = (p.todos || []).filter(isOpenTodo)
  const lines = open.map(t => {                                 // 2026-09-19: `who`, see whoMapping.js
    const who = whoTextOf(t, (a) => isMe(a, roster))
    return `  [${t.todo_id}] ${t.direction} · "${t.short_description || ''}"` +
      (who ? ` · who ${who}` : '') + ` · ${t.status} · imp ${t.importance}` +
      (t.due_hint ? ` · due ${t.due_hint}` : '') +
      (t.importance_locked ? ' · USER-SET importance' : '')
  })
  const closedCount = (p.todos || []).length - open.length
  return `### Project [${p.project_id}] "${p.name}" (importance ${p.importance}) [BRIEF]\n  summary: ${p.summary || '(none yet)'}` +
    ((p.keywords && p.keywords.length) ? `\n  keywords: ${p.keywords.join(', ')}` : '') +
    (parts ? `\n  participants: ${parts}` : '') +
    (lines.length ? `\n${lines.join('\n')}` : '\n  (no open to-dos)') +
    (closedCount > 0 ? `\n  [… ${closedCount} resolved/cancelled item(s) not listed — they are DONE.]` : '') +
    '\n  [This project has been quiet: to-dos are one-liners. You may return status / evidence_msg_id / ' +
    'change_reason / importance / due for them; to rewrite content or add items needing full context, ' +
    'ask for project_detail.]'
}

// DORMANT tier: a catalog-style row only. Editing requires pulling the detail first (invariant 4).
function renderDormantProject (p) {
  const open = (p.todos || []).filter(isOpenTodo).length
  return `### Project [${p.project_id}] "${p.name}" (importance ${p.importance}) [DORMANT — request project_detail before editing]\n` +
    `  summary: ${p.summary || '(none yet)'}` +
    ((p.keywords && p.keywords.length) ? `\n  keywords: ${p.keywords.join(', ')}` : '') +
    `\n  ${open} open to-do(s) · people: ${(p.participant_emails || Object.keys(p.participants || {})).join(', ') || '—'}` +
    ` · last active ${fmtDate(p.last_active_asof)}`
}

function renderLinkedProjects (linked, { openDetail = 'full', openFull = Infinity, closed = 10, tierOf = null, alias = IDENTITY_ALIAS, roster = null } = {}) {
  if (!linked.length) return '(no project is linked to this thread yet — assign each to-do to a catalog project below, or start a NEW project)'
  return linked.map(p => {
    // staleness tier decides how much of this project is sent at all (§5.1)
    const tier = tierOf ? tierOf(p) : 'full'
    if (tier === 'brief') return renderBriefProject(p, roster)
    if (tier === 'dormant') return renderDormantProject(p)
    const parts = Object.entries(p.participants || {}).map(([a, v]) => `${a} [${v.role || '?'}] — ${v.role_note || ''}`).join('; ')
    const all = p.todos || []
    const open = all.filter(isOpenTodo)
    const closedAll = all.filter(t => !isOpenTodo(t))
    // detail the top-ranked open items, keep the rest as one-liners — in ORIGINAL order, so the list
    // still reads chronologically rather than being re-sorted under the model
    const detailed = new Set([...open].sort(todoRank).slice(0, openFull).map(t => t.todo_id))
    const openLines = open.map(t => renderTodoLine(t, detailed.has(t.todo_id) ? openDetail : 'oneline', alias, roster))
    const keptClosed = closed > 0 ? closedAll.slice(-closed) : []
    const closedLines = keptClosed.map(t => renderTodoLine(t, 'oneline', alias, roster))
    const omittedClosed = closedAll.length - keptClosed.length
    const lines = [...openLines, ...closedLines]
    const todos = lines.length ? lines.join('\n') : '  (no to-dos yet)'
    const notes = []
    if (open.length > openFull) {
      notes.push(`  [… ${open.length - openFull} of the open to-dos above are listed as one line only (all ids are present — update them normally, or ask for detail with request_more).]`)
    }
    if (omittedClosed > 0) {
      notes.push(`  [… ${omittedClosed} older resolved/cancelled to-do(s) of this project are not listed (${all.length} in total). They are DONE — do not recreate them; ask with request_more if you need one.]`)
    }
    // SUGGESTED REPLIES ARE NOT SENT BACK. Draft bodies the model itself wrote earlier are noise
    // at best and anchoring at worst — it re-reads its own prose instead of judging the new mail.
    // Only the COUNT goes back, so it knows a suggestion exists rather than inventing a second one.
    // (reconcile keeps one live suggestion per to-do + kind, so nothing duplicates.)
    const liveResp = (p.responses || []).filter(r => r.status === 'suggested' || r.status === 'edited')
    const resp = liveResp.length
      ? '\n  [' + liveResp.length + ' suggested repl' + (liveResp.length === 1 ? 'y' : 'ies') +
        ' already drafted for this project — not shown. To REPLACE one, emit a response for the same todo_id + kind.]'
      : ''
    return `### Project [${p.project_id}] "${p.name}" (importance ${p.importance})\n  summary: ${p.summary || '(none yet)'}` +
      ((p.keywords && p.keywords.length) ? `\n  keywords: ${p.keywords.join(', ')}` : '') +
      (parts ? `\n  participants: ${parts}` : '') + `\n${todos}` +
      (notes.length ? '\n' + notes.join('\n') : '') + resp
  }).join('\n\n')
}

// The catalog exists for ONE decision: does this message belong to a project that already exists?
// So its reduction keeps breadth (every project stays visible by name+id, or the model will start a
// duplicate) and gives up depth: the summary and people go first, then it becomes a name list.
//   detailed  how many projects get the full line, most-recently-active first (the catalog arrives
//             sorted that way from projectStore.catalog)
//   summary   chars of each summary in the detailed lines (0 = omit)
// One catalog row at full detail — also the shape used by the snapshot (§4) and by the
// "Updates since the catalog snapshot" delta, so a row reads identically wherever it appears.
export function catalogRow (c, summaryChars = 400) {
  return `- [${c.project_id}] "${c.name}" — imp ${c.importance} · ${c.open_todo_count} open · last active ${fmtDate(c.last_active_asof)} · people: ${(c.participants || []).join(', ') || '—'}` +
    ((c.repos && c.repos.length) ? ` · repo: ${c.repos.join(', ')}` : '') +
    ((c.keywords && c.keywords.length) ? ` · kw: ${c.keywords.join(', ')}` : '') +
    (summaryChars > 0 && c.summary ? `\n    ${clip(c.summary, summaryChars)}` : '')
}
// Stale catalog entries keep only what MATCHING needs: id, name, keywords (§5.2).
const catalogNameRow = (c) => `- [${c.project_id}] "${c.name}"` +
  ((c.keywords && c.keywords.length) ? ` · kw: ${c.keywords.join(', ')}` : '')

function renderCatalog (catalog, { detailed = Infinity, summary = 400, staleIds = null } = {}) {
  if (!catalog.length) return '(no other active projects)'
  const rich = catalog.slice(0, detailed)
  const rest = catalog.slice(detailed)
  const lines = rich.map(c =>
    (staleIds && staleIds.has(c.project_id)) ? catalogNameRow(c) : catalogRow(c, summary)
  )
  if (rest.length) {
    // names + ids only: enough to spot a match and pull the project with request_more, ~40 chars each
    lines.push('- also active (name + id only — ask with request_more for any of these): ' +
      rest.map(c => `"${c.name}" [${c.project_id}]`).join(', '))
  }
  return lines.join('\n')
}

function snippet (text, n = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

function recipientsLine (m, roster) {
  const to = addrsOf(m.to).map(a => a + meTag(a, roster)).join(', ')
  const cc = addrsOf(m.cc).map(a => a + meTag(a, roster))
  return `to: ${to || '—'}` + (cc.length ? `  cc: ${cc.join(', ')}` : '')
}

// Index rows: the first row spells recipients out; later rows that carry the SAME set say so in
// four characters instead of re-printing eight addresses (a 12-row Exchange thread was spending
// ~4k chars on identical cc lists). A row whose recipients differ is still printed in full —
// that difference is signal (someone was added or dropped).
function indexRecipients (m, roster, prevKey) {
  const key = [...addrsOf(m.to), '|', ...addrsOf(m.cc)].join(',')
  if (prevKey.key === key) return { text: 'to: (same)', key }
  prevKey.key = key
  return { text: recipientsLine(m, roster), key }
}

// One index line is ~200 chars, so a 300-message thread is 60k of prompt before any body. Reduction
// drops the OLDEST whole lines (the most recent are the nearest context to the message being
// analysed) and shortens the per-message snippet — never a partial line, which would leave a
// dangling msg_id the model might cite wrongly.
function renderIndex (priorMsgs, roster, { max = INDEX_MAX, snippetChars = 120, alias = IDENTITY_ALIAS } = {}) {
  if (!priorMsgs.length) return '(this is the first message of the thread)'
  const shown = priorMsgs.length > max ? priorMsgs.slice(-max) : priorMsgs
  const head = priorMsgs.length > max
    ? '[… ' + (priorMsgs.length - max) + ' older message(s) of this thread are not listed — it has ' +
      priorMsgs.length + ' in total. The ' + max + ' most recent follow; ask for any body with request_more.]\n'
    : ''
  const prevKey = { key: null }
  let prevSubject = null
  return head + shown.map(m => {
    const from = m.from ? (m.from.address || '?') : '?'
    const reply = m.in_reply_to ? ` · ↳ replies to ${alias.aliasFor(m.in_reply_to)}` : ''
    const rec = indexRecipients(m, roster, prevKey)
    // same dedup for the subject: RE:-chains repeat it verbatim on every row
    const subj = (m.subject || '') === prevSubject ? '(same subject)' : `"${m.subject || ''}"`
    prevSubject = m.subject || ''
    return `- (${alias.aliasFor(m.msg_id)}) ${fmtDate(m.date)} · From ${from}${meTag(from, roster)} · ${rec.text}${reply} · ${subj}` +
      (snippetChars > 0 ? ` · ${snippet(m.clean_text, snippetChars)}` : '')
  }).join('\n')
}

// WHOLE-mode bodies (forwards, inline-comment replies) get a bigger cap: the quoted chain IS the
// content there, so cutting them like an ordinary reply amputates the substance (bootstrap
// experiment run 1: inline answers lost to truncation while boilerplate survived).
const bodyCapFor = (m, cap) => (m && m.body_mode === 'whole' ? cap * 3 : cap)

// Render a prior message in full (used for the replied-to parent and, on a fork, the latest message).
function renderPriorInFull (msg, roster, bodyCap, alias = IDENTITY_ALIAS) {
  if (!msg) return ''
  const from = msg.from ? (msg.from.name ? msg.from.name + ' <' + msg.from.address + '>' : msg.from.address) : '?'
  return [
    `from: ${from}${meTag(msg.from && msg.from.address, roster)} · (${alias.aliasFor(msg.msg_id)}) · ${fmtDate(msg.date)}`,
    `subject: ${msg.subject || ''}`,
    '',
    capBodyText(msg.clean_text, bodyCapFor(msg, bodyCap)) || '(empty body)'
  ].join('\n')
}

// priorTexts: the earlier messages of the thread (full or clean text) — when a stripped reply had
// quoted lines, the sender's INLINE additions are found by comparing that region with them
// (inlineDiff.js) and rendered as their own section under the body, question above answer
function renderNewMessage (m, roster, bodyCap, alias = IDENTITY_ALIAS, { priorTexts = null } = {}) {
  const from = m.from ? (m.from.name ? m.from.name + ' <' + m.from.address + '>' : m.from.address) : '?'
  const inlineAdds = (m.body_mode !== 'whole' && m.quoted_dropped > 0 && m.full_text && priorTexts && priorTexts.length) ? inlineInsertions(m.full_text, priorTexts) : []
  const inlineSection = inlineAdds.length ? '\n\n' + renderInlineInsertions(inlineAdds) : ''
  // a STRIPPED reply says what it left out, so the model can ask for it when the visible text refers
  // to the quoted part (an inline reply); a WHOLE body says why it is whole
  const inline = m.body_mode === 'whole' ? ` [WHOLE BODY${m.body_mode_reason ? ': ' + m.body_mode_reason : ''}]` : ''
  // …as its own line AFTER the body, where it is read last and next to the text it is about
  // (placement measured 2026-09-26: on the subject line the model never asked, three of three)
  const dropped = (m.body_mode !== 'whole' && m.quoted_dropped > 0)
    ? (inlineAdds.length
        ? `\n[The rest of this message's quoted part (${m.quoted_dropped} line(s)) matched earlier messages of the thread and is not shown; request its body — request_more { kind: "message_body", msg_id: "${alias.aliasFor(m.msg_id)}" } — only if you need the exact wording.]`
        : `\n[${m.quoted_dropped} quoted line(s) of this message are NOT shown above. If the text says its answers or comments are below, inline, or in the quoted part, they are in those lines: request this message's body now — request_more { kind: "message_body", msg_id: "${alias.aliasFor(m.msg_id)}" } — and judge only once you have read it.]`)
    : ''
  const reply = m.in_reply_to ? `   ↳ replies to ${alias.aliasFor(m.in_reply_to)}` : ''
  const labels = (m.labels && m.labels.length) ? `\nmail labels: ${m.labels.join(', ')}` : ''
  return [
    `from: ${from}${meTag(m.from && m.from.address, roster)}${reply}`,
    recipientsLine(m, roster),
    `date: ${fmtDate(m.date)}`,
    `subject: ${m.subject || ''}${inline}${labels}`,
    '',
    (capBodyText(m.clean_text, bodyCapFor(m, bodyCap)) || '(empty body)') + inlineSection + dropped
  ].join('\n')
}

// ---- per-channel item renderers (specs/superlazy-inputs.md: "renderer") -----------------------
// Each channel lays its items out its own way — an email as from/to/cc/subject, a (future) note as
// author/attendees/title. Only mail exists today; rendererFor defaults to it, so mail requests
// render byte-identically to the pre-channel code (the Phase-1 regression gate depends on that).
// A NOTES item: the user's own record — header marks the channel (the system prompt's notes
// guide keys off "[NOTES item]"), attendees may be name-only, body is never reply-stripped
// (normalize guarantees body_mode 'whole'). m.revised marks an EDIT of an already-analysed note
// (specs/superlazy-inputs.md §6.4) — the marker tells the model to amend, not duplicate.
function renderNote (m, roster, bodyCap, alias = IDENTITY_ALIAS) {
  const author = m.from ? (m.from.name ? m.from.name + ' <' + m.from.address + '>' : (m.from.address || '?')) : '?'
  const att = (m.to || []).map(x => x && x.address
    ? x.address + meTag(x.address, roster)
    : (x && x.name ? x.name + ' (no address known)' : null)).filter(Boolean)
  return [
    `[NOTES item${m.item_kind === 'meeting_notes' ? ' — meeting notes' : ''}] · (${alias.aliasFor(m.msg_id)}) · ${fmtDate(m.date)}` +
      (m.revised ? '\n[REVISED — an earlier version of this note was already analysed; to-dos citing this item derive from it. UPDATE, resolve or cancel them to match this version; do not re-create them.]' : ''),
    `note by: ${author}${meTag(m.from && m.from.address, roster)}`,
    att.length ? `attendees: ${att.join(', ')}` : null,
    `title: ${m.subject || '(untitled)'}`,
    '',
    capBodyText(m.clean_text, bodyCap) || '(empty note)'
  ].filter(x => x != null).join('\n')
}

// A MESSAGES item: one CHUNK of chat from one stream (Slack channel / DM / thread), body already a
// transcript (chunker.renderTranscript: "HH:MM · author: text", ME marked, reactions inline). The
// header keys the system prompt's messages guide ("[MESSAGES item]"). The chunk's in_reply_to (set
// by the chunker on adjacency) makes the engine inline the PREVIOUS chunk in full — rendered by
// this same function, exactly like a replied-to email. Never reply-stripped, never drafted at.
function renderChatChunk (m, roster, bodyCap, alias = IDENTITY_ALIAS) {
  const members = (m.to || []).map(x => x && x.address
    ? x.address + meTag(x.address, roster)
    : (x && x.name ? x.name : null)).filter(Boolean)
  const span = m.channel_data && m.channel_data.first_ts && m.channel_data.first_ts !== m.date
    ? fmtDate(m.channel_data.first_ts) + ' → ' + fmtDate(m.date)
    : fmtDate(m.date)
  const count = m.channel_data && m.channel_data.msg_count ? ' · ' + m.channel_data.msg_count + ' message(s)' : ''
  return [
    `[MESSAGES item — chat transcript${m.item_kind === 'thread' ? ', one reply-thread' : ''}] · (${alias.aliasFor(m.msg_id)}) · ${span}${count}` +
      (m.revised ? '\n[REVISED — an earlier version of this chunk was already analysed; to-dos citing this item derive from it. UPDATE, resolve or cancel them to match this version; do not re-create them.]' : ''),
    `stream: ${m.subject || '(chat)'}`,
    members.length ? `participants: ${members.join(', ')}` : null,
    m.in_reply_to ? `↳ continues ${alias.aliasFor(m.in_reply_to)} (given in full above/below)` : null,
    '',
    capBodyText(m.clean_text, bodyCap) || '(empty chunk)'
  ].filter(x => x != null).join('\n')
}

// A WORK item: ONE TURN of an agent session (Claude Code) — the user's prompt and the agent's
// answer; the SESSION is the thread (specs/superlazy-sessions.md). The header keys the system
// prompt's work guide ("[WORK item]"). Cut direction is the REVERSE of mail: the prompt keeps its
// HEAD (the ask leads with the ask), the answer keeps its TAIL (the recap is at the end); tool
// output was never stored. The turn's in_reply_to (the previous turn) makes the engine inline the
// previous turn in full via this same function, exactly like a replied-to email.
const WORK_PROMPT_CHARS = 1500
// A plan is sent WHOLE on the turn that writes it. The largest in the measured corpus is 27,390
// chars; this is a guard, and a cut is always marked, never silent (specs/superlazy-sessions.md §6.3).
const PLAN_PROMPT_CHARS = 32000
const PATCH_PROMPT_CHARS = 8000
const CHECK_MARK = { completed: '[x]', in_progress: '[~]', pending: '[ ]' }
// The HOT/STALE rule: the turn that WRITES a plan carries its full text; every later turn carries
// one line naming it, so a three-day-old plan is never re-read as a statement of what remains. The
// PRIOR turn (inlined like a replied-to mail) gets the one-liner too — it was read in full when it
// was itself analysed.
function renderAgentWork (d, { prior = false } = {}) {
  const aw = d.agent_work || null
  if (!aw) return []
  const out = []
  const plans = Array.isArray(aw.plans) ? aw.plans : []
  const full = plans.filter(p => p && p.kind !== 'patch')
  const patches = plans.filter(p => p && p.kind === 'patch')
  if (full.length && !prior) {
    for (const p of full) {
      const cut = p.text.length > PLAN_PROMPT_CHARS
      out.push('', `## PLAN written this turn — "${p.title}"` + (p.path ? ` (${p.source}: ${p.path})` : ` (${p.source})`) +
        (p.truncated ? ' [stored truncated at ' + p.chars.toLocaleString() + ' chars]' : ''))
      out.push(cut ? p.text.slice(0, PLAN_PROMPT_CHARS) + '\n[… ' + (p.text.length - PLAN_PROMPT_CHARS).toLocaleString() + ' more characters not sent — the full text is on the item]' : p.text)
    }
  } else if (full.length && prior) {
    out.push(`this turn wrote a plan: "${full[full.length - 1].title}" — read in full when this turn was analysed; its parts are on the project's to-dos and their "- " lines`)
  } else if (aw.latest_plan && aw.latest_plan.title) {
    const lp = aw.latest_plan
    // "to-dos and lines", not "the to-do": a draft plan is one row with "- " lines, an accepted
    // one may have been sized into several to-dos (prompt 0.59) — this line must hold in both phases
    out.push(`plan on record for this session: "${lp.title}" (written turn ${lp.turn_n}${lp.ts ? ', ' + fmtDate(lp.ts) : ''}) — NOT re-sent: its parts already live on the project's to-dos and their "- " lines; judge progress from THIS turn's dialogue and checklist, never from the plan text remembered`)
  }
  if (patches.length && !prior) {
    for (const p of patches) {
      const cut = p.text.length > PATCH_PROMPT_CHARS
      out.push('', `## PLAN document CHANGED this turn — ${p.path || p.title} (diff)`)
      out.push(cut ? p.text.slice(0, PATCH_PROMPT_CHARS) + '\n[… diff cut at ' + PATCH_PROMPT_CHARS.toLocaleString() + ' chars]' : p.text)
    }
    // A diff on its own is hard to read against nothing. The plan's CURRENT shape is not re-sent
    // (cost, and "never re-assert from memory") — it is the draft to-do's "- " lines, which are in
    // this request because the project is linked. Say so, so the model edits THAT row (user,
    // 2026-09-21: a draft must stay one row in one project so it can be found and edited).
    out.push('the plan\'s current parts are the "- " lines of the to-do named for it in the linked project — apply this change to THAT row (lines removed or re-scoped updated or cancelled, lines added added), never as a second row')
  }
  const cl = Array.isArray(aw.checklist) ? aw.checklist : []
  if (cl.length) {
    const done = cl.filter(t => t.status === 'completed').length
    out.push('', `agent checklist at the end of this turn (${done} of ${cl.length} done — [x] the agent reports done, [~] in progress, [ ] pending):`)
    for (const t of cl.slice(0, 40)) out.push(`  ${CHECK_MARK[t.status] || '[ ]'} ${String(t.content || '').slice(0, 160)}`)
    if (cl.length > 40) out.push(`  … ${cl.length - 40} more`)
  }
  return out
}
function renderWorkTurn (m, roster, bodyCap, alias = IDENTITY_ALIAS, { prior = false } = {}) {
  const d = m.channel_data || {}
  const { prompt, answer, footer } = splitTurnBody(m.clean_text)
  const promptCap = Math.min(WORK_PROMPT_CHARS, Math.max(300, Math.floor(bodyCap / 3)))
  const answerCap = Math.max(400, bodyCap - Math.min(prompt.length, promptCap) - footer.length - 200)
  const cutPrompt = prompt.length > promptCap ? prompt.slice(0, promptCap) + '\n[… prompt truncated by SuperLazy: ' + prompt.length.toLocaleString() + ' characters; the first ' + promptCap.toLocaleString() + ' shown]' : prompt
  const cutAnswer = answer.length > answerCap
    ? '[… the first ' + (answer.length - answerCap).toLocaleString() + ' characters of the answer are cut by SuperLazy — the END is kept: it is the recap of what was done and what remains]\n' + answer.slice(answer.length - answerCap)
    : answer
  const turnLabel = d.turn_n ? ' ' + d.turn_n + (d.turns_total ? ' of ' + d.turns_total : '') : ''
  const state = d.turn_state === 'unanswered' ? 'the prompt got NO answer (session left mid-turn)'
    : d.turn_state === 'mid_tool' ? 'stopped while a tool was running — left unfinished'
      : null
  return [
    `[WORK item — agent session, turn${turnLabel}] · (${alias.aliasFor(m.msg_id)}) · ${fmtDate(m.date)}` +
      (m.revised ? '\n[REVISED — an earlier version of this turn was already analysed; to-dos citing this item derive from it. UPDATE, resolve or cancel them to match this version; do not re-create them.]' : ''),
    `session: ${m.subject || '(untitled)'}` + (d.repo_name ? ` · repo: ${d.repo_name}` + (d.branch ? ` (branch ${d.branch})` : '') : ''),
    `you: ${(m.from && m.from.address) || 'ME'} [ME] · agent: ${d.agent_name || 'AI agent'} (team member, no address)`,
    state ? `turn state: ${state}` : null,
    d.work_stats ? `effort: ${effortLine(d.work_stats)}` : null,
    d.turn_kind === 'question' ? 'the agent ENDED this turn by asking the user a question — the next turn (if any) is the answer; if none follows, the question is unanswered' : null,
    d.session_state && d.session_state !== 'quiet' ? `session now: ${d.session_state}` : null,
    m.in_reply_to ? `↳ continues ${alias.aliasFor(m.in_reply_to)} (the previous turn, given in full above/below)` : null,
    '',
    'YOU:',
    cutPrompt || '(empty prompt)',
    '',
    agentMarker(d.agent_name || 'AI agent'),
    cutAnswer || '(no answer text)',
    footer ? '' : null,
    footer || null,
    ...renderAgentWork(d, { prior })
  ].filter(x => x != null).join('\n')
}

// "## Open items to account for": every open to-do this item bears on, each demanding a verdict
// (specs/superlazy-sessions.md §0.10, extended to mail 2026-09-07). Per-item analysis otherwise leaves
// items open long after the conversation moved past them — silence is preservation everywhere else in
// the contract, so this block is where silence is NOT allowed. Three deterministic lists, deduped:
//   born    — open to-dos whose history includes THIS thread (all channels; a reply IS the verdict);
//   linked  — open to-dos IN THE LINKED PROJECT(S) that name someone on this message (sender, authors,
//             any recipient), whatever the direction — "does this message finish, advance or overtake
//             any of these?" (2026-09-25: the signed-contract case — eight contract items in the linked
//             project stayed open after the signed contract arrived because only the one thread-born
//             line was listed; the model obeyed the block and preserved the rest);
//   owed    — elsewhere in the store: open they_owe_me / team_owes items the SENDER/authors are
//             responsible for — "did this message deliver or advance any?" (capped separately).
// People are read through whoMapping.whoOf so legacy owner/counterparty rows and `who`-written rows
// match alike; ME never matches (the direction already says where ME stands).
const ACCOUNT_ITEMS_CAP = 30
const ACCOUNT_OWED_CAP = 8
// 0.40 staged the thread-born list alone; 0.60 (2026-09-25) turns on the linked-project people list
// and the cross-project owed-by-sender list. owedByMeToRecipients stays off: ME is named on a large
// share of the open store, so across projects it saturates the cap with unrelated items — inside the
// linked projects the `linkedPeople` list already covers ME's items to the people on the message.
export const ACCOUNT_FOR_SCOPE = { thread: true, linkedPeople: true, owedBySender: true, owedByMeToRecipients: false }
const lc = (x) => String(x || '').toLowerCase()
// linkedIds: the project ids whose to-do lists this request shows in full/brief — the `linked` list
// is drawn from these only (the engine passes the same set on an implicit detail round)
// The instruction that opens the block — exported so the replay tooling renders a stored request's
// block with the CURRENT wording (prompt 0.61+ expects account_for entries) — prompt 0.62 adds
// "judge the LINE, not the project".
export const ACCOUNT_FOR_INSTRUCTION = {
  work: 'The dialogue has moved on since these were raised. For EVERY line put one entry in "account_for": { "todo_id", "verdict": resolved (the recap or a later prompt shows it done) | in_progress (visible movement) | cancelled (the user moved past it without taking it up — a superseded suggestion or question) | open (genuinely still owed), "reason": one line saying why }. Judge the LINE, not the project: a step that is done is resolved even when the effort moves on to new work — the new work is a new to-do, never a reason to keep a finished one open; an agent question the user has since answered, or a decision the user has since taken, is resolved by that answer. A resolved or cancelled verdict closes the item with this turn as evidence; return the full to-do object in projects[] only when you also rewrite it. Silence is not allowed: a reply missing any of these ids is invalid.',
  mail: 'For EVERY line put one entry in "account_for": { "todo_id", "verdict": resolved (this message delivers, answers or confirms it) | in_progress (visible movement — "will send Friday", a partial) | cancelled (explicitly dropped or overtaken) | open (still outstanding), "reason": one line saying why }. Judge the LINE, not the project: a step that is done is resolved even when the effort moves on to new work — the new work is a new to-do, never a reason to keep a finished one open. A resolved or cancelled verdict closes the item with this message as evidence; return the full to-do object in projects[] only when you also rewrite it (text, who, importance, due). Silence is not allowed: a reply missing any of these ids is invalid.'
}

export function renderOpenItemsToAccountFor (store, m, roster, alias = IDENTITY_ALIAS, scope = ACCOUNT_FOR_SCOPE, { linkedIds = [] } = {}) {
  if (!m || !store || typeof store.all !== 'function') return null
  const threadId = m.thread_id
  const from = lc(m.from && m.from.address)
  const fromMe = !!from && isMe(from, roster)
  const recipients = new Set([...(m.to || []), ...(m.cc || [])].map(x => lc(x && x.address)).filter(Boolean))
  const authors = new Set([from].filter(Boolean))
  if (m.channel === 'messages' && m.channel_data && Array.isArray(m.channel_data.authors)) {
    for (const a of m.channel_data.authors) if (a && a.address && !isMe(lc(a.address), roster)) authors.add(lc(a.address))
  }
  // everyone on the message except ME — what the linked-project list matches on
  const onMessage = new Set([...authors, ...recipients].filter(a => a && !isMe(a, roster)))
  const linkedSet = new Set(linkedIds || [])
  const meTest = (a) => isMe(a, roster)
  const seen = new Set()
  const rows = { born: [], linked: [], owed: [], mine: [] }
  // 2026-09-19: `who` rather than the stored owner/counterparty pair — see whoMapping.js
  const line = (p, t, why) => `- ${t.todo_id} · ${t.direction || '?'} · who ${whoTextOf(t, meTest) || '?'} · ${t.status} · imp ${t.importance || 3} · "${(t.short_description || t.description || '').replace(/\s+/g, ' ').slice(0, 110)}"${why}` + ` · in project [${p.project_id}]`
  let total = 0
  const take = (list, p, t, why) => { list.push(line(p, t, why)); seen.add(t.todo_id); total++ }
  // pass 1 — thread-born and linked-project lines (the lines the message is most likely about)
  for (const p of store.all()) {
    if (!p || p.status === 'archived' || p.merged_into) continue
    for (const t of (p.todos || [])) {
      if (!t || !(t.status === 'open' || t.status === 'in_progress') || seen.has(t.todo_id)) continue
      if (total >= ACCOUNT_ITEMS_CAP) break
      const ev = (scope.thread && threadId) ? (t.evidence || []).filter(e => e && e.thread_id === threadId) : []
      if (ev.length) {
        const bornRef = ev[0].msg_id ? alias.aliasFor(ev[0].msg_id) : null
        take(rows.born, p, t, bornRef ? ` · raised at (${bornRef})` : '')
        continue
      }
      if (scope.linkedPeople && linkedSet.has(p.project_id) && onMessage.size) {
        const people = whoOf(t, meTest).map(lc)
        if (people.some(a => onMessage.has(a))) take(rows.linked, p, t, '')
      }
    }
    if (total >= ACCOUNT_ITEMS_CAP) break
  }
  // pass 2 — owed by the sender/authors elsewhere in the store, and (off by default) owed by ME to
  // the recipients; both are cross-project and get their own cap so they never crowd out pass 1
  let owedTotal = 0
  if ((scope.owedBySender && !fromMe && authors.size) || (scope.owedByMeToRecipients && fromMe && recipients.size)) {
    for (const p of store.all()) {
      if (!p || p.status === 'archived' || p.merged_into) continue
      for (const t of (p.todos || [])) {
        if (!t || !(t.status === 'open' || t.status === 'in_progress') || seen.has(t.todo_id)) continue
        if (total >= ACCOUNT_ITEMS_CAP || owedTotal >= ACCOUNT_OWED_CAP) break
        const people = whoOf(t, meTest).map(lc)
        if (scope.owedBySender && !fromMe && (t.direction === 'they_owe_me' || t.direction === 'team_owes') && people.some(a => authors.has(a))) {
          take(rows.owed, p, t, ''); owedTotal++; continue
        }
        if (scope.owedByMeToRecipients && fromMe && t.direction === 'i_owe_them' && people.some(a => recipients.has(a))) {
          take(rows.mine, p, t, ''); owedTotal++; continue
        }
      }
      if (total >= ACCOUNT_ITEMS_CAP || owedTotal >= ACCOUNT_OWED_CAP) break
    }
  }
  if (!total) return null
  const isWork = m.channel === 'work'
  const out = [`## Open items to account for on this ${isWork ? 'turn' : 'item'} (${total}) — give EACH a verdict in "account_for"`]
  // prompt 0.61: the verdict is ONE ENTRY in the reply's top-level account_for list, not a to-do
  // object — cheap to give, and the reply is invalid without one per line (analyze.classify).
  out.push(isWork ? ACCOUNT_FOR_INSTRUCTION.work : ACCOUNT_FOR_INSTRUCTION.mail)
  if (rows.born.length) out.push(`### Raised on this ${isWork ? 'session' : 'thread'} (${rows.born.length})`, ...rows.born)
  if (rows.linked.length) out.push(`### In the linked project(s), involving someone on this ${isWork ? 'turn' : 'message'} (${rows.linked.length}) — does it finish, advance or overtake any of these?`, ...rows.linked)
  if (rows.owed.length) out.push(`### Owed BY the sender/author(s), elsewhere — did this message deliver or advance any? (${rows.owed.length})`, ...rows.owed)
  if (rows.mine.length) out.push(`### Owed by ME to the recipient(s) — is this message the delivery? (${rows.mine.length})`, ...rows.mine)
  return { text: out.join('\n'), ids: [...seen] }
}

const ITEM_RENDERERS = {
  mail: { renderNew: renderNewMessage, renderPrior: renderPriorInFull },
  notes: { renderNew: renderNote, renderPrior: renderNote },
  messages: { renderNew: renderChatChunk, renderPrior: renderChatChunk },
  work: {
    renderNew: (m, r, c, a) => renderWorkTurn(m, r, c, a, { prior: false }),
    renderPrior: (m, r, c, a) => renderWorkTurn(m, r, c, a, { prior: true })
  }
}
const rendererFor = (m) => ITEM_RENDERERS[(m && m.channel) || 'mail'] || ITEM_RENDERERS.mail

// store: createProjectStore(); thread: { thread_id }; priorMsgs/newMsg: normalized;
// profiles: createProfileStore(); extraDetail: array of strings (resolved request_more);
// userStyle: a short guide distilled from the user's sent mail (for drafting suggested replies);
// userInstructions: [text] user-authored custom instructions matching this sender (Concept A);
// workflowInstructions: [text] the "if X emit action Y" lines from the auto-process action
// registry in workflows.js (Concept B).
// contextChars: the INPUT budget for this request (prefs.analysis_context_chars — see
// DEFAULT_CONTEXT_CHARS / CONTEXT_CHOICES). The reduction ladder is applied until the request fits.
// THE STABLE (DURABLE) TURN (§4): everything that changes on a user-edit timescale, rendered once
// per snapshot period and sent as its own (provider-cached) user message:
//   1. the user's situation (business_context — written by bootstrap, edited by the user),
//   2. the whole active catalog (rows staleness-tiered §5.2, sorted by project_id), and
//   3. the auto-process action instructions (static registry text from workflows.js).
// Identical state must always produce IDENTICAL BYTES — a prefix cache only hits on an exact
// match. Volatile per-message data (people, linked projects, the thread) stays OUT of here.
//
// TWO BLOCKS, each its own cached turn (2026-09-13). A prefix cache re-writes everything after the
// first changed byte, so the parts that change least go FIRST:
//   COLD — the user's situation, the standing instructions that apply to ALL mail, the third-party
//          app instructions, the writing-style guide, and the rows of every project that is not in
//          the hot set. Re-rendered weekly, or when any of those change (the pin's durable_sig).
//          Its membership is FROZEN between renders (coldIds).
//   HOT  — the rows of the projects `selection.hotProjectIds` picks: the most active right now, the
//          most active this week, and the starred ones. Re-rendered on the message thresholds, so
//          this is the block whose SIZE is worth minimising — see the note in selection.js.
// A hot project touched later gets its current row in the volatile "Updates" section as before; a
// COLD project touched later does too, until the next cold render moves it.
// Returns { cold: { text, ids, chars, count } | null, hot: { text, ids, chars, count },
//           text (both, informational), ids, chars, count (totals) }. With `coldIds` the cold block
// is NOT re-rendered (cold: null) and hot = every active project not in that set.
export function renderCatalogSnapshot (store, { asof, stalenessPolicy, summaryChars = 400, businessContext, workflowInstructions, allMailInstructions, userStyle, profiles = null, meSet = null, tuning = null, coldIds = null } = {}) {
  const policy = stalenessPolicy || DEFAULT_STALENESS_POLICY
  const clock = Number(asof) || Date.now()
  const rows = store.catalog([])
    .slice()
    .sort((a, b) => (a.project_id < b.project_id ? -1 : a.project_id > b.project_id ? 1 : 0))
  const tier = (c) => stalenessTierOf({ last_active_asof: c.last_active_asof }, clock, policy)
  const frozen = coldIds ? new Set(coldIds) : null
  // Membership comes from selection.js, the ONE place every cached-block formula lives.
  const hotSet = frozen ? null : hotProjectIds(store.all ? store.all() : [], { asof: clock })
  const mine = meSet instanceof Set ? meSet : new Set(meSet || [])
  // …and WHICH profiles ride along. Sorted by address so identical state gives identical bytes.
  const coldPeopleAddrs = frozen ? new Set() : coldProfileAddresses(profiles && profiles.all ? profiles.all() : [], { asof: clock })
  const coldPeople = frozen
    ? []
    : (profiles && profiles.all ? profiles.all() : [])
        .filter(pp => pp && pp.address && coldPeopleAddrs.has(String(pp.address).toLowerCase()) && !mine.has(String(pp.address).toLowerCase()))
        .sort((a, b) => (String(a.address) < String(b.address) ? -1 : 1))
  // renderPersonLine needs a roster to answer roleOf(); this block is people-only, and the user is
  // already filtered out above, so a roster seeded from exactly these addresses is enough
  const coldRoster = seedRoster(coldPeople.map(pp => pp.address), mine)
  const isCold = (c) => frozen ? frozen.has(c.project_id) : !hotSet.has(c.project_id)
  const rowText = (c) => tier(c) === 'dormant' ? catalogNameRow(c) : catalogRow(c, summaryChars)
  const coldRows = rows.filter(isCold)
  const hotRows = rows.filter(c => !isCold(c))
  const asBlock = (list, text) => ({ text, ids: list.map(c => c.project_id), chars: text.length, count: list.length })

  let cold = null
  if (!frozen) {
    const blocks = []
    if (businessContext) {
      blocks.push('## The user’s situation (durable background — treat as established fact)\n' +
        String(businessContext).trim())
    }
    // Both instruction kinds are ONE thing to the model — extra instructions that outrank its
    // defaults — so they are announced together and only then split by who wrote them.
    const always = (allMailInstructions || []).filter(r => r && r.text)
    if (always.length || (workflowInstructions && workflowInstructions.length)) {
      const bits = [INSTRUCTIONS_HEADING]
      if (always.length) {
        bits.push('### Standing instructions from the user (these apply to EVERY message)',
          always.map(instructionLine).join('\n'))
      }
      if (workflowInstructions && workflowInstructions.length) {
        bits.push('### Third-party app instructions — when a condition below holds (or a standing instruction asks for a LISTED action), ALSO add the described entry to a top-level "triggers" array. This is in ADDITION to your normal analysis; it never replaces it.',
          workflowInstructions.map((t, i) => (i + 1) + '. ' + String(t).trim()).join('\n'))
      }
      blocks.push(bits.join('\n'))
    }
    // The style guide shapes suggested replies only, but it is stable text: cached here it costs a
    // tenth of what re-sending it on every message did.
    if (userStyle) {
      blocks.push('## The user’s writing style (match this in any suggested reply)\n' + String(userStyle).trim())
    }
    // The user's regular correspondents, in full, whether or not they are on today's thread — so a
    // name MENTIONED in a body is a person the model knows rather than a stranger. The volatile
    // block still carries everyone else, and re-sends anyone here whose profile has since changed.
    if (coldPeople.length) {
      const whoHandles = renderWhoHandlesWhat(WHO_HANDLES_COLD_HEAD, coldPeople.map(pp => ({ p: pp, detail: 'full' })))
      if (whoHandles) blocks.push(whoHandles)
      blocks.push('## The people the user deals with regularly (' + coldPeople.length + ' most frequent correspondents — reference, whether or not they are on the thread below)\n' +
        coldPeople.map(pp => renderPersonLine(pp, coldRoster, tuning, 'full', { handles: false })).join('\n'))
    }
    blocks.push('## Project catalog — part 1 of 2: projects with no recent activity (snapshot)\n' +
      'Every active project the user has is listed in part 1 or part 2 (part 2 follows in a later user message). ' +
      'Use the catalog to spot that a to-do belongs to an EXISTING project (pull it with request_more) rather than ' +
      'starting a duplicate. A later "Updates since the catalog snapshot" section, when present, overrides rows here.\n' +
      (coldRows.length ? coldRows.map(rowText).join('\n') : '(none — every active project is in part 2)'))
    cold = asBlock(coldRows, blocks.join('\n\n'))
    cold.people = coldPeople.map(pp => String(pp.address).toLowerCase())
  }
  const hot = asBlock(hotRows,
    '## Project catalog — part 2 of 2: the projects most active right now (snapshot)\n' +
    'Together with part 1 this is every active project. A later "Updates since the catalog snapshot" section, ' +
    'when present, overrides rows here.\n' +
    (hotRows.length ? hotRows.map(rowText).join('\n') : '(none — no project has been active recently)'))
  const text = [cold && cold.text, hot.text].filter(Boolean).join('\n\n')
  return { cold, hot, text, ids: rows.map(c => c.project_id), chars: (cold ? cold.chars : 0) + hot.chars, count: rows.length }
}

// BATCH-CAPABLE. `entries` is [{ newMsg, priorMsgs, threadId }] oldest-first; the single-message
// call (thread/priorMsgs/newMsg) is the one-entry case and behaves exactly as before.
// snapshot: { text, ids } — a pre-rendered catalog block living in an EARLIER (cached) user
// message; when present the catalog is NOT re-rendered here, and `updateIds` name the projects
// whose CURRENT rows go into the volatile "Updates since the catalog snapshot" section (§4).
export function assemble ({ store, thread, priorMsgs, newMsg, entries, profiles, meSet, asof, noDrafts, extraDetail, businessContext, userStyle, userInstructions, allMailInstructions, workflowInstructions, tuning, contextChars, stalenessPolicy, snapshot, updateIds, cachedProfiles, changedProfiles }) {
  const items = (entries && entries.length)
    ? entries
    : [{ newMsg, priorMsgs: priorMsgs || [], threadId: (thread && thread.thread_id) || null }]
  const isBatch = items.length > 1
  const lastItem = items[items.length - 1]
  // the batch's clock is its LAST (newest) message; single-message calls keep the caller's asof
  const clockAsof = asof != null ? asof : lastItem.newMsg.date

  const everyone = participantsOf(items.flatMap(it => [...(it.priorMsgs || []), it.newMsg]))
  const roster = seedRoster(everyone, meSet)
  const profileArr = profiles.forAddresses(everyone)
  // union of the projects linked to EVERY thread in the batch (deduped, stable order)
  const linkedMap = new Map()
  for (const it of items) {
    for (const p of store.linkedProjectsFor(it.threadId)) linkedMap.set(p.project_id, p)
  }
  // DIAGNOSTIC ONLY (was briefly an auto-link — reverted): projects citing this thread's
  // messages as evidence, without a direct link. Auto-linking them rendered their FULL to-do
  // lists into every request on the thread, which fed the echo/cost spiral (see reconcile's
  // NO-OP DETECTION). The model finds cross-project candidates through the catalog +
  // request_more instead; a genuine link forms via reconcile the moment it changes something.
  if (store.projectsCitingMessages) {
    const evidenceIds = items.flatMap(it => [...(it.priorMsgs || []).map(m => m.msg_id), it.newMsg.msg_id])
    const viaEvidence = store.projectsCitingMessages(evidenceIds).filter(p => !linkedMap.has(p.project_id))
    if (viaEvidence.length) {
      console.info('[superlazy] FYI: ' + viaEvidence.length + ' unlinked project(s) cite this thread’s messages as evidence (' +
        viaEvidence.map(p => p.project_id + ' "' + p.name + '"').join(', ') + ') — not auto-linked; the catalog covers them.')
    }
  }
  const linked = [...linkedMap.values()]
  const catalog = store.catalog(linked.map(p => p.project_id))
  // The budget is PER MESSAGE ("context sent per email" in Preferences), so a batch of n gets n
  // times it. The ladder's caps are per message too: against one shared budget a 10-message batch
  // sat at the ladder's floor and was STILL 49% over (2026-09-13: 104k chars against 70k, every
  // batch of long agent turns quietly overBudget) — the ladder could never reach it.
  const perMessage = Number(contextChars) > 0 ? Number(contextChars) : DEFAULT_CONTEXT_CHARS
  const budget = perMessage * Math.max(1, items.length)
  // staleness tiering (§5). A project linked to a thread being analysed never goes below BRIEF —
  // advancing an existing item must not require a fetch round.
  const policy = stalenessPolicy || DEFAULT_STALENESS_POLICY
  const tierOf = (p) => {
    const t = stalenessTierOf(p, clockAsof, policy)
    return t === 'dormant' ? 'brief' : t
  }
  const briefProjectIds = linked.filter(p => tierOf(p) === 'brief').map(p => p.project_id)
  const staleCatalogIds = new Set(
    catalog.filter(c => stalenessTierOf({ last_active_asof: c.last_active_asof }, clockAsof, policy) === 'dormant')
      .map(c => c.project_id)
  )
  // the senders of the analysed message(s) keep full profiles at every reduction level: their
  // relationship and history are what the analysis is being judged against
  const keepFullProfiles = items.map(it => (it.newMsg.from && it.newMsg.from.address) || '').filter(Boolean)
  // Direct recipients and the first few cc's, at the detail selection.RECIPIENT_PROFILES sets —
  // `to` is who is being asked to act, and a cc is often the person who says WHICH effort this
  // belongs to. The rest of a long cc list stays a names-only line: see the measured note on that
  // rule for why the cap is where it is. Anyone left out can still be pulled with
  // request_more: person_detail.
  const addrsOf = (list) => (list || []).map(x => (x && x.address) || '').filter(Boolean)
  const toAddrs = items.flatMap(it => addrsOf(it.newMsg.to))
  const ccAddrs = items.flatMap(it => addrsOf(it.newMsg.cc).slice(0, Math.max(0, RECIPIENT_PROFILES.ccCount)))
  const tierOfAddr = new Map()
  for (const a of ccAddrs) if (!tierOfAddr.has(a)) tierOfAddr.set(a, RECIPIENT_PROFILES.ccDetail)
  for (const a of toAddrs) tierOfAddr.set(a, RECIPIENT_PROFILES.toDetail) // `to` outranks a cc
  const keepFullProfiles2 = [...tierOfAddr].filter(([, d]) => d === 'full').map(([a]) => a)
  const briefProfiles = [...tierOfAddr].filter(([, d]) => d === 'brief').map(([a]) => a)
  // ONE alias map per request: short handles for the giant provider message ids, translated back
  // by engine.js before anything is stored. Assigned in render order, so it is deterministic.
  const alias = createAliasMap()
  // the NEW message(s) claim the first handles, so they read as m1(+m2…) rather than mid-thread
  for (const it of items) alias.aliasFor(it.newMsg.msg_id)

  // Messages are processed up to an hour after arrival (and history builds run over older mail),
  // so the analysis clock is always the MESSAGE's own date — one wording for every caller.
  const nowLine = `Treat the current moment as ${fmtDate(clockAsof)} (${clockAsof}) — when this message arrived. Ignore anything dated after it.`

  // per-entry reply context: the message each new message replies to (inlined in full), plus the
  // thread's latest prior message when the reply targets an older one (a fork)
  const ctxOf = (it) => {
    const parent = it.newMsg.in_reply_to ? (it.priorMsgs || []).find(m => m.msg_id === it.newMsg.in_reply_to) : null
    const latest = (it.priorMsgs || []).length ? it.priorMsgs[it.priorMsgs.length - 1] : null
    return { parent, forkLatest: (parent && latest && latest.msg_id !== parent.msg_id) ? latest : null }
  }
  const singleCtx = ctxOf(items[0])
  const parent = singleCtx.parent
  const forkLatest = singleCtx.forkLatest

  // Build the whole request at one reduction LEVEL, measuring each section on the way so the caller
  // can see what is actually big instead of guessing.
  function build (lv) {
    const accountFor = {} // handle -> ids listed in that message's account-for block
    const sections = {}
    const sect = (key, text) => { sections[key] = String(text || '').length; return text }

    const parts = [
      nowLine,
      'Message handles: emails are identified below by SHORT handles (m1, m2, …), not by their long ' +
      'provider ids. Use those handles when you cite evidence (evidence_msg_id) or ask for a body ' +
      'with request_more — they are the only ids you should ever emit for a message.',
      isBatch
        ? `You are given ${items.length} newly-arrived messages (oldest first) across ${new Set(items.map(i => i.threadId)).size} thread(s). Return one entry per message in "message_results" (see the batch rules).`
        : `It is on thread ${items[0].threadId}.`,
      ''
    ]
    // WHO THIS USER IS — written once by the one-pass setup (jobs/bootstrap) and edited by the user.
    // The user's situation, the ALL-mail standing instructions, the third-party app instructions and
    // the writing-style guide all ride in the CACHED cold block (renderCatalogSnapshot) — they are
    // stable text and re-sending them here would pay full price for the same bytes every message.
    // What is left for this block is only what genuinely varies by MESSAGE: the standing
    // instructions scoped to this sender, their domain, or the account it arrived on.
    if (userInstructions && userInstructions.length) {
      parts.push(
        INSTRUCTIONS_HEADING + ' (these are scoped to THIS sender / domain / account; the ones that apply to all mail are in the earlier cached message)',
        sect('instructions', userInstructions.map(instructionLine).join('\n')),
        ''
      )
    }
    // When the catalog rides in a cached earlier message (§4), the volatile block carries only the
    // CURRENT rows of projects touched since that snapshot — they override the snapshot's rows.
    if (snapshot && snapshot.text) {
      const ids = new Set(updateIds || [])
      const rows = catalog.filter(c => ids.has(c.project_id))
        .map(c => staleCatalogIds.has(c.project_id) ? catalogNameRow(c) : catalogRow(c, lv.catalogSummary))
      const gone = [...ids].filter(id => !catalog.some(c => c.project_id === id) && !linked.some(p => p.project_id === id))
      parts.push(
        '## Updates since the catalog snapshot (these rows OVERRIDE the snapshot’s row for the same project_id)',
        sect('updates', rows.length || gone.length
          ? [...rows, ...gone.map(id => `- [${id}] — no longer active (archived or merged); do not use it`)].join('\n')
          : '(nothing has changed since the snapshot)'),
        ''
      )
    }

    const handled = []
    const peopleText = renderPeople(profileArr, roster, tuning, {
      detail: lv.people, keepFull: [...keepFullProfiles, ...keepFullProfiles2], brief: briefProfiles,
      cached: cachedProfiles || [], changed: changedProfiles || [], collect: handled
    })
    const whoHandles = renderWhoHandlesWhat(WHO_HANDLES_VOL_HEAD, handled)
    if (whoHandles) parts.push(sect('who_handles', whoHandles), '')
    parts.push(
      '## People on the thread(s) below (the user’s own address is tagged [ME]; everyone else has NO preset role — decide each person’s team/external role per project below)',
      sect('people', peopleText),
      '',
      "## Project(s) linked to these thread(s) — edit these to-do lists IN PLACE (keep todo_ids; new items: new:true + tmp_id). RETURN A PROJECT ONLY IF THIS MESSAGE CHANGES SOMETHING IN IT — and within it, only the new or changed to-dos. Omission always PRESERVES: an unchanged project or to-do must NOT be re-emitted (echoing it back wastes tokens and corrupts activity tracking). Set each participant’s role (me|team|external) + role_note here — include ONLY participants whose role or note is new or changed; omitted ones are preserved, never removed. Projects marked [BRIEF] or [DORMANT] have been quiet — see the tier rules.",
      sect('linked', renderLinkedProjects(linked, {
        openDetail: lv.openDetail, openFull: lv.openFull, closed: lv.closed, tierOf, alias, roster
      }))
    )

    // Channel marker (specs/superlazy-inputs.md): the system prompt treats every item as EMAIL
    // unless the request says otherwise — so a mail-only request emits NOTHING here (byte-stability
    // for the cached prefix) and a mixed request names what it carries.
    if (items.some(it => (it.newMsg.channel || 'mail') !== 'mail')) {
      const counts = {}
      for (const it of items) { const c = it.newMsg.channel || 'mail'; counts[c] = (counts[c] || 0) + 1 }
      parts.push('', '## Channels in this request: ' + Object.entries(counts).map(([c, n]) => n + ' ' + c).join(', ') +
        ' — items not marked otherwise are email; read a non-email item per its channel guide.')
    }

    // one thread-context group per entry (index + inlined parent/fork), then the message itself
    let msgChars = 0
    let idxChars = 0
    items.forEach((it, i) => {
      const { parent: par, forkLatest: fork } = ctxOf(it)
      const head = isBatch ? `### New message ${i + 1} of ${items.length} (${alias.aliasFor(it.newMsg.msg_id)})` : `## The new message (${alias.aliasFor(it.newMsg.msg_id)})`
      parts.push('', isBatch ? `## Thread ${it.threadId} — prior messages (index only — request a body with request_more if you need it)` : '## Prior messages in this thread (index only — request a body with request_more if you need it)')
      const idx = renderIndex(it.priorMsgs || [], roster, { max: lv.indexMax, snippetChars: lv.indexSnippet, alias })
      idxChars += idx.length
      parts.push(idx)
      if (par) {
        const t = rendererFor(par).renderPrior(par, roster, lv.prior, alias)
        parts.push('', '## The message being replied to (full)', t)
        idxChars += t.length
      }
      if (fork) {
        const t = rendererFor(fork).renderPrior(fork, roster, lv.prior, alias)
        parts.push('', '## The latest message on the thread (full — the new message replies to an OLDER message; the thread has FORKED)', t)
        idxChars += t.length
      }
      const priorTexts = (it.priorMsgs || []).map(pm => pm && (pm.full_text || pm.clean_text)).filter(Boolean)
      const rendered = rendererFor(it.newMsg).renderNew(it.newMsg, roster, lv.newBody, alias, { priorTexts })
      msgChars += rendered.length
      parts.push('', head, rendered)
      // the open to-dos this item bears on, each demanding a verdict (every channel; see the
      // function's comment) — the accountant's block that stops items outliving their conversations
      {
        const block = renderOpenItemsToAccountFor(store, it.newMsg, roster, alias, ACCOUNT_FOR_SCOPE, { linkedIds: linked.map(p => p.project_id) })
        if (block) { msgChars += block.text.length; parts.push('', block.text); accountFor[alias.aliasFor(it.newMsg.msg_id)] = block.ids }
      }
    })
    sections.index = idxChars
    sections.newMessage = msgChars


    if (noDrafts) {
      parts.push('', 'NOTE: do NOT create or update suggested responses for this message — omit all "responses" arrays entirely. Analyse to-dos, projects and profiles normally. (Suggested replies are off for this message: it is either an older message processed to build history, or the user has turned reply drafting off.)')
    }

    // THE LAST THING THE MODEL READS. Standing instructions and third-party app requests live in
    // the weekly CACHED block, ~100k characters back — and measured on 8 real subscription emails
    // (experiment 9), haiku acted on them for only 2. The instructions stay cached (so tens of them
    // cost nothing per message); this reminder rides here instead, naming them and saying plainly
    // that they are obligations. Same 8 emails: 2/8 -> 8/8 reaching the right app, no false
    // flags. Placement beat moving the text itself, and cost ~600 chars a message to do it.
    const reminder = instructionReminder(allMailInstructions, workflowInstructions, activeSubscriptions())
    if (reminder) parts.push('', sect('reminder', reminder))

    parts.push('', isBatch
      ? `Analyse what EACH of the ${items.length} messages above changed, in order, as of each message's own date. Assign every to-do to a project. Output JSON only — { "message_results": [ … one entry per message, in order … ] }, or a request_more.`
      : `Analyse what THIS message changed, as of ${fmtDate(clockAsof)}. Assign every to-do to a project. Output JSON only — the analysis shape, or a request_more.`)
    return { userMessage: parts.join('\n'), sections, accountFor }
  }

  // Walk DOWN the ladder until the request fits the budget. Reducing every section together is what
  // makes the budget real: the previous version only shrank the new message's body, so a 409-char
  // email whose 114,783 characters came from a linked project's to-do list could not be trimmed at
  // all — it just re-rendered the same request and reported "over the request budget".
  let out = build(LEVELS[0])
  let level = 0
  while (out.userMessage.length > budget && level < LEVELS.length - 1) {
    level++
    out = build(LEVELS[level])
  }

  return {
    userMessage: out.userMessage,
    // the VOLATILE block is what `userMessage` now is; the STABLE block (the catalog snapshot)
    // is rendered by the caller once per snapshot period and sent as an earlier, cached message
    volatileBlock: out.userMessage,
    // handle -> the todo_ids its "Open items to account for" block listed: the reply must carry a
    // verdict for each (analyze.classify checks; reconcile applies) — prompt 0.61
    accountFor: out.accountFor || {},
    // alias -> real provider id. engine.js translates the model's reply through this BEFORE
    // reconcile, so nothing persisted ever contains a handle.
    aliasToReal: alias.toReal,
    realToAlias: alias.toAlias,
    briefProjectIds,          // reconcile merges status-level edits for these (§5.1)
    linkedProjectIds: linked.map(p => p.project_id),
    // the handles the model must key its batch entries by (it never sees the real ids)
    msgIds: items.map(it => alias.aliasFor(it.newMsg.msg_id)),
    realMsgIds: items.map(it => it.newMsg.msg_id),
    roster,
    // diagnostics for the caller's log: total size, which reduction level was needed, and the
    // per-section char counts — this is what identifies the section responsible for a huge request
    size: {
      chars: out.userMessage.length,
      level,
      maxLevel: LEVELS.length - 1,
      budget,
      overBudget: out.userMessage.length > budget,
      // biggest single body in the batch (the one most likely to have been capped)
      bodyChars: Math.max(...items.map(it => String(it.newMsg.clean_text || '').length)),
      bodyCappedTo: items.some(it => String(it.newMsg.clean_text || '').length > LEVELS[level].newBody) ? LEVELS[level].newBody : null,
      messages: items.length,
      sections: out.sections
    }
  }
}
