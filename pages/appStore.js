// appStore.js — the ONE in-memory working set behind the shell page (shell.js). Before the shell,
// every page was its own document loading its own copy of the same data and throwing it away on
// navigation; now the data is loaded once per shell load and every view (Dashboard, Tasks) paints
// from here — switching views refetches NOTHING. Deliberately NOT browser storage: freezr apps
// share one origin, so localStorage/sessionStorage is readable by every other installed app and
// competes for its quota — this store lives and dies with the page.

import { createEventsLoader, processedClock } from './recentData.js'
import { isMailThreadId } from '../shared/messageHistory.js'
import { createProfileStore } from '../jobs/analyze_thread/profiles.js'
import { createProjectStore } from '../jobs/analyze_thread/projectStore.js'

// every reload pulls at least this many events — covers the Dashboard's viewer sidebar and the
// Tasks page's "All" cap alike; a view whose window reaches further tops up via ensureEventCoverage
const EVENTS_BASE_CAP = 1000

export function createAppStore ({ persist }) {
  let loader = null      // windowed events loader (recentData.createEventsLoader) — ONE per reload
  let extraEvents = []   // manual edits / sent mail raised THIS session (persisted too — a reload refetches them)
  let loading = false

  const app = {
    persist,
    store: null,         // live project store — the boards, task rows and modals edit these objects
    profiles: null,      // profile store (createProfileStore)
    rawProfiles: [],     // raw profile records (buildPeople + the Who autocomplete want these, not the store)
    instructions: [],    // custom-instruction records (the person editor edits these)
    accounts: [],
    settings: {},
    events: [],          // merged events log, newest first by PROCESSED time
    lastLoadedAt: 0,
    onReload: null       // set by the shell: post-hydrate wiring + repaint of the active view
  }

  // merge what the loader has with this session's own additions, newest first by processed time
  function rebuildEvents () {
    app.events = [...extraEvents, ...(loader ? loader.rows() : [])]
      .sort((a, b) => processedClock(b) - processedClock(a))
  }

  // A COALESCED manual burst (ui.js) re-fires with the same manual_id as its values settle — that
  // is ONE decision and must stay ONE card, so it replaces its own entry instead of stacking.
  // _fresh drives the events feed's one-off flash (eventsUi); reloads pick up the persisted copy.
  app.addExtraEvent = (ev) => {
    const rec = { ...ev }
    if (rec.kind === 'manual_edit') {
      if (rec.manual_id) {
        const at = extraEvents.findIndex(e => e.manual_id === rec.manual_id)
        if (at >= 0) {
          extraEvents[at] = { ...rec, _fresh: extraEvents[at]._fresh || Date.now() }
          rebuildEvents()
          return
        }
      }
      rec._fresh = Date.now()
    }
    extraEvents.unshift(rec)
    rebuildEvents()
  }

  // events paging, shared so every view works one loaded slice (no per-view refetching)
  app.hasMoreEvents = () => !!(loader && loader.hasMore())
  app.loadedEventsCount = () => (loader ? loader.loadedCount() : 0)
  app.loadOlderEvents = async () => {
    if (!loader) return []
    const page = await loader.loadOlder()
    rebuildEvents()
    return page
  }

  // load enough of the log for a view's window: a bounded window loads to its cut; 'all' loads
  // the cap and leaves the rest to the Load-older button
  app.ensureEventCoverage = async ({ tfKey = 'all', tfSinceMs = 0, cap = EVENTS_BASE_CAP } = {}) => {
    if (!loader) return
    if (tfKey === 'all' || !tfSinceMs) await loader.ensureCount(cap)
    else await loader.ensureSince(tfSinceMs)
    rebuildEvents()
  }

  app.isLoading = () => loading

  // The events behind ONE project, for its card's Messages tab: the loaded log PLUS whatever the
  // database holds for the project's mail threads / evidence messages / recorded changes that has
  // already fallen out of the newest-1,000 slice (persist.loadEventsForProject). Cached per
  // project for the life of this load; a reload empties it. Returns a merged, deduped list,
  // newest-processed first, that the Messages tab filters like the plain log.
  const projectEventsCache = new Map() // project_id -> { at, rows }
  app.loadProjectEvents = async (project) => {
    if (!project || !project.project_id) return app.events
    const hit = projectEventsCache.get(project.project_id)
    if (hit && Date.now() - hit.at < 5 * 60e3) return mergeProjectEvents(hit.rows)
    const threadIds = (project.thread_ids || []).filter(isMailThreadId)
    const msgIds = []
    for (const t of (project.todos || [])) for (const e of (t.evidence || [])) if (e && e.msg_id) msgIds.push(e.msg_id)
    const rows = await persist.loadEventsForProject({ threadIds, msgIds, projectId: project.project_id })
    projectEventsCache.set(project.project_id, { at: Date.now(), rows })
    return mergeProjectEvents(rows)
  }
  function mergeProjectEvents (rows) {
    const seen = new Set(app.events.map(e => e._id).filter(Boolean))
    const extra = (rows || []).filter(r => r && !(r._id && seen.has(r._id)))
    if (!extra.length) return app.events
    return [...app.events, ...extra].sort((a, b) => processedClock(b) - processedClock(a))
  }

  // FULL reload: everything re-fetched (persist.loadAll + a fresh events loader). Runs once when
  // the shell opens and again only when new data definitely exists (a mail check landed, a note
  // was added, tab refocus after a long absence) — view switches never call this.
  app.reload = async () => {
    if (loading) return
    loading = true
    try {
      loader = createEventsLoader()
      extraEvents = []
      projectEventsCache.clear()
      const [data] = await Promise.all([
        persist.loadAll(),
        loader.ensureCount(EVENTS_BASE_CAP)
      ])
      rebuildEvents()
      app.profiles = createProfileStore()
      app.profiles.hydrate(data.profiles)
      app.rawProfiles = data.profiles || []
      app.store = createProjectStore()
      app.store.hydrate(data.projects)
      app.instructions = data.instructions || []
      app.accounts = data.accounts || []
      app.settings = data.settings || {}
      app.lastLoadedAt = Date.now()
      if (app.onReload) await app.onReload()
    } finally {
      loading = false
    }
  }

  return app
}
