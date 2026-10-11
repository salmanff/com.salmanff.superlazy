// whoMapping.js — the ONE translation between the model's `who` list and the stored to-do fields
// (owner / owners / counterparty). Added 2026-09-19 with prompt 0.53. Not deletable on its own:
// reconcile writes through it and assemble reads through it — see TO REMOVE IT LATER.
//
// WHY IT EXISTS. Prompt 0.53 collapsed the four who-fields the model used to fill
// (`sender`, `owner`, `owners[]`, `counterparty`) into ONE field: `who` — the people an item is
// about other than ME. The direction already says where ME stands, so the rest were derivable,
// and asking for them invited contradictions (measured: i_owe_them items naming ME as their own
// counterparty; owner and direction disagreeing on 20% of open items).
//
// `who` IS A LIST. Most items name one person, but joint ownership is real and the app already
// supports it end to end: the task editor takes comma-separated people, the People page matches a
// person against `owners[]`, and the project card builds its people set from them. So `who` takes
// one name or several, and this module writes the SAME stored shape the task editor writes, so an
// analyser-written item and a hand-edited one are indistinguishable:
//
//   direction     stored
//   ---------     ------
//   i_owe_them    owner = ME · counterparty = the people, comma-joined
//   they_owe_me   owner = the first · owners = the list (only when >1) · counterparty = ME
//   team_owes     owner = the first · owners = the list (only when >1) · counterparty = null
//   read_only     everything empty
//
// THERE IS ONLY ONE LIST. Which stored field holds it depends on the direction, but it is always
// the same list — the `who`. For i_owe_them it is the comma-joined `counterparty` string; for the
// other two it is `owner` (the lead) plus `owners` when more than one person shares it. Comma is a
// separator everywhere, so reading it back is the same operation either way. A parallel
// `counterparties` array was briefly added here and removed the same day: a second list for the
// same people is exactly the kind of contradiction collapsing to one `who` was meant to end.
//
// STORAGE WAS NOT MIGRATED. These fields are read in ~20 places (ui.js, renderUtils.js,
// assemble.js, peopleData.js, taskEditor.js, expandableProjectView.js, recent.js, reprofiler.js,
// the maintenance appliers) across every stored to-do. So this module is the ONLY translation
// between the model's `who` and the stored fields, in both directions.
//
// TO REMOVE IT LATER: migrate the store to a single `who` list, update those call sites, then
// delete this file and its call sites — `reconcile.normalizeTodo` (write path) and `assemble.js`'s
// to-do renderers (read path), all marked with the same 2026-09-19 note.

const lc = (s) => String(s || '').trim().toLowerCase()

// The ME test differs by caller: reconcile holds a Set of the user's addresses, assemble holds a
// roster and asks roleOf(). So accept EITHER a Set or a plain predicate.
const meTest = (me) => {
  if (typeof me === 'function') return (addr) => !!addr && !!me(addr)
  if (me instanceof Set) return (addr) => !!addr && me.has(lc(addr))
  return () => false
}

// One name, several names, or a comma-separated string -> a clean, de-duplicated list.
// The model is asked for an array; a single string is accepted because models sometimes send one
// for the common single-person case, and that is not worth failing an analysis over.
function asList (v) {
  const out = []
  const seen = new Set()
  // Comma is a separator at EVERY level, not just the top: the stored counterparty field holds
  // several people as one joined string (the task editor's convention), so a list that mixes that
  // string with a real array must not count the same person twice.
  for (const x of (Array.isArray(v) ? v : [v])) {
    for (const part of String(x == null ? '' : x).split(',')) {
      const s = part.trim()
      if (!s || seen.has(lc(s))) continue
      seen.add(lc(s))
      out.push(s)
    }
  }
  return out
}

/**
 * The people the MODEL named on this item, whatever shape it used.
 * Falls back to an older-shaped reply that still sends owner / owners[] / counterparty.
 * @param {object} rt  the raw to-do object from the model
 * @returns {string[]}
 */
export function whoListFrom (rt) {
  if (!rt) return []
  if (rt.who != null) return asList(rt.who)
  // a legacy reply that still sends the old fields
  return asList(rt.direction === 'i_owe_them'
    ? [rt.counterparty]
    : [rt.owner, ...asList(rt.owners)])
}

/**
 * Model output (`who` + direction) -> the stored fields. See the table in the header.
 * @param {object} rt   the raw to-do object from the model
 * @param {object} ctx  reconcile's ctx — { meSet?, from? }
 * @returns {{ owner: string|null, owners: string[], counterparty: string|null }}
 */
export function storedFromWho (rt, ctx = {}) {
  const empty = { owner: null, owners: [], counterparty: null }
  if (!rt || rt.direction === 'read_only') return empty

  const meSet = ctx.meSet instanceof Set ? ctx.meSet : new Set()
  const me = [...meSet][0] || null
  const people = whoListFrom(rt)
  if (!people.length) return empty

  // i_owe_them: the whole who goes in counterparty, comma-joined — the task editor's own shape
  if (rt.direction === 'i_owe_them') return { owner: me, owners: [], counterparty: people.join(', ') }
  // they_owe_me / team_owes: the lead in owner, the rest alongside it — again the editor's shape
  return {
    owner: people[0],
    owners: people.length > 1 ? people : [],
    counterparty: rt.direction === 'they_owe_me' ? me : null
  }
}

/**
 * The stored fields -> the people to SHOW the model, so the vocabulary it reads matches the one it
 * writes. ME is never in the answer: the direction already says where ME stands.
 * @param {object} todo  a STORED to-do
 * @param {Set|function} me  the user's addresses as a Set, or an (addr) => boolean predicate
 * @returns {string[]}
 */
export function whoOf (todo, me) {
  if (!todo || todo.direction === 'read_only') return []
  const isMe = meTest(me)
  // i_owe_them keeps the other party in counterparty; the other directions keep them in
  // owner/owners. Read both either way — legacy rows are not consistent.
  const ordered = todo.direction === 'i_owe_them'
    ? [todo.counterparty, todo.owner, ...asList(todo.owners)]
    : [todo.owner, ...asList(todo.owners), todo.counterparty]
  return asList(ordered).filter(a => !isMe(a))
}

/** whoOf as one display string ("a@x.com, b@y.com"), or null when nobody is named. */
export function whoTextOf (todo, me) {
  const list = whoOf(todo, me)
  return list.length ? list.join(', ') : null
}
