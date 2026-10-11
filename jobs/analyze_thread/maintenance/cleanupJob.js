// cleanupJob.js — the weekly clean-up (or a one-project review) run from INSIDE the background job
// (2026-09-27). Same core as the /cleanup page (cleanupCore.js): stores hydrated from the database,
// index input (the full-mail mode needs a mail source the job does not hold), the clean-up model
// (settings.cleanup_model, else the review tier — opus on Claude), the shared run lock, and a wall-clock deadline so the job
// returns before freezr kills it. The result is stamped as settings.cleanup_last_run with seen:false —
// every page shows the results bar until the user opens it. Failures are stamped too, so a Monday run
// that could not start is visible rather than silent.

import { createProjectStore } from '../projectStore.js'
import { createProfileStore } from '../profiles.js'
import { createInstructionStore } from '../instructionStore.js'
import { createCleanupCore } from './cleanupCore.js'

const errMsg = (e) => (e && e.message ? e.message : String(e))

/**
 * @param {Object} o
 * @param {Object} o.freezr      the job's client
 * @param {Object} o.persist     createPersistence(freezr)
 * @param {number} o.deadlineMs  wall clock by which the call must have returned
 * @param {number} [o.slot]      the schedule slot this run serves (stamped as cleanup_last_attempt)
 * @param {string} [o.projectId] a one-project review instead of the weekly run
 * @param {number} [o.windowDays] how many days back the input window reads (the Prefs "Run now" choice)
 * @returns {Promise<Object>} summary { ok, run_id, cost, counts, suggestions, attention, error }
 */
export async function runCleanupInJob ({ freezr, persist, deadlineMs, slot = null, projectId = null, windowDays = null }) {
  const startedAt = Date.now()
  // stamp the ATTEMPT first: a run that dies mid-way must not be retried every hour at opus prices
  if (!projectId) await persist.stampSettingsFields({ cleanup_last_attempt: slot || startedAt }).catch(() => {})
  try {
    const data = await persist.loadAll()
    const settings = data.settings || {}
    const store = createProjectStore(); store.hydrate(data.projects || [])
    const profiles = createProfileStore(); profiles.hydrate(data.profiles || [])
    const instructions = createInstructionStore(); instructions.hydrate(data.instructions || [])
    const meSet = new Set((settings.your_addresses || []).map(a => String(a).toLowerCase()))
    const nameOf = (a) => { const p = profiles.get(String(a || '').toLowerCase()); return (p && p.display_name) || null }
    const core = createCleanupCore({ freezr, persist, store, profiles, instructions, settings, meSet, nameOf })
    const knobs = { ...core.knobsFromSettings(), inputMode: 'index' }
    if (Number(windowDays) > 0) { knobs.windowDays = Math.min(90, Number(windowDays)); knobs.editsWindowDays = Math.max(knobs.editsWindowDays || 30, knobs.windowDays) }
    if (projectId) Object.assign(knobs, { projectId, windowDays: 30, sections: ['attention', 'stale', 'archive', 'split', 'questions'] })
    const info = await core.run({ knobs, model: settings.cleanup_model || null, source: 'job', deadlineMs })
    return { ok: true, run_id: info.runId, cost: info.cost, counts: info.counts, incomplete: !!info.incomplete, finished_at: Date.now() }
  } catch (e) {
    const failure = { run_id: null, source: 'job', started_at: startedAt, finished_at: Date.now(), cost: 0, counts: {}, suggestions: 0, attention: 0, failure: errMsg(e), seen: false }
    if (!projectId) await persist.stampSettingsFields({ cleanup_last_run: failure }).catch(() => {})
    return { ok: false, error: errMsg(e), finished_at: Date.now() }
  }
}
