// modelPicker.js — the model chooser, labelled with each model's TOKEN PRICE.
//
// Choosing a model is the biggest cost/accuracy lever in the app, and a bare list of family names
// ("Claude · sonnet", "Claude · haiku") gives the user nothing to decide with. freezr's llm.ping
// reports each model's price per million tokens, so that is what the list shows.
//
// Deliberately NOT a "cents per email" estimate: what one email costs depends on the thread length,
// how much project history exists, whether the model asks for more context, whether it triggers a
// re-profile — too many factors for a figure that would read as a promise. The REAL per-email cost
// is measured and shown after the fact, per message, on the Latest analysis card.
//
// Shared by the first-run setup form, the Status tab's start-training form, the mid-run switcher and
// the Preferences tab, so all four offer the identical choice.

// The "default" option keeps the user's own default PROVIDER and steers only the FAMILY within it,
// by tier (modelDefaults.js): 'analysis' = sonnet on Claude, 'review' (the clean-up) = opus. If that
// provider does not offer it, the provider's own default stands. Picking any model here overrides it.

import { defaultFamilyFor } from '../jobs/analyze_thread/modelDefaults.js'

// pricing from freezr.llm.ping: { input, output, other? } in USD per MILLION tokens.
const num = (v) => (Number(v) || 0)
const hasPricing = (p) => !!(p && (p.input || p.output))

// "$3 / $15 per Mtok" — in for input, out for output; the convention providers publish.
export function priceLabel (pricing) {
  if (!hasPricing(pricing)) return null
  const fmt = (v) => (v >= 1 ? '$' + (Number.isInteger(v) ? v : v.toFixed(2)) : '$' + v.toFixed(2).replace(/^0/, '0'))
  return fmt(num(pricing.input)) + ' in / ' + fmt(num(pricing.output)) + ' out per Mtok'
}

// Rank for "cheapest first". Weighted towards output, which is the pricier side per token and the
// part that scales with how much the model chooses to write.
const priceRank = (pricing) => (hasPricing(pricing) ? num(pricing.input) + num(pricing.output) * 2 : Infinity)

// One flat, de-duplicated list of { provider, family, latest, pricing } from a ping result.
function modelsFrom (ping) {
  const out = []
  const seen = new Set()
  for (const pname of Object.keys((ping && ping.providers) || {})) {
    for (const m of ping.providers[pname]) {
      const key = m.provider + '|' + m.family
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ provider: m.provider, family: m.family, latest: !!m.latest, pricing: m.pricing || null })
    }
  }
  // cheapest first: the point of showing the price is that the cheap options get considered
  return out.sort((a, b) => {
    const ra = priceRank(a.pricing)
    const rb = priceRank(b.pricing)
    if (ra === rb) return a.provider.localeCompare(b.provider) || a.family.localeCompare(b.family)
    return ra - rb
  })
}

const valueOf = (m) => JSON.stringify({ provider: m.provider, family: m.family })

// Is freezr's price table good enough to cost this run with? It is written by asking a model what
// it costs, so it goes stale and — worse — misses models released after it was written. A model
// with no entry is costed at ZERO: the run bills normally while the page reports nothing, which is
// the one failure a spend counter must not have. Either symptom is worth one refresh call.
const pricingIsIncomplete = (ping, models) => {
  const meta = (ping && ping.pricingMeta) || {}
  for (const k of Object.keys(meta)) if (meta[k] && meta[k].refreshNeeded) return true
  return models.some(m => !hasPricing(m.pricing))
}

/**
 * Fill a <select> with the user's models, each labelled with its estimated cost per email.
 * Keeps the existing "User default" option as the first entry (its text gains the resolved
 * provider/family so "default" is not a mystery).
 *
 * @param {HTMLSelectElement} sel
 * @param {Object}   o
 * @param {Object}  [o.stored]        { provider, family } to preselect (null = user default)
 * @param {number}  [o.contextChars]  the context budget the estimate is based on
 * @param {Element} [o.hintEl]        gets a per-model detail line, updated on change
 * @param {Function}[o.onError]       (message) — no keys configured / ping failed
 * @param {string}  [o.tier]          what "Recommended default" resolves to: 'analysis' | 'review'
 * @returns {Promise<{ models: Array, describe: Function, refresh: Function }>}
 */
export async function populateModelSelect (sel, { stored = null, hintEl = null, onError = null, tier = 'analysis' } = {}) {
  const noop = { models: [], describe: () => '', refresh: () => {} }
  if (!sel) return noop
  let ping = null
  try {
    ping = await freezr.llm.ping()
  } catch (e) {
    if (onError) onError('Could not query your LLM models: ' + ((e && e.message) || e))
    return noop
  }
  if (!ping || !ping.exists) {
    if (onError) onError('No LLM keys configured — set them in your freezr settings before training.')
    return noop
  }

  const models = modelsFrom(ping)

  // the default option keeps its id/value; only its text and the model list are (re)built
  const dflt = sel.querySelector('option[value="default"]') || sel.firstElementChild
  let defName = null
  let defModel = null
  const readDefaults = (p) => {
    // the tier's family within the user's OWN default provider; if that provider does not
    // offer it, the provider's own default family stands
    const want = defaultFamilyFor(p.defaultProvider, models.filter(m => m.provider === p.defaultProvider).map(m => m.family), tier)
    defModel = (want && models.find(m => m.provider === p.defaultProvider && m.family === want)) ||
      models.find(m => m.provider === p.defaultProvider && m.family === p.defaultFamily)
    defName = defModel ? (defModel.provider + ' · ' + defModel.family) : null
  }
  readDefaults(ping)

  const describe = (value) => {
    const m = models.find(x => valueOf(x) === value) ||
      (value === 'default' ? defModel : null)
    if (!m) return ''
    const price = priceLabel(m.pricing)
    return price
      ? price + ' — what one email costs depends on the thread and how much history it needs; the actual cost of each email is shown as it is analysed'
      : 'freezr has no price on file for this model, so a run with it will report $0 — it still bills you normally. Check your provider\'s account for the real figure.'
  }

  function refresh () {
    const keep = sel.value
    for (const o of [...sel.querySelectorAll('option')]) { if (o !== dflt) o.remove() }
    if (dflt) {
      const price = defModel ? priceLabel(defModel.pricing) : null
      dflt.textContent = 'Recommended default' + (defName ? ' (' + defName + ')' : '') +
        (price ? ' — ' + price : '')
      dflt.dataset.pricing = JSON.stringify((defModel && defModel.pricing) || null)
      dflt.dataset.modelName = defName || ''
    }
    for (const m of models) {
      const o = document.createElement('option')
      o.value = valueOf(m)
      const price = priceLabel(m.pricing)
      o.textContent = m.provider + ' · ' + m.family + (m.latest ? ' (latest)' : '') +
        (price ? ' — ' + price : ' — price unknown')
      o.dataset.pricing = JSON.stringify(m.pricing || null)
      o.dataset.modelName = m.provider + ' · ' + m.family
      sel.appendChild(o)
    }
    const want = stored && stored.provider ? valueOf(stored) : (keep || 'default')
    sel.value = want
    if (sel.value !== want) sel.value = 'default' // stored model no longer offered
    if (hintEl) hintEl.textContent = describe(sel.value)
  }

  refresh()
  if (hintEl) sel.addEventListener('change', () => { hintEl.textContent = describe(sel.value) })

  // Top the table up in the BACKGROUND: the page is usable immediately and re-labels itself when
  // the fresh prices land. Failure is silent by design — an out-of-date price is a worse number,
  // not a broken page.
  if (pricingIsIncomplete(ping, models)) {
    if (hintEl) hintEl.textContent = 'checking current token prices…'
    freezr.llm.ping({ refresh: true }).then((p2) => {
      const fresh = p2 && p2.exists ? modelsFrom(p2) : []
      if (fresh.length) {
        models.length = 0
        models.push(...fresh)
        readDefaults(p2)
      }
      refresh()
    }).catch(() => refresh())
  }

  return { models, describe, refresh }
}

// Read a select filled by populateModelSelect. {} means "let the app choose" — the user's own
// default provider with the tier's family inside it (engine.ensureModel / modelDefaults.js).
export function selectedModel (sel) {
  const v = sel && sel.value
  if (!v || v === 'default') return {}
  try { return JSON.parse(v) } catch (e) { return {} }
}

// The selected option's price table ({ input, output } USD per Mtok) and display name, for
// estimating a call's cost BEFORE sending it. null pricing = freezr has no price on file.
export function selectedPricing (sel) {
  const o = sel && sel.options && sel.options[sel.selectedIndex]
  if (!o) return { pricing: null, name: '' }
  let pricing = null
  try { pricing = JSON.parse(o.dataset.pricing || 'null') } catch (e) { pricing = null }
  return { pricing, name: o.dataset.modelName || o.textContent || '' }
}
