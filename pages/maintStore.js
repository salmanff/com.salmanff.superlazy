// maintStore.js — MOVED 2026-09-27 into the job bundle (jobs/analyze_thread/maintenance/maintStore.js)
// as a factory over a freezr client. This shim keeps the pages' function-style imports working,
// bound to the page's global freezr at call time.
import { createMaintStore } from '../jobs/analyze_thread/maintenance/maintStore.js'
export { createMaintStore, newRunId, newProposalKey, decisionsFrom } from '../jobs/analyze_thread/maintenance/maintStore.js'
const store = () => createMaintStore(typeof freezr !== 'undefined' ? freezr : null)
export const saveRun = (rec) => store().saveRun(rec)
export const updateRun = (runId, fields) => store().updateRun(runId, fields)
export const saveProposal = (rec) => store().saveProposal(rec)
export const updateProposal = (recId, fields) => store().updateProposal(recId, fields)
export const loadRecent = (opts) => store().loadRecent(opts)
