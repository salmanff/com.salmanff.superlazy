// shell.js — entry point for the MERGED Dashboard + Tasks page. The manifest points both the
// `index` and `recent` page keys at shell.html + this module: the shell reads the URL to pick the
// initial view, and switching between them is an in-page repaint (history.pushState keeps the
// address bar / bookmarks / back-forward honest) — the data is loaded ONCE per shell load into
// appStore.js and survives every switch.
//
// THE ONE RULE that keeps this safe: anything that polls, listens, or saves is mounted exactly
// once, HERE — the mail tools + status poller, the email-viewer context, the ＋ Add… button, the
// ui.js singleton hooks, the manual-event listener, visibilitychange/hashchange. Views (index.js =
// Dashboard, recent.js = Tasks, events.js = Events, people.js = People) own only their filters,
// their painting, and their own DOM hosts. Where the old pages differed per page (which repaint
// runs after an edit, which person-editor options apply), the shell dispatches to the ACTIVE view.
// Setup & Prefs and the debug pages remain separate real pages.

import { createPersistence } from '../jobs/analyze_thread/persist.js'
import { setCleanupResultsOpener } from '../shared/processingNotice.js'
import { openCleanupResults } from './reorgReview.js'
import { redirectUnlessTrained } from '../shared/setupGuard.js'
import { detectSource } from '../shared/sourceFactory.js'
import { configureEmailViewer } from '../shared/emailViewer.js'
import { createMailContext } from '../shared/viewerContext.js'
import { mountMailTools } from '../shared/mailTools.js'
import { openPersonEditor } from '../shared/personEditor.js'
import { openTaskEditor } from '../shared/taskEditor.js'
import {
  setMaintenanceContext,
  setStatus, openProjectModal, openTaskEmail, taskOps, taskEditOps,
  setProjectsProvider, setPeopleProvider, setEventsProvider, setProjectEventsLoader, setProjectSaver, setProjectCreator,
  setTodoMinter, setPersonEditorOpener, setSelfAddresses, setNameLookup, setManualEventListener,
  setProjectDeleter, setHostRepaint, setDraftHandlers
} from '../shared/ui.js'
import { renderTopBar, setActiveTopBarPage } from '../shared/topbar.js'
import { createAppStore } from './appStore.js'
import { createDashboardView } from './index.js'
import { createTasksView } from './recent.js'
import { createEventsView } from './events.js'
import { createPeopleView } from './people.js'
import { createThreadsView } from './threadsView.js'

const BASE = '/apps/com.salmanff.superlazy/'
const SETUP_URL = BASE + 'setup'
const SHELL_VIEW_KEYS = ['recent', 'threads', 'events', 'people']

// which shell view does this URL name? (the app root and anything unknown land on the Dashboard)
const viewKeyFromPath = () => {
  const seg = (window.location.pathname.split('/').pop() || '').toLowerCase()
  return SHELL_VIEW_KEYS.includes(seg) ? seg : 'index'
}

let views = {}
let activeKey = null
const activeView = () => views[activeKey] || null
const repaintActive = () => { const v = activeView(); if (v) v.paint() }

function switchTo (key, { push = true } = {}) {
  if (!views[key] || key === activeKey) return
  if (activeView()) activeView().hide()
  activeKey = key
  setActiveTopBarPage(key)
  views[key].show()
  if (push) window.history.pushState({ slView: key }, '', BASE + key)
}

async function init () {
  const persist = createPersistence(typeof freezr !== 'undefined' ? freezr : null)
  const app = createAppStore({ persist })

  const initialKey = viewKeyFromPath()
  renderTopBar(initialKey, {
    onNavigate: (key) => {
      if (!views[key]) return false // not a shell view — follow the real link (People, Events, Setup)
      switchTo(key)
      return true
    }
  })

  // not set up yet, or the initial training is still running → the setup page owns the story
  setStatus('Checking your setup…', 'info')
  if (!(await redirectUnlessTrained())) return

  const source = await detectSource()

  // ---- shared lookups + handlers (ONE copy, where the old pages each kept their own) ----------

  const nameOf = (a) => { const p = app.profiles && app.profiles.get(a); return (p && p.display_name) || null }
  // known people for the task editor's Who autocomplete
  const peopleForEditor = () => (app.rawProfiles || []).filter(p => p && p.address)
    .map(p => ({ address: p.address, name: p.display_name || '' }))
  const getProject = (id) => (id && app.store ? app.store.get(id) : null)
  const projectName = (id) => { const p = getProject(id); return (p && p.name) || id || '' }

  // person chips / sender discs everywhere open the person editor (profile description + special
  // instructions for that sender). A view can supply its OWN editor options — the People view's
  // carry the "Update with AI" re-profile action, exactly as its old page did — so the opener
  // dispatches to the active view first.
  const openPerson = (address) => {
    const v = activeView()
    if (v && v.personEditorOpts) return openPersonEditor(address, v.personEditorOpts())
    return openPersonEditor(address, {
      profiles: app.profiles,
      persist,
      instructions: app.instructions,
      projects: () => (app.store ? app.store.all() : []),
      nameOf,
      settings: app.settings || {},
      onChange: () => repaintActive()
    })
  }

  // clicking a project anywhere opens the LIVE interactive card in a full-screen modal; on close,
  // repaint so edits made inside are reflected
  const onOpenProject = (project) => openProjectModal(project, { onClose: () => repaintActive() })

  // THE standard task-row handlers, acting on the LIVE store objects — persistence + events flow
  // through the manual-event listener below
  const taskHandlers = {
    nameOf,
    self: [], // filled from settings on load — your own address never renders as a sender disc
    onOpenPerson: openPerson,
    onResolve: (t, p) => { taskOps.toggleResolve(t, p); repaintActive() },
    onCancel: (t, p) => { taskOps.cancel(t, p); repaintActive() },
    onImportance: (t, d, p) => { taskOps.setImportance(t, d, p); repaintActive() },
    // sub-task tick: persist only, NO repaint — the row updates in place, keeping its panel open
    onDescChange: (t, p, d) => taskOps.setDescription(t, p, d),
    // ▸ → the task editor (rename / due / move project)
    onEdit: (t, p, extra) => openTaskEditor(t, p, {
      projects: () => (app.store ? app.store.all() : []),
      self: taskHandlers.self,
      people: peopleForEditor,
      ops: taskEditOps,
      onChange: () => { repaintActive(); if (extra && extra.onChange) extra.onChange() }
    }),
    // ✉ → straight into the full email viewer
    openEmailModal: (t, p, msgId) => openTaskEmail(t, p, msgId)
  }

  // the shared viewer context: project-wide snippet sidebar, per-email task rows, drafts,
  // Reply/Forward — same reading pane for both views
  const mailCtx = createMailContext({
    persist,
    getProjects: () => (app.store ? app.store.all() : []),
    getProject,
    getEvents: () => app.events,
    nameOf,
    selfAddrs: () => taskHandlers.self,
    projectName,
    taskHandlers,
    onOpenProject,
    onOpenPerson: openPerson,
    onSent: (sentEv) => app.addExtraEvent(sentEv),
    refresh: () => repaintActive(),
    getSettings: () => app.settings || null   // the viewer's "open in editor" template lives here
  })
  configureEmailViewer({ source, persist, context: mailCtx.context })

  // ---- ui.js singleton hooks, installed ONCE against the store -------------------------------
  // the shared board handlers (project modal, project/task editors) read the live project list
  // and persist through here — without these their pickers are empty and edits are lost
  setProjectsProvider(() => (app.store ? app.store.all() : []))
  setPeopleProvider(peopleForEditor)
  setEventsProvider(() => app.events) // the project cards' Messages tab reads the mail from here
  setProjectEventsLoader((p) => app.loadProjectEvents(p)) // …and tops it up by thread from the database
  setDraftHandlers(mailCtx.draftHandlers) // cards' suggested replies: Send + the reply composer
  // dismissing / editing a suggested reply changes no to-do, so it raises no manual event —
  // ui.js persists the project through this saver instead
  setProjectSaver((p) => persist.saveProject(p).catch(e => console.error('project save failed', e)))
  // "move to a NEW project" in the project editor creates through the live store
  setProjectCreator((name) => app.store && app.store.ensureProject({ project_id: app.store.mintUserProjectId(), name, asof: Date.now() }))
  setTodoMinter(() => app.store && app.store.mintUserTodoId())
  // ANY edit made on a project card — including the ones that raise no manual_edit event (adding
  // a task, dismissing or editing a suggested reply) — repaints the view behind it, so a project
  // modal opened over the Tasks list never leaves that list stale (user, 2026-09-01)
  setHostRepaint(() => repaintActive())
  // "Delete project" in the project editor: out of the working set AND out of storage. The modal
  // has already had the user confirm; a failure here must surface, so the error propagates back
  // to the button rather than being swallowed.
  setProjectDeleter(async (p) => {
    if (!p || !p.project_id) return
    if (app.store) app.store.remove(p.project_id)
    await persist.deleteProject(p.project_id)
    repaintActive()
  })
  setPersonEditorOpener(openPerson)

  // manual edits persist immediately; a move touches TWO projects (project_id = target,
  // project_id_2 = source) — save both. The event also lands in the in-memory log so both views
  // (and the viewer sidebar) see it without a reload.
  setManualEventListener((mev) => {
    for (const pid of [mev.project_id, mev.project_id_2]) {
      const p = pid && app.store && app.store.get(pid)
      if (p) persist.saveProject(p).catch(e => console.error('manual save failed', e))
    }
    persist.addEvent({ ...mev, kind: 'manual_edit', source_id: 'user' }).catch(e => console.error('manual event save failed', e))
    app.addExtraEvent({ ...mev, kind: 'manual_edit', source_id: 'user', _date_created: Date.now() })
    // a sub-task ticked on a row's slide-open description: persist WITHOUT repainting — a repaint
    // rebuilds the row, slamming the open panel shut under the cursor (the row already restyled
    // itself in place). Editor-made description edits repaint via the editor's own onChange.
    if (mev.target === 'todo' && mev.field === 'description') return
    repaintActive()
  })

  // ---- the views ------------------------------------------------------------------------------

  // The config for "make something by hand" — used by the project board's own add section in its
  // filter bar (the topbar's ＋ Add… chooser it used to share this with is gone; user,
  // 2026-09-16). The callbacks are arrow functions so they resolve reloadSafe (declared below) at
  // CLICK time, not now.
  const addOpts = {
    persist,
    getProjects: () => (app.store ? app.store.all() : []),
    getPeople: () => (app.rawProfiles || []).map(p => ({ address: p.address, name: p.display_name || '' })),
    getAuthor: () => ((app.settings && app.settings.your_addresses) || [])[0] || '',
    onCreated: () => reloadSafe(),
    // a hand-made project opens straight into its own modal on the "+ Add" tab
    onProjectCreated: (p) => { repaintActive(); openProjectModal(p, { onClose: () => repaintActive(), startTab: 'add' }) }
  }

  const shared = { app, nameOf, peopleForEditor, getProject, projectName, taskHandlers, openPerson, onOpenProject, mailCtx, addOpts }
  views = {
    index: createDashboardView(shared),
    recent: createTasksView(shared),
    threads: createThreadsView(shared),
    events: createEventsView(shared),
    people: createPeopleView(shared)
  }
  for (const key of Object.keys(views)) views[key].mount()

  // post-load wiring — runs after EVERY reload (first load, mail landed, note added, refocus)
  app.onReload = async () => {
    setSelfAddresses(app.settings.your_addresses || [])
    // the one-project review modal renders live task rows with the page's handlers
    setMaintenanceContext({ taskHandlers })
    // the clean-up results bar opens the results HERE, as a modal (other pages go to /cleanup?run=)
    setCleanupResultsOpener((run) => openCleanupResults(run, { taskHandlers, onChange: () => { if (app.reload) app.reload() } }))
    // the user's timezone, for the weekly clean-up's "Monday 05:00" (the job has no browser clock)
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      if (tz && app.settings && app.settings.user_timezone !== tz) { persist.stampSettingsFields({ user_timezone: tz }).catch(() => {}); app.settings.user_timezone = tz }
    } catch (e) { /* no Intl timezone — the job falls back to the server's clock */ }
    taskHandlers.self = (app.settings.your_addresses || []).map(a => String(a).toLowerCase())
    setNameLookup(nameOf)
    mailCtx.refreshSelfReplies()
    if (app.settings.training_wip) {
      // training (re)started in another tab since we loaded — back to the setup page
      setStatus('⏳ History building is in progress — taking you to the training page…', 'info')
      window.location.href = SETUP_URL
      return
    }
    const v = activeView()
    if (v && v.onReload) await v.onReload()
  }

  const reloadSafe = () => app.reload()
    .catch(e => setStatus('Could not load: ' + ((e && e.message) || e), 'error'))

  // show the initial view (paints empty-guarded until data lands), keep the URL as served
  activeKey = initialKey
  window.history.replaceState({ slView: activeKey }, '', window.location.pathname + window.location.search)
  views[activeKey].show()
  window.addEventListener('popstate', () => {
    const key = viewKeyFromPath()
    if (views[key] && key !== activeKey) switchTo(key, { push: false })
  })

  await reloadSafe()

  // The topbar mail tools own EVERYTHING about checking mail: the mode (background job vs in-tab),
  // the single status poller, the status strip, and — mode off — the stale-mail prompt. Data
  // reloads ONLY when a run actually processed messages; repaints are state-preserving.
  mountMailTools({
    persist,
    accounts: app.accounts, // already loaded — no second accounts query
    onRefreshed: reloadSafe,
    allowInTab: true,
    promptWhenStale: true,
    onAccountChange: (v, tag) => {
      for (const key of Object.keys(views)) {
        if (views[key].onAccountChange) views[key].onAccountChange(v, tag)
      }
      repaintActive() // every view filters on the picker (projects.sources / events.account_id)
    }
  }).catch(e => console.error('mail tools failed', e))

  // tab refocus: the ACTIVE view decides (Tasks/Events/People re-anchor + refresh when stale;
  // the Dashboard deliberately does nothing — reloads come only from runs that landed)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    const v = activeView()
    if (v && v.onVisible) v.onVisible()
  })

  // hash changes drive IN-VIEW selection (the People view's #<address>) — active view only
  window.addEventListener('hashchange', () => {
    const v = activeView()
    if (v && v.onHashChange) v.onHashChange()
  })
}

init()
