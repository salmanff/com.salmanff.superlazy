// jobs/analyze_thread/maintenance/cleanupCall.js — the ONE streamed LLM call of the weekly clean-up
// (specs/superlazy-weekly-cleanup.md §2.1). Turn 1 is the state + input block, marked as a cache
// breakpoint explicitly (so the small closing turn can change between runs without rewriting the
// cache); turn 2 is the closing turn. JSONL sections are parsed as they arrive on the shared
// section parser. Two kinds of follow-up are handled on the SAME conversation, so the big prefix
// is re-read from cache: a `need` line (the model asks for bodies / threads / project detail — at
// most NEED_ROUNDS answered) and a continuation nudge when the reply stops before its done line.
// Nothing here persists anything — except, when the caller passes `onExchange`, every finished
// exchange is handed to it in the analysis audit's entry shape (llmAudit.auditRecordFrom), so a
// clean-up request can be replayed byte for byte like an analysis request (2026-09-25: the same
// state produced the right verdicts on opus/0.3 and none on sonnet/0.4, and nothing recorded which).

import { createSectionParser } from './sectionParser.js'

const TIMEOUT_MS = 15 * 60 * 1000
const MAX_OUTPUT_TOKENS = 32000
const NEED_ROUNDS = 2
const CONTINUATIONS = 1

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), ms)
  promise.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
})

const cachedTurn = (text) => ({ role: 'user', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] })

// translate the model's surrogate ids back to real ids, everywhere a section carries them
function translate (s, maps) {
  if (!maps) return s
  const m = (id) => (maps.realMsgId && maps.realMsgId[id]) || id
  if (Array.isArray(s.evidence)) s.evidence = s.evidence.map(m)
  if (Array.isArray(s.items)) {
    for (const it of s.items) {
      if (it.msg_id) it.msg_id = m(it.msg_id)
      if (it.thread_id && maps.realThreadId && maps.realThreadId[it.thread_id]) it.thread_id = maps.realThreadId[it.thread_id]
    }
  }
  return s
}

function sumMetas (metas) {
  const base = metas[metas.length - 1] || {}
  if (metas.length <= 1) return base
  const sum = (get) => metas.reduce((n, m) => n + (Number(get(m)) || 0), 0)
  return {
    ...base,
    turns: metas.length,
    cost: { ...(base.cost || {}), totalCost: sum(m => (m.cost || {}).totalCost), inputCost: sum(m => (m.cost || {}).inputCost), outputCost: sum(m => (m.cost || {}).outputCost), totalTokens: sum(m => (m.cost || {}).totalTokens) },
    tokensUsed: {
      input: { qtty: sum(m => ((m.tokensUsed || {}).input || {}).qtty) },
      output: { qtty: sum(m => ((m.tokensUsed || {}).output || {}).qtty) },
      other: { qtty: sum(m => ((m.tokensUsed || {}).other || {}).qtty) }
    }
  }
}

/**
 * @param {Object} o
 * @param {string} o.systemPrompt
 * @param {string} o.stateText      CURRENT STATE block
 * @param {string} o.inputText      INPUT WINDOW block (index or dump)
 * @param {string} o.closingText    the small closing turn
 * @param {Object} o.maps           surrogate → real id maps
 * @param {Object} [o.model]        { provider, family }
 * @param {Function} o.resolveNeed  async (items) => string  — renders the requested material (real ids in)
 * @param {Function} [o.onSection]  fires per parsed, translated section (need lines included)
 * @param {Function} [o.onRound]    ({ kind:'need'|'continue', round })
 * @param {Function} [o.onExchange] audit sink — called (not awaited) with every finished exchange
 * @param {string}   [o.promptVersion]
 * @param {string}   [o.subject]    what the audit record is labelled ('weekly clean-up')
 */
export async function runCleanup ({ freezr, systemPrompt, stateText, inputText, closingText, maps, model, resolveNeed, onSection, onDelta, onThinking, onRound, onExchange, promptVersion = null, subject = 'weekly clean-up', deadlineMs = null }) {
  const output = { attention: [], proposals: [], questions: [], needs: [], done: false, counts: null }
  let pendingNeed = null
  const parser = createSectionParser((s) => {
    const t = translate(s, maps)
    if (t.section === 'attention') output.attention.push(t)
    else if (t.section === 'proposal') output.proposals.push(t)
    else if (t.section === 'question') output.questions.push(t)
    else if (t.section === 'need') { pendingNeed = t; output.needs.push(t) }
    else if (t.section === 'done') { output.done = true; output.counts = t.counts || null }
    if (onSection) onSection(t)
  })

  const conversation = [cachedTurn(stateText + '\n\n' + inputText), { role: 'user', content: closingText }]
  const metas = []
  let raw = ''
  let parse = null
  let failure = null
  let needRounds = 0
  let continuations = 0
  const chainId = 'cl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
  // the exchange as the analysis audit records it: the turns that went out, the reply that came back
  const audit = (res, err, startedAt, opts) => {
    if (typeof onExchange !== 'function') return
    try {
      const turns = conversation.map(t => ({ role: t.role, cached: Array.isArray(t.content), content: Array.isArray(t.content) ? t.content.map(b => (b && b.text) || '').join('') : String(t.content == null ? '' : t.content) }))
      onExchange({
        chain_id: chainId, round: metas.length + 1, kind: 'cleanup', phase: continuations ? 'continue' : (needRounds ? 'need' : 'analysis'),
        at: startedAt, duration_ms: Date.now() - startedAt, msg_ids: [], subject, batch: 0, prompt_version: promptVersion,
        opts: { provider: opts.provider || null, family: opts.family || null, max_tokens: opts.max_tokens, system_prompt_chars: String(systemPrompt || '').length },
        turns, response: res && typeof res.response === 'string' ? res.response : (res ? JSON.stringify(res.response) : null),
        thinking: (res && res.thinking) || null, error: err ? ((err && err.message) || String(err)) : null, meta: (res && res.meta) || (err && err.meta) || {}
      })
    } catch (e) { /* the audit never breaks the run */ }
  }

  while (true) {
    pendingNeed = null
    // a wall-clock DEADLINE (the background job's): never start a round that cannot finish in time
    const left = deadlineMs ? deadlineMs - Date.now() : Infinity
    if (left < 90e3) { failure = failure || new Error('the run\'s time budget was reached before the reply finished'); parse = parser.finish(); break }
    // streamed where the client streams (a page); fed in one piece where it does not (a job) —
    // `fed` says which, so a streamed reply is never parsed twice
    let fed = false
    const opts = { context: systemPrompt, max_tokens: MAX_OUTPUT_TOKENS, streamBack: true, onDelta: (text) => { fed = true; parser.feed(text); if (onDelta) onDelta(text) }, onThinking: (text) => { if (onThinking) onThinking(text) } }
    if (model && model.provider) opts.provider = model.provider
    if (model && model.family) opts.family = model.family
    let res
    const startedAt = Date.now()
    try {
      res = await withTimeout(freezr.llm.ask(conversation, opts), Math.min(TIMEOUT_MS, left), 'no response for ' + Math.round(Math.min(TIMEOUT_MS, left) / 60000) + ' min (connection or provider stall, or the time budget)')
    } catch (e) {
      audit(null, e, startedAt, opts)
      failure = e; if (e && e.meta) metas.push(e.meta); parse = parser.finish(); break
    }
    audit(res, (!res || res.success === false) ? new Error('llm.ask failed') : null, startedAt, opts)
    if (!res || res.success === false) {
      failure = new Error('llm.ask failed: ' + ((res && (res.error || res.response)) || 'no response')); if (res && res.meta) metas.push(res.meta); parse = parser.finish(); break
    }
    metas.push(res.meta || {})
    const chunk = typeof res.response === 'string' ? res.response : JSON.stringify(res.response)
    if (!fed) parser.feed(chunk + '\n')
    raw += (raw ? '\n' : '') + chunk
    parse = parser.finish()
    conversation.push({ role: 'assistant', content: chunk })
    if (parse.done) break

    if (pendingNeed && needRounds < NEED_ROUNDS && resolveNeed) {
      needRounds++
      if (onRound) onRound({ kind: 'need', round: needRounds, items: pendingNeed.items || [] })
      let material = ''
      try { material = await resolveNeed(pendingNeed.items || []) } catch (e) { material = '(could not fetch: ' + ((e && e.message) || e) + ')' }
      conversation.push(cachedTurn('# REQUESTED MATERIAL\n' + (material || '(nothing found for those ids)') +
        '\n\nContinue from where you stopped: emit the remaining sections in the same JSONL format, without repeating lines already sent' +
        (needRounds >= NEED_ROUNDS ? ', and do not ask for more material — this was the last round answered' : '') + '. Finish with the done line.'))
      continue
    }
    if (continuations < CONTINUATIONS) {
      continuations++
      if (onRound) onRound({ kind: 'continue', round: continuations })
      conversation.push({ role: 'user', content: 'Your output stopped before the {"section":"done"} line. CONTINUE from exactly where you stopped: emit ONLY the sections you had not yet sent, in the same JSONL format, then the done line. So far: ' + output.attention.length + ' attention, ' + output.proposals.length + ' proposals, ' + output.questions.length + ' questions. Be terse to fit.' })
      continue
    }
    break
  }

  const got = output.attention.length || output.proposals.length || output.questions.length
  if (!got && failure) { failure.meta = sumMetas(metas); throw failure }
  return {
    output, raw, conversation, meta: sumMetas(metas), parse: parse || {},
    incomplete: !(parse && parse.done), needRounds, continuations,
    failure: failure ? ((failure && failure.message) || String(failure)) : null
  }
}
