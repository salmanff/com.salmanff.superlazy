// engine.js — PERMANENT core. The single per-message analysis pipeline, shared by every driver
// (processor.js — the background job, the in-tab check and Inspect — plus the lab pages' dry runs).
// Fix things HERE, once.
//
// A SESSION is the long-lived state (stores, caches, cost) plus its two injected dependencies:
//   freezr — the client API (global in the browser, a parameter in a background job)
//   source — a MailSource adapter (see sources note in archiveSource.js); the engine NEVER
//            imports a concrete source, so the same pipeline runs on the Email Cabinet archive
//            today and on live mail (freezr.connections.mail) later.
// processOneMessage() treats one message as "just arrived" and runs: profiles → rules/short-
// circuit → assemble → LLM (bounded request_more loop) → reconcile → triggers → events.

import { normalizeMessage } from './normalize.js'
import { createProfileStore } from './profiles.js'
import { createProjectStore } from './projectStore.js'
import { assemble, renderOpenItemsToAccountFor, ACCOUNT_FOR_SCOPE, renderEvidenceLines, renderCatalogSnapshot, renderPersonLine, DEFAULT_STALENESS_POLICY } from './assemble.js'
import { seedRoster } from './roles.js'
import { activeSubscriptions } from './subscriptionsCore.js'
import { analyzeThread, replyText } from './analyze.js'
import { reconcile } from './reconcile.js'
import { createInstructionStore } from './instructionStore.js'
import { preAnalyze, dispatchTriggers } from './rulesEngine.js'
import { inferAutomatedTriggers, autoprocessDiagnostic, backstopAutomatedItem, workflowInstructions } from './workflows.js'
import { buildUserStyle } from './userStyle.js'
import { tuningFrom } from './profileTuning.js'
import { runReprofile, historyFromSession } from './reprofiler.js'
import { fileToProject } from './autoProcess.js'
import { defaultModelFromPing } from './modelDefaults.js'
import { analysisSchema } from './analysisSchema.js'

export const MAX_FETCH_ROUNDS = 2

// ---- durable turn / provider cache (specs/pipeline-walkthrough.md §7) ---------------------
// Everything that changes on a user-edit timescale — the business context, the project catalog,
// and the auto-process instructions — is rendered ONCE into a frozen block sent as its own
// (cached) user message. Correctness does NOT depend on it being fresh: every project reconcile
// touches since the render is re-sent, CURRENT, in the volatile block's "Updates" section — which
// the prompt says overrides the snapshot. So the model never reasons over stale data.
// Refresh is therefore purely a COST policy, driven by Preferences:
//   snapshot_refresh_messages — re-render after this many processed EMAILS (default 50)
//   snapshot_refresh_chats    — …or this many chat turns (Slack / AI agents, default 100). Mixed
//                               traffic accrues fractionally — see noteProcessedForSnapshot
//   snapshot_max_age_hours    — …or when the render is older than this (default 24h)
// and NOTHING ELSE. There used to be a third, touched-projects trigger (re-render once N
// projects had changed since the render). It kept overriding the user's settings — even loosened
// to max(15, 33%) it fired constantly — so it is GONE: the cadence is exactly what Preferences
// says. The thing it was guarding against is a growing "Updates since the snapshot" section
// between renders; if that turns out to cost more than it saves, the fix is to send FEWER
// updates (only projects relevant to this message, rather than every touched one) — not to
// re-cache more often. Decide that after measuring.

// Two message thresholds, by channel: a chat turn (a Slack chunk, an AI-agent work turn) moves the
// catalog far less than an email does, so it draws the render budget down at half the rate. The
// old single threshold of 20 fired every second batch of ten — one 2x cache write (~$0.15 for a
// 25k-token catalog) per ~20 messages, measured 2026-09-13.
export const SNAPSHOT_REFRESH_MESSAGES = 50 // mail (and notes)
export const SNAPSHOT_REFRESH_CHATS = 100   // 'messages' (Slack) and 'work' (AI agents)
export const SNAPSHOT_MAX_AGE_HOURS = 24    // the HOT block (recently active projects)
// The durable turn is TWO cached blocks since 2026-09-13 (assemble.renderCatalogSnapshot): a COLD
// one (business context + auto-process rules + quiet projects) ahead of a HOT one (recently active
// projects). The thresholds above re-render only the hot block — a ~15-row write instead of ~85 —
// while the cold block lives a week, or until the rules / business context change (pin discard).
export const SNAPSHOT_COLD_MAX_AGE_HOURS = 168
const CHAT_CHANNELS = new Set(['messages', 'work'])

export function snapshotRefreshPolicy (prefs) {
  const p = prefs || {}
  const msgs = Number(p.snapshot_refresh_messages)
  const chats = Number(p.snapshot_refresh_chats)
  const hours = Number(p.snapshot_max_age_hours)
  const coldHours = Number(p.snapshot_cold_max_age_hours)
  return {
    messages: msgs > 0 ? msgs : SNAPSHOT_REFRESH_MESSAGES,
    chats: chats > 0 ? chats : SNAPSHOT_REFRESH_CHATS,
    maxAgeMs: (hours > 0 ? hours : SNAPSHOT_MAX_AGE_HOURS) * 3600 * 1000,
    coldMaxAgeMs: (coldHours > 0 ? coldHours : SNAPSHOT_COLD_MAX_AGE_HOURS) * 3600 * 1000
  }
}

// One processed message draws the snapshot's render budget down by 1/threshold for its channel;
// the snapshot is stale once the drawn-down share (refreshLoad) reaches 1 — so 25 emails plus 50
// chat turns is one re-render. msgsSinceRender stays the plain count the logs and the pin report.
export function noteProcessedForSnapshot (session, m) {
  const snap = session && session.snapshot
  if (!snap) return
  const policy = snapshotRefreshPolicy(session.prefs)
  const isChat = CHAT_CHANNELS.has((m && m.channel) || 'mail')
  snap.msgsSinceRender = (snap.msgsSinceRender || 0) + 1
  snap.refreshLoad = (Number(snap.refreshLoad) || 0) + 1 / (isChat ? policy.chats : policy.messages)
}

// The cache-WRITE premium of one call, from the provider's own figures: the tokens written at each
// TTL, priced at that TTL's multiple of the input rate (2x for 1h, 1.25x for 5m). 0 when the call
// carried no pricing (a $0 local connector) — nothing to attribute then.
export function cacheWriteCost (meta) {
  const t = (meta && meta.tokensUsed) || {}
  const det = (t.other && t.other.details) || {}
  const inRate = Number(meta && meta.pricing && meta.pricing.input) || 0
  if (!inRate) return 0
  const total = Number(det.cacheCreationTokens) || 0
  const w1h = Math.min(total, Number(det.cacheCreation1hTokens) || 0)
  const w5m = det.cacheCreation5mTokens != null ? Math.min(total - w1h, Number(det.cacheCreation5mTokens) || 0) : total - w1h
  return (w1h * 2 + w5m * 1.25) * inRate / 1e6
}

function snapshotFor (session, asof) {
  const snap = session.snapshot
  const policy = snapshotRefreshPolicy(session.prefs)
  // msgsSinceRender is the CROSS-RUN counter (a seeded snapshot arrives with the count it had
  // accumulated in earlier runs) — the pin means "one write per ~N messages", not "per run".
  // Age is WALL-CLOCK time since the render (renderedAt), NOT the gap between the render's message
  // date and this message's date. Measuring it on the message clock re-rendered the durable turn on
  // every day boundary a backlog crossed — observed: 8 re-renders (8 cache writes of ~24k tokens
  // each) in one 26-call run — while the policy promised one per 20 messages. On the wall clock a
  // replay of a month of mail in ten minutes never ages out (the message counter still bounds it),
  // and an hourly job re-renders once a day as the setting says.
  const now = Date.now()
  // COLD block: weekly, or gone (no snapshot / pin discarded because the rules or context changed)
  const coldAged = !!(snap && snap.cold && snap.cold.renderedAt && (now - Number(snap.cold.renderedAt)) > policy.coldMaxAgeMs)
  const needCold = !snap || !snap.cold || coldAged
  // HOT block: the message thresholds, its own age — and always when the cold block re-renders,
  // since the cold block precedes it in the prefix (and membership may have moved)
  const aged = !!(snap && snap.renderedAt && (now - Number(snap.renderedAt)) > policy.maxAgeMs)
  const overBudget = !!(snap && (Number(snap.refreshLoad) || 0) >= 1)
  if (!needCold && !overBudget && !aged) return snap
  const r = renderCatalogSnapshot(session.store, {
    asof,
    stalenessPolicy: session.stalenessPolicy,
    businessContext: session.prefs && session.prefs.business_context,
    workflowInstructions: workflowInstructions(),
    // the ALL-mail standing instructions and the style guide are stable text, so they live in the
    // cold block; durableSig (ingest.js) covers both, so editing one discards the pin
    allMailInstructions: (session.instructions && session.instructions.matching)
      ? session.instructions.matching('', null).filter(x => x.scope === 'all')
      : [],
    userStyle: session.userStyle || null,
    profiles: session.profiles,
    meSet: session.meSet,
    tuning: session.tuning,
    coldIds: needCold ? null : snap.cold.ids // frozen membership between cold renders
  })
  const coldTrigger = !needCold ? null : (!snap ? (session.snapshotDiscardReason || 'first') : 'age')
  const hotTrigger = !snap ? 'first' : (needCold ? 'cold' : (overBudget ? 'threshold' : 'age'))
  const cold = needCold
    ? { text: r.cold.text, chars: r.cold.chars, count: r.cold.count, ids: r.cold.ids, people: r.cold.people || [], renderedAt: now, trigger: coldTrigger }
    : snap.cold
  if (snap) {
    console.warn('[superlazy] durable turn RE-RENDERED (cache write incoming — ' + (needCold ? 'COLD + HOT blocks' : 'HOT block only') + '): ' +
      (snap.msgsSinceRender || 0) + ' message(s) since the last hot render (' + Math.round((Number(snap.refreshLoad) || 0) * 100) + '% of the render budget)' +
      (aged ? ', and the hot block aged out' : '') + (coldAged ? ', and the cold block aged out' : '') +
      ' — policy is ' + policy.messages + ' emails or ' + policy.chats + ' chat turns / ' + Math.round(policy.maxAgeMs / 3600000) + 'h hot, ' +
      Math.round(policy.coldMaxAgeMs / 3600000) + 'h cold')
  } else {
    console.info('[superlazy] no durable turn in this session yet — rendering both blocks (one cache write)' +
      (session.snapshotDiscardReason ? ' — the stored pin was discarded: ' + session.snapshotDiscardReason : '') +
      '. If this repeats every run, the PIN is not being adopted: check settings.snapshot_pin.')
  }
  // touched: a hot render makes the hot rows current, so they drop out of the volatile "Updates"
  // section; touched COLD projects keep their update row until the cold block itself re-renders
  const coldSet = new Set(cold.ids || [])
  const touched = needCold ? new Set() : new Set([...(snap.touched || [])].filter(id => coldSet.has(id)))
  // the same override discipline for PEOPLE: a profile changed since the cold render is re-sent in
  // full by the volatile block until that block is rendered again
  const coldPeopleSet = new Set(cold.people || [])
  const touchedPeople = needCold ? new Set() : new Set([...(snap.touchedPeople || [])].filter(a => coldPeopleSet.has(a)))
  session.snapshot = {
    text: r.hot.text,   // the HOT block — `text/chars/count/ids` keep meaning "the block on the message thresholds"
    chars: r.hot.chars,
    count: r.hot.count,
    ids: r.hot.ids,
    cold,               // { text, chars, count, ids, people, renderedAt, trigger }
    touched,
    touchedPeople,
    msgsSinceRender: 0,
    refreshLoad: 0,         // share of the render budget drawn down since (noteProcessedForSnapshot)
    renderedAsof: asof,   // the analysis clock the rows were tiered against (informational)
    renderedAt: now,      // wall clock — what the hot age policy is measured on
    // which block(s) this render will WRITE on the next call ('both' | 'hot'); cleared when the
    // cache_refresh event goes out. null on an adopted pin — a write then is a 'rewrite'.
    pendingWrite: needCold ? 'both' : 'hot',
    announced: false,
    trigger: hotTrigger
  }
  session.snapshotDiscardReason = null
  return session.snapshot
}

// Which block(s) a REWRITE (a write with no render pending) covered, estimated from the token
// counts: this catalog runs ~2.5 chars/token. Written ≤ 1.4× the hot block → hot; nothing read →
// the whole entry expired (system prompt included); otherwise cold + hot.
function estimateWrittenBlock (snap, created, read) {
  const hotTok = Math.max(1, Math.round(((snap && snap.chars) || 0) / 2.5))
  if (created <= hotTok * 1.4) return 'hot (estimated)'
  if (!read) return 'all — system prompt + cold + hot (estimated)'
  return 'cold + hot (estimated)'
}

export const errMsg = (e) => (e && e.message ? e.message : String(e))

// The durable turn carries its OWN cache breakpoint, as a content block with cache_control. That
// puts the freezr Anthropic connector in EXPLICIT mode: it still caches the system prompt, but adds
// no automatic breakpoints on the messages — so the volatile turn (the email, the thread, the
// linked projects: ~15k tokens per call) is no longer WRITTEN to the provider cache on every call.
// Measured before this change: 4.78M of 6.37M cache-written tokens were that volatile turn, billed
// at the 1h write premium (2x) and re-read on only ~10% of calls (request_more / repair rounds).
// Those rounds now re-send the volatile turn at the plain input rate instead — cheaper overall.
// With caching off (cacheOpt null) the turn is a plain string, byte-identical to before.
export function durableTurn (text, cacheOpt) {
  if (!cacheOpt) return { role: 'user', content: text }
  const cache_control = { type: 'ephemeral', ...(cacheOpt && cacheOpt.ttl === '1h' ? { ttl: '1h' } : {}) }
  return { role: 'user', content: [{ type: 'text', text, cache_control }] }
}

export function fmtDate (ms) {
  try { return new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') } catch (e) { return String(ms) }
}

// The cumulative state that survives across windows/batches ("the clock"). All parts are
// injectable so a page can share a profile store with its UI or restore persisted stores.
export function createSession ({ freezr, source, meSet, model, prefs, instructions, profiles, store, allById, promptOverride } = {}) {
  const p = prefs || {}
  return {
    // LAB ONLY (agentslabRun's A/B arms): { text, version } replaces the system prompt for this
    // session. null on every production path, where analyze.js uses its own SYSTEM_PROMPT.
    systemPromptOpt: (promptOverride && typeof promptOverride.text === 'string' && promptOverride.text) ? promptOverride.text : null,
    promptVersionOpt: (promptOverride && promptOverride.version) || null,
    freezr: freezr || null,
    source: source || null,
    meSet: meSet || new Set(),
    model: model || {},   // resolved by ensureModel() on the first message — see config.js
    prefs: p,
    // staleness tiers (§5) + provider caching (§4) — both read from prefs, both safely defaulted
    stalenessPolicy: p.staleness_policy || DEFAULT_STALENESS_POLICY,
    cacheOpt: p.llm_cache === false ? null : (p.snapshot_1h_ttl ? { ttl: '1h' } : true),
    // extended thinking for the per-message analysis: costly and off by default (see analyze.js)
    thinkingOpt: p.analysis_thinking === true,
    // effort scales EVERYTHING the model writes (thinking included) — the docs' recommended dial
    // for high-volume structured work; 'low' fits mail analysis, overridable per settings
    effortOpt: p.analysis_effort || 'low',
    // output ceiling per analysis call (Preferences: analysis_max_tokens); null = analyze.js default
    maxTokensOpt: Number(p.analysis_max_tokens) > 0 ? Number(p.analysis_max_tokens) : null,
    // how many request_more rounds the model gets (Preferences: analysis_fetch_rounds, 0-5)
    fetchRoundsMax: (p.analysis_fetch_rounds != null && Number.isFinite(Number(p.analysis_fetch_rounds)))
      ? Math.max(0, Math.min(5, Number(p.analysis_fetch_rounds)))
      : MAX_FETCH_ROUNDS,
    // when a caller sets this to an array, analyze.js pushes every LLM exchange onto it
    // (opts + turns + reply + usage) — the inspect page's window into the wire
    exchangeCapture: null,
    // dev request audit (llmAudit.js): when settings.llm_audit is on the driver sets this to the
    // audit sink and every finished exchange (analysis, detail round, repair) is persisted verbatim
    exchangeSink: null,
    snapshot: null,         // { text, ids, touched:Set, chars, count, msgsSinceRender, … }
    instructions: instructions || createInstructionStore(),
    profiles: profiles || createProfileStore(),
    store: store || createProjectStore(),
    tuning: tuningFrom(prefs), // profile-lifecycle knobs (profileTuning.js defaults + prefs.profile_tuning overrides)
    threadCache: new Map(), // thread_id -> { byId: Map(msg_id -> normalized), sorted: [normalized] }
    allById: allById || new Map(), // msg_id -> normalized (request_more resolution + UI modal lookups)
    userStyle: null,        // distilled once (lazily); null = not built yet, '' = tried + unavailable
    totalCost: 0,
    calls: 0,
    processed: 0            // messages analysed across the whole session
  }
}

// Distil the user's writing style once per session (best-effort, for suggested replies).
// Pick the model ONCE per session, the first time it is needed. An explicit choice is left alone.
// Otherwise: keep the user's DEFAULT PROVIDER and steer only the family to the analysis tier
// (modelDefaults.js — sonnet on Claude). If that provider does not offer it — or the ping fails, or
// we have no opinion about that provider — fall back to {} , which is freezr's own default. Never
// name a model the user's provider does not have.
// A batch matches rules per message, so the same instruction can arrive several times; the model
// should read each rule once, and each rule's id must stay unique for rules_applied.
function dedupeInstructions (records) {
  const seen = new Set()
  const out = []
  for (const r of (records || [])) {
    const id = r && (r.instruction_id || r.text)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(r)
  }
  return out
}

export async function ensureModel (session) {
  if (!session || session.modelResolved) return session ? session.model : {}
  session.modelResolved = true
  // session.provider = the provider that will actually answer. schemaFor() below needs it even
  // when the model itself is left to freezr's default, so it is recorded on every path.
  const picked = !!(session.model && (session.model.provider || session.model.family))
  if (picked && session.model.provider) { session.provider = session.model.provider; return session.model }
  try {
    const ping = await session.freezr.llm.ping()
    const provider = (ping && ping.defaultProvider) || null
    session.provider = provider
    if (picked) return session.model // a family-only pick: freezr's default provider supplies it
    session.model = defaultModelFromPing(ping, 'analysis')
  } catch (e) {
    if (!picked) session.model = {}
    session.provider = session.provider || null
  }
  return session.model
}

// WHICH PROVIDER GETS A RESPONSE SCHEMA — the one provider-aware rule in this code, and it rests
// on measurement, not preference (specs/analysis-experiments.md (E4)):
//   ChatGPT: without a schema, 5 of 15 batches dropped a msg_id (a repair round each); with one,
//            0 of 17. The schema fixes the one systematic contract failure ChatGPT models have.
//   Claude:  refuses this schema outright — 29 nullable fields against Anthropic's cap of 16,
//            and a grammar-size ceiling besides — and haiku was 9 of 9 WITHOUT one.
// So: ChatGPT yes, everyone else no. Not a setting. When the provider is unknown (ping failed)
// nothing is sent, which is today's behaviour. The schema is built per call because it pins the
// batch's message handles; it rides on the same options into detail and repair rounds.
export function schemaFor (session, expectMsgIds) {
  if (!session || session.provider !== 'ChatGPT') return null
  return {
    name: 'superlazy_analysis',
    description: 'One superlazy analysis per message, or a request for more context',
    // the subscriptions this request carries — pinning sub_id to them makes a hallucinated id
    // structurally impossible and puts the valid ids where the decision is made
    schema: analysisSchema({ expectMsgIds, subIds: activeSubscriptions().map(s => s.sub_id) })
  }
}

export async function ensureUserStyle (session, emit) {
  if (session.userStyle != null) return session.userStyle
  if (emit) emit({ type: 'building_style' })
  session.userStyle = await buildUserStyle(session.freezr, {
    source: session.source, meSet: session.meSet, model: session.model
  })
  // say what actually happened — the old line promised "one extra LLM call" before knowing whether
  // any sent mail existed to learn from, which on a sent-less mailbox printed misleadingly forever
  console.info(session.userStyle
    ? '[superlazy] writing-style guide built from sent mail (' + session.userStyle.length + ' chars) — stored, rebuilt monthly'
    : '[superlazy] no sent mail found to learn a writing style from — noted; it will be retried monthly, not every run')
  return session.userStyle
}

// Load + normalize a whole thread ONCE per session (cached). The full thread is needed so a
// message picked mid-thread still gets its prior-message INDEX as context.
export async function ensureThread (session, threadId, emit) {
  if (session.threadCache.has(threadId)) return session.threadCache.get(threadId)
  if (emit) emit({ type: 'loading', thread_id: threadId })
  const { messages } = await session.source.loadThreadRaw(threadId, {
    onProgress: (i, n) => emit && emit({ type: 'loading_progress', thread_id: threadId, i, n })
  })
  const sorted = messages.map(normalizeMessage).sort((a, b) => a.date - b.date)
  const byId = new Map()
  sorted.forEach(m => { byId.set(m.msg_id, m); session.allById.set(m.msg_id, m) })
  const entry = { byId, sorted }
  session.threadCache.set(threadId, entry)
  return entry
}

// ---- handle translation ----------------------------------------------------------------------
// The request refers to emails by short handles (m1, m2, … — see assemble.createAliasMap), so the
// model's reply comes back speaking handles. Translate them to real provider ids HERE, before
// reconcile or resolveRequests sees the output: nothing persisted may ever contain a handle.
// An unknown handle is dropped (not stored) and logged — a bogus evidence id would silently break
// the ✉ button on that to-do, and a wrong citation is worse than a missing one.
function translateHandles (output, aliasToReal, label) {
  if (!output || typeof output !== 'object' || !aliasToReal) return output
  const bad = []
  const real = (id) => {
    const s = String(id || '')
    if (!s) return null
    if (aliasToReal.has(s)) return aliasToReal.get(s)
    if (/^m\d+$/.test(s)) { bad.push(s); return null }   // handle-shaped but not one we minted
    return s                                             // already a real id (or something we pass through)
  }
  for (const entry of (Array.isArray(output.message_results) ? output.message_results : [output])) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.msg_id) entry.msg_id = real(entry.msg_id) || entry.msg_id
    for (const p of (entry.projects || [])) {
      for (const t of (p.todos || [])) {
        if ('evidence_msg_id' in t) t.evidence_msg_id = real(t.evidence_msg_id)
      }
    }
  }
  for (const r of (output.request_more || [])) if (r && r.msg_id) r.msg_id = real(r.msg_id) || r.msg_id
  if (bad.length) {
    console.warn('[superlazy] the model cited ' + bad.length + ' message handle(s) that were never sent (' +
      [...new Set(bad)].join(', ') + ') on ' + label + ' — dropped rather than stored')
  }
  return output
}

// INVARIANT 3, ENFORCED (2026-09-25): "only edit to-dos of projects whose full list you were given;
// to touch a catalog project, request its detail first". The model files into a catalog project it
// was shown only as a row — a new thread, a Slack thread, a note, the first turn of a session all
// start unlinked — and, wanting to close that project's to-dos, invents ids for them (the signed-contract
// case: "review-contract"). Asking is cheap and the model almost never does it (3 of 394
// audited exchanges). So the engine asks for it: a reply that touches an existing project outside
// the shown set is treated as an implicit request_more for that project's detail, the reply is
// discarded exactly as a request_more reply is, and the model answers again with the real ids.
function unseenProjectIds (output, store, shown) {
  const out = []
  if (!output || typeof output !== 'object' || !store) return out
  for (const entry of (Array.isArray(output.message_results) ? output.message_results : [output])) {
    for (const p of ((entry && entry.projects) || [])) {
      if (!p || p.new === true) continue
      // only a reply that EDITS EXISTING to-dos there matters — a status change or rewrite citing a
      // todo_id it cannot have seen. CREATING a to-do in a catalog project is allowed and routine
      // (every notice filed into a standing project does it — measured 2026-09-26: the round fired
      // on a batch-mate's new KYC item and cost the whole batch a second call), and a bare echo of
      // a row (no to-dos) is ignored by reconcile anyway.
      if (!Array.isArray(p.todos) || !p.todos.some(t => t && t.new !== true && t.todo_id)) continue
      const pid = String(p.project_id || '')
      if (!pid || shown.has(pid) || out.includes(pid) || !store.get(pid)) continue
      out.push(pid)
    }
  }
  return out
}

// The answer to a project_detail request. CAPPED: this used to render EVERY to-do with full
// description + evidence — a long-running "magnet" project came back as a 25k-char turn, billed at
// full input price per fetch round. The model asked for the project to decide whether/where a NEW
// item fits (or, on the implicit round, which existing items a message closes): open items (clipped)
// up to a cap serve that; closed items and overflow become counts it can drill into.
// Exported (pure) so the replay tooling renders the round exactly as production does.
export function renderProjectDetailForRound (p, aliasObj) {
  const OPEN_MAX = 30
  const DESC_MAX = 300
  const clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t }
  const open = p.todos.filter(t => t.status === 'open' || t.status === 'in_progress')
  const closedCount = p.todos.length - open.length
  const shown = open.slice(-OPEN_MAX)
  const todos = shown.map(t => {
    const sums = renderEvidenceLines(t, '      ', 3, aliasObj).slice(-1) // newest evidence line only
    return `  [${t.todo_id}] (${t.direction}, ${t.status}, imp ${t.importance}) "${t.short_description || ''}" — ${clip(t.description, DESC_MAX)}` +
      (sums.length ? '\n' + sums.join('\n') : '')
  }).join('\n')
  const notes = []
  if (open.length > shown.length) notes.push(`  [… ${open.length - shown.length} older open to-dos not shown — their ids exist; ask again naming a todo_id if you need one.]`)
  if (closedCount > 0) notes.push(`  [… ${closedCount} resolved/cancelled to-do(s) not shown — they are DONE; do not recreate them.]`)
  return `Requested project [${p.project_id}] "${p.name}" (importance ${p.importance})\n  summary: ${p.summary || '(none)'}\n${todos || '  (no open to-dos)'}` +
    (notes.length ? '\n' + notes.join('\n') : '')
}

// The preface of an IMPLICIT detail round (see unseenProjectIds) — exported for the replay tooling.
export const IMPLICIT_ROUND_PREFACE = '## Detail of the project(s) you filed into without having seen their to-do lists\n' +
  'Your previous reply edited to-dos in the project(s) below, which this request showed only as catalog rows, so the ids it cited could not be real. Their OPEN to-dos are listed here with their REAL todo_ids. Your previous reply is discarded — answer again IN FULL: keep everything else from it that still stands (the other projects and to-dos, message_summary, profile_updates, triggers), and redo the part about these project(s): cite these todo_ids (never an invented one); give EVERY line of the "Open items to account for" block below its verdict; the items this message finishes or overtakes are resolved / cancelled with this message as evidence; do not create a to-do beside an existing one that covers the same obligation.\n'
export const ROUND_CLOSING = '\n\nNow return the full analysis (no further requests unless truly impossible). ' +
  'Include ONLY the projects you are actually CHANGING: requesting a project’s detail does ' +
  'not oblige you to return it — a requested project that turned out to be unrelated must ' +
  'be OMITTED from your reply, not echoed back unchanged.'

// Resolve the model's request_more list against everything loaded so far + the project store.
function resolveRequests (reqs, session, alias) {
  const details = []
  for (const r of (reqs || [])) {
    if (r.kind === 'message_body' && r.msg_id && session.allById.has(r.msg_id)) {
      const m = session.allById.get(r.msg_id)
      const handle = (alias && alias.get(m.msg_id)) || m.msg_id
      // the WHOLE text when the stripped rendering left quoted history out: this is how an inline
      // reply (answers written under the quoted paragraphs) reaches the model — it asks for it
      const whole = m.full_text && m.full_text.length > (m.clean_text || '').length
      details.push(`Requested message (${handle}) — from ${m.from && m.from.address} · ${fmtDate(m.date)} · "${m.subject || ''}"` +
        (whole ? ' — FULL body: quoted lines start with ">"; an unquoted passage under a quoted paragraph is the sender\'s answer to it' : '') +
        `\n${(whole ? m.full_text : m.clean_text) || '(empty body)'}`)
    } else if (r.kind === 'project_detail' && r.project_id && session.store.get(r.project_id)) {
      details.push(renderProjectDetailForRound(session.store.get(r.project_id), alias ? { aliasFor: (id) => alias.get(String(id)) || '(not sent)' } : undefined))
    } else if (r.kind === 'person_detail' && r.address) {
      // The people block sends CC'd and off-thread participants as names only, and tells the model
      // to ask when one of them matters. This is that ask being answered: the SAME full profile line
      // the block would have rendered, so the model reads one shape wherever a person arrives.
      const addr = String(r.address).toLowerCase()
      const prof = session.profiles.get ? session.profiles.get(addr) : null
      if (prof) {
        const roster = seedRoster([addr], session.meSet)
        details.push('Requested person — ' + renderPersonLine(prof, roster, session.tuning, 'full'))
      } else {
        details.push(`No profile exists for ${addr} yet — they are new to the user, or their address differs from the one on file. Judge with what the message itself says about them.`)
      }
    } else {
      details.push(`Could not resolve request: ${JSON.stringify(r)} — judge with what you have.`)
    }
  }
  return { details }
}

// ---- profile lifecycle (see profileTuning.js for the model) ---------------------------------
// Runs any re-profile that is now DUE. Today there is exactly one automatic trigger:
//  - graduation: the sender's provisional window closed (messages_from hit the threshold) —
//    one dedicated call grounds the profile (incl. user_tone) and solidifies it.
// 2026-09-19: the second trigger, DRIFT, is gone with fit_concerns — the model was asked for
// those on every message and emitted none in 983 analyses, so the accumulator never moved and
// the branch never fired. On-demand re-profiles (trigger 'user_request') are unaffected.
// Failures never fail the message.
async function maintainProfiles (session, { newMsg, asof }, out) {
  const t = session.tuning

  // collect who is due which re-profile
  const due = [] // { address, trigger }
  const sender = String((newMsg.from && newMsg.from.address) || '').toLowerCase()
  const senderProf = sender && !session.meSet.has(sender) ? session.profiles.get(sender) : null
  if (senderProf && !senderProf.profile.solidified_asof && !senderProf.profile.user_edited &&
      (senderProf.interaction_data.messages_from || 0) >= t.MESSAGES_BEFORE_SOLIDIFYING_PROFILE) {
    const fileEntry = fileToProject(senderProf.profile)
    if (!(fileEntry && fileEntry.active)) due.push({ address: sender, trigger: 'graduation' })
  }
  const reprofiles = []
  for (const d of due) {
    out({ type: 'reprofile_start', address: d.address, trigger: d.trigger })
    try {
      const history = historyFromSession({ allById: session.allById, address: d.address, asof, tuning: t })
      const r = await runReprofile({
        freezr: session.freezr, model: session.model, profiles: session.profiles, store: session.store,
        address: d.address, history, tuning: t, trigger: d.trigger, asof, meSet: session.meSet
      })
      session.calls++
      session.totalCost += r.cost || 0
      // meta travels with the entry so the message's token total can include the re-profile's calls
      reprofiles.push({ address: d.address, trigger: d.trigger, outcome: r.outcome, reason: r.reason || null, applied: r.applied || null, cost: r.cost || 0, rounds: r.rounds || 0, meta: r.meta || null })
      out({ type: 'reprofile_done', address: d.address, trigger: d.trigger, outcome: r.outcome, reason: r.reason || null, cost: r.cost || 0, totalCost: session.totalCost })
    } catch (e) {
      reprofiles.push({ address: d.address, trigger: d.trigger, outcome: 'error', reason: errMsg(e), cost: 0 })
      out({ type: 'reprofile_done', address: d.address, trigger: d.trigger, outcome: 'error', reason: errMsg(e), cost: 0, totalCost: session.totalCost })
    }
  }
  return { reprofiles }
}

// Analyse ONE message as if it just arrived — the one-entry case of processBatch (below), kept as
// the name every driver already calls.
export async function processOneMessage (session, { newMsg, priorMsgs, threadId, accountId, noDrafts, idx, total }, { emit } = {}) {
  await ensureModel(session)
  const r = await processBatch(session, {
    entries: [{ newMsg, priorMsgs, threadId, accountId }], noDrafts, idx, total
  }, { emit })
  return r.results && r.results[0] ? r.results[0] : { ok: false }
}

/**
 * Analyse a BATCH of newly-arrived messages in ONE LLM call (spec §3). A one-entry batch is
 * byte-identical to the old single-message request, so this is one code path, not a fork.
 * @param {Object} session
 * @param {Array}  o.entries  [{ newMsg, priorMsgs, threadId, accountId? }] oldest-first (one account)
 * @returns {Object} { ok, results: [{ ok, applied?, msg_id }], missing: [msg_id] }
 *   `missing` = messages the model returned no entry for; the driver re-queues them individually.
 */
export async function processBatch (session, { entries, noDrafts, idx, total }, { emit } = {}) {
  // every message in the batch is addressable by id from here on — a request_more message_body
  // for the NEW message (an inline reply: "answers below") must resolve even when the caller did
  // not register it in allById first (2026-09-26)
  for (const e of (entries || [])) {
    if (e && e.newMsg && e.newMsg.msg_id && !session.allById.has(e.newMsg.msg_id)) session.allById.set(e.newMsg.msg_id, e.newMsg)
    for (const pm of ((e && e.priorMsgs) || [])) if (pm && pm.msg_id && !session.allById.has(pm.msg_id)) session.allById.set(pm.msg_id, pm)
  }
  await ensureModel(session)
  const out = emit || (() => {})
  const items = (entries || []).filter(e => e && e.newMsg)
  if (!items.length) return { ok: false, results: [], missing: [] }
  const isBatch = items.length > 1
  const newMsg = items[0].newMsg          // the single-message path's message
  const priorMsgs = items[0].priorMsgs || []
  const threadId = items[0].threadId
  const asof = items[items.length - 1].newMsg.date
  const threadRef = { thread_id: threadId }

  // ---- per-message accounting ----------------------------------------------------------------
  // What did THIS email cost, in time, money and tokens? One message can make several LLM calls —
  // each request_more round, plus any re-profile it triggers — so the numbers have to accumulate.
  // (The step event used to report only the LAST round's cost, which understated any message that
  // needed extra context.) Wall-clock is measured here rather than in the driver so it covers the
  // whole pipeline: assembling the request, the calls themselves, reconcile and the triggers.
  const startedAt = Date.now()
  const spend = { cost: 0, input: 0, output: 0, other: 0, cacheRead: 0, cacheWrite: 0, thinking: 0, calls: 0, analysisCost: 0, reprofileCost: 0, cacheWriteCost: 0 }
  const addUsage = (meta) => {
    const c = (meta && meta.cost && meta.cost.totalCost) || 0
    const t = (meta && meta.tokensUsed) || {}
    const det = (t.other && t.other.details) || {}
    spend.calls++
    spend.cost += c
    spend.input += Number(t.input && t.input.qtty) || 0
    spend.output += Number(t.output && t.output.qtty) || 0
    spend.other += Number(t.other && t.other.qtty) || 0
    // split the cache traffic: a READ is the discount working, a WRITE is the premium being paid —
    // summing them into one "other" number hid which one a given run was doing
    spend.cacheRead += Number(det.cacheReadTokens) || 0
    spend.cacheWrite += Number(det.cacheCreationTokens) || 0
    // the DEFINITIVE thinking measurement: the API reports how many billed output tokens were
    // internal reasoning (usage.output_tokens_details.thinking_tokens) — no more inferring it
    // from "output looks too big for its JSON"
    const rd = (meta && meta.rawUsage && meta.rawUsage.output_tokens_details) || {}
    spend.thinking += Number(rd.thinking_tokens) || 0
    return c
  }
  const spendSummary = () => ({
    duration_ms: Date.now() - startedAt,
    cost: spend.cost,
    cost_analysis: spend.analysisCost,
    cost_reprofiles: spend.reprofileCost,
    llm_calls: spend.calls,
    tokens: {
      input: spend.input,
      output: spend.output,
      other: spend.other,           // cache traffic combined (kept for old consumers)
      cache_read: spend.cacheRead,  // the discount working
      cache_write: spend.cacheWrite, // the premium being paid
      thinking: spend.thinking,     // reasoning share of output, as the API reports it
      total: spend.input + spend.output + spend.other
    }
  })

  // ---- 1. per-message pre-pass: stats, rules engine, short-circuits --------------------------
  // Auto-filed messages never enter an LLM batch — they are applied here and reported exactly as
  // before (zero LLM calls). Everything else becomes an entry of the one batched request.
  const results = []
  const llm = [] // { it, decision, autoprocessBlocked, unlearned }
  for (const it of items) {
    const m = it.newMsg
    const statsParent = m.in_reply_to ? (it.priorMsgs || []).find(x => x.msg_id === m.in_reply_to) : null
    session.profiles.recordMessage(m, { parent: statsParent, meSet: session.meSet, channel: m.channel || 'mail' })
    const unlearned = session.profiles.takeUnlearned ? session.profiles.takeUnlearned() : []

    out({ type: 'msg_start', idx, total, globalIdx: session.processed, thread_id: it.threadId, msg: m })

    const decision = preAnalyze({ newMsg: m, profiles: session.profiles, prefs: session.prefs, store: session.store, instructions: session.instructions, account: it.accountId || null })
    if (decision.shortCircuit) {
      const applied = decision.shortCircuit.apply(session.store, { asof: m.date, msgId: m.msg_id, threadId: it.threadId })
      // NOT snapshot-touched: a short-circuit files a read_only item into a bucket project —
      // nothing the catalog row carries changes, and these are the highest-volume messages there
      // are. (The project is still persisted via touched_project_ids below.)
      out({
        type: 'step', idx, total, globalIdx: session.processed, thread_id: it.threadId, msg: m, asof: m.date,
        applied, profUpdates: [], via_workflow: decision.shortCircuit.workflow,
        workflow_category: decision.shortCircuit.category,
        workflow_reason: decision.shortCircuit.reason,
        workflow_mismatch: decision.shortCircuit.mismatch || null,
        workflow_doubt: decision.shortCircuit.doubt || null,
        unlearned,
        fetchRounds: 0, totalCost: session.totalCost,
        ...spendSummary()
      })
      session.processed++
      noteProcessedForSnapshot(session, m)
      results.push({ ok: true, applied, viaWorkflow: true, msg_id: m.msg_id })
      continue
    }
    llm.push({
      it,
      decision,
      unlearned,
      autoprocessBlocked: autoprocessDiagnostic({
        newMsg: m, profiles: session.profiles, prefs: session.prefs, store: session.store, instructions: session.instructions, account: it.accountId || null
      })
    })
  }
  if (!llm.length) return { ok: true, results, missing: [] }

  // ---- 2. ONE analysis call for the remaining messages ----------------------------------------
  // The catalog rides in an earlier, provider-cached user turn (§4); the volatile block carries the
  // current rows of everything touched since it was rendered, which override it. A request_more is
  // answered by APPENDING turns, so the whole prefix re-reads at the cached rate (§6).
  const snap = snapshotFor(session, asof)
  // two cached turns: the COLD block first (changes least), then the HOT block (assemble §4)
  const priorTurns = [durableTurn(snap.cold.text, session.cacheOpt), durableTurn(snap.text, session.cacheOpt)]
  const entriesForAssembly = llm.map(x => x.it)
  const firstMsg = llm[0].it.newMsg
  let rounds = 0
  let result = null
  let assembled = null
  // On a fetch round the outgoing user message is ONLY the resolved detail — the volatile block
  // already sits in priorTurns. The old loop re-assembled and re-sent the whole volatile block as
  // the new user turn on EVERY round, so a single request_more paid for those ~25-70k chars twice.
  let roundMessage = null
  // one CHAIN = this analysis call plus every follow-on round for it (request_more detail, repair);
  // the request audit groups exchanges by it so a message's total cost reads as one request
  const chainId = 'ch_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
  // the projects whose to-do lists the model HAS been shown in this chain: the linked ones from the
  // assembly, plus every project_detail answered on a later round (explicit or implicit)
  const shownProjects = new Set()
  // handle -> ids whose verdict the reply must carry (the account-for blocks; prompt 0.61). Filled
  // from the assembly, extended by an implicit round's block.
  let expectAccountFor = {}
  while (true) {
    if (!roundMessage) {
      assembled = assemble({
        store: session.store, thread: threadRef, entries: entriesForAssembly,
        profiles: session.profiles, meSet: session.meSet, asof, noDrafts,
        businessContext: session.prefs && session.prefs.business_context,
        userStyle: session.userStyle, tuning: session.tuning,
        contextChars: session.prefs && session.prefs.analysis_context_chars,
        stalenessPolicy: session.stalenessPolicy,
        snapshot: snap, updateIds: [...snap.touched],
        // only the per-sender/domain/account rules: the ALL-mail ones ride in the cold block
        userInstructions: dedupeInstructions(llm.flatMap(x => x.decision.userInstructions || [])),
        // the cached block holds their text; the volatile block closes with a reminder that names
        // them and says they must be acted on (assemble.instructionReminder)
        allMailInstructions: dedupeInstructions(llm.flatMap(x => x.decision.allMailInstructions || [])),
        workflowInstructions: llm[0].decision.workflowInstructions,
        cachedProfiles: (snap.cold && snap.cold.people) || [],
        changedProfiles: [...(snap.touchedPeople || [])]
      })
      for (const id of (assembled.linkedProjectIds || [])) shownProjects.add(id)
      expectAccountFor = { ...(assembled.accountFor || {}) }
      const sz = assembled.size
      if (sz && (sz.level > 0 || sz.bodyCappedTo)) {
        const big = Object.entries(sz.sections || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([k, v]) => k + ' ' + v.toLocaleString()).join(', ')
        console.warn('[superlazy] context reduced for "' + (firstMsg.subject || '') + '"' +
          (isBatch ? ' (+' + (llm.length - 1) + ' more)' : '') + ': level ' + sz.level +
          '/' + sz.maxLevel + ', request ' + sz.chars.toLocaleString() + '/' + sz.budget.toLocaleString() + ' chars' +
          (sz.overBudget ? ' · STILL over budget' : '') + ' · biggest sections: ' + big)
      }
    }
    const outgoing = roundMessage || assembled.volatileBlock
    // userMessage rides on the event so an inspection UI can show the request BEFORE the reply
    out({ type: 'step_pending', idx, total, globalIdx: session.processed, msg: firstMsg, round: rounds, batch: llm.length, userMessage: outgoing, snapshotChars: (snap && snap.chars) || 0 })
    // The call below is the longest silent stretch in the whole app — a batch on a thinking model
    // can run for minutes with no bytes back. Say what was sent, and HEARTBEAT while waiting:
    // the event keeps the UI honest ("still waiting, 2m 10s") and, forwarded up to ingest, renews
    // the run lock so a long call is never mistaken for a dead holder and taken over mid-flight.
    const askStarted = Date.now()
    console.info('[superlazy] LLM request: ' + llm.length + ' message(s)' +
      (firstMsg.subject ? ' · "' + firstMsg.subject + '"' + (llm.length > 1 ? ' (+' + (llm.length - 1) + ' more)' : '') : '') +
      ', round ' + (rounds + 1) +
      ', ' + outgoing.length.toLocaleString() + ' chars ' + (roundMessage ? 'detail turn' : 'volatile') +
      (priorTurns && priorTurns.length ? ' + ' + priorTurns.length + ' prior turn(s)' : '') +
      ' — waiting on the model…')
    const heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - askStarted) / 1000)
      console.info('[superlazy] …still waiting on the model (' + Math.floor(secs / 60) + 'm ' + (secs % 60) + 's)')
      out({ type: 'llm_waiting', idx, total, msg: firstMsg, batch: llm.length, elapsedMs: Date.now() - askStarted })
    }, 30000)
    try {
      result = await analyzeThread(session.freezr, {
        userMessage: outgoing,
        priorTurns,
        model: session.model,
        cache: session.cacheOpt,
        thinking: session.thinkingOpt,
        effort: session.effortOpt,
        maxTokens: session.maxTokensOpt,
        capture: session.exchangeCapture,
        onExchange: session.exchangeSink,
        audit: { chain_id: chainId, round: rounds + 1, kind: roundMessage ? 'detail' : 'analysis', msg_ids: assembled.msgIds || [], subject: firstMsg.subject || '', batch: llm.length },
        expectMsgIds: assembled.msgIds,
        expectAccountFor,
        structuredOutput: schemaFor(session, assembled.msgIds),
        systemPrompt: session.systemPromptOpt,
        promptVersion: session.promptVersionOpt
      })
      {
        const t = (result && result.meta && result.meta.tokensUsed) || {}
        const det = (t.other && t.other.details) || {}
        const q = (x) => ((x && Number(x.qtty)) || 0).toLocaleString()
        const pr = (result && result.meta && result.meta.pricing) || null
        const rd = (result && result.meta && result.meta.rawUsage && result.meta.rawUsage.output_tokens_details) || {}
        // <200 tokens is bookkeeping residue the API reports even with thinking disabled (observed
        // 121/48 on confirmed-off calls) — the flag is for REASONING creeping back, not for noise
        const thinkTok = Number(rd.thinking_tokens) || 0
        const thinkFlag = thinkTok >= 200
        console.info('[superlazy] LLM reply: ' + Math.round((Date.now() - askStarted) / 1000) + 's · $' +
          (((result && result.meta && result.meta.cost && result.meta.cost.totalCost) || 0)).toFixed(4) +
          (thinkFlag ? ' · ⚠ THINKING ' + thinkTok.toLocaleString() + ' tokens (asked for none)' : '') +
          ' · ' + ((result && result.meta && result.meta.model) || '?') +
          (pr ? ' billed @ $' + pr.input + '/$' + pr.output + ' per Mtok' : ' · ⚠ NO PRICE ON FILE — costed at zero') +
          ' · ' + ((result && result.type) || '?') +
          ' · in ' + q(t.input) + ' / out ' + q(t.output) +
          (det.cacheReadTokens ? ' / cache READ ' + Number(det.cacheReadTokens).toLocaleString() : '') +
          (det.cacheCreationTokens ? ' / cache WRITE ' + Number(det.cacheCreationTokens).toLocaleString() : '') +
          ((session.cacheOpt && !det.cacheReadTokens && !det.cacheCreationTokens) ? ' · ⚠ cache asked for but NO cache traffic reported' : ''))
      }
    } catch (e) {
      console.error('[superlazy] LLM call FAILED after ' + Math.round((Date.now() - askStarted) / 1000) + 's: ' + errMsg(e))
      for (const x of llm) {
        out({ type: 'step_error', idx, total, msg: x.it.newMsg, message: errMsg(e), userMessage: assembled.volatileBlock, raw: e.raw || null })
        results.push({ ok: false, error: errMsg(e), msg_id: x.it.newMsg.msg_id })
      }
      // Batching is an optimisation; PROCESSING THE MAIL IS THE JOB. When one request was too much
      // to answer in one go, say so — the caller splits it and asks about each message on its own,
      // against the same cached catalog, so the run continues instead of stopping dead.
      return { ok: false, results, missing: [], tooMuchAtOnce: !!(e && e.tooMuchAtOnce) && llm.length > 1 }
    } finally {
      clearInterval(heartbeat)
    }
    session.calls++
    const c = addUsage(result.meta)
    spend.analysisCost += c
    session.totalCost += c
    // The provider WROTE the cached prefix on this call → a cache_refresh event, so cache spend is
    // visible in the events feed (spec §7). Its cost is the WRITE PREMIUM ONLY: the rest of the
    // call is apportioned across the messages below. It used to carry the whole call cost while
    // the messages ALSO carried it — the events ledger over-reported by that amount (2026-09-13:
    // $2.82 reported against $2.14 billed).
    const created = Number(((result.meta || {}).tokensUsed || {}).other &&
      result.meta.tokensUsed.other.details && result.meta.tokensUsed.other.details.cacheCreationTokens) || 0
    if (created) {
      const writeCost = cacheWriteCost(result.meta)
      spend.cacheWriteCost += writeCost
      const read = Number(((result.meta || {}).rawUsage || {}).cache_read_input_tokens) || 0
      const cold = snap.cold || { chars: 0, count: 0, trigger: null }
      out({
        type: 'cache_refresh', asof,
        // 'first' | 'threshold' | 'age' | 'cold': the hot render this call wrote ('cold' = it
        // re-rendered because the cold block did). 'rewrite': bytes the provider had ALREADY cached
        // were written again — its entry expired (a run landing past the 1h TTL) or something ahead
        // of the catalog in the prefix changed (system prompt, model).
        trigger: snap.pendingWrite ? snap.trigger : 'rewrite',
        // which block(s) were written: 'both' | 'hot' from the render, else estimated from the tokens
        block: snap.pendingWrite || estimateWrittenBlock(snap, created, read),
        cold_trigger: snap.pendingWrite === 'both' ? cold.trigger : null,
        snapshot_chars: snap.chars + (cold.chars || 0), projects_in_snapshot: snap.count + (cold.count || 0),
        hot_chars: snap.chars, hot_projects: snap.count, cold_chars: cold.chars || 0, cold_projects: cold.count || 0,
        cache_creation_tokens: created, cache_read_tokens: read,
        cost: writeCost, call_cost: c, totalCost: session.totalCost
      })
      snap.pendingWrite = null
      snap.announced = true
    }

    // the implicit round (see unseenProjectIds): allowed once even when the user set fetch rounds
    // to 0, because the alternative is applying edits to a list the model never saw
    let implicit = false
    if (result.type !== 'request_more' && result.output) {
      const unseen = unseenProjectIds(result.output, session.store, shownProjects)
      if (unseen.length && rounds < Math.max(1, session.fetchRoundsMax)) {
        implicit = true
        console.info('[superlazy] the model filed into ' + unseen.length + ' project(s) it was shown only as catalog row(s) (' + unseen.join(', ') + ') — re-asking with their to-do lists')
        result = { type: 'request_more', output: { request_more: unseen.map(id => ({ kind: 'project_detail', project_id: id })) }, raw: result.raw, meta: result.meta }
      } else if (unseen.length) {
        console.warn('[superlazy] the model filed into unseen project(s) ' + unseen.join(', ') + ' and no fetch round is left — applying as-is (unknown to-do ids are dropped by reconcile)')
      }
    }
    if (result.type === 'request_more' && rounds < Math.max(implicit ? 1 : 0, session.fetchRoundsMax)) {
      translateHandles(result.output, assembled.aliasToReal, 'a request_more')
      const { details } = resolveRequests(result.output.request_more, session, assembled.realToAlias)
      for (const r of (result.output.request_more || [])) if (r && r.kind === 'project_detail' && r.project_id) shownProjects.add(String(r.project_id))
      // on an implicit round the detail carries its own accountant's block: the open items of the
      // project(s) that name someone on this message, each demanding a verdict (assemble.js)
      if (implicit) {
        const aliasObj = { aliasFor: (id) => (assembled.realToAlias && assembled.realToAlias.get(String(id))) || null }
        const detailedIds = (result.output.request_more || []).map(r => String(r.project_id))
        for (const x of llm) {
          const block = renderOpenItemsToAccountFor(session.store, x.it.newMsg, assembled.roster, aliasObj, ACCOUNT_FOR_SCOPE, { linkedIds: detailedIds })
          if (!block) continue
          const handle = (assembled.realToAlias && assembled.realToAlias.get(String(x.it.newMsg.msg_id))) || null
          details.push('For ' + (handle || 'this message') + ':\n' + block.text.replace(/^## Open items to account for on this (item|turn) \(/, '## Open items to account for on this $1, in the project(s) above ('))
          if (handle) expectAccountFor[handle] = [...new Set([...(expectAccountFor[handle] || []), ...block.ids])]
        }
      }
      out({ type: 'fetch', idx, msg: firstMsg, requests: result.output.request_more, round: rounds, implicit, cost: c, totalCost: session.totalCost })
      // conversation form: move what was just SENT into the prior turns, append the model's ask,
      // and make the resolved detail the NEXT outgoing message. The volatile block therefore goes
      // over the wire exactly ONCE — the old code re-sent it as the new user turn every round.
      priorTurns.push({ role: 'user', content: outgoing })
      // MUST be text: with responseType:'json' result.raw is the PARSED OBJECT, and an object here is
      // rejected outright by the provider ("messages.N.content: Input should be a valid array") — a
      // 400 in 0s that reads like a model failure but is our own request shape.
      priorTurns.push({ role: 'assistant', content: replyText(result.raw) })
      roundMessage = (implicit ? IMPLICIT_ROUND_PREFACE : '## Additional detail you requested\n') + details.join('\n\n') + ROUND_CLOSING
      rounds++
      continue
    }
    if (result.type === 'request_more') {
      for (const x of llm) {
        out({ type: 'step_error', idx, total, msg: x.it.newMsg, message: 'model kept requesting detail past the fetch cap', userMessage: assembled.volatileBlock })
        results.push({ ok: false, msg_id: x.it.newMsg.msg_id })
      }
      return { ok: false, results, missing: [] }
    }
    break
  }

  // handles -> real provider ids, ONCE, before anything downstream reads the output
  translateHandles(result.output, assembled.aliasToReal, 'the analysis')

  // ---- 3. apply each message's entry, in order -------------------------------------------------
  // A batch reply is message_results[]; a single-message reply is the analysis object itself.
  const byId = new Map()
  if (result.type === 'batch') {
    for (const r of result.output.message_results || []) byId.set(String(r.msg_id), r)
  } else {
    byId.set(String(llm[0].it.newMsg.msg_id), result.output)
  }
  // apportion the call's analysis cost across the messages it covered, by rendered body size
  const weights = llm.map(x => Math.max(1, String(x.it.newMsg.clean_text || '').length))
  const weightSum = weights.reduce((a, b) => a + b, 0)
  // …minus what the cache_refresh event(s) above already carry, so the two ledgers add up
  const analysisTotal = Math.max(0, spend.analysisCost - spend.cacheWriteCost)
  // cache + thinking ride along: without them the per-message event reported cache_read/write as
  // ABSENT, so the events log (and costReport, and my own diagnosis) could not tell a cache HIT
  // from a cold write — the numbers looked like "no caching at all" when reads were simply unrecorded
  const callTokens = {
    input: spend.input, output: spend.output, other: spend.other,
    cacheRead: spend.cacheRead, cacheWrite: spend.cacheWrite, thinking: spend.thinking
  }
  const batchId = isBatch ? 'b_' + firstMsg.msg_id + '_' + llm.length : null

  const missing = []
  // tmp_id -> minted id, SHARED across the batch's entries: reconcile fills these as it mints,
  // so entry k+1 can cite what entry k created by its tmp_id instead of re-creating it (the
  // prompt's "tmp_ids are scoped to the WHOLE reply" contract — without this, every reply in a
  // back-and-forth thread batched into one call duplicated the same task).
  const batchTmpTodo = {}
  const batchTmpProj = {}
  for (let i = 0; i < llm.length; i++) {
    const { it, decision, unlearned, autoprocessBlocked } = llm[i]
    const m = it.newMsg
    const output = byId.get(String(m.msg_id))
    if (!output) {
      // The model skipped this message. Do NOT guess: the driver re-queues it on its own.
      missing.push(m.msg_id)
      out({ type: 'step_error', idx, total, msg: m, message: 'the model returned no entry for this message in the batch — it will be retried on its own' })
      results.push({ ok: false, requeue: true, msg_id: m.msg_id })
      continue
    }
    const share = analysisTotal * (weights[i] / weightSum)
    const perSpend = { cost: share, analysis: share, reprofile: 0, calls: 0 }

    // which standing instructions the model says actually changed this analysis (prompt 0.54).
    // Nothing acts on it — it is measurement: offered-vs-cited is what tells the user whether an
    // instruction earns its tokens. Kept to the ids that were really in this request's prompt, so
    // a hallucinated id never reaches storage.
    const offeredRules = new Set([
      ...((decision && decision.userInstructions) || []).map(r => r.instruction_id),
      ...((decision && decision.allMailInstructions) || []).map(r => r.instruction_id)
    ].filter(Boolean))
    const rulesApplied = (Array.isArray(output.rules_applied) ? output.rules_applied : [])
      .map(x => String(x || '').trim()).filter(x => offeredRules.has(x))
    const applied = reconcile(session.store, output, {
      asof: m.date,
      msgId: m.msg_id,
      threadId: it.threadId,
      channel: m.channel || 'mail', // stamps the evidence trail (specs/superlazy-inputs.md)
      // chat items: the conversation title ("Slack DM: A, B" / "#chan") — the task row's
      // attribution shows it, since a chunk's nominal sender (first author) is often ME
      via: (m.channel === 'messages' && m.subject) || null,
      from: m.from && m.from.address,
      briefProjectIds: assembled.briefProjectIds,
      tmpTodo: batchTmpTodo,
      tmpProj: batchTmpProj,
      summary: typeof output.message_summary === 'string' ? output.message_summary.trim() : null,
      rules: rulesApplied
    })
    // every project this message touched is re-sent CURRENT in the next call's updates section
    // only projects whose CATALOG ROW changed materially force a fresh updates row (reconcile
    // splits these out; a read-only filing is persisted but not snapshot-touched)
    for (const pid of (applied && (applied.snapshot_touch_ids || applied.touched_project_ids)) || []) snap.touched.add(pid)

    // profile updates are honored only for people ON this message:
    // an update for an arbitrary address would create an in-memory profile the driver never
    // persists (it saves only the message's participants) — applied, influential, then lost.
    const onThisMsg = new Set([m.from, ...(m.to || []), ...(m.cc || [])]
      .map(x => String((x && x.address) || '').toLowerCase()).filter(Boolean))
    const profileUpdates = (output.profile_updates || []).filter(u => {
      const a = String(u.address || '').toLowerCase()
      return a && onThisMsg.has(a) && !session.meSet.has(a)
    })
    const profUpdates = session.profiles.applyUpdates(profileUpdates, m.date)
    // a cached profile that has since changed must be re-sent in full by the volatile block until
    // the cold block is rendered again (same override discipline as a touched project's row)
    if (session.snapshot) {
      session.snapshot.touchedPeople = session.snapshot.touchedPeople || new Set()
      for (const u of profUpdates) {
        const a = String((u && (u.address || u)) || '').toLowerCase()
        if (a) session.snapshot.touchedPeople.add(a)
      }
    }
    const { reprofiles } = await maintainProfiles(session, { newMsg: m, asof: m.date }, out)
    // a re-profile rewrites the whole profile, so it invalidates a cached copy just as an update does
    if (session.snapshot) {
      session.snapshot.touchedPeople = session.snapshot.touchedPeople || new Set()
      for (const r of reprofiles) {
        const a = String((r && r.address) || '').toLowerCase()
        if (a && r.outcome !== 'error') session.snapshot.touchedPeople.add(a)
      }
    }
    for (const r of reprofiles) {
      spend.reprofileCost += r.cost || 0
      perSpend.reprofile += r.cost || 0
      perSpend.cost += r.cost || 0
      if (r.meta) addUsage(r.meta)
      else { spend.calls++; spend.cost += r.cost || 0 }
    }

    const allTriggers = [
      ...(output.triggers || []),
      ...inferAutomatedTriggers(output, applied, m, session.store)
    ]
    const backstopped = backstopAutomatedItem(allTriggers, applied, m, session.store, { asof: m.date, msgId: m.msg_id, threadId: it.threadId, batchMsgIds: items.map(x => x.newMsg.msg_id) })
    const triggersFired = await dispatchTriggers(allTriggers, { freezr: session.freezr, newMsg: m, output, applied, profiles: session.profiles, store: session.store, asof: m.date, threadId: it.threadId, accountId: it.accountId || null })

    out({
      type: 'step', idx, total, globalIdx: session.processed, thread_id: it.threadId, msg: m,
      roster: assembled.roster, asof: m.date,
      userMessage: assembled.volatileBlock, raw: result.raw, output,
      applied, profUpdates, reprofiles, triggersFired,
      // standing-instruction metrics: which ids were in this request's prompt, and which of them
      // the model says changed the outcome. Both halves are needed — a cited count means nothing
      // without knowing how often the instruction was offered in the first place.
      rules_offered: [...offeredRules],
      rules_applied: rulesApplied,
      backstopped_item: backstopped ? backstopped.todo.todo_id : null,
      autoprocess_blocked: autoprocessBlocked,
      unlearned,
      fetchRounds: rounds, meta: result.meta, totalCost: session.totalCost,
      // what this request was MADE OF (chars per section, measured by assemble) + what rode in the
      // cached prefix — persisted onto the event so cost patterns can be diagnosed from the record
      // instead of re-guessed every time the bill looks wrong
      request_profile: {
        volatile_chars: assembled.volatileBlock.length,
        sections: (assembled.size && assembled.size.sections) || {},
        reduce_level: (assembled.size && assembled.size.level) || 0,
        snapshot_chars: ((snap && snap.chars) || 0) + ((snap && snap.cold && snap.cold.chars) || 0),
        snapshot_projects: ((snap && snap.count) || 0) + ((snap && snap.cold && snap.cold.count) || 0),
        snapshot_hot_projects: (snap && snap.count) || 0,
        prior_turns: priorTurns.length,
        rounds: rounds + 1
      },
      via_batch: batchId, batch_size: llm.length,
      // this message's SHARE of the batch call, plus every re-profile it alone set off
      duration_ms: Date.now() - startedAt,
      cost: perSpend.cost,
      cost_analysis: perSpend.analysis,
      cost_reprofiles: perSpend.reprofile,
      llm_calls: spend.calls,
      tokens: {
        input: Math.round(callTokens.input * (weights[i] / weightSum)),
        output: Math.round(callTokens.output * (weights[i] / weightSum)),
        other: Math.round(callTokens.other * (weights[i] / weightSum)),
        cache_read: Math.round(callTokens.cacheRead * (weights[i] / weightSum)),
        cache_write: Math.round(callTokens.cacheWrite * (weights[i] / weightSum)),
        thinking: Math.round(callTokens.thinking * (weights[i] / weightSum)),
        total: Math.round((callTokens.input + callTokens.output + callTokens.other) * (weights[i] / weightSum))
      }
    })
    session.processed++
    noteProcessedForSnapshot(session, m)
    results.push({ ok: true, applied, msg_id: m.msg_id })
  }

  return { ok: results.some(r => r.ok), results, missing }
}
