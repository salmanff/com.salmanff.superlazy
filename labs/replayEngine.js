// replayEngine.js — the DATA layer of the /replay demo: which recorded steps to play back, and
// what the board looked like at any moment of the recording. Nothing here calls the model, fetches
// mail or writes anything: the whole replay is reconstructed from what was already stored.
//
// HOW THE RECONSTRUCTION WORKS (and why it is exact)
// Every to-do carries `created_asof` plus an `evidence[]` trail, and reconcile.js records a
// field-level diff on each entry — { field, from, to } over status / importance /
// short_description / description / direction / due_hint (reconcile.TRACKED_EDITS). So a to-do's
// state at time T is TODAY'S record with every evidence diff dated after T rewound to its `from`.
// That is why the replay does NOT forward-build the board from events.changes[]: a 'created'
// change carries only the short text, while the rewind restores every tracked field exactly.
// The events are the CLOCK and the left-hand card; the projects are the state.
//
// LIMITS, stated where they are implemented rather than in a doc nobody reads:
//   · Fields the pipeline does not version (project name / summary / keywords, owner + `who`,
//     participants, suggested replies) show TODAY'S value at every step. A project therefore wears
//     its final name from step 1.
//   · Events are pruned (settings.events_retention_days), to-do evidence is not. Anything older
//     than the loaded events window simply shows as board state already present at step 0.
//   · A step whose project was later deleted has nothing to light up; boardAt just won't find it.

import { effImportance } from '../jobs/analyze_thread/dueDates.js'
import { repoOfWorkItem, reposOfProject, repoFilterMatches } from '../shared/renderUtils.js'

const num = (v) => Number(v) || 0
const isOpenStatus = (s) => s === 'open' || s === 'in_progress'

// exactly reconcile.js TRACKED_EDITS — the fields whose history is recorded, so the fields the
// rewind can restore. Anything else is shown as it stands today (see the header).
const REWINDABLE = new Set(['status', 'importance', 'short_description', 'description', 'direction', 'due_hint'])

// The event kinds that are a STEP in the story, grouped the way the page offers them.
export const KIND_GROUPS = {
  // SuperLazy read it and decided
  analysed: ['message'],
  // the standing automation filed it with no LLM read
  auto: ['workflow_short_circuit'],
  // you overruled it by hand
  manual: ['manual_edit']
}
// Everything else (cache_refresh, reprofile, autofile_learned, project_drift) is housekeeping —
// real, but not a beat in "a message came in and the list moved".

// ---- ONE to-do, as it stood at time T -------------------------------------------------------
// Returns null when the to-do did not exist yet. Otherwise a COPY with the rewindable fields put
// back to their values at T.
export function todoAsOf (todo, atMs) {
  if (!todo || num(todo.created_asof) > atMs) return null
  const out = { ...todo }
  const later = (todo.evidence || [])
    .filter(e => e && num(e.asof) > atMs && Array.isArray(e.changed) && e.changed.length)
    .sort((a, b) => num(b.asof) - num(a.asof)) // newest first: rewind backwards through time
  for (const entry of later) {
    for (let i = entry.changed.length - 1; i >= 0; i--) {
      const c = entry.changed[i]
      if (c && REWINDABLE.has(c.field) && c.from !== undefined) out[c.field] = c.from
    }
  }
  // Belt and braces: 46 of the 353 closed to-dos in the live data were closed without a status
  // diff on the trail (bulk resolves, older records). resolved_asof is set on every one of them,
  // so it settles the question whenever the rewind above could not.
  if (!isOpenStatus(out.status) && num(todo.resolved_asof) > atMs) out.status = 'open'
  if (isOpenStatus(out.status)) out.resolved_asof = null
  return out
}

// ---- which projects / repos an event is ABOUT ------------------------------------------------
export function eventProjectIds (ev) {
  const out = new Set()
  if (ev.project_id) out.add(ev.project_id)
  for (const c of (ev.changes || [])) if (c && c.project_id) out.add(c.project_id)
  return out
}

// Mail has no repo; agent work carries one (renderUtils.repoOfWorkItem reads the stored field and
// falls back to the 'cc:<slug>:<session>' thread id for older records).
export function eventRepos (ev) {
  const r = repoOfWorkItem(ev)
  return r ? [r] : []
}

// ---- the step list ---------------------------------------------------------------------------
// events: the loaded log (any order). Returns the steps to play, OLDEST FIRST — the replay runs on
// the analysis clock (asof, the message's own date), which is the order the story actually
// happened in, not the order the server got round to processing it.
export function buildSteps (events, {
  fromMs = 0, toMs = 0, channels = null, groups = ['analysed', 'auto', 'manual'],
  projectIds = null, repoFilter = 'all'
} = {}) {
  const kinds = new Set(groups.flatMap(g => KIND_GROUPS[g] || []))
  const wantProjects = projectIds && projectIds.size ? projectIds : null
  const steps = []
  for (const ev of (events || [])) {
    if (!kinds.has(ev.kind)) continue
    const at = num(ev.asof)
    if (!at) continue
    if (fromMs && at < fromMs) continue
    if (toMs && at > toMs) continue
    // channel: absent on records written before prompt 0.29, which are all mail
    if (channels && channels.size && !channels.has(ev.channel || 'mail')) continue
    if (!repoFilterMatches(eventRepos(ev), repoFilter)) continue
    if (wantProjects) {
      const pids = eventProjectIds(ev)
      let hit = false
      for (const id of pids) if (wantProjects.has(id)) { hit = true; break }
      if (!hit) continue
    }
    steps.push({ ev, atMs: at })
  }
  steps.sort((a, b) => a.atMs - b.atMs || String(a.ev._id).localeCompare(String(b.ev._id)))
  steps.forEach((s, i) => { s.idx = i })
  return steps
}

// every project id the steps touch — the default board scope, so the list on the right is about
// what the left is showing rather than the user's whole life
export function projectIdsOfSteps (steps) {
  const out = new Set()
  for (const s of steps) for (const id of eventProjectIds(s.ev)) out.add(id)
  return out
}

// ---- the board pool --------------------------------------------------------------------------
// One flat cross-project list of { todo, project }, the Tasks page's language rather than the
// project cards': on a slide, 3 lines that say what is owed read better than 3 project cards.
export function buildPool (projects, { projectIds = null, repoFilter = 'all' } = {}) {
  const pool = []
  for (const p of (projects || [])) {
    if (projectIds && projectIds.size && !projectIds.has(p.project_id)) continue
    if (!repoFilterMatches(reposOfProject(p), repoFilter)) continue
    for (const t of (p.todos || [])) pool.push({ todo: t, project: p })
  }
  return pool
}

// when this to-do was last touched AS OF T (for the secondary sort)
const touchedAt = (todo, atMs) => {
  let last = num(todo.created_asof)
  for (const e of (todo.evidence || [])) {
    const a = num(e.asof)
    if (a > last && a <= atMs) last = a
  }
  return last
}

const byPriority = (atMs) => (a, b) =>
  effImportance(b.todo) - effImportance(a.todo) ||
  touchedAt(b.todo, atMs) - touchedAt(a.todo, atMs)

// ---- the board at time T ---------------------------------------------------------------------
// Three buckets, exactly what the slide shows: what I owe, what the team owes, what got closed.
// `cap` rows each plus the count of the rest. read_only items are deliberately left out of the
// resolved bucket — a filed newsletter closing is not a win worth a line on a slide.
export function boardAt (pool, atMs, { cap = 3 } = {}) {
  const iOwe = []; const team = []; const resolved = []
  for (const entry of pool) {
    const t = todoAsOf(entry.todo, atMs)
    if (!t) continue
    const row = { todo: t, project: entry.project }
    if (isOpenStatus(t.status)) {
      if (t.direction === 'i_owe_them') iOwe.push(row)
      else if (t.direction === 'team_owes') team.push(row)
    } else if (t.direction !== 'read_only') resolved.push(row)
  }
  iOwe.sort(byPriority(atMs))
  team.sort(byPriority(atMs))
  resolved.sort((a, b) => num(b.todo.resolved_asof) - num(a.todo.resolved_asof))
  const bucket = (list) => ({ rows: list.slice(0, cap), total: list.length, more: Math.max(0, list.length - cap) })
  return { i_owe_them: bucket(iOwe), team_owes: bucket(team), resolved: bucket(resolved) }
}

// ---- what THIS step changed (for the flash) ---------------------------------------------------
// Two sources, unioned: the event's own change list, and every to-do whose evidence trail cites
// this message. The second catches changes the feed-level list does not itemise.
export function changedTodoIds (ev, pool) {
  const ids = new Set()
  for (const c of (ev.changes || [])) if (c && c.todo_id) ids.add(c.todo_id)
  if (ev.msg_id) {
    for (const { todo } of pool) {
      if ((todo.evidence || []).some(e => e && e.msg_id === ev.msg_id)) ids.add(todo.todo_id)
    }
  }
  return ids
}
