// jobs/analyze_thread/maintenance/archive.js — archived projects live in their OWN collection, projects_archive
// (user decision 2026-09-20: a separate collection, not a flag). Archiving copies the record with
// its open to-dos closed, deletes the original, and drops it from the live store; restoring is the
// reverse. persist.loadAll never reads the archive, so the working set shrinks.

const COLL = 'projects_archive'
const openish = (t) => t && (t.status === 'open' || t.status === 'in_progress')
const strip = (o) => { const c = { ...o }; for (const k of Object.keys(c)) if (k.startsWith('_')) delete c[k]; return c }

/** Archive ONE live project. Returns { closed: n, archived_id }. */
export async function archiveProject ({ freezr, persist, store, project, runId = null, reason = null, by = 'cleanup', asof = Date.now() }) {
  if (!project || !project.project_id) throw new Error('no project')
  const copy = JSON.parse(JSON.stringify(strip(project)))
  let closed = 0
  for (const t of (copy.todos || [])) {
    if (!openish(t)) continue
    t.status = 'cancelled'
    t.resolved_asof = asof
    t.change_reason = 'archived with project'
    t.evidence = Array.isArray(t.evidence) ? t.evidence : []
    t.evidence.push({ type: 'manual', source: 'maintenance', thread_id: null, msg_id: null, asof, reason: 'archived with the project', who: 'clean-up (accepted by you)' })
    closed++
  }
  copy.status = 'archived'
  copy.archived_asof = asof
  copy.archived_reason = reason || null
  copy.archived_by = by
  copy.archived_run_id = runId
  const res = await freezr.create(COLL, copy)
  await persist.deleteProject(project.project_id)
  store.remove(project.project_id)
  return { closed, archived_id: res && res._id }
}

/** Newest-archived first. Returns the raw records (with _id). */
export async function listArchived (freezr, { count = 200 } = {}) {
  const rows = await freezr.query(COLL, {}, { count, sort: { _date_modified: -1 } })
  return (Array.isArray(rows) ? rows : []).filter(r => r && r.project_id)
}

/** Restore ONE archived record to the live projects collection. The caller reloads its stores. */
export async function restoreProject ({ freezr, persist, rec }) {
  if (!rec || !rec.project_id) throw new Error('no record')
  const live = strip(rec)
  delete live.archived_asof; delete live.archived_reason; delete live.archived_by; delete live.archived_run_id
  live.status = 'active'
  live.last_active_asof = Math.max(Number(live.last_active_asof) || 0, Date.now())
  await persist.saveProject(live)
  if (rec._id) await freezr.delete(COLL, rec._id)
  return live
}
