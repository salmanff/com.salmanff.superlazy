// jobs/analyze_thread/maintenance/cleanupPrompt.js — the WEEKLY CLEAN-UP prompt (specs/superlazy-weekly-cleanup.md
// §2) + the builders for everything the model reads: the CURRENT STATE block, the INPUT INDEX
// (one line per analysed item, all channels) and the small uncached CLOSING turn.
//
// ONE call covers every section (attention, stale, archive, merge, split, people, rules, learn,
// questions): the user judged that the rules and learning sections need the project context too
// (2026-09-24), so nothing is split into a second call. Every suggestion comes back as a PROPOSAL
// carrying OPERATIONS (ops.js) — the structured language the app renders and applies.
//
// CONSISTENCY CONTRACT: the "What a project is" paragraph is copied VERBATIM from
// jobs/analyze_thread/prompt.js (same contract as bootstrapPrompt.js) — any edit to that
// definition happens in every copy in the same commit.
//
// The system prompt is a constant with ZERO interpolation, and the state+input turn is rendered
// deterministically (sorted, capped) so a re-run within the cache window re-reads it at ~10%.

import { catalogRow, renderPersonLine } from '../assemble.js'
import { overlappingResponsibilities } from '../responsibilities.js'
import { fileToProject } from '../autoProcess.js'

export const CLEANUP_PROMPT_VERSION = '0.9'   // 0.9 (2026-10-10): the add_instruction examples are generic (supplier invoices, not fund notices) — pre-publish
// previous: '0.8'   // 0.8 (2026-10-10): the EVIDENCE example names "The law firm", not a real firm (pre-publish)
// previous: '0.7'   // 0.7 (2026-09-27, user): WORDS not ids in everything the user reads — a question named projects only as 'p_41, p_3p, p_16'
// previous: '0.6'   // 0.6: responsibilities are a LIST; overlap candidates + the people-section job that reads them
const OVERLAP_CAP = 12

// rail / group order — the same order the prompt asks the model to emit in
export const GROUPS = ['period', 'focus', 'attention', 'stale', 'archive', 'merge', 'split', 'people', 'rules', 'learn', 'questions']
// the order the model emits in: VERDICTS FIRST (0.5, 2026-09-25 — at 0.4 stale came fourth, after
// attention, focus and the period summary, and a sonnet run wrote seven attention cards and never
// reached the eight contract items the opus 0.3 runs had closed; attention also read those
// overtaken items as "overdue", which the stale-first order lets it avoid), then attention, then
// the narrative sections, which are cheap to regenerate
export const EMIT_ORDER = ['stale', 'attention', 'focus', 'period', 'archive', 'merge', 'split', 'people', 'rules', 'learn', 'question']

export const CLEANUP_SYSTEM_PROMPT = `You are the WEEKLY CLEAN-UP reviewer for superlazy, a dashboard of TO-DOS — what the user owes others, what others owe the user, and what the user's team must handle. A cheaper analyst files each incoming item one at a time, through a keyhole. You have the wide view: the app's whole current state, the user's own recent corrections, and the recent window of what came in. Your job is to help the user get their map in order for the coming week, and to put in front of them the things that need their attention. You propose; the user decides; nothing you write is applied without a click.

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
"evidence" holds item surrogate ids (m0042) or, for learn and rules, the hand-edit ids given in CURRENT STATE (e0012). The final line is ALWAYS the done line.`

// ---- rendering helpers -----------------------------------------------------------------------------
const CATALOG_CAP = 300
const OPEN_PER_PROJECT = 40
const CLOSED_PER_PROJECT = 8
const PROFILE_CAP = 200
export const day = (ms) => { try { return new Date(Number(ms)).toISOString().slice(0, 10) } catch (e) { return '' } }
export const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
const openish = (t) => t && (t.status === 'open' || t.status === 'in_progress')
const whoText = (t) => {
  const w = Array.isArray(t.who) && t.who.length ? t.who : [t.owner, t.counterparty, ...(t.owners || [])].filter(Boolean)
  return w.length ? w.join(', ') : '—'
}
const lastTouch = (t) => Math.max(Number(t.created_asof) || 0, Number(t.resolved_asof) || 0, ...(t.evidence || []).map(e => Number(e && e.asof) || 0))

// The ids of the standing auto-file buckets: every project some profile's file_to_project points at.
export function bucketIdsOf (profiles) {
  const ids = new Set()
  for (const p of (profiles && profiles.all ? profiles.all() : (profiles || []))) {
    const f = fileToProject(p.profile || {})
    const pid = f && f.details && f.details.project_id
    if (pid) ids.add(pid)
  }
  return ids
}

// withTrail: append the NEWEST evidence-trail note (date + the analyst's one-line summary of the
// message that last moved the item) — the same "status notes" the per-item analyst reads, three
// deep, on every request. Sent only for projects the window touched (2026-09-26: the OVERTAKEN
// check judges "was this step finished by what happened?", which needs where the step last stood).
function todoLine (t, { closed = false, withTrail = false } = {}) {
  const base = '    · ' + t.todo_id + ' [' + (closed ? (t.status || 'closed') + ' ' + day(t.resolved_asof || lastTouch(t)) + ' · ' : '') +
    (t.direction || '') + ' · who: ' + whoText(t) + ' · imp ' + (t.importance || 3) + (t.importance_locked ? ' USER-SET' : '') +
    (t.due_hint ? ' · due: ' + clip(t.due_hint, 40) : '') + '] ' + clip(t.short_description || t.description, 120)
  if (!withTrail) return base
  const ev = (t.evidence || []).filter(e => e && e.summary).slice(-1)[0]
  return ev ? base + '\n        last: ' + day(ev.asof) + ' · ' + clip(ev.summary, 160) : base
}

/**
 * The CURRENT STATE block (spec §2.2 blocks 1–10). Deterministic given identical inputs.
 * @param {Object} o
 * @param {Object} o.settings
 * @param {Object} o.store          hydrated project store
 * @param {Object} o.profiles       hydrated profile store
 * @param {Array}  o.instructions   instruction records (all statuses)
 * @param {Array}  o.rulesUsage     rulesInput.instructionUsage rows
 * @param {Array}  o.overlaps       rulesInput.scopeOverlaps rows
 * @param {Array}  o.handEdits      rulesInput.gradeHandEdits rows (each with id eNNNN)
 * @param {Array}  o.staleRows      deterministic.previewForgottenItems rows
 * @param {Array}  o.dormantRows    deterministic.previewDormantProjects rows
 * @param {Array}  o.earlierDecisions  [{ kind:'ignored'|'seen', text, asof }]
 * @param {Set}    [o.meSet]
 */
export function buildStateBlock ({ settings = {}, store, profiles, instructions = [], rulesUsage = [], overlaps = [], handEdits = [], staleRows = [], dormantRows = [], earlierDecisions = [], meSet = null, periodCounts = null, dueRows = [], focusDays = 7, touchedProjectIds = null }) {
  const touched = touchedProjectIds instanceof Set ? touchedProjectIds : new Set(touchedProjectIds || [])
  const parts = []
  const buckets = bucketIdsOf(profiles)
  parts.push('# CURRENT STATE — as the app holds it now')
  parts.push('Ids are REAL: project_id p_xx, todo_id t_xx, instruction i_xx, hand edit e_xxxx, people by address. Cite them exactly as written.')
  parts.push('')

  parts.push('## The user\'s situation (their own words — established fact)')
  parts.push((settings.business_context && settings.business_context.trim()) || '(none yet)')
  parts.push('')

  parts.push('## Standing instructions (' + instructions.filter(i => i.status === 'active').length + ' active) — with usage over the edits window')
  if (!rulesUsage.length) parts.push('(none)')
  for (const r of rulesUsage) {
    parts.push('- [' + r.instruction_id + '] ' + r.status + ' · scope ' + r.scope + (r.match ? ' ' + r.match : '') + ' · since ' + (day(r.created_asof) || '?') +
      (r.author && r.author !== 'user' ? ' · by ' + r.author : '') +
      ' · offered ' + r.offered + ' · cited ' + r.cited + ' · overridden after ' + r.overridden + (r.last_offered ? ' · last offered ' + day(r.last_offered) : '') +
      (r.recently_edited ? ' · [USER-EDITED recently]' : ''))
    parts.push('    "' + clip(r.text, 300) + '"')
  }
  if (overlaps.length) {
    parts.push('Scope overlaps (one rule\'s matches are inside another\'s):')
    for (const o of overlaps) parts.push('- [' + o.inner + '] (' + o.inner_scope + ') is inside [' + o.outer + '] (' + o.outer_scope + ')')
  }
  parts.push('')

  const projects = store.all()
    .filter(p => p.status === 'active' && !p.merged_into)
    .sort((a, b) => (Number(b.last_active_asof) || 0) - (Number(a.last_active_asof) || 0) || (a.project_id < b.project_id ? -1 : 1))
  const rows = new Map(store.catalog([]).map(c => [c.project_id, c]))
  parts.push('## Project catalog (' + projects.length + ' active) — each row, then its OPEN to-dos (with the last note on each, for projects that moved in the window), then its most recently CLOSED ones')
  for (const p of projects.slice(0, CATALOG_CAP)) {
    const c = rows.get(p.project_id)
    const isBucket = buckets.has(p.project_id)
    const opens = (p.todos || []).filter(openish)
    const closed = (p.todos || []).filter(t => !openish(t)).sort((a, b) => lastTouch(b) - lastTouch(a))
    let head = c ? catalogRow(c, isBucket ? 120 : 400) : ('- [' + p.project_id + '] "' + (p.name || '') + '"')
    if (isBucket) head = head.replace(/^- \[/, '- [BUCKET] [')
    if (p.importance_locked) head = head.replace(' — imp ', ' — imp [USER-SET] ')
    if (p.starred) head += ' · ★ starred'
    parts.push(head)
    if (isBucket) { parts.push('    (' + opens.length + ' open · ' + closed.length + ' closed — a filing bin, items not listed)'); continue }
    const withTrail = touched.has(p.project_id)
    for (const t of opens.slice(0, OPEN_PER_PROJECT)) parts.push(todoLine(t, { withTrail }))
    if (opens.length > OPEN_PER_PROJECT) parts.push('    · … and ' + (opens.length - OPEN_PER_PROJECT) + ' more open')
    for (const t of closed.slice(0, CLOSED_PER_PROJECT)) parts.push(todoLine(t, { closed: true }))
    if (closed.length > CLOSED_PER_PROJECT) parts.push('    · … and ' + (closed.length - CLOSED_PER_PROJECT) + ' more closed (ask for project_detail to see them)')
  }
  if (projects.length > CATALOG_CAP) parts.push('… and ' + (projects.length - CATALOG_CAP) + ' more projects (not listed)')
  parts.push('')

  const roster = { meSet: meSet || new Set() }
  const people = profiles.all()
    .filter(p => p.profile && (p.profile.solidified_asof || (Number(p.profile.llm_importance) || 0) >= 3 || p.manual_rank != null))
    .sort((a, b) => (Number(b.interaction_data && b.interaction_data.last_seen_asof) || 0) - (Number(a.interaction_data && a.interaction_data.last_seen_asof) || 0) || (a.address < b.address ? -1 : 1))
  parts.push('## People (' + people.length + ' shown — real addresses)')
  for (const p of people.slice(0, PROFILE_CAP)) {
    const pr = p.profile || {}
    let line
    try { line = renderPersonLine(p, roster, null, 'brief') } catch (e) { line = '- ' + p.address }
    line += ' ' + (pr.solidified_asof ? '[SOLID]' : '[provisional]') + (pr.user_edited ? ' [USER-EDITED]' : '')
    parts.push(line)
  }
  if (people.length > PROFILE_CAP) parts.push('… and ' + (people.length - PROFILE_CAP) + ' more (not listed)')
  // Responsibility OVERLAPS — where two or more people's profiles claim the same kind of work.
  // Found by shared word-pairs, deliberately dumb: these are CANDIDATES for the model to judge, not
  // findings. They exist because ambiguity here is expensive — with four people's profiles each
  // claiming the same recurring work, 57 such to-dos were split across five owners.
  const respOverlaps = overlappingResponsibilities(people).slice(0, OVERLAP_CAP)
  if (respOverlaps.length) {
    parts.push('')
    parts.push('## Responsibilities claimed by more than one person (candidates — judge them, they are only word matches)')
    for (const o of respOverlaps) {
      parts.push('- “' + o.term + '” — ' + o.people.map(x => x.address + ' (' + x.id + ': ' + String(x.text).slice(0, 90) + ')').join(' · '))
    }
  }
  parts.push('')

  parts.push('## Period counts — what the app recorded over the input window')
  if (!periodCounts) parts.push('(not computed)')
  else {
    const pc = periodCounts
    parts.push('- items analysed: ' + pc.items + (Object.keys(pc.byChannel || {}).length ? ' (' + Object.entries(pc.byChannel).map(([k, v]) => k + ' ' + v).join(', ') + ')' : '') + ' · threads: ' + pc.threads)
    parts.push('- to-dos: ' + pc.todosNew + ' created · ' + pc.todosResolved + ' resolved · ' + pc.todosCancelled + ' cancelled · ' + pc.todosUpdated + ' updated — by the analyst')
    parts.push('- projects created: ' + pc.projectsNew + ' · hand edits by the user: ' + pc.handEdits + ' · auto-filed items: ' + pc.autoFiled)
  }
  parts.push('')

  parts.push('## Due within the focus horizon (' + focusDays + ' days) — OPEN items with a due window that has started, ends inside the horizon, or has passed; overdue first')
  if (!dueRows.length) parts.push('(no dated open items inside the horizon)')
  for (const r of dueRows) {
    parts.push('- ' + r.todo_id + ' in ' + r.project_id + ' ("' + clip(r.project_name, 50) + '") [' + r.direction + ' · who: ' + r.who + ' · imp ' + r.importance + (r.importance_locked ? ' USER-SET' : '') + '] due ' + (r.due_earliest && r.due_earliest !== r.due_latest ? r.due_earliest + ' → ' : '') + (r.due_latest || r.due_earliest) + (r.overdue ? ' (OVERDUE ' + r.overdue + 'd)' : '') + (r.due_hint ? ' · "' + clip(r.due_hint, 40) + '"' : '') + ' — ' + clip(r.short, 100))
  }
  parts.push('')

  parts.push('## Gathering dust — old low-priority OPEN items (stale section)')
  if (!staleRows.length) parts.push('(none at the current thresholds)')
  for (const r of staleRows) {
    parts.push('- ' + r.todo_id + ' in ' + r.project_id + ' ("' + clip(r.project_name, 60) + '") [' + r.direction + ' imp ' + r.importance + (r.importance_locked ? ' USER-SET' : '') + '] age ' + r.age_days + 'd · quiet ' + r.quiet_days + 'd — ' + clip(r.short, 140))
  }
  parts.push('')

  parts.push('## Archive candidates — no open items, quiet for months (archive section)')
  if (!dormantRows.length) parts.push('(none at the current threshold)')
  for (const r of dormantRows) {
    parts.push('- ' + r.project_id + ' "' + clip(r.name, 60) + '" · ' + (r.todos_total != null ? r.todos_total + ' to-dos all closed · ' : '') + 'last active ' + day(r.last_active_asof) + (r.quiet_days != null ? ' (' + r.quiet_days + 'd)' : ''))
  }
  parts.push('')

  parts.push('## Your recent hand edits (' + handEdits.length + ') — graded; cite by e-id')
  if (!handEdits.length) parts.push('(none in the window)')
  for (const e of handEdits) parts.push('- ' + e.id + ' · ' + day(e.asof) + ' · ' + e.grade + ' · ' + e.text)
  parts.push('')

  parts.push('## Earlier clean-up decisions (do not raise these again without new evidence)')
  if (!earlierDecisions.length) parts.push('(none)')
  for (const d of earlierDecisions) parts.push('- ' + d.kind.toUpperCase() + ' ' + day(d.asof) + ': ' + clip(d.text, 160))
  parts.push('')
  return parts.join('\n')
}

/**
 * The INPUT INDEX — one line per analysed item in the window, ALL channels, grouped by thread,
 * newest thread first, oldest item first within a thread. Built from the app's own `events`
 * (kind message / workflow_short_circuit): no provider fetch. Surrogate ids as the dump uses.
 * @param {Array} events   analysis events in the window
 * @param {Object} o       { store, nameOf, meSet, fromMs, toMs }
 * @returns {{ text, maps, stats }}
 */
export function buildInputIndex (events, { store, nameOf = null, meSet = new Set(), fromMs, toMs } = {}) {
  const realMsgId = {}; const realThreadId = {}; const surrogateMsgId = {}; const surrogateThreadId = {}
  const msgMeta = {}
  let mSeq = 0; let tSeq = 0
  const pad = (n, w) => String(n).padStart(w, '0')
  const tag = (a) => { const s = String(a || '').toLowerCase(); if (!s) return ''; const nm = nameOf && nameOf(s); return (nm ? nm + ' <' + s + '>' : s) + (meSet.has(s) ? ' [ME]' : '') }
  const byThread = new Map()
  for (const ev of events) {
    if (!ev || !ev.msg_id) continue
    if (ev.kind !== 'message' && ev.kind !== 'workflow_short_circuit') continue
    const tid = ev.thread_id || ev.msg_id
    if (!byThread.has(tid)) byThread.set(tid, [])
    byThread.get(tid).push(ev)
  }
  const threads = [...byThread.entries()].map(([tid, evs]) => {
    evs.sort((a, b) => (Number(a.asof) || 0) - (Number(b.asof) || 0))
    return { tid, evs, last: Number(evs[evs.length - 1].asof) || 0 }
  }).sort((a, b) => b.last - a.last || (a.tid < b.tid ? -1 : 1))

  const projName = (id) => { const p = store && store.get(id); return p ? p.name : null }
  const byChannel = {}
  for (const evs of byThread.values()) for (const ev of evs) { const c = ev.channel || 'mail'; byChannel[c] = (byChannel[c] || 0) + 1 }
  const parts = []
  parts.push('# INPUT WINDOW — index of what came in ' + day(fromMs) + ' → ' + day(toMs) + ' · ' + events.length + ' items (' + Object.entries(byChannel).sort().map(([k, v]) => k + ' ' + v).join(', ') + ') · ' + threads.length + ' threads')
  parts.push('One line per analysed item, with the analyst\'s summary and what it touched. Ask with a need line for any item\'s full text or a whole thread. Ids are short surrogates — cite them exactly.')
  parts.push('')
  let items = 0
  for (const { tid, evs } of threads) {
    const tSur = 'th' + pad(++tSeq, 3)
    surrogateThreadId[tid] = tSur; realThreadId[tSur] = tid
    const projs = new Set()
    for (const ev of evs) for (const c of (ev.changes || [])) if (c.project_id) projs.add(c.project_id)
    const ch = evs[0].channel || 'mail'
    const repo = evs[0].repo_name || null
    parts.push('=== ' + tSur + ' · ' + ch + (repo ? ' · repo ' + repo : '') + ' · ' + evs.length + ' item' + (evs.length > 1 ? 's' : '') + ' · last ' + day(evs[evs.length - 1].asof) +
      ' · "' + clip(evs[0].subject || '(no subject)', 90) + '"' +
      (projs.size ? ' · projects: ' + [...projs].map(id => id + (projName(id) ? ' "' + clip(projName(id), 40) + '"' : '')).join(', ') : '') + ' ===')
    for (const ev of evs) {
      const sur = 'm' + pad(++mSeq, 4)
      surrogateMsgId[ev.msg_id] = sur; realMsgId[sur] = ev.msg_id
      msgMeta[ev.msg_id] = { msg_id: ev.msg_id, thread_id: ev.thread_id || null, account_id: ev.account_id || null, date: Number(ev.asof) || 0, channel: ev.channel || 'mail' }
      items++
      const touched = (ev.changes || []).filter(c => c.todo_id).map(c => c.todo_id + (c.type ? ' (' + c.type + ')' : '')).slice(0, 8)
      const to = (ev.to_addresses || []).slice(0, 4).map(tag).join(', ')
      parts.push('- ' + sur + ' · ' + new Date(Number(ev.asof) || 0).toISOString().slice(0, 16).replace('T', ' ') +
        (ev.agent_name ? ' · agent ' + ev.agent_name : '') +
        ' · from ' + (tag(ev.from_address) || '?') + (to ? ' → ' + to + ((ev.to_addresses || []).length > 4 ? ' +' + ((ev.to_addresses || []).length - 4) : '') : '') +
        (ev.kind === 'workflow_short_circuit' ? ' · auto-filed' : '') +
        ' · ' + (ev.summary ? clip(ev.summary, 220) : (ev.body_snippet ? 'snippet: ' + clip(ev.body_snippet, 160) : '(no summary)')) +
        (touched.length ? ' · touched: ' + touched.join(', ') : '') +
        (ev.rules_applied && ev.rules_applied.length ? ' · rules: ' + ev.rules_applied.join(', ') : ''))
    }
    parts.push('')
  }
  const text = parts.join('\n')
  return {
    text,
    maps: { realMsgId, realThreadId, surrogateMsgId, surrogateThreadId, msgMeta },
    stats: { items, threads: threads.length, byChannel, chars: text.length, estTokens: Math.round(text.length / 4), windowFrom: day(fromMs), windowTo: day(toMs), mode: 'index' }
  }
}

/** The short, uncached closing turn: today + the knobs + the section list (spec §2.3). */
// projectFocus: { project_id, name } when the run reviews ONE project (the project editor's
// "Review this project" — 2026-09-26, replacing the separate R1 re-org prompt): the same prompt and
// operations, the state block reduced to that project, and this line telling the model so.
// accounts: null = every account; else the labels of the accounts the input window was restricted to —
// the model is told so it does not read the other channels' absence as silence (page knob, 2026-10-04).
export function buildClosingTurn ({ today = new Date(), windowDays, editsWindowDays, focusDays = 7, stale, dormantMonths, inputMode, sections = GROUPS, projectFocus = null, accounts = null, scope = null } = {}) {
  const d = today instanceof Date ? today : new Date(today)
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getUTCDay()]
  const asked = new Set(sections.map(g => g === 'questions' ? 'question' : g === 'period' ? 'summary' : g))
  const order = EMIT_ORDER.map(g => g === 'period' ? 'summary' : g).filter(g => asked.has(g))
  const focus = projectFocus && projectFocus.project_id
    ? 'This run reviews ONE project only — [' + projectFocus.project_id + '] "' + String(projectFocus.name || '').replace(/"/g, "'") + '". The catalog holds just this project and the input window holds just the items that touched it. Every card, proposal and question is about it: verdicts on its open items (the OVERTAKEN BY EVENTS check applies in full), archive_project if the effort is finished, restructure / split / move within it, rename_project or set_project_summary when its name or summary no longer says where it stands. Do not propose merges — the other projects are not shown.'
    : null
  const restricted = Array.isArray(accounts)
    ? 'This run is restricted to these accounts: ' + (accounts.length ? accounts.join(', ') : '(none)') + '. The catalog holds ONLY the projects those accounts fed' + (scope && scope.of != null ? ' (' + scope.projects + ' of ' + scope.of + ')' : '') + ', with their people, and the input window ONLY their items. Everything else was left out on purpose — their absence is not inactivity, so do not call a to-do or project stale or finished merely because nothing from elsewhere appears here, and propose merges only among the projects shown.'
    : null
  return [
    'Today is ' + d.toISOString().slice(0, 10) + ' (' + weekday + '). Treat this as the present for every "overdue / quiet for / due soon" judgement.',
    'Run settings: input window ' + windowDays + ' days (' + (inputMode === 'full' ? 'full mail threads' : 'index of analysed items, ' + (Array.isArray(accounts) ? 'selected accounts only' : 'all channels')) + ') · hand edits over ' + editsWindowDays + ' days · focus horizon ' + focusDays + ' days ahead · stale = open, importance ≤ ' + (stale ? stale.maxImportance : 3) + ', older than ' + (stale ? stale.minAgeDays : 30) + ' days and untouched ' + (stale ? stale.quietDays : 21) + ' days · archive candidates = no open items and quiet ' + dormantMonths + ' months.',
    focus,
    restricted,
    'Produce these sections, in this order: ' + order.join(' → ') + ' → done.' + (sections.length < GROUPS.length ? ' Sections not listed were not asked for this run — emit nothing for them.' : ''),
    'Cite ids exactly as given. Keep every JSON line complete. Finish with the done line.'
  ].filter(Boolean).join('\n')
}

// ---- deterministic helpers the state block reads --------------------------------------------------
/** What the app recorded over the input window — from the analysis events' changes + the hand edits. */
export function periodCountsOf (windowEvents, handEdits = []) {
  const pc = { items: 0, threads: 0, byChannel: {}, todosNew: 0, todosResolved: 0, todosCancelled: 0, todosUpdated: 0, projectsNew: 0, autoFiled: 0, handEdits: handEdits.length }
  const threads = new Set()
  for (const ev of windowEvents) {
    if (!ev || !ev.msg_id || (ev.kind !== 'message' && ev.kind !== 'workflow_short_circuit')) continue
    pc.items++
    threads.add(ev.thread_id || ev.msg_id)
    const c = ev.channel || 'mail'; pc.byChannel[c] = (pc.byChannel[c] || 0) + 1
    if (ev.kind === 'workflow_short_circuit') pc.autoFiled++
    for (const ch of (ev.changes || [])) {
      const t = String(ch.type || '')
      if (!ch.todo_id) { if (/project/.test(t) && /new|creat/.test(t)) pc.projectsNew++; continue }
      if (/new|creat/.test(t)) pc.todosNew++
      else if (/resolv/.test(t) || ch.to === 'resolved') pc.todosResolved++
      else if (/cancel/.test(t) || ch.to === 'cancelled') pc.todosCancelled++
      else pc.todosUpdated++
    }
  }
  pc.threads = threads.size
  return pc
}

/** OPEN to-dos whose due window has started, ends inside the horizon, or has passed — overdue first. */
export function dueWithinHorizon (store, { nowMs = Date.now(), focusDays = 7 } = {}) {
  const today = new Date(nowMs).toISOString().slice(0, 10)
  const end = new Date(nowMs + focusDays * 24 * 3600e3).toISOString().slice(0, 10)
  const rows = []
  for (const p of store.all()) {
    if (p.status !== 'active' || p.merged_into) continue
    for (const t of (p.todos || [])) {
      if (!openish(t)) continue
      const e = t.due_earliest || null; const l = t.due_latest || null
      const ref = l || e
      if (!ref) continue
      if (!((e && e <= end) || (l && l <= end))) continue
      const overdue = ref < today ? Math.round((Date.parse(today) - Date.parse(ref)) / (24 * 3600e3)) : 0
      rows.push({ todo_id: t.todo_id, project_id: p.project_id, project_name: p.name || p.project_id, direction: t.direction || '', who: whoText(t), importance: t.importance || 3, importance_locked: !!t.importance_locked, due_earliest: e, due_latest: l, due_hint: t.due_hint || null, overdue, short: t.short_description || t.description || '' })
    }
  }
  rows.sort((a, b) => (b.overdue - a.overdue) || String(a.due_latest || a.due_earliest).localeCompare(String(b.due_latest || b.due_earliest)) || (b.importance - a.importance))
  return rows.slice(0, 80)
}
