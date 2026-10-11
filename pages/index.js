// index.js — the DASHBOARD VIEW of the shell page (shell.js): the user's projects and to-dos on
// the project board. Formerly the standalone Dashboard page's entry point; the data now lives in
// the shared appStore and all cross-view wiring (viewer context, mail tools, ui.js hooks, the
// ＋ Add… button) is installed once by the shell — this module owns only the board: its filters,
// its painting, and the due-date interpreter maintenance pass.

import { setAllCardStates } from '../shared/expandableProjectView.js'
import { getAccountFilterTag, matchesAccountSource } from '../shared/mailTools.js'
import { el, setStatus, renderProjectBoard, setHideResolved, setOnlyMine, setHideNotDue } from '../shared/ui.js'
import { resolveDueRanges, effImportance } from '../jobs/analyze_thread/dueDates.js'
import { createFilterBar, passesOnly, sharedRepoFilter, sharedSearch } from '../shared/filterBar.js'
import { addProjectFlow, addNoteFlow } from './addFlows.js'
import { reposOfProject, parseSearch, repoQueryMatches, repoFilterMatches, allReposOfProjects, REPO_FILTER_ALL, DIR_GLYPHS } from '../shared/renderUtils.js'

export function createDashboardView ({ app, addOpts = {} }) {
  // shared filter bar state: min PROJECT importance + free text + the "show only" icons. The Hide
  // row is gone (user, 2026-09-12) — the same cuts now read the positive way up, in the Tasks
  // page's icon vocabulary, so the two boards say the same thing with the same buttons.
  let minImp = 0
  const onlyKeys = new Set() // 'unresolved' | 'resolved' | a direction — see projectPassesOnly
  // the search text and the repo cut FOLLOW you between views (filterBar's shared state)
  const query = () => sharedSearch()
  const repoFilter = () => sharedRepoFilter()
  let expandAll = false
  let migrating = false
  let fb = null // the filter bar handle — refresh() re-checks the # button and the search box

  const isOpenTodo = (t) => t.status === 'open' || t.status === 'in_progress'

  // The "show only" cut is defined on TASKS, and a project shows when any ONE of its tasks passes
  // EVERY pressed button (they AND). So "unresolved + I owe" wants a task that is both; pressing
  // two directions asks for a task with two directions and correctly shows nothing. Nothing
  // pressed = every project passes, tasks or not.
  const taskPassesOnly = (t) => passesOnly(onlyKeys, (k) => {
    if (k === 'unresolved') return isOpenTodo(t)
    if (k === 'resolved') return !isOpenTodo(t)
    return t.direction === k
  })
  const projectPassesOnly = (p) => !onlyKeys.size || (p.todos || []).some(taskPassesOnly)

  // does this project match the search text? (name, summary, keywords, people, to-do text)
  function projectMatches (p, needle) {
    // "#name" = repos only (renderUtils.parseSearch); the plain needle keeps the text search
    const q = parseSearch(needle)
    if (q.repo !== null) return repoQueryMatches(reposOfProject(p), q.repo)
    needle = q.needle
    const names = Object.keys(p.participants || {})
      .map(a => { const pr = app.profiles && app.profiles.get(a); return (pr && pr.display_name) || a })
    const hay = [
      p.name, p.summary, (p.keywords || []).join(' '),
      (p.participant_emails || []).join(' '), names.join(' '),
      // the repo is on the card, so it must be searchable: both the short name people type
      // ("freezrprivate") and the full slug, which carries the path they might search instead
      ...reposOfProject(p).flatMap(r => [r.name, r.slug]),
      ...(p.todos || []).map(t => (t.short_description || '') + ' ' + (t.description || ''))
    ].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(needle)
  }

  // The min-priority filter is about WORK, not labels: a project shows when the project itself is
  // rated that high OR any of its still-open tasks is (user, 2026-08-18 — a priority-3 project with
  // a priority-4 task inside it must survive "4+"). Resolved/cancelled tasks don't count.
  function projectMeetsPriority (p, min) {
    if ((Number(p.importance) || 3) >= min) return true
    return (p.todos || []).some(t => (t.status === 'open' || t.status === 'in_progress') &&
      effImportance(t) >= min)
  }

  function visibleProjects () {
    let projects = app.store ? app.store.all() : []
    // the topbar account picker: a project belongs to whichever account(s) fed it (projects.sources).
    // Untagged projects (analysed before source tagging) stay visible — see matchesAccountSource.
    const tag = getAccountFilterTag()
    if (tag) projects = projects.filter(p => matchesAccountSource(p, tag))
    if (minImp) projects = projects.filter(p => projectMeetsPriority(p, minImp))
    const q = query()
    if (q) { const needle = q.toLowerCase(); projects = projects.filter(p => projectMatches(p, needle)) }
    if (onlyKeys.size) projects = projects.filter(projectPassesOnly)
    if (repoFilter() !== REPO_FILTER_ALL) projects = projects.filter(p => repoFilterMatches(reposOfProject(p), repoFilter()))
    return projects
  }

  // ---- give due texts their machine window (due_earliest/due_latest) -------------------------
  // Runs when the Dashboard shows / data reloads, but only ACTS on tasks that still need it: a due
  // text with no window and no due_no_date marker. Parser first; leftovers go to the LLM in ONE
  // batch call, each anchored to the date its words were written. The LLM answering "not a date"
  // stamps due_no_date (never re-asked); an LLM FAILURE leaves the task unmarked so it is retried.
  async function migrateDueDates () {
    if (!app.store || migrating) return
    migrating = true
    try {
      const jobs = []
      for (const p of app.store.all()) {
        for (const t of (p.todos || [])) {
          if (!t.due_hint || t.due_earliest || t.due_latest || t.due_no_date) continue
          const lastMail = (t.evidence || []).filter(e => e.msg_id).map(e => Number(e.asof) || 0).reduce((m, n) => Math.max(m, n), 0)
          jobs.push({ i: jobs.length, text: t.due_hint, anchorMs: lastMail || Number(t.created_asof) || Date.now(), t, p })
        }
      }
      if (!jobs.length) return
      const { ranges, llmFailed } = await resolveDueRanges(jobs)
      const touched = new Set()
      let interpreted = 0
      let noDate = 0
      for (const j of jobs) {
        const r = ranges.get(j.i)
        if (!r) continue // unresolved (LLM failed/omitted) — retried next time
        if (r.earliest || r.latest) {
          j.t.due_earliest = r.earliest
          j.t.due_latest = r.latest
          interpreted++
        } else {
          j.t.due_no_date = true // the LLM read it — it just isn't a date; don't re-ask
          noDate++
        }
        touched.add(j.p)
      }
      for (const p of touched) await app.persist.saveProject(p)
      if (interpreted) paintBoard()
      const unresolved = jobs.length - interpreted - noDate
      console.log('[superlazy] due-date interpreter: ' + interpreted + ' interpreted, ' + noDate + ' not-a-date, ' +
        unresolved + ' unresolved' + (llmFailed ? ' (LLM call failed — will retry)' : ''))
    } finally {
      migrating = false
    }
  }

  // an open project modal lists its tasks under the same cut (ui.js's flags are the only channel)
  function syncModalFlags () {
    setHideResolved(onlyKeys.has('unresolved') && !onlyKeys.has('resolved'))
    // "only what I owe" is a single-direction ask — two directions pressed is not "mine"
    setOnlyMine(onlyKeys.has('i_owe_them') && !onlyKeys.has('team_owes') && !onlyKeys.has('they_owe_me'))
    setHideNotDue(false) // the board has no due filter
  }

  function paintBoard () {
    if (fb) fb.refresh() // the # button and the search box catch up with the shared state
    // Cards remember their own expanded/tab state (expandableProjectView's registry), so a
    // background run landing mid-read repaints the board without collapsing what the user opened.
    if (app.store) renderProjectBoard(visibleProjects(), null, { startExpanded: expandAll })
    paintBoardTools()
  }

  // the right-aligned board tools between the filters and the board: "expand all / collapse all"
  function paintBoardTools () {
    const host = el('boardTools')
    if (!host) return
    host.textContent = ''
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'su-expandall'
    b.textContent = expandAll ? '⌃ collapse all' : '⌄ expand all'
    b.title = expandAll ? 'Collapse every project card' : 'Expand every project card'
    b.addEventListener('click', () => {
      expandAll = !expandAll
      setAllCardStates(expandAll) // the explicit command overrides every remembered card state
      paintBoard()
    })
    host.appendChild(b)
  }

  function paint () {
    if (!app.store) return // data not loaded yet — the shell's status line owns the screen
    paintBoard()
    if (!app.store.all().length) {
      setStatus('No projects yet — process some messages on the Setup & Prefs page.', 'info')
    } else {
      const st = el('status'); if (st) { st.textContent = ''; st.style.display = 'none' } // all good — no banner
    }
  }

  function mount () {
    // shared filter bar: min PROJECT importance + text search over the whole board — built ONCE
    // into this view's own host, so its state survives view switches untouched
    fb = createFilterBar(el('filterbar-index'), {
      priority: { active: minImp, onChange: (v) => { minImp = v; paintBoard() } },
      // SHOW ONLY — the Tasks page's icons, read on PROJECTS: a project survives when one of its
      // tasks matches. The leading empty tick box is the one the board wants most (only projects
      // with something still open); the direction icons replace the old "Not mine" hide.
      only: {
        items: [
          { key: 'unresolved', group: 'status', icon: '☐', label: 'Unresolved', title: 'only projects with a to-do still open or in progress' },
          { key: 'resolved', group: 'status', icon: '☑️', grey: true, label: 'Resolved / cancelled', title: 'only projects with a resolved or cancelled to-do' },
          { key: 'i_owe_them', group: 'dir', icon: DIR_GLYPHS.i_owe_them, label: 'I owe', title: 'only projects with a to-do on YOUR plate' },
          { key: 'team_owes', group: 'dir', icon: DIR_GLYPHS.team_owes, label: 'Team owes', title: 'only projects with a to-do the team owes' },
          { key: 'they_owe_me', group: 'dir', icon: DIR_GLYPHS.they_owe_me, label: 'Owed to you', title: 'only projects with a to-do others owe you' }
        ],
        onChange: (key, on) => {
          if (on) onlyKeys.add(key); else onlyKeys.delete(key)
          syncModalFlags()
          paintBoard()
        }
      },
      // the # chooser, at the end of the same row: hidden until the data has a repo, and SHARED
      // with the other views (filterBar keeps the value)
      repos: {
        items: () => allReposOfProjects(app.store ? app.store.all() : []),
        onChange: () => paintBoard()
      },
      // no mail action here: the topbar's mail tools already own checking for new mail
      // shared with the other views too — the text follows you from board to Tasks to Events
      search: {
        placeholder: 'Filter projects by name, person or to-do…',
        onChange: () => paintBoard()
      },
      // CREATE, at the end of the bar — the board is where you notice a project is missing, and
      // since the topbar's ＋ Add… chooser was removed (user, 2026-09-16) this is the ONLY place
      // in the app that makes one. The flows themselves live in addFlows.js; the shell wires the
      // config.
      add: {
        items: [
          {
            label: '＋ Project',
            title: 'A new project — an empty bucket of to-dos, named by you',
            onPick: () => addProjectFlow(addOpts)
          },
          {
            label: '＋ Meeting note',
            title: 'Notes for the AI to read and turn into to-dos',
            onPick: () => addNoteFlow(addOpts)
          }
        ]
      }
    })
  }

  function show () {
    const host = el('view-index')
    if (host) host.style.display = ''
    // re-assert the ui.js modal flags this view's filters own — the other view may have set them
    syncModalFlags()
    paint()
    migrateDueDates().catch(e => console.warn('due-date migration skipped:', e && e.message))
  }

  function hide () {
    const host = el('view-index')
    if (host) host.style.display = 'none'
  }

  async function onReload () {
    paint()
    migrateDueDates().catch(e => console.warn('due-date migration skipped:', e && e.message))
  }

  return { key: 'index', mount, show, hide, paint, onReload }
}
