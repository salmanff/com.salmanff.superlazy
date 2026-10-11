// modelDefaults.js — what "Recommended default" means for each of the app's two model choices
// (user, 2026-10-11): the per-message ANALYSIS model and the CLEAN-UP & REVIEW model.
//
// The PROVIDER stays the user's own — whatever they set as their freezr default. What this picks is
// the FAMILY within it, by TIER:
//   analysis — Claude: sonnet · ChatGPT: the flagship gpt (gpt-5.5, not -mini / -nano / -pro)
//   review   — Claude: opus   · ChatGPT: the flagship gpt as well (-pro costs several times opus)
// The analysis tier was haiku until 2026-10-11 (specs/analysis-experiments.md measured it level with
// sonnet on the scored cases); the user moved the default up a tier. ChatGPT's small models are NOT
// offered as a default: gpt-5-mini asked for extra detail rounds and gpt-5-nano went silent on 5 of 9
// replayed cases (E3), while the full-size model handled the prompt well.
//
// freezr reports families WITH a version (sonnet-5, opus-5, gpt-5.5), so a tier is a test on the
// family name and the newest match wins. A provider with no tier entry, or that offers no match,
// keeps its own default ({} = freezr decides). The user's explicit pick always wins over all of this.

const TIERS = {
  analysis: { Claude: (f) => /^sonnet(-|$)/.test(f), ChatGPT: (f) => /^gpt-\d+(\.\d+)?$/.test(f) },
  review: { Claude: (f) => /^opus(-|$)/.test(f), ChatGPT: (f) => /^gpt-\d+(\.\d+)?$/.test(f) }
}

// 'gpt-5.5' → [5, 5]; 'sonnet-5' → [5] — compared number by number, newest first
const versionOf = (f) => (String(f).match(/\d+/g) || []).map(Number)
const newer = (a, b) => {
  const va = versionOf(a); const vb = versionOf(b)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    if ((va[i] || 0) !== (vb[i] || 0)) return (va[i] || 0) - (vb[i] || 0)
  }
  return 0
}

/** The tier's family among `families` (the provider's offered family names), or null. */
export function defaultFamilyFor (provider, families, tier = 'analysis') {
  const test = (TIERS[tier] || {})[String(provider || '')]
  if (!test) return null
  const hits = [...new Set((families || []).filter(f => f && test(String(f))))]
  return hits.length ? hits.sort((a, b) => newer(b, a))[0] : null
}

/** From a freezr.llm.ping result: { provider, family } for the tier, or {} (freezr's own default). */
export function defaultModelFromPing (ping, tier = 'analysis') {
  const provider = (ping && ping.defaultProvider) || null
  if (!provider) return {}
  const families = (((ping.providers || {})[provider]) || []).map(m => m && m.family)
  const family = defaultFamilyFor(provider, families, tier)
  return family ? { provider, family } : {}
}

/** Pings and resolves; {} when the ping fails. */
export async function resolveDefaultModel (freezr, tier = 'analysis') {
  try { return defaultModelFromPing(await freezr.llm.ping(), tier) } catch (e) { return {} }
}

// true when a stored/picked model actually names something ({} and null mean "the default")
export const isPicked = (m) => !!(m && (m.provider || m.family))
