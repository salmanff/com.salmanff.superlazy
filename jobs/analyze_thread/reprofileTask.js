// reprofileTask.js — the USER-REQUESTED re-profile ("✨ Update with AI" on a person), complete
// with its persistence: history from stored events/bodies → the dedicated re-profile LLM call →
// archive the replaced version → save the profile → log a 'reprofile' event.
//
// Shared by both hosts, like ingest.js: the background job runs it verbatim (task 'reprofile'),
// and the People page runs it in-tab when no job capability exists — passing its LIVE stores so
// the open editor updates in place. Before this file the persistence glue lived only in
// people.js, which is why the job couldn't do it.
//
// The result is ALWAYS persisted here, not by the caller. That is what makes the background path
// refresh-proof: if the user closes or reloads the page mid-run, the updated profile, the
// archived previous version (profile_history) and the feed event all still land — nothing is
// held in a page that no longer exists, and nothing needs the user to "confirm" what they
// already explicitly requested. profile_history is the undo story, the event is the audit trail.

import { tuningFrom } from './profileTuning.js'
import { runReprofile, historyFromEvents } from './reprofiler.js'
import { createProfileStore } from './profiles.js'
import { createProjectStore } from './projectStore.js'
import { profileHistorySnapshot } from './persist.js'

const lc = (s) => String(s || '').toLowerCase()

export const REPROFILE_EVENTS_CAP = 2000 // newest analysis events considered for the history

// Newest-first paged pull of the events feed (events aren't part of persist.loadAll).
export async function loadRecentEvents (freezr, { cap = REPROFILE_EVENTS_CAP } = {}) {
  const out = []
  let skip = 0
  while (out.length < cap) {
    const rows = await freezr.query('events', {}, { count: 500, skip, sort: { _date_modified: -1 } })
    if (!rows || !rows.length) break
    out.push(...rows)
    if (rows.length < 500) break
    skip += 500
  }
  return out
}

/**
 * Run one user-requested re-profile and persist everything it changed.
 *
 * @param {Object}  o
 * @param {Object}  o.freezr
 * @param {Object}  o.persist    createPersistence(freezr)
 * @param {string}  o.address    the person
 * @param {Object} [o.profiles]  LIVE profile store (People page) — hydrated fresh when omitted (job)
 * @param {Object} [o.store]     LIVE project store — ditto
 * @param {Array}  [o.events]    pre-loaded events — loaded fresh when omitted
 * @param {Object} [o.settings]  settings record — loaded fresh when omitted
 * @returns {Promise<Object>} runReprofile's result: { ok, outcome, reason?, applied?, cost, rounds }
 */
export async function runUserReprofile ({ freezr, persist, address, profiles = null, store = null, events = null, settings = null } = {}) {
  const addr = lc(address)
  if (!addr) return { ok: false, outcome: 'error', reason: 'no address given' }

  // hydrate whatever the caller didn't inject (the job injects nothing; the page injects its
  // live stores so the open person editor reflects the change without a reload)
  if (!profiles || !store || settings == null) {
    const data = await persist.loadAll()
    if (!profiles) { profiles = createProfileStore(); profiles.hydrate(data.profiles) }
    if (!store) { store = createProjectStore(); store.hydrate(data.projects) }
    if (settings == null) settings = data.settings || {}
  }
  if (!events) events = await loadRecentEvents(freezr)

  const meSet = new Set(((settings && settings.your_addresses) || []).map(lc))
  const tuning = tuningFrom(settings || {})
  const asof = Date.now()

  const history = await historyFromEvents({
    events, address: addr, meSet, asof, tuning,
    getBody: (k) => persist.getEmailBody(k)
  })
  const res = await runReprofile({
    freezr,
    model: (settings && settings.default_model) || {},
    profiles, store, address: addr, history, tuning,
    trigger: 'user_request', asof, meSet, userRequested: true
  })

  if (res.ok) {
    const p = profiles.get(addr)
    // archive the replaced version (only real profiles — solidified or user-edited; not provisional churn)
    const before = res.outcome === 'updated' && res.applied && res.applied.before
    if (before && (before.solidified_asof || before.user_edited)) {
      await persist.saveProfileHistory(profileHistorySnapshot(addr, before, {
        manualRank: p ? p.manual_rank : null, source: 'reprofile:user_request', reason: res.reason, asof
      })).catch(e => console.error('profile history save failed', e))
    }
    if (p) await persist.saveProfile(p).catch(e => console.error('profile save failed', e))
    await persist.addEvent({
      // a system action: real and auditable, never urgent — ranks 1 so priority filters drop it
      kind: 'reprofile', source_id: 'user', asof, importance: 1, address: addr, from_address: addr,
      trigger: 'user_request', outcome: res.outcome, reason: res.reason || null, cost: res.cost || 0,
      subject: 'Profile ' + (res.outcome === 'updated' ? 'updated' : res.outcome) + ' (on request)' + (res.reason ? ' — ' + res.reason : '')
    }).catch(e => console.error('reprofile event save failed', e))
  }
  return res
}
