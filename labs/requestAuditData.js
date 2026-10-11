// requestAuditData.js — data layer for the Request Audit Lab: the recording flag in settings, the
// llm_audit rows (persist.js listAuditExchanges / readAuditBlob / pruneAudit / clearAudit), the
// grouping of exchanges into runs → request chains, and the per-exchange COST BREAKDOWN — priced
// from the provider's own figures when the call was billed, or as an "eq" equivalent (eqPricing.js)
// when it ran on a $0 local connector.
import { equivalentCost, isZeroCostProvider } from '../shared/eqPricing.js'
import { AUDIT_DEFAULT_DAYS } from '../jobs/analyze_thread/llmAudit.js'

export { AUDIT_DEFAULT_DAYS }

export async function readAuditSettings (persist) {
  const s = (await persist.readSettings().catch(() => null)) || {}
  return { on: s.llm_audit === true, days: Number(s.llm_audit_days) > 0 ? Number(s.llm_audit_days) : AUDIT_DEFAULT_DAYS }
}

export async function setAuditSettings (persist, { on, days }) {
  const fields = {}
  if (on != null) fields.llm_audit = !!on
  if (Number(days) > 0) fields.llm_audit_days = Math.min(30, Math.max(1, Math.round(Number(days))))
  await persist.stampSettingsFields(fields)
  return fields
}

export const loadExchanges = (persist, { hours }) =>
  persist.listAuditExchanges({ sinceMs: hours > 0 ? Date.now() - hours * 3600e3 : 0, count: 400 })

export const loadBlob = async (persist, hash) => { const r = await persist.readAuditBlob(hash); return r && r.text ? r.text : null }

// The cost of one exchange, by part. Server-priced when meta.pricing carries a real input rate;
// otherwise (local connector / no price on file) an eq equivalent from the API price list, or a
// tokens-only breakdown when even that is unknown.
export function breakdownOf (ex) {
  const meta = ex.meta || {}
  const tu = meta.tokensUsed || {}
  const det = (tu.other && tu.other.details) || {}
  const raw = meta.rawUsage || {}
  const n = (v) => Number(v) || 0
  const tokens = {
    input: n(tu.input && tu.input.qtty),
    output: n(tu.output && tu.output.qtty),
    cache_read: n(det.cacheReadTokens),
    cache_write: n(det.cacheCreationTokens),
    cache_write_1h: n(det.cacheCreation1hTokens),
    thinking: n(raw.output_tokens_details && raw.output_tokens_details.thinking_tokens)
  }
  const pr = meta.pricing || null
  const billed = pr && n(pr.input) > 0 && !isZeroCostProvider(ex.provider)
  if (billed) {
    const cachedRate = Number.isFinite(Number(pr.cachedInput)) && pr.cachedInput != null ? Number(pr.cachedInput) : n(pr.input) * 0.1
    const w1h = Math.min(tokens.cache_write_1h, tokens.cache_write)
    const w5m = tokens.cache_write - w1h
    const lines = [
      { key: 'cache_read', label: 'cached prefix (read)', tokens: tokens.cache_read, rate: cachedRate, cost: tokens.cache_read * cachedRate / 1e6 },
      { key: 'input', label: 'new input (uncached)', tokens: tokens.input, rate: n(pr.input), cost: tokens.input * n(pr.input) / 1e6 },
      { key: 'cache_write_1h', label: 'cache write · 1h TTL (2x)', tokens: w1h, rate: n(pr.input) * 2, cost: w1h * n(pr.input) * 2 / 1e6 },
      { key: 'cache_write_5m', label: 'cache write · 5m TTL (1.25x)', tokens: w5m, rate: n(pr.input) * 1.25, cost: w5m * n(pr.input) * 1.25 / 1e6 },
      { key: 'output', label: 'output' + (tokens.thinking ? ' (incl. ' + tokens.thinking.toLocaleString() + ' thinking)' : ''), tokens: tokens.output, rate: n(pr.output), cost: tokens.output * n(pr.output) / 1e6 }
    ]
    const sum = lines.reduce((s, l) => s + l.cost, 0)
    const server = meta.cost && Number.isFinite(Number(meta.cost.totalCost)) ? Number(meta.cost.totalCost) : null
    return { tokens, lines, total: server != null ? server : sum, computed: sum, server, eq: false, priced_as: ex.model || null }
  }
  const eq = equivalentCost(tokens, { model: ex.model, provider: ex.provider, family: ex.family })
  if (eq) {
    const lines = eq.lines.map(l => ({ ...l, rate: null }))
    return { tokens, lines, total: eq.cost, computed: eq.cost, server: null, eq: true, priced_as: eq.priced_as + ' via ' + eq.provider }
  }
  return { tokens, lines: [], total: 0, computed: 0, server: null, eq: false, priced_as: null, unpriced: true }
}

// runs (newest first) → chains (oldest first within a run) → exchanges (by round, then time)
export function groupExchanges (rows) {
  const byRun = new Map()
  for (const r of rows) {
    const runKey = r.run_id || 'unknown'
    const run = byRun.get(runKey) || { run_id: runKey, driver: r.driver || null, first: r.at, last: r.at, chains: new Map(), total: 0, eqTotal: 0, unpriced: 0 }
    run.first = Math.min(run.first, r.at || run.first)
    run.last = Math.max(run.last, r.at || run.last)
    const ck = r.chain_id || r._id
    const chain = run.chains.get(ck) || { chain_id: ck, subject: r.subject || '', msg_ids: r.msg_ids || [], batch: r.batch || 1, exchanges: [], total: 0, eq: false, error: false, first: r.at }
    const bd = breakdownOf(r)
    chain.exchanges.push({ ...r, breakdown: bd })
    chain.total += bd.total
    if (bd.eq) chain.eq = true
    if (r.error) chain.error = true
    chain.first = Math.min(chain.first, r.at || chain.first)
    if (!chain.subject && r.subject) chain.subject = r.subject
    run.chains.set(ck, chain)
    if (bd.eq) run.eqTotal += bd.total; else run.total += bd.total
    if (bd.unpriced) run.unpriced++
    byRun.set(runKey, run)
  }
  const runs = [...byRun.values()].sort((a, b) => b.last - a.last)
  for (const run of runs) {
    run.chains = [...run.chains.values()].sort((a, b) => a.first - b.first)
    for (const c of run.chains) c.exchanges.sort((a, b) => (a.round - b.round) || (a.at - b.at))
  }
  return runs
}
