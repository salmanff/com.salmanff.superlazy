// eqPricing.js — EQUIVALENT prices for zero-cost connectors. The local Claude and Codex connectors
// (ClaudeLocal / CodexLocal — the user's own CLI subscription) report token usage but price
// everything at $0, so a run through them reads as free. This module prices those same tokens as
// if they had gone through the API, using the live price list freezr.llm.ping() returns for the
// configured API providers. Every figure it produces is marked eq: true and must be SHOWN as
// "eq" (equivalent), never as an actual charge.
//
// Lookup order for a model: exact id → id without a date suffix → the provider's latest model in
// the same family → a family word in the id ('opus', 'sonnet', 'haiku', 'gpt-5', …).

const LOCAL_TO_API = { ClaudeLocal: 'Claude', CodexLocal: 'ChatGPT' }
const FAMILY_WORDS = ['opus', 'sonnet', 'haiku', 'gpt-5', 'gpt-4', 'o3', 'o4', 'o1']

let priceMap = null
let loading = null

const norm = (id) => String(id || '').toLowerCase().trim()
const stripDate = (id) => norm(id).replace(/-\d{8}$/, '').replace(/-latest$/, '')

function buildMap (ping) {
  const byId = {}
  const byFamily = {}
  const byWord = {}
  for (const [prov, models] of Object.entries((ping && ping.providers) || {})) {
    if (LOCAL_TO_API[prov]) continue // the zero-cost lists themselves are not prices
    for (const m of (models || [])) {
      if (!m || !m.pricing || !Number.isFinite(Number(m.pricing.input))) continue
      const entry = { input: Number(m.pricing.input), output: Number(m.pricing.output) || 0, cachedInput: Number.isFinite(Number(m.pricing.cachedInput)) ? Number(m.pricing.cachedInput) : null, provider: prov, id: m.id }
      byId[norm(m.id)] = entry
      byId[stripDate(m.id)] = byId[stripDate(m.id)] || entry
      const fk = prov + '|' + norm(m.family)
      if (m.latest || !byFamily[fk]) byFamily[fk] = entry
      for (const w of FAMILY_WORDS) {
        if (norm(m.id).includes(w)) { const wk = prov + '|' + w; if (m.latest || !byWord[wk]) byWord[wk] = entry }
      }
    }
  }
  return { byId, byFamily, byWord }
}

// Resolves once per page; equivalentCost() returns null until it has.
export function ensurePriceMap () {
  if (priceMap) return Promise.resolve(priceMap)
  if (!loading) {
    loading = (typeof freezr !== 'undefined' && freezr.llm && freezr.llm.ping ? freezr.llm.ping() : Promise.resolve(null))
      .then(p => { priceMap = buildMap(p); return priceMap })
      .catch(() => { priceMap = { byId: {}, byFamily: {}, byWord: {} }; return priceMap })
  }
  return loading
}

export const isZeroCostProvider = (provider) => !!LOCAL_TO_API[provider]

// The API price entry to use for a model that ran at $0. provider is the connector name when known.
export function priceFor ({ model, provider, family } = {}) {
  if (!priceMap) return null
  const apiProv = LOCAL_TO_API[provider] || null
  const id = norm(model)
  const hit = priceMap.byId[id] || priceMap.byId[stripDate(id)]
  if (hit && (!apiProv || hit.provider === apiProv)) return hit
  const provs = apiProv ? [apiProv] : ['Claude', 'ChatGPT']
  for (const p of provs) {
    if (family && priceMap.byFamily[p + '|' + norm(family)]) return priceMap.byFamily[p + '|' + norm(family)]
    for (const w of FAMILY_WORDS) if (id.includes(w) && priceMap.byWord[p + '|' + w]) return priceMap.byWord[p + '|' + w]
  }
  return hit || null
}

// tokens: { input, output, cache_read, cache_write, cache_write_1h? } (the event / audit shapes).
// Returns { cost, lines, priced_as, eq: true } or null when no price can be found yet.
export function equivalentCost (tokens, ident = {}) {
  const p = priceFor(ident)
  if (!p) return null
  const t = tokens || {}
  const n = (v) => Number(v) || 0
  const cachedRate = Number.isFinite(p.cachedInput) && p.cachedInput != null ? p.cachedInput : p.input * 0.1
  const w1h = Math.min(n(t.cache_write_1h), n(t.cache_write))
  const w5m = n(t.cache_write) - w1h
  const lines = [
    { key: 'input', label: 'new input', tokens: n(t.input), cost: n(t.input) * p.input / 1e6 },
    { key: 'cache_read', label: 'cached prefix (read, ~10%)', tokens: n(t.cache_read), cost: n(t.cache_read) * cachedRate / 1e6 },
    { key: 'cache_write_1h', label: 'cache write · 1h (2x)', tokens: w1h, cost: w1h * p.input * 2 / 1e6 },
    { key: 'cache_write_5m', label: 'cache write · 5m (1.25x)', tokens: w5m, cost: w5m * p.input * 1.25 / 1e6 },
    { key: 'output', label: 'output (incl. thinking)', tokens: n(t.output), cost: n(t.output) * p.output / 1e6 }
  ]
  return { cost: lines.reduce((s, l) => s + l.cost, 0), lines, priced_as: p.id, provider: p.provider, rates: p, eq: true }
}
