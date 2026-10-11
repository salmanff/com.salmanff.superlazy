// events.js — the EVENTS VIEW of the shell page (shell.js): the reverse-chronological feed of
// everything that happened (analysed messages, auto-processed mail, your manual edits). Formerly
// the standalone Events page's entry point; the events now come from the shell's shared appStore
// loader and the cross-view wiring (viewer, mail tools, ui.js hooks, manual-event listener) is
// installed once by the shell — this module owns the feed's filters, its ordering (the ANALYSIS
// clock: the message's own date, unlike the store's processed-time order) and the painting.

import { eventClock } from './eventsData.js'
import { effImportance, isDueDated } from '../jobs/analyze_thread/dueDates.js'
import { setStatus } from '../shared/ui.js'
import { renderFeed, matchesSearch, eventImportance, eventWho, reposOfEvent } from './eventsUi.js'
import { openEmailViewer } from '../shared/emailViewer.js'
import { createFilterBar, passesOnly, slMark, sharedRepoFilter, sharedSearch } from '../shared/filterBar.js'
import { getAccountFilter } from '../shared/mailTools.js'
import { repoFilterMatches, allReposOfProjects } from '../shared/renderUtils.js'
import { ensurePriceMap } from '../shared/eqPricing.js'

const el = (id) => document.getElementById(id)
const PAGE = 100

// a manual edit whose only content is a resolve/cancel — the one event type Hide-resolved drops
// (analysed messages stay: the feed is an audit log)
const isResolveEdit = (ev) => ev.kind === 'manual_edit' && ev.field === 'status' &&
  (ev.after === 'resolved' || ev.after === 'cancelled')

// WHO did it — ✍️ you · ⚙ the standing automation · ⬠ SuperLazy itself. ONE definition for every
// page (eventsUi.eventWho); the To-dos page's bar carries the same three buttons. A clean-up
// change you accepted is SuperLazy's (it proposed it), not a manual edit (2026-10-04).
const isManual = (ev) => eventWho(ev) === 'manual'
const isAuto = (ev) => eventWho(ev) === 'auto'
const isSuperlazy = (ev) => eventWho(ev) === 'superlazy'

export function createEventsView ({ app, nameOf, getProject, projectName, taskHandlers, onOpenProject, mailCtx }) {
  // eq prices for $0 local-connector events need the API price list; repaint once it has loaded
  ensurePriceMap().then(() => { try { paint() } catch (err) { /* not mounted yet — the first paint prices them */ } })
  let minImp = 0
  // SHOW ONLY, in place of the Hide row (user, 2026-09-12). Every pressed button must match: the
  // STATUS of the tasks a row touched (the Tasks page's own icons) and WHO did it (manual /
  // auto-processed / SuperLazy). Nothing pressed = the whole feed; two buttons from the same side
  // of a mini separator contradict, so pressing both shows nothing.
  const onlyKeys = new Set()
  // the search text and the repo cut FOLLOW you between views (filterBar's shared state)
  const query = () => sharedSearch()
  const repoFilter = () => sharedRepoFilter()
  let acctFilter = getAccountFilter() // '' = all; the topbar account picker (shared across pages)
  let limit = PAGE
  let fb = null // the filter bar handle — refresh() re-checks the # button and the search box

  // the feed orders by the ANALYSIS clock (asof — the message's own date), newest first; the
  // store's merged log is ordered by processed time, so re-sort a copy per paint (cheap at ~1-2k)
  const sortedEvents = () => app.events.slice().sort((a, b) => eventClock(b) - eventClock(a))

  // ✉ on a task row goes STRAIGHT to the full email + thread (the feed line already shows the
  // summary). msgId names a SPECIFIC evidence message; without one, the newest email behind the
  // task. Everything else on the row is the shared shell handlers (live self / repaints).
  const feedTaskHandlers = Object.create(taskHandlers)
  feedTaskHandlers.openEmailModal = (t, p, msgId) => {
    const evs = (t.evidence || []).filter(e => e.msg_id)
    const evd = (msgId && evs.find(e => e.msg_id === msgId)) ||
      evs.reduce((best, e) => (!best || (Number(e.asof) || 0) >= (Number(best.asof) || 0)) ? e : best, null)
    if (evd) openEmailViewer({ msg_id: evd.msg_id, thread_id: evd.thread_id })
  }

  // user-created mail label ids → their display names (Gmail user labels list as opaque
  // "Label_123…" ids). Best-effort, loaded lazily on the view's FIRST show: no mail connection /
  // expired token simply leaves custom folders unnamed (skipped rather than shown raw).
  const labelNames = new Map() // "connectionName|labelId" -> name
  let labelsRequested = false
  async function loadLabelNames () {
    if (labelsRequested) return
    labelsRequested = true
    try {
      if (typeof freezr === 'undefined' || !freezr.connections || !freezr.connections.mail) return
      const { accounts } = await freezr.connections.mail.listAccounts()
      for (const a of (accounts || [])) {
        try {
          const { folders } = await freezr.connections.mail.listFolders({ connectionName: a.connectionName })
          for (const f of (folders || [])) labelNames.set(a.connectionName + '|' + f.id, f.name)
        } catch (e) { /* per-account best effort */ }
      }
      if (labelNames.size) paint()
    } catch (e) { /* archive source / no grant — mail folders just stay system-only */ }
  }

  // the live lookups eventsUi renders with (the old page built these from a loadAll snapshot;
  // here they read the LIVE store, like the Tasks view's message cards)
  const ctx = {
    nameOf,
    projectName,
    getProject,   // matchesSearch: a repo: query matches through the repos of the projects an event touched
    todoShort: (pid, tid) => {
      const p = getProject(pid)
      const t = p && (p.todos || []).find(t => t.todo_id === tid)
      return (t && (t.short_description || t.description)) || ''
    },
    todoImp: (pid, tid) => {
      const p = getProject(pid)
      const t = p && (p.todos || []).find(t => t.todo_id === tid)
      return t ? effImportance(t) : 0
    },
    // a project's own priority — auto-processed events rank by the project they were filed into,
    // so a newsletter in a priority-1 bucket filters out like one
    projectImp: (pid) => { const p = getProject(pid); return (p && Number(p.importance)) || 0 },
    labelName: (accountId, labelId) => labelNames.get(accountId + '|' + labelId) || null
  }

  // The LIVE tasks one event touched (its own todo_id plus every change it recorded) — what the
  // status half of "show only" tests. A row that touched no task matches no status button, so it
  // drops out as soon as one is pressed; that is the point of asking for "only unresolved".
  function todosOf (ev) {
    const out = []
    const add = (pid, tid) => {
      if (!tid) return
      const p = getProject(pid)
      const t = p && (p.todos || []).find(t => t.todo_id === tid)
      if (t) out.push(t)
    }
    add(ev.project_id, ev.todo_id)
    for (const c of (ev.changes || [])) add(c.project_id, c.todo_id)
    return out
  }
  const isOpenTodo = (t) => t.status === 'open' || t.status === 'in_progress'

  // Every pressed button must match (they AND): status against the tasks the row touched, and
  // who did it. manual / auto / SuperLazy are mutually exclusive by construction, so pressing two
  // of them is an empty list on purpose — the mini separator is the warning.
  // A resolve/cancel edit counts as "resolved" on its own account: it IS the resolution, even
  // when the task it closed has since been deleted.
  const STATUS_KEYS = ['unresolved', 'resolved', 'due']
  function eventPassesOnly (ev) {
    const todos = STATUS_KEYS.some(k => onlyKeys.has(k)) ? todosOf(ev) : []
    return passesOnly(onlyKeys, (k) => {
      if (k === 'unresolved') return todos.some(isOpenTodo)
      if (k === 'resolved') return isResolveEdit(ev) || todos.some(t => !isOpenTodo(t))
      if (k === 'due') return todos.some(t => isOpenTodo(t) && isDueDated(t))
      if (k === 'manual') return isManual(ev)
      if (k === 'auto') return isAuto(ev)
      return isSuperlazy(ev)
    })
  }

  function filtered (evs) {
    return (evs || sortedEvents()).filter(ev =>
      matchesSearch(ev, query(), ctx) &&
      (!minImp || eventImportance(ev, ctx) >= minImp) &&
      eventPassesOnly(ev) &&
      repoFilterMatches(reposOfEvent(ev, ctx), repoFilter()) &&
      (!acctFilter || ev.kind === 'manual_edit' || !ev.account_id || ev.account_id === acctFilter))
  }

  function resolveTodo (projectId, todoId) {
    const p = getProject(projectId)
    const t = p && (p.todos || []).find(t => t.todo_id === todoId)
    return (p && t) ? { todo: t, project: p } : null
  }

  function paint () {
    if (!app.store) return
    if (fb) fb.refresh() // the # button and the search box catch up with the shared state
    const events = filtered()
    const { shown, total } = renderFeed(el('feed'), events, ctx, {
      limit,
      onOpenEmail: (ev) => openEmailViewer({ msg_id: ev.msg_id, thread_id: ev.thread_id, account_id: ev.account_id, subject: ev.subject, snippet: ev.body_snippet }),
      onResolveTodo: resolveTodo,
      drafts: mailCtx ? mailCtx.draftHandlers : { resolve: () => null },
      taskHandlers: feedTaskHandlers,
      onOpenProject,
      // the auto-processed "filed to" pill resolves its project against the LIVE store
      getProject
    })
    // the one button covers both steps: reveal more of what's loaded, then pull older pages from
    // the server once the loaded log runs out (the log grows without bound — it never loads whole)
    const more = el('moreBtn')
    const serverHasMore = app.hasMoreEvents()
    if (shown < total) {
      more.style.display = ''
      more.textContent = 'Show ' + Math.min(PAGE, total - shown) + ' more (' + (total - shown) + (serverHasMore ? '+' : '') + ' older)'
    } else if (serverHasMore) {
      more.style.display = ''
      more.textContent = 'Load older ↓ (' + app.events.length + ' loaded so far)'
    } else {
      more.style.display = 'none'
    }
    setStatus(app.events.length ? '' : 'No events yet — process some messages on the Setup & Prefs page first.')
  }

  function mount () {
    fb = createFilterBar(el('filterbar-events'), {
      priority: { active: minImp, onChange: (v) => { minImp = v; limit = PAGE; paint() } },
      // SHOW ONLY, in place of the Hide row. The Tasks page's status icons first, then — after a
      // rule, because it is a different question that ANDs with them — WHO did it: your pen, the
      // standing automation's cog, and SuperLazy's own red pentagon. Those three are exhaustive
      // and mutually exclusive, so between them they cover every row in the feed.
      only: {
        items: [
          { key: 'unresolved', group: 'status', icon: '☐', label: 'Unresolved', title: 'only rows that touched a to-do still open' },
          { key: 'resolved', group: 'status', icon: '☑️', grey: true, label: 'Resolved / cancelled', title: 'resolve / cancel edits and rows that touched a closed to-do' },
          { key: 'due', group: 'due', icon: '⏱', label: 'Due', title: 'only rows that touched an open to-do whose due date has arrived' },
          { key: 'manual', group: 'who', icon: '✍️', label: 'Manual edits', title: 'only what YOU changed by hand' },
          { key: 'auto', group: 'who', icon: '⚙', label: 'Auto-processed', title: 'only auto-processed / skipped mail and SuperLazy’s own housekeeping' },
          { key: 'superlazy', group: 'who', node: slMark, label: 'SuperLazy', title: 'only what SuperLazy did itself — analysed messages, its auto-file decisions and the clean-up changes you accepted' }
        ],
        onChange: (key, on) => {
          if (on) onlyKeys.add(key); else onlyKeys.delete(key)
          limit = PAGE; paint()
        }
      },
      // the # chooser, at the end of the same row: hidden until the data has a repo, and SHARED
      // with the other views (filterBar keeps the value)
      repos: {
        items: () => allReposOfProjects(app.store ? app.store.all() : []),
        onChange: () => { limit = PAGE; paint() }
      },
      // shared with the other views too — the text follows you from Events to Tasks to the board
      search: {
        placeholder: 'Filter by sender, subject, to-do or project…',
        onChange: () => { limit = PAGE; paint() }
      }
    })
    el('moreBtn').addEventListener('click', async () => {
      limit += PAGE
      // top up from the server when the loaded log can no longer fill the next page (a few pages
      // per click at most, so a narrow filter can't trigger an unbounded fetch loop)
      let fetches = 0
      while (app.hasMoreEvents() && filtered().length < limit && fetches < 4) {
        fetches++
        try {
          await app.loadOlderEvents()
        } catch (e) {
          setStatus('Could not load older events: ' + ((e && e.message) || e), 'error')
          break
        }
      }
      paint()
    })
  }

  function show () {
    const host = el('view-events')
    if (host) host.style.display = ''
    // the feed is deliberately FULL-WIDTH (the old events page's #app had no .su container) —
    // lift the shell's 1180px cap while this view is up, restore it on hide
    const appEl = el('app')
    if (appEl) appEl.classList.remove('su')
    loadLabelNames().catch(() => {})
    paint()
  }

  function hide () {
    const host = el('view-events')
    if (host) host.style.display = 'none'
    const appEl = el('app')
    if (appEl) appEl.classList.add('su')
  }

  async function onReload () {
    paint()
  }

  // the topbar account picker changed (shell relays it; repaint is the shell's job)
  function onAccountChange (v) { acctFilter = v; limit = PAGE }

  // tab refocus: repaint (edits from other views are already in the store); full reload only when
  // the data is actually stale — switching apps for a moment shouldn't refetch everything
  function onVisible () {
    if (Date.now() - (app.lastLoadedAt || 0) > 60000) {
      app.reload().catch(e => console.error('refresh failed', e))
    } else {
      paint()
    }
  }

  return { key: 'events', mount, show, hide, paint, onReload, onAccountChange, onVisible }
}
