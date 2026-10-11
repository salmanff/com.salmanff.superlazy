// maintStore.js — persistence for maintenance RUN ARTIFACTS and PROPOSALS
// (specs/superlazy-weekly-cleanup.md §6: every run is an artifact; proposal statuses — ignored is
// permanent, attention items are "seen", questions are dismissed — outlive the run that made them,
// and a fingerprint lets an ignored proposal be suppressed before it is ever shown again).
// BEST-EFFORT everywhere: the collections land with a manifest re-install, and the page must keep
// working (in-memory) on an app that hasn't been re-installed yet — a failed save logs and
// returns null, it never blocks a run.

const RUNS = 'maintenance_runs'
const PROPOSALS = 'maintenance_proposals'
const DAY = 24 * 3600e3

export const newRunId = () => 'mr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
export const newProposalKey = () => 'mp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

const soft = (p, label) => p.then(r => r, e => { console.warn('[superlazy maint] ' + label + ' failed (re-install pending?):', e && e.message); return null })

// createMaintStore(F): the store over a freezr client — the page's global, or the job's injected one
// (2026-09-27: the clean-up runs in the background job too, where there is no global freezr).
export function createMaintStore (F) {
  function saveRun (rec) { return soft(F.create(RUNS, rec), 'run save') }
  function updateRun (runId, fields) { return soft(F.updateFields(RUNS, { run_id: runId }, fields), 'run update') }

  // One record per proposal / attention item / question. Returns the created _id (null when the
  // collection isn't there yet).
  async function saveProposal (rec) {
    const r = await soft(F.create(PROPOSALS, rec), 'proposal save')
    return (r && r._id) || null
  }

  function updateProposal (recId, fields) {
    if (!recId) return Promise.resolve(null)
    return soft(F.updateFields(PROPOSALS, recId, fields), 'proposal update')
  }

  // Everything recent, newest first. The status filters run CLIENT-SIDE: only _date_modified/_id
  // are reliably indexed on all backends.
  async function loadRecent ({ runCount = 12, proposalCount = 800 } = {}) {
    const runs = await soft(F.query(RUNS, {}, { count: runCount, sort: { _date_modified: -1 } }), 'runs load') || []
    const recent = await soft(F.query(PROPOSALS, {}, { count: proposalCount, sort: { _date_modified: -1 } }), 'proposals load') || []
    const rows = Array.isArray(recent) ? recent.filter(Boolean) : []
    return {
      runs: Array.isArray(runs) ? runs : [],
      all: rows,
      pending: rows.filter(r => r.status === 'proposed' || r.status === 'accepted'),
      decided: rows.filter(r => r.status === 'ignored' || r.status === 'seen' || r.status === 'dismissed')
    }
  }
  return { saveRun, updateRun, saveProposal, updateProposal, loadRecent }
}

// Fingerprints of proposals the user ignored (or saw / dismissed) within `days` — never shown again.
export function decisionsFrom (decided, { days = 90, nowMs = Date.now() } = {}) {
  const out = []
  for (const r of decided) {
    const asof = Number(r.status_asof) || Number(r._date_modified) || 0
    if (nowMs - asof > days * DAY) continue
    out.push({ kind: r.status === 'ignored' ? 'ignored' : (r.status === 'dismissed' ? 'dismissed question' : 'seen'), asof, fingerprint: r.fingerprint || null, text: r.title || r.question || r.headline || r.kind || '?', group: r.group || null })
  }
  return out
}
