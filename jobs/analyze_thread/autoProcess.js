// autoProcess.js — PERMANENT core. The AUTO-PROCESS contract: standing per-sender actions the
// app performs on a sender's mail automatically. Stored on the profile as an ARRAY so one sender
// can carry several actions (file their newsletters AND forward their bills, later):
//   profile.auto_processes = [{
//     type,       // WHICH action — matches a key in the workflows.js registry.
//                 //   'file_to_project' is the first (and so far only) implemented type.
//     active,     // true = perform it; false = the user explicitly turned it OFF
//     details,    // per-type config. file_to_project: { project_id, disposition }
//                 //   (disposition = the automated-mail category when category-based; null for
//                 //   a user-chosen custom project)
//     locked,     // the USER set this action — the model may never change it
//     suggested,  // the model's dissent while locked (per-type; file_to_project: { disposition })
//     source,     // 'user' | 'model' — who last set it
//     asof        // when it was last set
//   }]
// Legacy profiles carry flat auto_file / auto_file_locked / disposition / auto_file_project_id /
// suggested_disposition fields — normalizeAutoProcesses() upgrades them IN PLACE (lazy one-time
// migration on hydrate); the next save persists the new shape. This module is dependency-free so
// both the engine (jobs) and the UI (pages) share ONE definition of the shape.

export const FILE_TO_PROJECT = 'file_to_project'

// Upgrade a profile's inner object (p.profile) to the auto_processes shape. Returns the array.
// Mutates ONLY when there is legacy state to migrate (so untouched profiles stay clean); always
// deletes the legacy fields once migrated so the persisted record converges on the new shape.
export function normalizeAutoProcesses (prof) {
  if (!prof) return []
  const hasLegacy = prof.auto_file !== undefined || prof.disposition != null ||
    prof.auto_file_project_id != null || prof.auto_file_locked !== undefined ||
    prof.suggested_disposition != null
  // a POPULATED array is authoritative; an empty one may just be the store default merged in
  // ahead of a legacy record's flat fields — those still need migrating
  if (Array.isArray(prof.auto_processes) && (prof.auto_processes.length || !hasLegacy)) {
    return prof.auto_processes
  }
  if (!hasLegacy) return []
  // legacy semantics: auto_file true = on; undefined + a learned disposition = on (pre-flag
  // records); explicit false = the user turned it off
  const on = prof.auto_file === true || (prof.auto_file === undefined && !!prof.disposition)
  const entry = {
    type: FILE_TO_PROJECT,
    active: on,
    details: { project_id: prof.auto_file_project_id || null, disposition: prof.disposition || null },
    locked: !!prof.auto_file_locked,
    suggested: prof.suggested_disposition ? { disposition: prof.suggested_disposition } : null,
    source: prof.auto_file_locked ? 'user' : 'model',
    asof: prof.last_profiled_asof || null
  }
  prof.auto_processes = (on || prof.auto_file === false || entry.suggested) ? [entry] : []
  delete prof.auto_file
  delete prof.auto_file_locked
  delete prof.disposition
  delete prof.auto_file_project_id
  delete prof.suggested_disposition
  return prof.auto_processes
}

// The entry for one action type (active or not), or null. Normalizes legacy profiles first.
export function getAutoProcess (prof, type) {
  const list = normalizeAutoProcesses(prof)
  return list.find(a => a && a.type === type) || null
}

// The ACTIVE file_to_project entry, or null — the one question most callers ask.
export function fileToProject (prof) {
  const e = getAutoProcess(prof, FILE_TO_PROJECT)
  return (e && e.active) ? e : null
}

// ---- the three USER-SETTABLE states of file_to_project ---------------------------------------
// `locked` is what makes a user's choice permanent (onTrigger refuses to touch a locked action), so
// the OFF and RESET states differ ONLY in that flag — and that difference is the whole feature:
//   'on'    active           → mail auto-files, no LLM call.
//   'off'   !active + locked → never auto-files again; every message goes to the LLM. Permanent.
//   'reset' !active,!locked  → the next message goes to the LLM, and if the model calls it
//                             automated again the sender is RE-LEARNED (onTrigger reactivates).
// 'reset' is also the state of a sender who was never learned, so "not set" and "let the AI decide"
// are correctly the same thing.
export function autoProcessState (prof, type = FILE_TO_PROJECT) {
  const e = getAutoProcess(prof, type)
  if (e && e.active) return 'on'
  if (e && e.locked) return 'off'
  return 'reset'
}

// The applyAutoProcess patch for a user-chosen state. Every user choice sets source 'user' and
// clears any stored model dissent (`suggested`) — the disagreement is moot once the user has ruled.
export function userAutoProcessPatch (state, { type = FILE_TO_PROJECT, disposition = null, project_id = null, asof = null } = {}) {
  const base = { type, locked: true, suggested: null, source: 'user', asof }
  if (state === 'on') return { ...base, active: true, details: { disposition, project_id } }
  if (state === 'off') return { ...base, active: false }
  // reset: drop the lock so the model may re-learn, and clear the stale target
  return { ...base, active: false, locked: false, details: { disposition: null, project_id: null } }
}

// Set (or update) one action on a profile's inner object. Merge semantics like the old
// setDisposition: only the fields you pass change; `details` keys are shallow-merged onto the
// existing ones. Returns { before, after } snapshots of the entry for change logging.
export function applyAutoProcess (prof, { type, active, details, locked, suggested, source, asof } = {}) {
  if (!prof || !type) return null
  const list = normalizeAutoProcesses(prof)
  if (!Array.isArray(prof.auto_processes)) prof.auto_processes = list
  let entry = prof.auto_processes.find(a => a && a.type === type)
  const before = entry ? JSON.parse(JSON.stringify(entry)) : null
  if (!entry) {
    entry = { type, active: false, details: {}, locked: false, suggested: null, source: null, asof: null }
    prof.auto_processes.push(entry)
  }
  if (active !== undefined) entry.active = !!active
  if (details !== undefined) entry.details = { ...(entry.details || {}), ...(details || {}) }
  if (locked !== undefined) entry.locked = !!locked
  if (suggested !== undefined) entry.suggested = suggested
  if (source !== undefined) entry.source = source
  if (asof !== undefined) entry.asof = asof
  return { before, after: JSON.parse(JSON.stringify(entry)) }
}
