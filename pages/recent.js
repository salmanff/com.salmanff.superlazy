// recent.js — the TASKS VIEW of the shell page (shell.js): every task of every project, sliced the
// same way a project card is — page-wide tabs I owe / Team / Owed / Read / People / All Tasks /
// Messages / Events. Formerly the standalone Tasks page's entry point; the data now lives in the
// shared appStore (one events loader for the whole shell) and the cross-view wiring is installed
// once by the shell — this module owns the tab + filter state, the working-set cuts, and the
// painting. The shared filter bar cuts one working set for every tab: timeframe on PROCESSED time,
// min-priority, "show only" restrictors, hide toggles and text search — WHAT shows, never in what
// order. The ORDER is its own pill, right-aligned on the section-title line under the tabs
// (sortPill), which also flags when a priority edit is holding the order still (taskSort.js).
// Clicking a project opens it LIVE in a full-screen modal.

import { openEmailViewer } from '../shared/emailViewer.js'
import {
  setStatus, setHideResolved, setOnlyMine, setHideNotDue
} from '../shared/ui.js'
import { isDueDated, effImportance } from '../jobs/analyze_thread/dueDates.js'
import { sortImportanceOf, sortTouchOf, lastTouchOf, isSortHeld, releaseSortHold } from '../shared/taskSort.js'
import { createFilterBar, sinceMsForPreset, passesOnly, slMark, sharedRepoFilter, sharedSearch } from '../shared/filterBar.js'
import { getAccountFilter, getAccountFilterTag, matchesAccountSource } from '../shared/mailTools.js'
import { buildDigest, processedClock } from './recentData.js'
import {
  PAGE_DIRS, renderPageTabs, renderTaskEntries, renderPeopleTab, renderAllTasksTab,
  renderResolved, renderProjectGroups, renderDecisions, fmtAgo
} from './recentUi.js'
import { buildPeople } from './peopleData.js'
import { renderFeed, matchesSearch, eventImportance, eventWho, reposOfEvent } from './eventsUi.js'
import { applyAutoProcess, userAutoProcessPatch } from '../jobs/analyze_thread/autoProcess.js'
import { reposOfTask, parseSearch, repoQueryMatches, repoFilterMatches, allReposOfProjects } from '../shared/renderUtils.js'

const el = (id) => document.getElementById(id)

const EVENTS_CAP = 1000 // the "All" timeframe loads this many events up front; Load older ↓ pages on

export function createTasksView ({ app, taskHandlers, nameOf, getProject, projectName, onOpenProject, mailCtx }) {
  // filter + view state (owned here; the shared filter bar / tab bar just report changes)
  let activeTab = 'i_owe_them' // the landing tab: what's on my plate
  let tfKey = 'night'
  let tfSinceMs = sinceMsForPreset('night')
  let minImp = 0
  // "SHOW ONLY" is now the page's whole WHAT-shows filter — the Hide row is gone, because the
  // direction cuts it carried are what the tabs already do (user, 2026-09-12). Buttons:
  // unresolved · resolved | due | manual · auto · SuperLazy. They AND, so unresolved + resolved
  // is deliberately empty. The WHO trio is the Events (Messages) page's, with the same meaning
  // (eventsUi.eventWho): it cuts the digest's lines, the Messages tab, AND which events count as
  // "touching" a task for the timeframe window — pressing Manual after a clean-up shows only
  // what you did by hand (user, 2026-10-04: clean-up items were in "since last night").
  const onlyKeys = new Set()
  const WHO_KEYS = ['manual', 'auto', 'superlazy']
  const whoKey = () => WHO_KEYS.find(k => onlyKeys.has(k)) || null // the group is exclusive — at most one
  const eventPassesWho = (ev) => { const w = whoKey(); return !w || eventWho(ev) === w }
  // the search text and the repo cut FOLLOW you between views (filterBar's shared state)
  const query = () => sharedSearch()
  const repoFilter = () => sharedRepoFilter()
  // the digest's Resolved list is resolved rows only — it goes when unresolved-only is asked for
  const hideDone = () => onlyKeys.has('unresolved')
  let showAllResolved = false // the All-Tasks tab's "+ N more resolved" expander (resets on tab switch)
  let selectedPerson = null   // the People tab's selected address (falls back to the first listed)
  let peopleSort = 'rank'     // People tab list order: 'rank' (priority) or 'name'
  let taskSort = 'priority'   // task-list order: 'priority' | 'date' (last touched) | 'due' (overdue first) | 'project'
  let msgLimit = 100          // the Messages tab shows this many cards; Show more ↓ raises it
  let acctFilter = getAccountFilter() // '' = all; the topbar account picker (shared across pages)
  let digest = null
  let fb = null // the filter bar handle — getSinceMs() re-anchors relative windows on refresh
  let byDirCache = {} // direction key -> { open, done }, rebuilt by every paint()

  // the events feeding the digest, cut to the chosen account (manual edits are account-agnostic).
  function eventsForView () {
    if (!acctFilter) return app.events
    return app.events.filter(e => e.kind === 'manual_edit' || !e.account_id || e.account_id === acctFilter)
  }

  function openEmailForAction (a) {
    openEmailViewer({ msg_id: a.msg_id, thread_id: a.thread_id, account_id: a.account_id, subject: a.subject, snippet: a.snippet })
  }

  // The task rows here are THE standard rows acting on the LIVE store objects — resolve the
  // action's ids to them (edits route through the shell's shared handlers + manual-event listener)
  function resolveEntry (a) {
    const p = getProject(a.project_id)
    const t = p && (p.todos || []).find(t => t.todo_id === a.todo_id)
    return (p && t) ? { todo: t, project: p } : null
  }

  // ---- the working set: tasks from the LIVE projects, cut by the shared filters ---------------

  const isOpenTodo = (t) => t.status === 'open' || t.status === 'in_progress'
  const lastTouch = lastTouchOf // the canonical copy now lives in taskSort.js, beside the sort keys

  function visibleProjectsForTasks () {
    let projects = app.store ? app.store.all() : []
    // the topbar account picker: a project belongs to whichever account(s) fed it (projects.sources)
    const tag = getAccountFilterTag()
    if (tag) projects = projects.filter(p => matchesAccountSource(p, tag))
    return projects
  }

  // The timeframe cuts tasks on PROCESSED time, like the digest: a task is "in the window" when a
  // windowed event touched it (so a training run over old mail counts as new), with the task's own
  // dates as a fallback (manual adds raise no message event). null = no cut (the All timeframe).
  // With a WHO button pressed only THAT actor's events count ("what did SuperLazy touch since
  // last night?"), and the task's own-dates fallback is off — a clean-up resolve bumps a task's
  // resolved_asof, so the fallback would put it straight back into a Manual-only window.
  function windowedTodoIds () {
    if (tfKey === 'all' || !tfSinceMs) return null
    const ids = new Set()
    for (const ev of eventsForView()) {
      if (processedClock(ev) < tfSinceMs) break // events are sorted newest-first
      if (!eventPassesWho(ev)) continue
      if (ev.todo_id) ids.add(ev.todo_id)
      for (const c of (ev.changes || [])) if (c.todo_id) ids.add(c.todo_id)
    }
    return ids
  }
  const taskInWindow = (t, ids) => !ids || (t.todo_id && ids.has(t.todo_id)) || (!whoKey() && lastTouch(t) >= tfSinceMs)

  function taskMatches (t, p, needle) {
    const q = parseSearch(needle)
    if (q.repo !== null) return repoQueryMatches(reposOfTask(t, p), q.repo)   // "#name": repos only
    needle = q.needle
    const hay = [
      t.short_description, t.description, t.due_hint, t.sender, t.owner, t.counterparty,
      ...(t.owners || []), nameOf(t.sender), nameOf(t.owner), p.name,
      // the row shows the repo, so the row must be findable by it
      ...reposOfTask(t, p).flatMap(r => [r.name, r.slug])
    ].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(needle)
  }

  // the "show only" restrictors: every pressed button must match (they AND). Unresolved and
  // resolved contradict, so pressing both shows nothing — that is what the mini separator marks
  // (and why pressing one releases the other). "Due" means a REAL due window that has started —
  // an undated task is not due (isDueDated, not the old hide's isDueNow).
  const taskPassesOnly = (t) => passesOnly(onlyKeys, (k) => {
    if (k === 'unresolved') return isOpenTodo(t)
    if (k === 'resolved') return !isOpenTodo(t)
    return isDueDated(t)
  })

  // all tasks of one direction that survive the filters, split open/done and sorted for display
  function collectEntries (dirKey, ids, needle) {
    const open = []
    const done = []
    for (const p of visibleProjectsForTasks()) {
      for (const t of (p.todos || [])) {
        if (t.direction !== dirKey) continue
        if (!taskPassesOnly(t)) continue
        if (!repoFilterMatches(reposOfTask(t, p), repoFilter())) continue
        if (minImp && effImportance(t) < minImp) continue
        // SEARCHING MEANS "find it, wherever it is": a typed needle lifts the timeframe cut.
        // Without this the box silently ANDs with "Last night" and a word you know is in there
        // finds nothing (user, 2026-09-12 — "the old filter acts like an AND, sometimes").
        if (!needle && !taskInWindow(t, ids)) continue
        if (needle && !taskMatches(t, p, needle)) continue
        ;(isOpenTodo(t) ? open : done).push({ todo: t, project: p })
      }
    }
    sortEntries(open)
    done.sort((a, b) => (Number(b.todo.resolved_asof) || 0) - (Number(a.todo.resolved_asof) || 0))
    return { open, done }
  }

  // Asking to see resolved items means the direction tabs must show their resolved rows — those
  // tabs otherwise list open tasks alone.
  const showDoneOnTabs = () => onlyKeys.has('resolved')
  const tabEntries = (dirKey) => showDoneOnTabs()
    ? byDirCache[dirKey].open.concat(byDirCache[dirKey].done)
    : byDirCache[dirKey].open

  // the page's sort pill (sortPill, below): priority (default) / date changed (last touched,
  // newest first) / date due (overdue on top, later dates after, no-date last) / project
  // (grouped alphabetically).
  // Keys come from taskSort.js, not straight off the task: a row whose priority you just nudged
  // keeps sorting on the value it HAD, so the list stays still under the cursor until you ask
  // the sort control for a fresh order (user, 2026-08-31).
  function sortEntries (list) {
    if (taskSort === 'date') {
      list.sort((a, b) => sortTouchOf(b.todo) - sortTouchOf(a.todo))
    } else if (taskSort === 'due') {
      // ascending by the due window's end, so past-due leads and later dates follow; tasks with
      // NO due date sit after every dated one (nothing says they are urgent), priority within.
      // "asap" outranks every date — its machine window is just the day it was set, but the
      // word means "before all of these" (user, 2026-08-27)
      const isAsap = (t) => /\basap\b/i.test(String(t.due_hint || ''))
      const dueKey = (t) => t.due_latest || t.due_earliest || '' // ISO days compare lexically
      list.sort((a, b) => {
        const aa = isAsap(a.todo); const ab = isAsap(b.todo)
        if (aa !== ab) return aa ? -1 : 1
        const da = dueKey(a.todo); const db = dueKey(b.todo)
        if (da && db && da !== db) return da < db ? -1 : 1
        if (!!da !== !!db) return da ? -1 : 1
        return (sortImportanceOf(b.todo) - sortImportanceOf(a.todo)) || (sortTouchOf(b.todo) - sortTouchOf(a.todo))
      })
    } else if (taskSort === 'project') {
      list.sort((a, b) => String(a.project.name || '').localeCompare(String(b.project.name || '')) ||
        (sortImportanceOf(b.todo) - sortImportanceOf(a.todo)))
    } else {
      list.sort((a, b) => (sortImportanceOf(b.todo) - sortImportanceOf(a.todo)) || (sortTouchOf(b.todo) - sortTouchOf(a.todo)))
    }
  }

  // ---- the page's SORT CONTROL ---------------------------------------------------------------
  // It lives on the section-title line, right-aligned, in the project card's pill language — not
  // in the filter bar, which is about WHAT shows, not what order it shows in (user, 2026-08-31).
  // One pill that names the current order and cycles to the next on click; when a priority edit
  // is holding the order still it flags that too, and clicking releases the hold.
  const SORT_ORDER = [
    { key: 'priority', label: 'priority', hint: 'highest priority first' },
    { key: 'date', label: 'date changed', hint: 'most recently touched first' },
    { key: 'due', label: 'date due', hint: 'overdue first, undated last' },
    { key: 'project', label: 'project', hint: 'grouped by project name' }
  ]
  function sortPill () {
    const at = Math.max(0, SORT_ORDER.findIndex(o => o.key === taskSort))
    const cur = SORT_ORDER[at]
    const next = SORT_ORDER[(at + 1) % SORT_ORDER.length]
    const held = isSortHeld()
    const b = document.createElement('button'); b.type = 'button'
    b.className = 'epv-allres epv-allres-bucket epv-sortbtn rc-sortbtn' + (held ? ' epv-sortbtn-held' : '')
    b.textContent = '⇅ ' + cur.label + (held ? ' ⚠' : '')
    b.title = held
      ? 'Sorted by ' + cur.label + ', but the order is HELD where it was while you changed ' +
        'priorities — so nothing jumped out from under you. Click to re-sort by ' + cur.label + '.'
      : 'Sorted by ' + cur.label + ' (' + cur.hint + ') — click to sort by ' + next.label
    b.addEventListener('click', () => {
      // a click IS the user asking for an order: let go of any hold, then advance
      if (isSortHeld()) { releaseSortHold() } else { taskSort = next.key }
      paint()
    })
    return b
  }

  // ---- the Messages tab: the events log's MAIL, cut by the same shared filters -----------------
  // (manual edits and pure housekeeping stay out — this tab is the message history behind the
  // tasks, rendered with the Events page's mail-client cards)
  const evCtx = {
    nameOf: (a) => nameOf(a),
    projectName: (id) => projectName(id),
    getProject: (pid) => getProject(pid),   // matchesSearch: repo: queries match via the touched projects' repos
    todoShort: (pid, tid) => { const e = resolveEntry({ project_id: pid, todo_id: tid }); return (e && (e.todo.short_description || e.todo.description)) || '' },
    todoImp: (pid, tid) => { const e = resolveEntry({ project_id: pid, todo_id: tid }); return e ? effImportance(e.todo) : 0 },
    projectImp: (pid) => { const p = getProject(pid); return (p && p.importance) || 0 },
    labelName: () => null
  }
  function messageEvents () {
    const out = []
    for (const ev of eventsForView()) {
      if (!ev.msg_id || ev.kind === 'manual_edit') continue
      if (tfKey !== 'all' && tfSinceMs && processedClock(ev) < tfSinceMs) break // newest-first
      if (!eventPassesWho(ev)) continue
      if (minImp && eventImportance(ev, evCtx) < minImp) continue
      if (!repoFilterMatches(reposOfEvent(ev, evCtx), repoFilter())) continue
      if (query() && !matchesSearch(ev, query(), evCtx)) continue
      out.push(ev)
    }
    return out
  }

  // the People tab's working set: who owes what (Owed to you + Team), heaviest debtors first.
  // A search hit on the PERSON keeps all their items; otherwise items filter like everywhere else.
  function peopleEntries (ids, needle) {
    const selfSet = new Set(taskHandlers.self)
    const persons = buildPeople({ profiles: app.rawProfiles, projects: visibleProjectsForTasks(), events: [], selfSet })
    const out = []
    for (const person of persons) {
      const personHit = needle && parseSearch(needle).repo === null && (person.name + ' ' + person.address).toLowerCase().includes(needle)   // a repo query never matches a person
      const filt = (list) => list.filter(({ todo, project }) =>
        taskPassesOnly(todo) &&
        repoFilterMatches(reposOfTask(todo, project), repoFilter()) &&
        (!minImp || effImportance(todo) >= minImp) &&
        (!!needle || taskInWindow(todo, ids)) && // a search lifts the timeframe cut (collectEntries)
        (!needle || personHit || taskMatches(todo, project, needle)))
      const owedEntries = filt(person.open.they_owe_me)
      const teamEntries = filt(person.open.team_owes)
      if (!owedEntries.length && !teamEntries.length) continue
      out.push({ name: person.name, address: person.address, rank: person.rank, owedEntries, teamEntries })
    }
    if (peopleSort === 'name') {
      out.sort((a, b) => a.name.localeCompare(b.name))
    } else {
      out.sort((a, b) => (b.rank - a.rank) ||
        ((b.owedEntries.length + b.teamEntries.length) - (a.owedEntries.length + a.teamEntries.length)))
    }
    return out
  }

  // ---- painting ---------------------------------------------------------------------------

  const DIR_TITLES = {
    i_owe_them: { title: 'I owe', hint: 'on your plate' },
    team_owes: { title: 'Team owes', hint: 'on the team’s plate' },
    they_owe_me: { title: 'Owed to you', hint: 'what others owe you' },
    read_only: { title: 'To read / FYI', hint: 'no action expected — just worth knowing' }
  }

  // the Events/Messages tabs' "Load older ↓" — server paging only when the timeframe is All (a
  // bounded window is always loaded in full). On the Messages tab a "Show more ↓" comes first,
  // revealing already-loaded cards before anything is fetched.
  function paintOlderButton ({ msgShown = 0, msgTotal = 0 } = {}) {
    const host = el('rcOlder')
    host.textContent = ''
    host.style.display = 'none'
    const mkBtn = (label, fn) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'rc-older-btn'
      b.textContent = label
      b.addEventListener('click', () => fn(b))
      host.style.display = ''
      host.appendChild(b)
    }
    if (activeTab === 'messages' && msgShown < msgTotal) {
      mkBtn('Show ' + Math.min(100, msgTotal - msgShown) + ' more ↓ (' + (msgTotal - msgShown) + ' older loaded)', () => {
        msgLimit += 100
        paint()
      })
      return
    }
    if ((activeTab !== 'events' && activeTab !== 'messages') || tfKey !== 'all' || !app.hasMoreEvents()) return
    mkBtn('Load older ↓ (' + app.loadedEventsCount() + ' loaded so far)', async (b) => {
      b.disabled = true
      b.textContent = 'Loading…'
      try {
        await app.loadOlderEvents()
        paint()
      } catch (e) {
        setStatus('Could not load older events: ' + ((e && e.message) || e), 'error')
      }
    })
  }

  // the project modal's to-do lists follow the same cut (ui.js's flags are the only channel).
  // "Not mine" has no button here any more — the TABS are the direction cut — so it stays off.
  function syncModalFlags () {
    setHideResolved(hideDone())
    setOnlyMine(false)
    setHideNotDue(onlyKeys.has('due'))
  }

  function paint () {
    if (!app.store) return
    if (fb) fb.refresh() // the # button and the search box catch up with the shared state
    digest = buildDigest({ events: eventsForView(), getProject, nameOf, sinceMs: tfSinceMs, minImp, q: query(), who: whoKey() })

    const ids = windowedTodoIds()
    const needle = query().trim().toLowerCase()
    const byDir = {}
    const counts = {}
    const maxImps = {}
    for (const d of PAGE_DIRS) {
      byDir[d.key] = collectEntries(d.key, ids, needle)
    }
    byDirCache = byDir
    for (const d of PAGE_DIRS) {
      // with "only resolved" on, the tabs list their resolved rows — so count what they SHOW
      const shown = tabEntries(d.key)
      counts[d.key] = shown.length
      maxImps[d.key] = shown.reduce((m, e) => Math.max(m, effImportance(e.todo)), 0) || 3
    }
    const people = peopleEntries(ids, needle)
    const msgs = messageEvents()
    counts.people = people.length
    counts.events = digest.windowedCount
    counts.messages = msgs.length

    renderPageTabs(el('rcTabs'), {
      active: activeTab,
      counts,
      maxImps,
      onSelect: (key) => {
        // a different list: nothing is being held in place any more, so re-sort it properly
        releaseSortHold()
        activeTab = key; showAllResolved = false; msgLimit = 100; paint()
      }
    })

    // one host for the task views; the Events tab uses its own three sections + the older button
    const eventsMode = activeTab === 'events'
    const taskHost = el('rcTasks')
    taskHost.style.display = eventsMode ? 'none' : ''
    el('rcResolved').style.display = 'none'
    el('rcDecisions').style.display = 'none'
    el('rcProjects').style.display = eventsMode ? '' : 'none'

    let msgShown = 0
    if (eventsMode) {
      if (!hideDone()) {
        el('rcResolved').style.display = ''
        renderResolved(el('rcResolved'), digest.resolved, { resolveEntry, taskHandlers, onOpenProject })
      }
      renderDecisions(el('rcDecisions'), digest.decisions, {
        onStopAutofile: stopAutofile,
        onOpenPerson: (addr) => taskHandlers.onOpenPerson && taskHandlers.onOpenPerson(addr)
      })
      renderProjectGroups(el('rcProjects'), digest.projects, {
        onSelect: (projectId) => { const p = getProject(projectId); if (p) onOpenProject(p) },
        onOpenEmail: openEmailForAction
      })
    } else if (activeTab === 'messages') {
      // the message history behind the tasks — the Events page's mail-client cards (summary,
      // live task rows, inline drafts, ✉ opens the full email + thread), cut by the shared filters
      const r = renderFeed(taskHost, msgs, evCtx, {
        limit: msgLimit,
        onOpenEmail: openEmailForAction,
        onResolveTodo: (pid, tid) => resolveEntry({ project_id: pid, todo_id: tid }),
        drafts: mailCtx ? mailCtx.draftHandlers : { resolve: () => null },
        taskHandlers,
        onOpenProject,
        getProject
      })
      msgShown = r.shown
    } else if (activeTab === 'people') {
      // resolve the selection against the CURRENT list (filters may have dropped the old pick)
      const selected = people.find(p => p.address === selectedPerson) || people[0] || null
      renderPeopleTab(taskHost, people, {
        taskHandlers,
        onOpenProject,
        onOpenPerson: taskHandlers.onOpenPerson,
        tools: sortPill(),
        selected,
        sort: peopleSort,
        onSelectPerson: (addr) => { selectedPerson = addr; paint() },
        onSortChange: (s) => { peopleSort = s; paint() }
      })
    } else if (activeTab === 'all') {
      renderAllTasksTab(taskHost, PAGE_DIRS.map(d => ({
        key: d.key,
        tab: d.tab,
        open: byDir[d.key].open,
        // collectEntries already applied the only-filters to both halves, so "only unresolved"
        // leaves `done` empty of its own accord
        done: byDir[d.key].done
      })), {
        taskHandlers,
        onOpenProject,
        tools: sortPill(),
        showAllResolved,
        onExpandResolved: () => { showAllResolved = true; paint() }
      })
    } else {
      const d = DIR_TITLES[activeTab] || { title: activeTab, hint: '' }
      renderTaskEntries(taskHost, tabEntries(activeTab), { taskHandlers, onOpenProject }, {
        title: d.title,
        hint: d.hint + (tfKey === 'all' ? '' : ' — touched in this window'),
        empty: onlyKeys.size
          ? 'Nothing here matches the “show only” filters.'
          : (tfKey === 'all' ? 'Nothing outstanding here. 🎉' : 'Nothing in this window — widen the timeframe to see more.'),
        tools: sortPill()
      })
    }
    paintOlderButton({ msgShown, msgTotal: msgs.length })

    if (activeTab !== 'events' || digest.windowedCount) {
      setStatus('') // content speaks for itself — no banner
    } else if (app.events.length) {
      setStatus('All quiet in this window. Last activity was ' + fmtAgo(processedClock(app.events[0])) + ' — widen the timeframe to see it.', 'info')
    } else {
      setStatus('No events yet — process some messages on the Setup & Prefs page first.', 'info')
    }
  }

  // One tap from an automation-decision row: stop auto-filing this sender for good (locked, so the
  // model can never re-learn them). "Change" opens the person modal, which also offers the softer
  // "Reset — let the AI decide next time".
  async function stopAutofile (address) {
    const addr = String(address || '').toLowerCase()
    const person = app.profiles && addr ? app.profiles.get(addr) : null
    if (!person) return
    person.profile = person.profile || {}
    applyAutoProcess(person.profile, userAutoProcessPatch('off', { asof: Date.now() }))
    try {
      if (app.persist) await app.persist.saveProfile(person)
      setStatus('Auto-filing off for ' + addr + ' — every message from them will be analysed.', 'info')
    } catch (e) {
      setStatus('Could not save that: ' + ((e && e.message) || e), 'error')
    }
    paint()
  }

  // ---- loading ----------------------------------------------------------------------------

  // load enough of the shared events log for the selected window, repainting if more arrived
  async function topUp () {
    const before = app.loadedEventsCount()
    try {
      await app.ensureEventCoverage({ tfKey, tfSinceMs, cap: EVENTS_CAP })
    } catch (e) {
      setStatus('Could not load events: ' + ((e && e.message) || e), 'error')
      return
    }
    if (app.loadedEventsCount() !== before) paint()
  }

  function mount () {
    fb = createFilterBar(el('filterbar-recent'), {
      timeframe: {
        active: tfKey,
        onChange: (key, sinceMs) => {
          tfKey = key
          tfSinceMs = sinceMs
          // widening the window may need more of the log — top up, then repaint
          paint()
          topUp()
        }
      },
      priority: { active: minImp, onChange: (v) => { minImp = v; paint() } },
      // SHOW ONLY — the page's whole WHAT-shows filter now that the Hide row is gone: the
      // direction cuts Hide carried are exactly what the TABS do, so status and due are left
      // (user, 2026-09-12), plus — after a rule, because it is a different question that ANDs
      // with them — WHO did it: your pen, the standing automation's cog, SuperLazy's pentagon
      // (the Events page's trio; user, 2026-10-04). Nothing pressed = no restriction. (The sort
      // is NOT here — it lives on the section-title line as a pill; see sortPill().)
      only: {
        items: [
          { key: 'unresolved', group: 'status', icon: '☐', label: 'Unresolved', title: 'only to-dos still open or in progress' },
          { key: 'resolved', group: 'status', icon: '☑️', grey: true, label: 'Resolved / cancelled', title: 'only to-dos that are done or written off' },
          { key: 'due', group: 'due', icon: '⏱', label: 'Due', title: 'only to-dos with a due date that has arrived — undated to-dos are not due' },
          { key: 'manual', group: 'who', icon: '✍️', label: 'Manual edits', title: 'only what YOU changed by hand — and only the to-dos you touched in the window' },
          { key: 'auto', group: 'who', icon: '⚙', label: 'Auto-processed', title: 'only auto-processed / skipped mail and SuperLazy’s own housekeeping' },
          { key: 'superlazy', group: 'who', node: slMark, label: 'SuperLazy', title: 'only what SuperLazy did itself — analysed messages, its auto-file decisions and the clean-up changes you accepted' }
        ],
        onChange: (key, on) => {
          if (on) onlyKeys.add(key); else onlyKeys.delete(key)
          syncModalFlags()
          paint()
        }
      },
      // the # chooser, at the end of the same row: hidden until the data has a repo, and SHARED
      // with the other views (filterBar keeps the value)
      repos: {
        items: () => allReposOfProjects(app.store ? app.store.all() : []),
        onChange: () => paint()
      },
      // shared with the other views too — the text follows you from Tasks to the board to Events
      search: {
        placeholder: 'Filter by person, to-do, subject or project…',
        onChange: () => paint()
      }
    })
  }

  function show () {
    const host = el('view-recent')
    if (host) host.style.display = ''
    // re-assert the ui.js modal flags this view's filters own — the other view may have set them
    syncModalFlags()
    tfSinceMs = fb ? fb.getSinceMs() : tfSinceMs // re-anchor relative windows ("past hour" = now)
    paint()
    topUp()
  }

  function hide () {
    const host = el('view-recent')
    if (host) host.style.display = 'none'
  }

  async function onReload () {
    releaseSortHold() // fresh data — sort it properly again
    tfSinceMs = fb ? fb.getSinceMs() : sinceMsForPreset(tfKey, tfSinceMs)
    await app.ensureEventCoverage({ tfKey, tfSinceMs, cap: EVENTS_CAP })
      .catch(e => setStatus('Could not load events: ' + ((e && e.message) || e), 'error'))
    paint()
  }

  // the topbar account picker changed (shell relays it; repaint is the shell's job)
  function onAccountChange (v) { acctFilter = v }

  // tab refocus: stay current while processing runs elsewhere; re-anchor the live window. A full
  // reload only when the data is actually stale — switching apps for a moment shouldn't refetch.
  function onVisible () {
    tfSinceMs = fb ? fb.getSinceMs() : sinceMsForPreset(tfKey, tfSinceMs)
    if (Date.now() - (app.lastLoadedAt || 0) > 60000) {
      app.reload().catch(e => console.error('refresh failed', e)) // onReload repaints via the shell
    } else {
      paint()
      topUp()
    }
  }

  return { key: 'recent', mount, show, hide, paint, onReload, onAccountChange, onVisible }
}
