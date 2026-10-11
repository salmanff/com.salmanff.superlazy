// people.js — the PEOPLE VIEW of the shell page (shell.js): the per-person directory and
// meeting-prep detail panel. Formerly the standalone People page's entry point; the data now
// lives in the shared appStore (this view tops the shared events log up to its deeper cap for
// the message-history panels) and the cross-view wiring is installed once by the shell — this
// module owns the person view models (peopleData.js), its filters, the hash-driven selection
// (#<address> — orthogonal to the shell's path routing) and the on-demand AI re-profile.

import { profileHistorySnapshot } from '../jobs/analyze_thread/persist.js'
import { openEmailViewer } from '../shared/emailViewer.js'
import { runUserReprofile } from '../jobs/analyze_thread/reprofileTask.js'
import { probeCapability } from '../shared/backgroundMode.js'
import { buildPeople, filterPeople, SORTS } from './peopleData.js'
import { renderPeopleList, renderPersonDetail } from './peopleUi.js'
import { openPersonEditor } from '../shared/personEditor.js'
import { setStatus, openProjectModal, renderProjectCardsInto } from '../shared/ui.js'
import { createFilterBar, sharedSearch } from '../shared/filterBar.js'
import { getAccountFilterTag, matchesAccountSource } from '../shared/mailTools.js'

const el = (id) => document.getElementById(id)

const EVENTS_CAP = 2000 // newest events loaded for the message-history panels (deeper than the shell's base)

export function createPeopleView ({ app, taskHandlers, onOpenProject }) {
  let people = []            // all person view models
  let selectedAddr = null
  let fb = null              // the filter bar handle — refresh() re-syncs the shared search box

  // shared-filter-bar state (the bar reports changes; this view owns the values). The Hide row is
  // gone (user, 2026-09-12): the same cuts read the positive way up as "show only", which also
  // flips the DEFAULT — with nothing pressed the list now includes the learned bulk senders and
  // every person shows both their open and their resolved items.
  const onlyKeys = new Set() // 'unresolved' | 'resolved' | 'auto'
  const controlsState = { minImp: 0, sort: 'rank' }
  // the search text FOLLOWS you between views (filterBar's shared state)
  const query = () => sharedSearch()
  // Every pressed button must match (they AND): an item cannot be both unresolved and resolved,
  // so pressing both shows neither list — that is what the mini separator marks.
  const itemCuts = () => ({
    showOpen: !onlyKeys.has('resolved'),
    showDone: !onlyKeys.has('unresolved')
  })
  const controls = () => ({ ...controlsState, q: query(), autoOnly: onlyKeys.has('auto') })

  const selectedPerson = () => people.find(p => p.address === selectedAddr) || null

  // ---- the people list as a DRAWER on a narrow screen ----------------------------------------
  // Same shape as the email viewer's conversation rail: below 760px the list slides in from the
  // left over the page and goes away again as soon as a person is picked. All of the layout is in
  // people.css; this only owns the open/closed flag, so a resize needs no handling. The one
  // difference from the modal is that the drawer is position:FIXED — the detail panel (meeting
  // prep, message history) is long, so a drawer confined to the column would scroll off the top
  // and the ☰ with it. The ☰ bar is sticky for the same reason.
  let listOpen = false
  function setList (on) {
    listOpen = on
    const btn = el('ppListBtn'); const scrim = el('ppScrim'); const list = el('ppList')
    if (!btn || !scrim || !list) return
    document.body.classList.toggle('pp-list-open', on)
    btn.setAttribute('aria-expanded', String(on))
    if (on) {
      const item = list.querySelector('.pp-row.active') || list.querySelector('.pp-row')
      if (item) { item.focus({ preventScroll: true }); item.scrollIntoView({ block: 'nearest' }) }
    }
  }
  // Escape closes the drawer. Capture phase, and it only acts while the drawer is open, so a
  // modal opened on top of this page (an email viewer) still gets its own Escape.
  function onListKey (e) {
    if (e.key !== 'Escape' || !listOpen) return
    e.stopPropagation(); e.preventDefault()
    setList(false)
    const btn = el('ppListBtn'); if (btn) btn.focus({ preventScroll: true })
  }

  // known people for the task editor's Who autocomplete
  const peopleForEditor = () => people.map(p => ({ address: p.address, name: p.name || '' }))

  function renderAll () {
    if (fb) fb.refresh() // the search box catches up with the shared state
    const shown = filterPeople(people, controls())
    renderPeopleList(el('ppList'), shown, {
      selected: selectedAddr,
      onSelect: (person) => {
        window.location.hash = encodeURIComponent(person.address)
        setList(false) // picking someone sends the drawer back, like a phone mail client
      }
    })
    // the count IS the drawer's label on a narrow screen — with the list off-canvas it is the
    // only sign of how many people the current filters leave
    const countEl = el('ppListCount')
    if (countEl) countEl.textContent = shown.length ? String(shown.length) : ''
    renderPersonDetail(el('ppDetail'), selectedPerson(), { ...detailHandlers, ...itemCuts() })
    setStatus(people.length ? '' : 'No people yet — process some messages first.')
  }

  // ---- on-demand AI re-profile (the person editor's "Update with AI" button) -----------------
  // The work + persistence live in jobs/analyze_thread/reprofileTask.js, shared with the
  // background job: background capable → the JOB runs it (survives page refreshes; the result is
  // persisted server-side either way). The outcome comes back by polling
  // settings.bg_last_reprofile. Otherwise → the same task runs in-tab with the LIVE stores.
  const REPROFILE_POLL_MS = 3000
  const REPROFILE_WAIT_MS = 4 * 60e3

  async function reprofileNow (address) {
    const cap = await probeCapability().catch(() => ({ capable: false }))
    if (cap.capable) return reprofileViaJob(address)
    const res = await runUserReprofile({
      freezr: (typeof freezr !== 'undefined' ? freezr : null),
      persist: app.persist,
      address,
      profiles: app.profiles,
      store: app.store,
      events: app.events,
      settings: app.settings || {}
    })
    if (res.ok) rebuildAndRender()
    return res
  }

  async function reprofileViaJob (address) {
    const addr = String(address || '').toLowerCase()
    const t0 = Date.now()
    const run = freezr.jobs.run('analyze_thread', { task: 'reprofile', address: addr }, { maxRuntime: '300s' })
    run.then(() => {}, () => {}) // the outcome arrives via the stamp below — silence the late promise
    // watch only for an IMMEDIATE refusal (permission / nowhere to run) — a real run stays pending
    const quick = await Promise.race([
      run.then(r => r, e => ({ __error: (e && e.message) || String(e) })),
      new Promise(resolve => setTimeout(() => resolve(null), 3000))
    ])
    if (quick && quick.__error) return { ok: false, outcome: 'error', reason: quick.__error }

    while (Date.now() - t0 < REPROFILE_WAIT_MS) {
      const s = await app.persist.readSettings().catch(() => null)
      const r = s && s.bg_last_reprofile
      if (r && r.address === addr && Number(r.finished_at) >= t0) {
        await refreshOneProfile(addr) // pull the job's result into the live store (editor included)
        return { ok: !!r.ok, outcome: r.outcome || (r.ok ? 'updated' : 'error'), reason: r.reason || null }
      }
      await new Promise(resolve => setTimeout(resolve, REPROFILE_POLL_MS))
    }
    // Still running (or the stamp write failed). NOT an error: the job persists its own result, so
    // it lands on the profile + events feed whenever it finishes — even if this page is long gone.
    return { ok: true, outcome: 'pending', reason: 'still running in the background — the update lands on this profile and in the events feed when done' }
  }

  // Merge ONE freshly-persisted profile record into the live store IN PLACE (profiles.hydrate
  // ensures + merges), so the open person editor — which holds a reference to the store's object —
  // shows the job's result without a whole reload.
  async function refreshOneProfile (addr) {
    try {
      const rows = await freezr.query('profiles', { address: addr }, { count: 1 })
      if (rows && rows[0] && app.profiles) app.profiles.hydrate([rows[0]])
      rebuildAndRender()
    } catch (e) {
      // field query unavailable on this backend — fall back to the full reload
      await app.reload().catch(() => {})
    }
  }

  // One options bag for every person-editor open while this view is active (header ✏️, task-row
  // discs, ui.js person chips — the shell's shared opener dispatches here, so the People view's
  // editors carry the "Update with AI" button and the others' don't, exactly as before)
  const personEditorOpts = () => ({
    profiles: app.profiles,
    persist: app.persist,
    instructions: app.instructions,
    projects: () => (app.store ? app.store.all() : []),
    nameOf: (a) => { const p = app.profiles && app.profiles.get(a); return p && p.display_name },
    reprofile: reprofileNow,
    settings: app.settings || {},
    onChange: () => rebuildAndRender()
  })

  // ---- manual edits (persist immediately, mirrored as manual_edit events) --------------------

  const detailHandlers = {
    // history rows open the full email (whole thread) in the shared viewer
    onOpenEmail: (ev) => openEmailViewer({ msg_id: ev.msg_id, thread_id: ev.thread_id, subject: ev.subject }),
    // ✏️ in the header → the shared person editor (description + special instructions)
    onEditPerson: (person) => openPersonEditor(person.address, personEditorOpts()),
    // click the same value again to clear the manual rank (falls back to the model's estimate)
    onRank: (person, n) => {
      const prof = person.profile
      const before = prof.manual_rank
      // priorities are part of the profile record — archive the outgoing version (real profiles only)
      if (prof.profile && (prof.profile.solidified_asof || prof.profile.user_edited)) {
        app.persist.saveProfileHistory(profileHistorySnapshot(person.address, prof.profile, {
          manualRank: before, source: 'manual_rank', reason: 'rank ' + (before == null ? '(llm)' : before) + ' → ' + ((Number(before) === n) ? '(llm)' : n), asof: Date.now()
        })).catch(e => console.error('profile history save failed', e))
      }
      prof.manual_rank = (Number(before) === n) ? null : n
      app.persist.saveProfile(prof).catch(e => console.error('rank save failed', e))
      app.persist.addEvent({
        kind: 'manual_edit', source_id: 'user', asof: Date.now(),
        field: 'manual_rank', target: 'profile', address: person.address,
        before, after: prof.manual_rank
      }).catch(e => console.error('rank event save failed', e))
      rebuildAndRender()
    },
    // the standard task rows: THE shared shell handlers (live ops + persistence through the
    // manual-event listener); person-editor opens route back here via the shell's dispatcher
    task: taskHandlers,
    // the rows' project pill opens the LIVE project modal
    onOpenProject,
    // shared projects render as the SAME live cards as the dashboard
    renderProjects: (host, projects) => renderProjectCardsInto(host, projects)
  }

  function rebuildAndRender () {
    if (!app.store || !app.profiles) return
    // the topbar account picker: a person belongs to whichever account(s) they were learned from
    // (profiles.sources), and the projects they are shown against are filtered the same way.
    // Untagged records stay visible — see matchesAccountSource.
    const tag = getAccountFilterTag()
    const keep = (r) => matchesAccountSource(r, tag)
    people = buildPeople({
      profiles: app.profiles.all().filter(keep),
      projects: app.store.all().filter(keep),
      events: app.events,
      selfSet: new Set(taskHandlers.self)
    })
    renderAll()
  }

  // ---- selection via the URL hash (orthogonal to the shell's path routing) -------------------

  function readHash () {
    const h = decodeURIComponent((window.location.hash || '').replace(/^#/, ''))
    selectedAddr = h || null
  }

  // load the deeper events window this view wants (message-history panels), repaint if it grew
  async function topUp () {
    const before = app.loadedEventsCount()
    try {
      await app.ensureEventCoverage({ tfKey: 'all', cap: EVENTS_CAP })
    } catch (e) {
      setStatus('Could not load events: ' + ((e && e.message) || e), 'error')
      return
    }
    if (app.loadedEventsCount() !== before) rebuildAndRender()
  }

  function mount () {
    const btn = el('ppListBtn'); const scrim = el('ppScrim')
    if (btn) btn.addEventListener('click', () => setList(!listOpen))
    if (scrim) scrim.addEventListener('click', () => setList(false))
    document.addEventListener('keydown', onListKey, true)

    // shared filter bar: min PERSON importance + the show-only cut + sort + search
    fb = createFilterBar(el('filterbar-people'), {
      priority: { active: controlsState.minImp, onChange: (v) => { controlsState.minImp = v; renderAll() } },
      // SHOW ONLY, in place of the old Hide row. Every pressed button must match: the status of a
      // person's ITEMS (unresolved / resolved — pressing both contradicts, so neither list shows)
      // and whether the PERSON is a learned bulk sender. Nothing pressed now means everyone,
      // resolved items included — the Hide row used to start with bulk senders hidden
      // (user, 2026-09-12).
      only: {
        items: [
          { key: 'unresolved', group: 'status', icon: '☐', label: 'Unresolved', title: 'only each person’s still-open items' },
          { key: 'resolved', group: 'status', icon: '☑️', grey: true, label: 'Resolved / cancelled', title: 'only each person’s resolved / cancelled items' },
          { key: 'auto', group: 'who', icon: '⚙', label: 'Auto-processed senders', title: 'only the learned bulk senders (newsletters, admin, promos)' }
        ],
        onChange: (key, on) => {
          if (on) onlyKeys.add(key); else onlyKeys.delete(key)
          renderAll()
        }
      },
      selects: [{
        label: 'sort',
        options: Object.fromEntries(Object.entries(SORTS).map(([k, s]) => [k, s.label])),
        active: controlsState.sort,
        onChange: (v) => { controlsState.sort = v; renderAll() }
      }],
      // shared with the other views too — the text follows you from People to Tasks to the board
      search: {
        placeholder: 'Search name, address, role…',
        onChange: () => renderAll()
      }
    })
  }

  function show () {
    const host = el('view-people')
    if (host) host.style.display = ''
    setList(false) // never arrive on the view with the drawer hanging open
    readHash()
    rebuildAndRender()
    topUp()
  }

  function hide () {
    const host = el('view-people')
    if (host) host.style.display = 'none'
    setList(false) // the drawer is fixed-position: it would hang over whatever view comes next
  }

  async function onReload () {
    await topUp().catch(() => {})
    rebuildAndRender()
  }

  // the shell relays hashchange to the ACTIVE view only — person selection
  function onHashChange () {
    readHash()
    renderAll()
  }

  // the topbar account picker changed (repaint is the shell's job — paint() rebuilds)
  function onAccountChange () {}

  // tab refocus: repaint from the store; full reload only when actually stale
  function onVisible () {
    if (Date.now() - (app.lastLoadedAt || 0) > 60000) {
      app.reload().catch(e => console.error('refresh failed', e))
    } else {
      rebuildAndRender()
      topUp()
    }
  }

  return {
    key: 'people',
    mount,
    show,
    hide,
    paint: rebuildAndRender,
    onReload,
    onHashChange,
    onAccountChange,
    onVisible,
    personEditorOpts
  }
}
