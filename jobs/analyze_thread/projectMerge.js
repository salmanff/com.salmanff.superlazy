// projectMerge.js — CONCURRENCY SAFETY for the `projects` collection.
//
// Why this exists (incident, 2026-08-20): a project record is written WHOLE (freezr update
// replaces the record), and several writers touch the same project — every open tab, plus the
// analyzer (in-tab run or background job). Two failure modes followed from that:
//
//   1. DUPLICATES. persist.upsert created a record when its project_id → _id map had no entry.
//      Concurrent first-time saves of a NEW project (the "+ Add Project" flow fired three at
//      once) each found the map empty and each created a record — two or three rows with the
//      SAME project_id. Loading keeps one arbitrarily (hydrate sets by project_id, last row
//      wins, and row order follows _date_modified), so edits landed in one row while the board
//      showed another: tasks "vanished", then an older version "came back". Fixed at the source
//      (deterministic record ids + serialised writes in persist.js) and healed on load here.
//   2. LOST UPDATES. A tab holding a project from hours ago writes its whole snapshot over
//      whatever another writer added since. Fixed by the 3-way merge below: before writing, the
//      stored record is read and folded into the local copy against a BASELINE (what this
//      process last loaded/wrote for that project).
//
// The baseline is what makes the merge safe rather than a blunt union: a to-do the stored record
// has and we don't is ADOPTED when it is new to us, but DROPPED when our baseline had it too —
// because then we removed it deliberately (moved it to another project, or merged the project).
// Union-with-no-baseline is only used for healing duplicates, where there is no baseline to know
// intent and losing content would be worse than resurrecting some.
//
// Pure functions, no freezr/DOM — persist.js wires them, test/verifyProjectMerge.mjs proves them.

// Scalars a writer can change on the project itself (collections are handled separately).
const SCALARS = ['name', 'summary', 'importance', 'importance_locked', 'computed_importance',
  'status', 'merged_into', 'auto_bucket', 'keywords']

// How recently a to-do was TOUCHED — its own stamps plus the newest evidence entry. Every writer
// (analyzer and manual edits alike) appends evidence when it changes something, so this is the
// comparable "version" of a to-do across writers.
export function touchOf (t) {
  if (!t) return 0
  let m = Math.max(Number(t.created_asof) || 0, Number(t.resolved_asof) || 0, Number(t.edited_asof) || 0)
  for (const e of (t.evidence || [])) m = Math.max(m, Number(e.asof) || 0)
  return m
}
const respTouchOf = (r) => Math.max(Number(r && r.asof) || 0, Number(r && r.edited_asof) || 0,
  Number(r && r.created_asof) || 0, Number(r && r.dismissed_asof) || 0, Number(r && r.sent_asof) || 0)

// A BASELINE snapshot: the ids (with their touch stamps) and scalars this process last saw for a
// project — taken when it is loaded and after every successful write.
export function projectBaseline (p) {
  if (!p) return null
  const scalars = {}
  for (const k of SCALARS) scalars[k] = JSON.stringify(p[k] === undefined ? null : p[k])
  return {
    todos: new Map((p.todos || []).filter(t => t && t.todo_id).map(t => [t.todo_id, touchOf(t)])),
    responses: new Map((p.responses || []).filter(r => r && r.response_id).map(r => [r.response_id, respTouchOf(r)])),
    scalars,
    // the thread tombstones we last saw — so a tombstone WE cleared (a real re-link) is told
    // apart from one the other writer added since (see mergeStored)
    unlinked: new Set(p.unlinked_threads || [])
  }
}

const byId = (list, key) => new Map((list || []).filter(x => x && x[key]).map(x => [x[key], x]))
const uniq = (arr) => [...new Set((arr || []).filter(x => x != null))]

// Merge one collection (todos / responses) 3-way. Returns { list, adopted, dropped, conflicts }.
function mergeList (localList, storedList, baseMap, key, touch) {
  const local = byId(localList, key)
  const stored = byId(storedList, key)
  const base = baseMap || new Map()
  const out = []
  const adopted = []
  const conflicts = []
  const dropped = []
  for (const [id, mine] of local) {
    const theirs = stored.get(id)
    if (!theirs) { out.push(mine); continue }
    const b = base.has(id) ? base.get(id) : null
    const theyChanged = b === null ? touch(theirs) > touch(mine) : touch(theirs) > b
    const weChanged = b === null ? false : touch(mine) > b
    if (theyChanged && !weChanged) {
      out.push(theirs) // they changed it, we didn't — their version is the newer truth
      adopted.push(id)
    } else {
      out.push(mine) // ours wins (we changed it, or nobody did)
      if (theyChanged && weChanged) conflicts.push(id)
    }
  }
  for (const [id, theirs] of stored) {
    if (local.has(id)) continue
    // in our baseline but gone from our copy = we removed it on purpose (moved / merged away)
    if (base.has(id)) {
      dropped.push(id)
      continue
    }
    out.push(theirs)
    adopted.push(id)
  }
  return { list: out, adopted, dropped, conflicts }
}

// Merge the STORED record into our LOCAL project against the baseline.
// baseline === null → union mode (duplicate healing: keep everything from both sides).
// Returns { project, report } — project is a NEW object; report says what moved (for logging).
export function mergeStored (local, stored, baseline) {
  const report = { adoptedTodos: [], droppedTodos: [], conflictTodos: [], adoptedResponses: [], scalarsTaken: [], changed: false }
  if (!stored) return { project: local, report }
  if (!local) return { project: stored, report }
  const out = { ...local }

  // A project retired by a merge (either side) has had its work moved elsewhere — adopting the
  // other side's to-dos would resurrect items that now live in the target project.
  const retired = !!(local.merged_into || stored.merged_into)
  if (retired) {
    out.merged_into = local.merged_into || stored.merged_into
  } else {
    const t = mergeList(local.todos, stored.todos, baseline && baseline.todos, 'todo_id', touchOf)
    out.todos = t.list
    report.adoptedTodos = t.adopted; report.droppedTodos = t.dropped; report.conflictTodos = t.conflicts
    const r = mergeList(local.responses, stored.responses, baseline && baseline.responses, 'response_id', respTouchOf)
    out.responses = r.list
    report.adoptedResponses = r.adopted
  }

  // scalars: ours wins when WE changed it since the baseline, else take the stored value
  for (const k of SCALARS) {
    if (k === 'merged_into' && retired) continue
    const mineJson = JSON.stringify(local[k] === undefined ? null : local[k])
    const theirsJson = JSON.stringify(stored[k] === undefined ? null : stored[k])
    if (mineJson === theirsJson) continue
    const baseJson = baseline && baseline.scalars ? baseline.scalars[k] : undefined
    const weChanged = baseJson === undefined ? true : mineJson !== baseJson
    if (!weChanged) { out[k] = stored[k]; report.scalarsTaken.push(k) }
  }

  // additive fields: union / max — no writer ever means to shrink these… except thread links,
  // which a writer releases DELIBERATELY (projectStore.unlinkThread → a tombstone in
  // unlinked_threads). Tombstones merge 3-way like to-dos: ours all stand; theirs stand unless our
  // baseline had the tombstone and we no longer do — then WE cleared it on purpose (the thread
  // was genuinely re-linked) and their stale copy must not bring it back. The union of thread
  // ids then loses whatever is tombstoned.
  const removedByUs = baseline && baseline.unlinked
    ? [...baseline.unlinked].filter(t => !(local.unlinked_threads || []).includes(t))
    : []
  const theirTombstones = (stored.unlinked_threads || []).filter(t => !removedByUs.includes(t))
  out.unlinked_threads = uniq([...(local.unlinked_threads || []), ...theirTombstones])
  const dead = new Set(out.unlinked_threads)
  out.thread_ids = uniq([...(local.thread_ids || []), ...(stored.thread_ids || [])]).filter(t => !dead.has(t))
  out.sources = uniq([...(local.sources || []), ...(stored.sources || [])])
  out.last_active_asof = Math.max(Number(local.last_active_asof) || 0, Number(stored.last_active_asof) || 0)
  out.created_asof = Math.min(Number(local.created_asof) || Infinity, Number(stored.created_asof) || Infinity)
  if (!Number.isFinite(out.created_asof)) out.created_asof = Number(local.created_asof) || Number(stored.created_asof) || 0

  // participants: per-address, ours wins unless we never had that address
  const parts = { ...(stored.participants || {}), ...(local.participants || {}) }
  out.participants = parts
  out.participant_emails = uniq([...Object.keys(parts), ...(local.participant_emails || []), ...(stored.participant_emails || [])])

  report.changed = !!(report.adoptedTodos.length || report.adoptedResponses.length ||
    report.droppedTodos.length || report.conflictTodos.length || report.scalarsTaken.length)
  return { project: out, report }
}

// ---- duplicate healing (rows straight from the db) --------------------------------------------
// Groups loaded rows by project_id. For a group of more than one, ONE row wins (the canonical
// record id if present, else most to-dos, else most recently modified) and the others' content is
// union-merged into it; the losers are reported so the caller can retire them (tag, don't delete —
// the bytes stay for forensics but never load again).
// Returns { rows, healed, retire } — rows = one record per project_id, ready to hydrate.
export function healDuplicateProjects (rows, canonicalIdFor) {
  const groups = new Map()
  for (const r of (rows || [])) {
    if (!r || !r.project_id) continue
    if (!groups.has(r.project_id)) groups.set(r.project_id, [])
    groups.get(r.project_id).push(r)
  }
  const out = []
  const healed = []
  const retire = []
  for (const [pid, group] of groups) {
    if (group.length === 1) { out.push(group[0]); continue }
    const canonical = canonicalIdFor ? canonicalIdFor(pid) : null
    const ranked = group.slice().sort((a, b) => {
      if (canonical) {
        if (a._id === canonical && b._id !== canonical) return -1
        if (b._id === canonical && a._id !== canonical) return 1
      }
      const at = (a.todos || []).length
      const bt = (b.todos || []).length
      if (at !== bt) return bt - at
      return (Number(b._date_modified) || 0) - (Number(a._date_modified) || 0)
    })
    let winner = ranked[0]
    for (const loser of ranked.slice(1)) {
      // no baseline: union — with duplicates there is no way to tell a deliberate removal from a
      // write that landed on the other row, and losing a task is worse than keeping a stale one
      const { project } = mergeStored(winner, loser, null)
      winner = { ...project, _id: ranked[0]._id, _date_modified: ranked[0]._date_modified }
      retire.push({ _id: loser._id, project_id: pid, winner_id: ranked[0]._id })
    }
    healed.push({ project_id: pid, kept: ranked[0]._id, retired: ranked.slice(1).map(r => r._id), todos: (winner.todos || []).length })
    out.push(winner)
  }
  return { rows: out, healed, retire }
}
