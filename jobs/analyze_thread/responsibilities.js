// responsibilities.js — PERMANENT core. `profile.responsibilities` is a LIST of entries, and this
// module is the ONLY place that reads or writes its shape (the same role whoMapping.js plays for a
// to-do's `who`).
//
// WHY A LIST (user, 2026-09-26). Responsibilities used to be one free-text blob the model rewrote
// wholesale. Two things broke on that shape:
//   · the USER could not own a line. Anything they typed was one edit away from being replaced by
//     the next re-profile, so the only safe thing to hand-write was nothing.
//   · nothing could be reviewed. "Does anyone else claim this work?" is a question about ENTRIES;
//     against one paragraph per person it cannot be asked at all. Four people's blobs each claimed
//     [a certain type of ] work when the clean-up went looking, which is the likeliest reason 57
//     to-dos [of that kind of work] were split across five owners.
//
// THE CONTRACT, and it is the whole point of the file:
//   · an entry with source 'user' is LOCKED. The model may not rewrite it, reorder it away, or drop
//     it. Not in the inline analysis, not in a re-profile, not in a clean-up proposal.
//   · the model owns the rest: a model proposal REPLACES every unlocked entry (that is how it
//     refreshes its own read) and leaves every locked one exactly where it was.
//   · ids are stable within a profile, so the UI can edit or delete one line without touching others.
//
// LEGACY. Records hold a plain string (or null). normalize() turns one into a single model-owned
// entry on load, so nothing needs migrating in storage and an old record keeps working untouched.

const MAX_TEXT = 600
const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()

/** Next free id in a profile's list: r1, r2, … */
function mintId (list) {
  let n = 0
  for (const e of list) { const m = /^r(\d+)$/.exec(String((e && e.id) || '')); if (m) n = Math.max(n, Number(m[1])) }
  return 'r' + (n + 1)
}

function asEntry (v, { source = 'model', asof = null, list = [] } = {}) {
  if (v == null) return null
  if (typeof v === 'string') {
    const text = clean(v).slice(0, MAX_TEXT)
    return text ? { id: mintId(list), text, source, locked: source === 'user', asof } : null
  }
  const text = clean(v.text).slice(0, MAX_TEXT)
  if (!text) return null
  const src = v.source === 'user' ? 'user' : 'model'
  return {
    id: String(v.id || '').trim() || mintId(list),
    text,
    source: src,
    locked: v.locked != null ? !!v.locked : src === 'user',
    asof: v.asof != null ? Number(v.asof) : asof
  }
}

/**
 * Bring `profile.responsibilities` to the list shape IN PLACE and return it. Accepts the legacy
 * string, a list of strings, a list of entries, null, or anything else (→ []).
 * Safe to call repeatedly; call it before every read.
 */
export function normalizeResponsibilities (profile) {
  if (!profile || typeof profile !== 'object') return []
  const raw = profile.responsibilities
  if (Array.isArray(raw)) {
    const out = []
    for (const v of raw) { const e = asEntry(v, { list: out }); if (e) out.push(e) }
    // de-duplicate ids that arrived colliding from an older write
    const seen = new Set()
    for (const e of out) { if (seen.has(e.id)) e.id = mintId(out); seen.add(e.id) }
    profile.responsibilities = out
    return out
  }
  const out = []
  const e = asEntry(raw, { list: out })          // the legacy blob becomes ONE model-owned entry
  if (e) out.push(e)
  profile.responsibilities = out
  return out
}

/** The entries, normalized. Never mutates the caller's object when given a plain profile copy. */
export function entriesOf (profile) {
  if (!profile) return []
  const raw = profile.responsibilities
  if (Array.isArray(raw)) return raw.map(v => asEntry(v, { list: [] })).filter(Boolean).map((e, i) => ({ ...e, id: e.id || ('r' + (i + 1)) }))
  const e = asEntry(raw, { list: [] })
  return e ? [e] : []
}

/** One display string: "supplier invoices …; payroll runs …". `max` clips the whole thing. */
export function responsibilitiesText (profile, { max = 0 } = {}) {
  const t = entriesOf(profile).map(e => e.text).join('; ')
  return max && t.length > max ? t.slice(0, max) + '…' : t
}

/**
 * The prompt-facing rendering. User entries are marked so the model can see which lines are the
 * user's own words — the prompt tells it those are never its to change.
 */
export function responsibilitiesForPrompt (profile, { max = 0 } = {}) {
  const t = entriesOf(profile).map(e => e.source === 'user' ? e.text + ' [USER-SET]' : e.text).join('; ')
  return max && t.length > max ? t.slice(0, max) + '…' : t
}

/** True when any entry is the user's own — used to decide whether a wholesale rewrite is safe. */

/**
 * Apply a MODEL proposal. Every locked (user) entry survives untouched and keeps its position at the
 * FRONT; the proposal replaces the model-owned entries. `proposed` may be a string, a list of
 * strings, or a list of entries — whatever the model sent.
 * Pass proposed === undefined to leave the list alone (the field was not in the reply).
 * @returns {{ changed:boolean, kept:number, added:number, removed:number }}
 */
export function applyModelResponsibilities (profile, proposed, { asof = null } = {}) {
  if (!profile || proposed === undefined) return { changed: false, kept: 0, added: 0, removed: 0 }
  const before = normalizeResponsibilities(profile)
  const locked = before.filter(e => e.locked)
  const wasModel = before.filter(e => !e.locked)
  const list = [...locked]
  const incoming = Array.isArray(proposed) ? proposed : (proposed == null ? [] : [proposed])
  for (const v of incoming) {
    const e = asEntry(v, { source: 'model', asof, list })
    if (!e) continue
    e.source = 'model'; e.locked = false          // a model proposal can never mint a user entry
    // never duplicate what a user entry already says
    if (list.some(x => x.text.toLowerCase() === e.text.toLowerCase())) continue
    list.push(e)
  }
  profile.responsibilities = list
  const added = list.length - locked.length
  const changed = added !== wasModel.length || list.slice(locked.length).some((e, i) => !wasModel[i] || wasModel[i].text !== e.text)
  return { changed, kept: locked.length, added, removed: wasModel.length }
}

/**
 * Add or edit ONE entry as the USER. Returns the entry. An id that is not found is added.
 * Anything the user touches becomes theirs: source 'user', locked true.
 */
export function setUserResponsibility (profile, { id, text, asof = Date.now() } = {}) {
  const list = normalizeResponsibilities(profile)
  const t = clean(text).slice(0, MAX_TEXT)
  if (!t) return null
  const found = id && list.find(e => e.id === id)
  if (found) { found.text = t; found.source = 'user'; found.locked = true; found.asof = asof; return found }
  const e = { id: mintId(list), text: t, source: 'user', locked: true, asof }
  list.push(e)
  return e
}

/** Remove one entry by id (the user's own delete). Returns true when something went. */
export function removeResponsibility (profile, id) {
  const list = normalizeResponsibilities(profile)
  const i = list.findIndex(e => e.id === id)
  if (i < 0) return false
  list.splice(i, 1)
  return true
}

/**
 * Entries that OVERLAP across people — the clean-up's "who else claims this work?" input.
 * Deliberately dumb: a shared significant word run, not semantics. The model judges; this only
 * hands it candidates it would otherwise have to find by reading every profile.
 * @param {Array} profiles profile records ({ address, display_name, profile })
 * @returns {Array<{ term, people: [{ address, id, text }] }>}
 */
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'their', 'this', 'that', 'user', 'all', 'any', 'our', 'his', 'her', 'them', 'they', 'when', 'only', 'etc', 'including', 'include'])
export function overlappingResponsibilities (profiles, { minWordLen = 4, minPeople = 2 } = {}) {
  const byTerm = new Map()
  for (const p of (profiles || [])) {
    if (!p || !p.address) continue
    for (const e of entriesOf(p.profile)) {
      const words = e.text.toLowerCase().match(/[a-z][a-z-]{2,}/g) || []
      const terms = new Set()
      for (let i = 0; i < words.length - 1; i++) {
        const a = words[i]; const b = words[i + 1]
        if (STOP.has(a) || STOP.has(b) || a.length < minWordLen) continue
        terms.add(a + ' ' + b)
      }
      for (const t of terms) {
        if (!byTerm.has(t)) byTerm.set(t, new Map())
        byTerm.get(t).set(String(p.address).toLowerCase(), { address: String(p.address).toLowerCase(), id: e.id, text: e.text })
      }
    }
  }
  const out = []
  for (const [term, people] of byTerm) {
    if (people.size < minPeople) continue
    out.push({ term, people: [...people.values()] })
  }
  return out.sort((a, b) => b.people.length - a.people.length || a.term.localeCompare(b.term))
}
