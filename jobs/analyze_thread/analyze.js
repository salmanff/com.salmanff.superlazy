// analyze.js — PERMANENT core (v0.3). The single LLM call. Returns either an ANALYSIS
// (projects-nested) or a REQUEST_MORE (the model asks for a prior message body / project detail).
// freezr is passed in, so this runs unchanged from the browser (Part 1) or a job (Part 4).

import { SYSTEM_PROMPT, PROMPT_VERSION } from './prompt.js'

// THE REPLY AS TEXT. With responseType:'json' freezr hands back a PARSED OBJECT, not a string — so
// String(response) yields "[object Object]". That matters wherever the reply is put back on the
// wire (a conversation turn must be a string or a content array) or shown to a human, so every use
// of `res.response` as text goes through here.
export const replyText = (response) => {
  if (response == null) return ''
  return typeof response === 'string' ? response : JSON.stringify(response)
}

// A TURN AS TEXT. A turn's content is a string, or a content-block array (the durable turn rides as
// [{ type:'text', text, cache_control }] so it carries its own cache breakpoint — engine.durableTurn).
// Every place that measures or shows a turn goes through here, or the durable turn logs as
// "[object Object]" (15 chars) and the inspect page shows nothing of the catalog that was sent.
export const turnText = (turn) => {
  const c = turn && turn.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(b => (b && typeof b.text === 'string') ? b.text : '').join('')
  return c == null ? '' : String(c)
}

function coerce (response) {
  if (response && typeof response === 'object') return response
  let s = String(response || '').trim()
  s = s.replace(/^```(json)?/i, '').replace(/```$/, '').trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first > 0 || last < s.length - 1) { if (first >= 0 && last > first) s = s.slice(first, last + 1) }
  try { return JSON.parse(s) } catch (e) { return null }
}

// Returns { type: 'analysis' | 'batch' | 'request_more' } or an error string.
// A BATCH reply wraps one analysis entry per input message in message_results[] (prompt.js
// "Batch input"); each entry is validated with the same rules as a single analysis.
const ACCOUNT_VERDICTS = ['resolved', 'in_progress', 'cancelled', 'open']
// expectedIds: the todo_ids this entry's "Open items to account for" block listed (prompt 0.61).
// A verdict per line is what the block demands, and it used to be unenforceable: the model skipped
// the whole block on about a third of runs (haiku and sonnet alike, measured 2026-09-26) and the
// reply still parsed. Now a missing verdict is an invalid reply and gets the repair round.
function classifyOne (o, expectedIds) {
  if (!Array.isArray(o.projects)) return { error: 'output has neither projects[] nor request_more[]' }
  if (!o.latest_delta) return { error: 'missing latest_delta' }
  if (Array.isArray(expectedIds) && expectedIds.length) {
    const af = Array.isArray(o.account_for) ? o.account_for : []
    const bad = af.find(v => !v || !v.todo_id || !ACCOUNT_VERDICTS.includes(String(v.verdict)))
    if (bad) return { error: 'account_for entry without a todo_id or with a verdict outside resolved | in_progress | cancelled | open: ' + JSON.stringify(bad).slice(0, 120) }
    const given = new Set(af.map(v => String(v.todo_id)))
    const missing = expectedIds.filter(id => !given.has(String(id)))
    if (missing.length) return { error: 'account_for is missing a verdict for ' + missing.join(', ') + ' — every line of the "Open items to account for" block needs one { todo_id, verdict, reason } entry' }
  }
  for (const p of o.projects) {
    if (!Array.isArray(p.todos)) return { error: 'a project is missing todos[]' }
  }
  // A reply with NO NEW ITEMS is not an error — 40% of real analysed messages create nothing, and
  // the prompt explicitly asks for an empty entry when a message changes nothing. What is never
  // legitimate is an entry with no MESSAGE_SUMMARY: that sentence is required of every entry and
  // is what the activity feed shows, so a model that skips it did not do the work rather than
  // deciding there was none. Measured 2026-09-19: 0 of 757 stored analyses lack a summary, while
  // small models on other providers returned batches of 8-10 entries with every summary blank
  // (specs/analysis-experiments.md (E3)). Those replies are silent failures — the user
  // never learns the mail was read — so they are rejected and repaired like any malformed JSON.
  if (typeof o.message_summary !== 'string' || !o.message_summary.trim()) {
    return { error: 'missing message_summary (an entry that records nothing must still say what the message was)' }
  }
  return { type: 'analysis' }
}

// EXPORTED so the reply contract can be asserted directly — it is the one place that decides
// whether a reply is usable, and what counts as an empty-but-legitimate analysis.
// expectAccountFor: { handle: [todo_id, …] } — the ids each message's account-for block listed
export function classify (o, expectedMsgIds, expectAccountFor = null) {
  if (!o || typeof o !== 'object') return { error: 'not an object' }
  if (Array.isArray(o.request_more)) return { type: 'request_more' }
  const idsFor = (handle) => (expectAccountFor && handle != null && expectAccountFor[String(handle)]) || null
  if (Array.isArray(o.message_results)) {
    if (!o.message_results.length) return { error: 'message_results is empty' }
    for (const r of o.message_results) {
      if (!r || !r.msg_id) return { error: 'a message_results entry has no msg_id' }
      const c = classifyOne(r, idsFor(r.msg_id))
      if (c.error) return { error: 'entry ' + r.msg_id + ': ' + c.error }
    }
    return { type: 'batch' }
  }
  // A single-entry reply to a batch request is acceptable ONLY when one message was asked about;
  // otherwise the model silently dropped messages — surface it rather than losing them.
  if (expectedMsgIds && expectedMsgIds.length > 1) {
    return { error: 'expected message_results with ' + expectedMsgIds.length + ' entries' }
  }
  const single = expectAccountFor ? Object.values(expectAccountFor)[0] : null
  return classifyOne(o, (expectedMsgIds && expectedMsgIds.length === 1 ? idsFor(expectedMsgIds[0]) : null) || single || null)
}

// OUTPUT ceilings. Raising these is free: providers bill the tokens actually generated, not the cap,
// so the only thing a low ceiling buys is truncated JSON — which parses to nothing, wastes the whole
// input, and shows up as the useless error "not an object". A busy thread legitimately emits many
// to-dos and drafts, so give it room.
// THINKING SHARES THIS BUDGET. Current Claude models (Sonnet 5, Opus 5, 4.6+) think by DEFAULT when
// no thinking parameter is sent, and those tokens are billed and counted as output — so a ceiling
// sized for the answer alone lets the model think itself out of room and return an EMPTY reply
// after minutes of work. That is not a hypothesis: a 9-message batch did exactly this twice, 3
// minutes each, 0 characters back. The budget must cover reasoning AND the JSON.
const MAX_TOKENS = 40000
// a reply cut off (or thought away) gets more room on the retry — 1.4x whatever the base cap is
const repairCapFor = (cap) => Math.round(cap * 1.4)

// Did the reply run out of output budget? A truncated JSON reply is the commonest cause of
// "not an object", and it is the one failure where re-asking IDENTICALLY is guaranteed to fail
// again — so it gets a different repair (more room + an explicit instruction to be terser).
// `cap` must be the max_tokens the reply was actually generated under (base vs repair differ).
function looksTruncated (res, cap) {
  const raw = replyText(res && res.response)
  if (!raw) return false
  const used = res && res.meta && res.meta.tokensUsed && res.meta.tokensUsed.output
  const qtty = used && Number(used.qtty)
  if (qtty && qtty >= cap - 50) return true
  // ends mid-structure: unbalanced braces with no closing one at the end
  const opens = (raw.match(/\{/g) || []).length
  const closes = (raw.match(/\}/g) || []).length
  return opens > closes && !/\}\s*$/.test(raw.trim())
}

// SERVER LOGS CARRY NO BODIES. In the browser the full-exchange dumps below collapse into groups;
// in a job they flatten into the server log as plain text — every email body, prompt and reply
// lands in a file that outlives the run. So anything running server-side logs META ONLY (sizes,
// options, usage, subject); the full exchange is still available via `capture` (the inspect page).
const IS_SERVER = typeof window === 'undefined'

// Dump what is needed to diagnose an invalid reply — WITHOUT it reading as if the model sent our
// prompt back. The sections are labelled unambiguously and the two big blobs are collapsed groups,
// so the console shows a one-line diagnosis by default and the bodies only when expanded.
const outTokens = (res) => {
  const u = res && res.meta && res.meta.tokensUsed && res.meta.tokensUsed.output
  return (u && Number(u.qtty)) || 0
}

// An empty reply that BURNED the output budget was not refused or dropped — the model reasoned
// until it had no room left to answer. It is the one empty-reply cause with a real fix (more
// room / less to chew on), so it must be named rather than hidden behind "usually oversized".
const thoughtItselfOut = (res, cap) => {
  const raw = replyText(res && res.response).trim()
  return !raw && outTokens(res) >= Math.round(cap * 0.6)
}

function logInvalid (attempt, error, res, userMessage, cap) {
  const raw = replyText(res && res.response)
  const t = (res && res.meta && res.meta.tokensUsed) || {}
  const q = (x) => ((x && Number(x.qtty)) || 0).toLocaleString()
  const usage = 'in ' + q(t.input) + ' · out ' + q(t.output) + ' · other ' + q(t.other) +
    ' · $' + (((res && res.meta && res.meta.cost && res.meta.cost.totalCost) || 0)).toFixed(4)
  const trunc = looksTruncated(res, cap || MAX_TOKENS)
  if (!raw.trim() && outTokens(res) > 0) {
    console.error('[superlazy] the model produced ' + outTokens(res).toLocaleString() + ' output tokens but NO text — ' +
      'it spent its whole budget thinking. Raising max_tokens / shrinking the request is the fix, ' +
      'not retrying identically.')
  }
  console.error('[superlazy] LLM output invalid (attempt ' + attempt + '): ' + error +
    ' · model ' + ((res && res.meta && res.meta.model) || '?') +
    ' · reply ' + raw.length.toLocaleString() + ' chars' +
    ' · prompt we sent ' + String(userMessage || '').length.toLocaleString() + ' chars' +
    (trunc ? ' · LOOKS TRUNCATED (the reply hit the output cap mid-JSON)' : ''))
  console.error('[superlazy] usage:', usage)
  const group = (label, body) => {
    if (console.groupCollapsed) {
      console.groupCollapsed(label)
      console.log(body)
      console.groupEnd()
    } else {
      console.log(label + '\n' + body)
    }
  }
  if (IS_SERVER) {
    console.error('[superlazy] ↳ prompt/reply bodies withheld from server logs — see the inspect page (capture) for the full exchange')
    return
  }
  group('[superlazy] ↳ THE MODEL’S REPLY (' + raw.length.toLocaleString() + ' chars) — this is what came back', raw)
  group('[superlazy] ↳ THE PROMPT WE SENT (' + String(userMessage || '').length.toLocaleString() +
    ' chars) — our own request, NOT the model’s reply', userMessage)
}

/**
 * One analysis call.
 * @param {Object} o
 * @param {string}  o.userMessage  the volatile block (what used to be the whole prompt)
 * @param {Array}  [o.priorTurns]  earlier conversation turns to prepend — the cached STABLE block
 *                                 ([{ role:'user', content: snapshotText }]) and, on a re-ask, the
 *                                 model's own request_more plus the resolved detail (§6)
 * @param {boolean|Object} [o.cache]  freezr llm cache option (true / { ttl: '1h' }): breakpoints
 *                                 the system prompt + each user turn, so the stable block bills at
 *                                 the provider's cached rate on every later call of the run
 * @param {Array}  [o.expectMsgIds] the batch's msg_ids — a reply missing entries is an error
 */
// EXCHANGE LOGGING. In the browser: everything sent and received, as collapsed console groups —
// expand a group to inspect the exact bytes. Server-side (jobs): META ONLY — turn sizes, options,
// usage — never the prompt/reply/thinking text. On by default while costs are under investigation;
// silence entirely with globalThis.SUPERLAZY_LOG_LLM = false.
const logExchange = (label, { opts, turns, userMessage, res }) => {
  if (globalThis.SUPERLAZY_LOG_LLM === false) return
  const tsum = (turns || [{ role: 'user', content: userMessage }])
    .map((t, i) => i + ':' + t.role + ' ' + turnText(t).length.toLocaleString() + 'ch').join(' · ')
  if (IS_SERVER) {
    // meta only — no prompt, reply or thinking text in the server log
    console.log('[superlazy] LLM exchange — ' + label + ' · turns: ' + tsum +
      ' · system prompt ' + String(opts.context || '').length.toLocaleString() + ' chars' +
      ' · max_tokens ' + opts.max_tokens + ' · thinking ' + JSON.stringify(opts.thinking) +
      (opts.cache ? ' · cache ' + JSON.stringify(opts.cache) : '') +
      (res
        ? ' · reply ' + replyText(res.response).length.toLocaleString() + ' chars' +
          (res.thinking ? ' · thinking ' + String(res.thinking).length.toLocaleString() + ' chars (BILLED AS OUTPUT)' : '') +
          ' · usage ' + JSON.stringify(res.meta && res.meta.tokensUsed)
        : ''))
    return
  }
  const g = console.groupCollapsed || console.log
  g.call(console, '[superlazy] LLM exchange — ' + label + ' · turns: ' + tsum)
  console.log('OPTIONS (system prompt ' + String(opts.context || '').length.toLocaleString() + ' chars):',
    { max_tokens: opts.max_tokens, thinking: opts.thinking, cache: opts.cache, responseType: opts.responseType, provider: opts.provider, family: opts.family })
  console.log('SENT (turns array — expand for full text):', turns || userMessage)
  if (res) {
    console.log('RECEIVED response (' + replyText(res.response).length.toLocaleString() + ' chars):', res.response)
    if (res.thinking) console.log('RECEIVED thinking (' + String(res.thinking).length.toLocaleString() + ' chars — BILLED AS OUTPUT):', res.thinking)
    console.log('USAGE:', res.meta && res.meta.tokensUsed, '· rawUsage:', res.meta && res.meta.rawUsage)
  }
  if (console.groupEnd) console.groupEnd()
}

// audit: engine-supplied identity for the request-audit record ({ chain_id, round, kind, msg_ids,
// subject, batch }); onExchange: the audit sink — called (not awaited) with every FINISHED exchange,
// success or failure, when settings.llm_audit is on (jobs/analyze_thread/llmAudit.js).
// systemPrompt / promptVersion: a LAB override of the system prompt (agentslabRun's A/B arms — see
// createDryRun's promptOverride). Absent, the module's own SYSTEM_PROMPT / PROMPT_VERSION are used,
// which is every production path. The version rides along so a captured exchange names its arm.
export async function analyzeThread (freezr, { userMessage, priorTurns, model, cache, thinking, effort, expectMsgIds, expectAccountFor, maxTokens, capture, audit, onExchange, structuredOutput, systemPrompt, promptVersion } = {}) {
  // thinking is OFF unless the caller opts in. Recent models think by default, thinking bills as
  // output, and on this request shape the model was observed spending its ENTIRE output budget
  // reasoning (40k tokens ≈ $0.60) on a routine email — 10x the cost of the analysis itself. The
  // per-message engine is high-volume structured extraction; depth belongs to the bootstrap and
  // the (future) weekly review, which opt in deliberately.
  // maxTokens: the output ceiling (Preferences: analysis_max_tokens); default MAX_TOKENS.
  // capture: optional array — every exchange (opts + turns + reply + usage) is pushed onto it,
  // so an inspection UI can show exactly what went over the wire (the inspect page uses this).
  const cap = Number(maxTokens) > 0 ? Number(maxTokens) : MAX_TOKENS
  const capRepair = repairCapFor(cap)
  const promptText = (typeof systemPrompt === 'string' && systemPrompt) ? systemPrompt : SYSTEM_PROMPT
  const promptVer = promptVersion || PROMPT_VERSION
  const opts = { context: promptText, responseType: 'json', max_tokens: cap, thinking: thinking === true ? true : false }
  if (effort) opts.effort = effort
  if (model && model.provider) opts.provider = model.provider
  if (model && model.family) opts.family = model.family
  if (cache) opts.cache = cache
  // Native structured output (2026-09-19). The ENGINE decides whether to send a schema (see
  // engine.schemaFor — ChatGPT yes, Claude no, on measured evidence); this function only carries
  // it. It rides on `opts`, so the repair round below inherits it automatically: a reply that
  // failed classify() is re-asked under the SAME constraint, never a looser one.
  if (structuredOutput && structuredOutput.schema) opts.structuredOutput = structuredOutput

  // The audit record must not carry the whole schema (~4k chars, identical on every exchange) —
  // a name, its size and a hash identify it; the module that built it is the source of truth.
  const schemaSummary = (so) => {
    if (!so || !so.schema) return undefined
    const text = JSON.stringify(so.schema)
    let h = 5381
    for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0
    return { name: so.name || null, schema_chars: text.length, schema_hash: h.toString(16) }
  }

  // Two-step capture: the entry is pushed BEFORE the ask (pending: true) so an inspection UI can
  // show the exact request while the model is still working, and filled in when the reply lands.
  const hasSink = typeof onExchange === 'function'
  const record = (phase, usedOpts, sentTurns) => {
    if (!Array.isArray(capture) && !hasSink) return null
    const entry = {
      phase, // 'analysis' | 'repair'
      ...(audit || {}), // chain_id, round, kind, msg_ids, subject, batch — set by the engine
      prompt_version: promptVer,
      at: Date.now(),
      pending: true,
      opts: { ...usedOpts, context: undefined, system_prompt_chars: String(usedOpts.context || '').length, structuredOutput: schemaSummary(usedOpts.structuredOutput) },
      turns: (sentTurns || [{ role: 'user', content: userMessage }]).map(t => ({ role: t.role, content: turnText(t), cached: Array.isArray(t.content) && t.content.some(b => b && b.cache_control) })),
      response: null,
      thinking: null,
      meta: null,
      error: null
    }
    if (Array.isArray(capture)) capture.push(entry)
    return entry
  }
  // err: the exception when the ask itself threw (a 400, a network failure) — the exchange is still
  // recorded, with the error, so the audit shows requests that never got a reply too.
  const recordReply = (entry, res, err) => {
    if (!entry) return
    entry.pending = false
    entry.duration_ms = Date.now() - entry.at
    entry.response = res ? replyText(res.response) : null
    entry.thinking = (res && res.thinking) || null
    entry.meta = (res && res.meta) || null
    entry.error = err ? ((err && err.message) || String(err)) : (res && res.success === false ? replyText(res.response) : null)
    if (hasSink) { try { Promise.resolve(onExchange(entry)).catch(() => {}) } catch (e) { /* the audit never breaks the run */ } }
  }

  // A conversation whenever there are prior turns; a bare string otherwise (identical bytes to the
  // pre-batch behaviour, so nothing changes for the single-message path without a snapshot).
  const turns = (priorTurns && priorTurns.length)
    ? [...priorTurns, { role: 'user', content: userMessage }]
    : null
  const mainEntry = record('analysis', opts, turns)
  let res
  try { res = await freezr.llm.ask(turns || userMessage, opts) } catch (e) { recordReply(mainEntry, null, e); throw e }
  if (!res || res.success === false) { recordReply(mainEntry, res); throw new Error('llm.ask failed: ' + (res && res.response ? res.response : 'no response')) }
  logExchange('analysis', { opts, turns, userMessage, res })
  recordReply(mainEntry, res)
  // TRIPWIRE. This call asks for NO thinking; if reasoning text comes back anyway, the off-switch
  // was lost in transit — in practice: the freezr server is running code from before the
  // thinking-false fix and needs a restart. Every reasoning token bills as OUTPUT, so this is the
  // signature of a reply that costs 10x what its content justifies (observed: 6,776 output tokens
  // carrying one status change).
  if (opts.thinking === false && res.thinking && String(res.thinking).length > 400) {
    console.warn('[superlazy] ⚠ the model THOUGHT despite thinking:false (' +
      String(res.thinking).length.toLocaleString() + ' chars of reasoning, billed as output). ' +
      'The freezr server is running pre-fix code — restart it; this is where the oversized bills come from.')
  }
  let parsed = coerce(res.response)
  let c = classify(parsed, expectMsgIds, expectAccountFor)

  if (c.error) {
    logInvalid(1, c.error, res, userMessage, cap)
    // The repair round is a CONVERSATION, not a re-ask. The old code re-sent the whole prompt with a
    // note appended, which on a long thread meant paying for the entire input twice (~29k tokens on
    // the message that prompted this change) and gave the model no sight of what it got wrong —
    // so a truncated reply was simply truncated again. Handing back its own output costs about the
    // same and lets it fix that output; when the reply was cut off it also gets more room and is
    // told to be terser, which is the only thing that can actually work.
    const truncated = looksTruncated(res, cap)
    const raw = replyText(res && res.response)
    const burnedBudget = thoughtItselfOut(res, cap)
    const instruction = !raw.trim()
      ? (burnedBudget
          ? 'Your previous reply used the ENTIRE output budget on reasoning and returned no text at ' +
            'all. Do NOT deliberate further: you have already done the thinking. Write the JSON now, ' +
            'as briefly as the schema allows — one short sentence per summary/description, only ' +
            'genuinely new or changed to-dos, every optional field omitted. No prose, no code fences.'
          : 'Your previous reply was EMPTY — nothing came back at all. Reply now with the analysis as ' +
            'plain JSON text: either the analysis shape or a request_more. No prose, no code fences.')
      : truncated
        ? 'Your reply was CUT OFF before the JSON was complete, so it could not be parsed. Reply again ' +
          'with the COMPLETE JSON and make it shorter: keep summaries and descriptions to one short ' +
          'sentence, emit only genuinely new or changed to-dos, and omit every optional field you can. ' +
          'No prose, no code fences.'
        : 'Your previous reply was invalid (' + c.error + '). Reply again with ONLY valid JSON — either ' +
          'the analysis shape or a request_more — no prose, no code fences.'
    // Echo the broken reply back so the model can see what it got wrong — but NOT when it is empty
    // (an empty assistant turn is rejected outright by the providers, which would turn a recoverable
    // parse failure into a hard API error) and NOT when it is gigantic (re-spending the tokens it
    // already wasted buys nothing; the signal is in the instruction).
    const echoable = raw.trim().length > 0 && raw.length <= 40000
    // more room whenever the budget itself was the problem — cut off mid-JSON, or thought away
    const repairCap = (truncated || burnedBudget) ? capRepair : cap
    const repairOpts = { ...opts, max_tokens: repairCap }
    // An EMPTY reply is not a formatting mistake — the model produced nothing at all. In practice
    // that means the request itself was rejected or dropped somewhere in the chain, and asking again
    // in exactly the same way is the least likely thing to work. Drop responseType so the reply comes
    // back as plain text (which coerce() parses anyway): if the JSON mode was what returned nothing,
    // this recovers, and the log then shows it recovered on the plain-text retry.
    if (!raw.trim()) delete repairOpts.responseType
    const base = [...(priorTurns || []), { role: 'user', content: userMessage }]
    const conversation = echoable
      ? [...base, { role: 'assistant', content: raw }, { role: 'user', content: instruction }]
      : [...base, { role: 'user', content: instruction }]
    const repairEntry = record('repair', repairOpts, conversation)
    try { res = await freezr.llm.ask(conversation, repairOpts) } catch (e) { recordReply(repairEntry, null, e); throw e }
    logExchange('repair round', { opts: repairOpts, turns: conversation, res })
    recordReply(repairEntry, res)
    parsed = coerce(res && res.response)
    c = classify(parsed, expectMsgIds, expectAccountFor)
    if (c.error) {
      logInvalid(2, c.error, res, userMessage, repairCap)
      const bothEmpty = !raw.trim() && !replyText(res && res.response).trim()
      const burnedTwice = burnedBudget || thoughtItselfOut(res, repairCap)
      const err = new Error(bothEmpty
        ? (burnedTwice
            ? 'the AI spent its whole output budget reasoning and never wrote an answer, twice ' +
              '(' + outTokens(res).toLocaleString() + ' output tokens, no text, on a ' +
              String(userMessage || '').length.toLocaleString() + '-character request) — too much to ' +
              'weigh up in one go'
            : 'the AI returned an EMPTY reply twice (nothing at all, on a ' + String(userMessage || '').length.toLocaleString() +
              '-character request) — full exchange dumped to the browser console')
        : 'LLM output invalid after one retry: ' + c.error +
          (looksTruncated(res, repairCap) ? ' (the reply was cut off mid-JSON — the message is probably too long to analyse in one pass)' : '') +
          ' — full exchange dumped to the browser console')
      err.raw = replyText(res && res.response) // shown in the UI/event — never an object
      err.meta = res && res.meta
      // "the request was too much for one call" — the caller's cue to split the batch and retry
      // the messages one at a time rather than abandoning the whole run.
      err.tooMuchAtOnce = bothEmpty || burnedTwice || looksTruncated(res, repairCap)
      throw err
    }
  }

  // prompt_version rides INSIDE meta as well as beside it: persist.addEvent reads it off ev.meta,
  // so events used to store prompt_version: null and a run could not be attributed to a prompt.
  return { type: c.type, output: parsed, meta: { ...(res.meta || {}), prompt_version: promptVer }, raw: res.response, prompt_version: promptVer }
}
