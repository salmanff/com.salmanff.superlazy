// modelInfo.js — which model the analysis will ACTUALLY use, resolved the way engine.ensureModel
// does: the user's chosen default (settings.default_model) wins; otherwise freezr's default
// provider with the analysis tier's family for it (modelDefaults.js), falling back to
// that provider's own default family. Cached per page: one ping, however many editors open.

import { defaultModelFromPing } from '../jobs/analyze_thread/modelDefaults.js'

let cachedPing = null

export async function analysisModel (settings) {
  const dm = settings && settings.default_model
  if (dm && dm.family) return { provider: dm.provider || null, family: dm.family, chosen: true }
  try {
    if (!cachedPing) cachedPing = await freezr.llm.ping()
    const p = cachedPing || {}
    const want = defaultModelFromPing(p, 'analysis').family
    return { provider: p.defaultProvider || null, family: want || p.defaultFamily || null, chosen: false }
  } catch (e) {
    return null
  }
}

// Models measured as NOT reliably routing work by a person's card line alone (regression battery,
// 2026-10-04: haiku put a colleague's invoice on the user 3/3 with her card line; sonnet 12/14 right).
// Re-measure with the battery before adding or removing a family here.
export const cardLinesUnreliableOn = (m) => !!m && /^haiku/i.test(String(m.family || ''))
