// bootstrapCall.js — the LLM calls of the bulk bootstrap (specs/superlazy-bulk-bootstrap.md §2/§5).
// The model streams its map as JSONL — one self-contained JSON object per line — so sections are
// PARSED AND SHOWN AS THEY ARRIVE, and one malformed line costs one section, never the whole run
// (the failure mode of the old single-object contract: 20 minutes of output, then "not an object").
// Refinement is REPEATABLE: every round appends turns to the same conversation, and the llm
// `cache` option re-reads the dump + earlier turns at ~10%, so a back-and-forth is affordable.
// Nothing here persists anything: the Setup page saves the map through adopt.js when the user presses Save.

import { BOOTSTRAP_SYSTEM_PROMPT, BOOTSTRAP_PROMPT_VERSION, buildRefinementMessage } from './bootstrapPrompt.js'
import { translateIds } from './dumpBuilder.js'

export { BOOTSTRAP_PROMPT_VERSION, buildRefinementMessage }

// A dump-sized request legitimately runs minutes; a stalled connection hangs forever. Same
// discipline as processor.js withTimeout, with a bulk-sized budget (streamBack keeps bytes flowing,
// so a genuinely live call never trips this).
const BULK_TIMEOUT_MS = 20 * 60 * 1000
// The output budget must cover THINKING + the map. Recent Claude models think by default when the
// caller sends no `thinking` parameter (freezr's connector omits it unless asked), and thinking
// tokens are billed against max_tokens — a 30k budget spent mostly on thinking is what truncated
// the first live run before it reached the autofile/questions/done sections.
const MAX_OUTPUT_TOKENS = 64000
// Older/smaller models cap output far lower and 400 on a big ask; retry once at a safe value.
const FALLBACK_OUTPUT_TOKENS = 8000
// A truncated reply is resumable: the conversation (incl. the dump) is cached, so asking for the
// rest costs a fraction. Bounded so a model that keeps stopping can't loop forever.
const MAX_CONTINUATIONS = 2

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), ms)
  promise.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
})

import { createSectionParser } from '../analyze_thread/maintenance/sectionParser.js'
export { createSectionParser }

// Assemble the flat output object the page stores, from the stream of section objects.
// `seed` continues an EARLIER map (a resumed run keeps everything already received).
export function createAssembler (seed) {
  const out = seed || {
    business_context: '',
    me: null,
    projects: [],
    profiles: [],
    autofile_candidates: [],
    open_questions: [],
    fetch_requests: []
  }
  return {
    out,
    add (s) {
      if (s.section === 'business_context') out.business_context = s.markdown || ''
      else if (s.section === 'me') out.me = { addresses: s.addresses || [], role_guess: s.role_guess || '' }
      else if (s.section === 'project') out.projects.push(s)
      else if (s.section === 'profile') out.profiles.push(s)
      else if (s.section === 'autofile') out.autofile_candidates.push(s)
      else if (s.section === 'question') out.open_questions.push(s)
      else if (s.section === 'fetch_request') out.fetch_requests.push(s)
    }
  }
}

/**
 * ONE streamed call on an existing conversation. Sections are translated to REAL ids and handed
 * to onSection AS THEY ARRIVE (progressive rendering); the assembled output comes back at the end.
 * ALWAYS returns/throws with the call's meta attached, so the caller can record spend either way.
 *
 * @returns {Promise<{ output, raw, meta, parse: { lines, badLines, done, counts } }>}
 */
// ONE streamed turn. Feeds the shared parser/assembler so a CONTINUATION turn keeps adding to the
// same map. onThinking is wired: recent models think before writing, and without it the page shows
// nothing for minutes (the whole reply then lands at once — the first live run's complaint).
async function askOnce ({ freezr, conversation, maps, model, parser, onDelta, onThinking, maxTokens }) {
  const opts = {
    context: BOOTSTRAP_SYSTEM_PROMPT,
    max_tokens: maxTokens || MAX_OUTPUT_TOKENS,
    cache: true,               // system + user-turn breakpoints → later turns re-read at ~10%
    streamBack: true,
    onDelta: (text) => {
      parser.feed(text)
      if (onDelta) onDelta(text)
    },
    onThinking: (text) => { if (onThinking) onThinking(text) }
  }
  if (model && model.provider) opts.provider = model.provider
  if (model && model.family) opts.family = model.family
  let res
  try {
    res = await withTimeout(
      freezr.llm.ask(conversation, opts),
      BULK_TIMEOUT_MS,
      'no response for ' + Math.round(BULK_TIMEOUT_MS / 60000) + ' min (connection or provider stall)'
    )
  } catch (e) {
    // a model whose output ceiling is below our ask rejects the request outright — retry small
    const msg = String((e && e.message) || '').toLowerCase()
    if ((maxTokens || MAX_OUTPUT_TOKENS) > FALLBACK_OUTPUT_TOKENS && /max_tokens|max tokens|too large|exceed/.test(msg)) {
      console.warn('[superlazy bootstrap] model rejected max_tokens — retrying at ' + FALLBACK_OUTPUT_TOKENS)
      return askOnce({ freezr, conversation, maps, model, parser, onDelta, onThinking, maxTokens: FALLBACK_OUTPUT_TOKENS })
    }
    throw e
  }
  if (!res || res.success === false) {
    const e = new Error('llm.ask failed: ' + ((res && (res.error || res.response)) || 'no response'))
    e.meta = res && res.meta
    throw e
  }
  return res
}

/**
 * A streamed exchange that RESUMES if the model stops before its done-marker. Sections stream
 * into one shared parser/assembler across the continuation turns, so the caller sees one map.
 */
async function askStreaming ({ freezr, conversation, maps, model, onSection, onDelta, onThinking, onContinue, seedOutput }) {
  const assembler = createAssembler(seedOutput)
  const parser = createSectionParser((s) => {
    const t = maps ? translateSection(s, maps) : s
    assembler.add(t)
    if (onSection) onSection(t)
  })

  const metas = []
  let raw = ''
  let parse = null
  let failure = null
  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    let res
    try {
      res = await askOnce({ freezr, conversation, maps, model, parser, onDelta, onThinking })
    } catch (e) {
      // Network drop, expired token, exhausted credit, provider stall — treat it EXACTLY like a
      // truncation: keep everything already streamed, keep the conversation, let the caller
      // resume. Only a failure with nothing at all to show is fatal (thrown below).
      failure = e
      if (e && e.meta) metas.push(e.meta)
      parse = parser.finish()
      break
    }
    metas.push(res.meta || {})
    const chunk = typeof res.response === 'string' ? res.response : JSON.stringify(res.response)
    raw += (raw ? '\n' : '') + chunk
    parse = parser.finish()
    conversation.push({ role: 'assistant', content: chunk })
    if (parse.done) break
    if (attempt === MAX_CONTINUATIONS) break
    // Ran out of room mid-stream (thinking + output share max_tokens). Everything parsed so far is
    // real; ask only for the REST — cached, so this costs a fraction of a fresh call.
    const have = assembler.out
    if (onContinue) onContinue(attempt + 1, have)
    conversation.push({
      role: 'user',
      content: 'Your output stopped before the {"section":"done"} line — you ran out of room. ' +
        'CONTINUE from exactly where you stopped: emit ONLY the sections you had not yet sent, in the same ' +
        'JSONL format, and finish with the done line. Do NOT repeat sections you already sent — so far you ' +
        'have sent: business_context=' + (have.business_context ? 'yes' : 'no') +
        ', projects=' + have.projects.length + ' (last: "' + ((have.projects[have.projects.length - 1] || {}).name || '—') + '")' +
        ', profiles=' + have.profiles.length +
        ', autofile=' + have.autofile_candidates.length +
        ', questions=' + have.open_questions.length + '. Be terse to fit.'
    })
  }

  const output = assembler.out
  const gotSomething = !!output.business_context || output.projects.length > 0
  if (!gotSomething) {
    const e = failure || new Error('the reply contained no parseable sections (' + (parse ? parse.badLines : '?') + ' bad line(s))')
    e.raw = raw
    e.meta = mergeMeta(metas)
    throw e
  }
  return {
    output,
    raw,
    meta: mergeMeta(metas),
    parse: parse || {},
    turns: metas.length,
    // RESUMABLE STATE: set when the exchange stopped early (cut off, or a failure part-way).
    // The caller shows what arrived and can continue the same cached conversation.
    incomplete: !(parse && parse.done),
    failure: failure ? ((failure && failure.message) || String(failure)) : null,
    conversation
  }
}

/**
 * Continue an exchange that stopped early — truncation, a dropped connection, an exhausted
 * credit. Streams only the MISSING sections into the map already assembled (`seedOutput`), on the
 * same cached conversation, so it costs a fraction of starting again.
 */
export async function resumeBootstrap ({ freezr, conversation, maps, model, seedOutput, onSection, onDelta, onThinking, onContinue }) {
  const have = seedOutput || {}
  // if the previous turn died mid-flight its assistant reply never landed — don't leave a
  // dangling user turn, the provider requires alternation
  const last = conversation[conversation.length - 1]
  if (last && last.role === 'user') conversation.pop()
  conversation.push({
    role: 'user',
    content: 'Your output stopped before the {"section":"done"} line. CONTINUE from where you stopped: ' +
      'emit ONLY the sections you had not yet sent, in the same JSONL format, and finish with the done line. ' +
      'Do NOT repeat what you already sent — so far: business_context=' + (have.business_context ? 'yes' : 'no') +
      ', projects=' + ((have.projects || []).length) +
      ' (last: "' + (((have.projects || [])[(have.projects || []).length - 1] || {}).name || '—') + '")' +
      ', profiles=' + ((have.profiles || []).length) +
      ', autofile=' + ((have.autofile_candidates || []).length) +
      ', questions=' + ((have.open_questions || []).length) + '. Be terse to fit.'
  })
  return askStreaming({ freezr, conversation, maps, model, onSection, onDelta, onThinking, onContinue, seedOutput: have })
}

// Sum the cost/tokens of every turn an exchange took, so the page bills a continued run honestly.
function mergeMeta (metas) {
  const base = metas[metas.length - 1] || {}
  if (metas.length === 1) return base
  const sum = (get) => metas.reduce((n, m) => n + (Number(get(m)) || 0), 0)
  const t = (m, k) => ((m.tokensUsed || {})[k] || {}).qtty
  return {
    ...base,
    turns: metas.length,
    cost: {
      ...(base.cost || {}),
      totalCost: sum(m => (m.cost || {}).totalCost),
      inputCost: sum(m => (m.cost || {}).inputCost),
      outputCost: sum(m => (m.cost || {}).outputCost),
      totalTokens: sum(m => (m.cost || {}).totalTokens)
    },
    tokensUsed: {
      input: { qtty: sum(m => t(m, 'input')), cost: null },
      output: { qtty: sum(m => t(m, 'output')), cost: null },
      other: {
        qtty: sum(m => t(m, 'other')),
        cost: null,
        details: ((base.tokensUsed || {}).other || {}).details || {}
      }
    }
  }
}

// Translate ONE section's surrogate ids to real ids (progressive-rendering variant of
// dumpBuilder.translateIds, which handles the assembled object).
function translateSection (s, maps) {
  const m = (id) => (maps.realMsgId[id] || id)
  const t = (id) => (maps.realThreadId[id] || id)
  const arr = (a, fn) => Array.isArray(a) ? a.map(fn) : a
  if (s.section === 'project') {
    s.thread_ids = arr(s.thread_ids, t)
    s.evidence_msg_ids = arr(s.evidence_msg_ids, m)
    for (const td of (s.todos || [])) td.evidence_msg_ids = arr(td.evidence_msg_ids, m)
    for (const it of (s.notable_open_items || [])) it.evidence_msg_ids = arr(it.evidence_msg_ids, m)
  } else if (s.section === 'profile' || s.section === 'autofile') {
    s.evidence_msg_ids = arr(s.evidence_msg_ids, m)
  } else if (s.section === 'fetch_request') {
    s.msg_id = m(s.msg_id)
  }
  return s
}

/** Call 1: the dump → the map. Returns the started conversation for later refinement rounds. */
export async function runBootstrap ({ freezr, dumpText, maps, model, onSection, onDelta, onThinking, onContinue }) {
  const conversation = [{ role: 'user', content: dumpText }]
  const r = await askStreaming({ freezr, conversation, maps, model, onSection, onDelta, onThinking, onContinue })
  return { ...r, conversation } // askStreaming already appended each assistant turn
}

/**
 * A refinement round — REPEATABLE. Appends the user's turn + the model's reply to `conversation`
 * (mutated in place), so each further round carries the whole exchange and the cache pays.
 * `resolveBody(realMsgId)` answers pending fetch_requests with full untruncated bodies.
 */
export async function refineBootstrap ({ freezr, conversation, maps, model, editedContext, answers, freeText, fetchRequests, resolveBody, onSection, onDelta, onThinking, onContinue }) {
  const fetchedBodies = []
  for (const f of (fetchRequests || []).slice(0, 10)) {
    if (!resolveBody) break
    try {
      const body = await resolveBody(f.msg_id)
      const sur = maps.surrogateMsgId[f.msg_id] || f.msg_id
      if (body) fetchedBodies.push('--- full body of msg ' + sur + ' (you asked: ' + (f.reason || '') + ')\n' + body)
    } catch (e) { /* a missing body never blocks the refinement */ }
  }
  conversation.push({ role: 'user', content: buildRefinementMessage({ editedContext, answers, freeText, fetchedBodies }) })
  return askStreaming({ freezr, conversation, maps, model, onSection, onDelta, onThinking, onContinue })
}

export { translateIds }
