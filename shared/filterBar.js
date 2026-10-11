// filterBar.js — the SHARED filter bar that sits under the top bar on every page. Pages compose
// their own bar from the same slots so they all look and behave identically (filterbar.css).
// Each slot renders as a titled SECTION (title top-left, controls below, subtle separators):
//   chips     — segmented filter (page-specific keys)
//   timeframe — "since when" presets: All / Past hour / Since last night / Custom (past X hours
//               or Y days via an anchored popover — no calendar)
//   priority  — minimum-importance filter: All / 3+ / 4+ / 5 (colour-coded like the boards)
//   selects   — page-specific dropdowns (e.g. the People page's sort), same styling
//   only      — "show only" restrictors: icon buttons where nothing pressed = no restriction and
//               every pressed button must ALSO match — they AND, always (see passesOnly).
//               Items carry a `group`, and a group is a single question: its buttons are mutually
//               exclusive (nothing can be both resolved AND unresolved), so a mini separator is
//               drawn wherever the group changes and pressing one button RELEASES the others in
//               its group. Unpressing leaves its group-mates alone.
//   repos     — the "#" chooser (Show all / Repos only / Hide repos / a named repo). It rides in
//               the `only` row behind its own mini separator, and appears only once the data
//               actually has a repo.
//   hide      — the standard exclusion checkboxes (resolved / manual / auto-processed as applicable)
//   search    — free-text filter (flexes to fill the right side)
//   add       — CREATE actions, last section on the bar: one button per thing you can make by
//               hand. A filter bar is where you already are when you notice something is missing,
//               so the board's "new project / meeting note" live here rather than only in the
//               topbar chooser (user, 2026-09-16).
// Each slot fires its onChange with the new value; the PAGE owns the state and re-renders.
// Omit a slot and it simply isn't rendered — same bar, per-page configuration.

import { impColor, myTodosIcon, REPO_FILTER_ALL } from './renderUtils.js'

// The `only` semantics, in one place so every page reads the same: EVERY pressed button must
// match. They AND — never OR (user, 2026-09-12). Buttons within one group contradict each other,
// so the bar releases group-mates on press rather than letting you AND your way to an empty list;
// the mini separator is where one question ends and the next begins, and buttons EITHER SIDE of
// it genuinely compose ("unresolved AND due"). `test(key)` answers "does this item match that
// button?" for one item.
export function passesOnly (onlyKeys, test) {
  for (const k of onlyKeys) if (!test(k)) return false
  return true
}

// ---- the filters that follow you between views -----------------------------------------------
// The shell is ONE page with four views, each owning its own bar. The repo cut and the search
// text are about WHAT you are looking for, not which view you are in, so they live here at module
// level and every bar reads and writes the same value (user, 2026-09-12): search "acme" on the
// board, switch to Tasks, and it is still "acme". Slots opt out with `shared: false`.
// In memory only — the shell's views share one origin, so nothing goes to browser storage.
const shared = { repo: REPO_FILTER_ALL, search: '' }
export const sharedRepoFilter = () => shared.repo
export const sharedSearch = () => shared.search

// The SuperLazy mark for a "show only" button: the logo's inverted pentagon, hollow and
// red-outlined (filterbar.css) — "SuperLazy itself did this", next to the pen (you) and the
// cog (the standing automation).
export function slMark () {
  const m = document.createElement('span'); m.className = 'fb-sl-mark'
  const c = document.createElement('span'); c.className = 'fb-sl-core'
  m.appendChild(c)
  return m
}

export const TIME_PRESETS = [
  { key: 'all', label: 'All' },
  { key: '1h', label: 'Past hour' },
  { key: 'night', label: 'Last night' },
  { key: 'custom', label: 'Custom…' }
]

// Resolve a preset to an absolute "since" ms ('all' = 0, no cut). Recomputed at call time so a
// bar left open all day stays honest. "Last night" = the most recent 6pm (see below). Custom is
// RELATIVE — { unit: 'h'|'d', n } ("past 36 hours") — so it re-anchors to now
// on every recompute too; a legacy absolute-ms number is still honoured. Custom opens on PAST 2
// HOURS: pressing Custom means "narrower than the presets", and 24h was wider than most of them
// (user, 2026-08-31).
export function sinceMsForPreset (key, custom) {
  const now = Date.now()
  if (key === 'all') return 0
  if (key === '1h') return now - 3600e3
  if (key === '24h') return now - 24 * 3600e3
  if (key === '7d') return now - 7 * 24 * 3600e3
  if (key === 'night') {
    // "since 6pm the day before": the most recent 6pm (local) — yesterday's until 6pm today,
    // today's after that — so the window is NEVER more than 24 hours (user, 2026-10-04; the
    // earlier "midnight at the start of yesterday" reached back up to 48h and showed mail from
    // the morning before). The cut is on PROCESSED time (recentData.processedClock), which is
    // the right measure: what SuperLazy did since you last looked.
    const d = new Date(); d.setHours(18, 0, 0, 0)
    if (d.getTime() > now) d.setDate(d.getDate() - 1)
    return d.getTime()
  }
  if (key === 'custom') {
    if (custom && typeof custom === 'object') {
      const n = Math.max(1, Math.round(Number(custom.n)) || CUSTOM_DEFAULT_HOURS)
      return now - n * 3600e3 * (custom.unit === 'd' ? 24 : 1)
    }
    return Number(custom) || (now - CUSTOM_DEFAULT_HOURS * 3600e3)
  }
  return 0
}

// what the Custom chip opens on (and the "hours" row seeds with)
const CUSTOM_DEFAULT_HOURS = 2
const CUSTOM_DEFAULT_DAYS = 7

const PRIORITY_STOPS = [
  { v: 0, label: 'All' },
  { v: 3, label: '3+' },
  { v: 4, label: '4+' },
  { v: 5, label: '5' }
]

function group (label) {
  const g = document.createElement('div'); g.className = 'fb-group'
  if (label) { const l = document.createElement('span'); l.className = 'fb-lbl'; l.textContent = label; g.appendChild(l) }
  return g
}

function chipRow (items, activeKey, onPick) {
  const row = document.createElement('div'); row.className = 'fb-chips'
  const set = (btn) => { row.querySelectorAll('.fb-chip').forEach(b => b.classList.toggle('active', b === btn)) }
  for (const it of items) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'fb-chip' + (it.key === activeKey ? ' active' : '')
    b.textContent = it.label
    if (it.title) b.title = it.title
    if (it.color) b.style.setProperty('--fb-chip-color', it.color)
    b.addEventListener('click', () => { set(b); onPick(it) })
    row.appendChild(b)
  }
  return row
}

// Build the bar into `host`. slots: { chips, timeframe, priority, search } — see header comment.
// Returns { getSinceMs() } so pages can recompute the live window on refresh.
export function createFilterBar (host, slots = {}) {
  host.textContent = ''
  const bar = document.createElement('div'); bar.className = 'fb-bar'
  // refresh() hooks: the repo button re-reads the live repo list (the bar is built before the
  // data loads) and the search box re-syncs from the shared value. Pages call refresh() on paint.
  let refreshRepos = () => {}
  let refreshSearch = () => {}

  // ---- kind chips ----
  if (slots.chips) {
    const g = group(slots.chips.label || 'show')
    g.appendChild(chipRow(slots.chips.items, slots.chips.active || slots.chips.items[0].key,
      (it) => slots.chips.onChange && slots.chips.onChange(it.key)))
    bar.appendChild(g)
  }

  // ---- timeframe ----
  // Custom is a small anchored popover — no calendar: "past X hours" OR "past Y days", each with
  // an editable number and −/+ steppers. The chosen row applies immediately and the Custom chip's
  // label becomes e.g. "Past 36h ▾" so the active window stays readable with the popover closed.
  let tfState = { key: (slots.timeframe && slots.timeframe.active) || 'night', custom: { unit: 'h', n: CUSTOM_DEFAULT_HOURS } }
  if (slots.timeframe) {
    const g = group(slots.timeframe.label || 'since')
    g.classList.add('fb-tf-group')
    const fire = () => slots.timeframe.onChange &&
      slots.timeframe.onChange(tfState.key, sinceMsForPreset(tfState.key, tfState.custom))

    let customChip = null
    const setCustomLabel = () => {
      if (!customChip) return
      customChip.textContent = tfState.key === 'custom'
        ? 'Past ' + tfState.custom.n + (tfState.custom.unit === 'd' ? 'd' : 'h') + ' ▾'
        : 'Custom…'
    }

    const pop = document.createElement('div'); pop.className = 'fb-pop'; pop.style.display = 'none'
    const radios = []
    const mkPopRow = (unit, unitLbl, seed) => {
      const row = document.createElement('div'); row.className = 'fb-pop-row'
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'fbtf-unit'
      const inp = document.createElement('input'); inp.type = 'number'; inp.min = '1'; inp.className = 'fb-pop-num'; inp.value = String(seed)
      const pick = () => {
        const n = Math.max(1, Math.round(Number(inp.value)) || seed)
        inp.value = String(n)
        radio.checked = true
        tfState.key = 'custom'
        tfState.custom = { unit, n }
        setCustomLabel()
        fire()
      }
      const stepBtn = (glyph, delta) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'fb-pop-step'; b.textContent = glyph
        b.addEventListener('click', () => { inp.value = String(Math.max(1, (Math.round(Number(inp.value)) || seed) + delta)); pick() })
        return b
      }
      radio.addEventListener('change', pick)
      inp.addEventListener('change', pick)
      const lbl = document.createElement('span'); lbl.textContent = 'Past'
      const unitSpan = document.createElement('span'); unitSpan.textContent = unitLbl
      row.appendChild(radio); row.appendChild(lbl)
      row.appendChild(stepBtn('−', -1)); row.appendChild(inp); row.appendChild(stepBtn('+', +1))
      row.appendChild(unitSpan)
      radios.push({ radio, unit })
      return row
    }
    pop.appendChild(mkPopRow('h', 'hours', CUSTOM_DEFAULT_HOURS))
    pop.appendChild(mkPopRow('d', 'days', CUSTOM_DEFAULT_DAYS))

    const openPop = () => {
      pop.style.display = ''
      const r = radios.find(r => r.unit === tfState.custom.unit)
      if (r) r.radio.checked = true
    }
    const closePop = () => { pop.style.display = 'none' }
    document.addEventListener('click', (e) => {
      if (pop.style.display === 'none') return
      if (pop.contains(e.target) || (customChip && customChip.contains(e.target))) return
      closePop()
    })
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop() })

    const row = chipRow(TIME_PRESETS, tfState.key, (it) => {
      if (it.key === 'custom') { tfState.key = 'custom'; setCustomLabel(); openPop(); fire(); return }
      tfState.key = it.key
      closePop()
      setCustomLabel() // back to plain "Custom…"
      fire()
    })
    customChip = [...row.querySelectorAll('.fb-chip')].pop() // TIME_PRESETS puts custom last
    setCustomLabel()
    g.appendChild(row)
    g.appendChild(pop)
    bar.appendChild(g)
  }

  // ---- minimum priority ----
  if (slots.priority) {
    const g = group(slots.priority.label || 'priority')
    const items = PRIORITY_STOPS.map(s => ({
      key: String(s.v), label: s.label, color: s.v ? impColor(s.v) : null,
      title: s.v ? 'Only items with priority ' + s.v + (s.v < 5 ? ' or higher' : '') : 'All priorities'
    }))
    g.appendChild(chipRow(items, String(slots.priority.active || 0),
      (it) => slots.priority.onChange && slots.priority.onChange(Number(it.key))))
    bar.appendChild(g)
  }

  // ---- page-specific selects (e.g. sort) ----
  for (const s of (slots.selects || [])) {
    const g = group(s.label || '')
    const sel = document.createElement('select'); sel.className = 'fb-select'
    for (const [key, label] of Object.entries(s.options || {})) {
      const o = document.createElement('option'); o.value = key; o.textContent = label
      if (key === s.active) o.selected = true
      sel.appendChild(o)
    }
    sel.addEventListener('change', () => s.onChange && s.onChange(sel.value))
    g.appendChild(sel)
    bar.appendChild(g)
  }

  // ---- show only + the repo cut: ONE row ------------------------------------------------------
  // Icon buttons whose pressed state means "only this". Pressed = the button LIGHTS UP (blue
  // fill) rather than gaining the hide row's no-entry ring. They AND (passesOnly): nothing
  // pressed = no restriction, and buttons that contradict each other leave an empty list on
  // purpose. `group` draws a MINI SEPARATOR wherever it changes — that rule is the hint that the
  // buttons either side of it are different, mutually exclusive questions.
  // An item may bring its own icon element via node() (the my-todos glyph, the SuperLazy mark).
  // The repo chooser rides at the end of the same row behind its own separator — it is one more
  // cut, not a section of its own (user, 2026-09-12).
  if (slots.only || slots.repos) {
    const g = group((slots.only && slots.only.label) || (slots.only ? 'show only' : 'repos'))
    const row = document.createElement('div'); row.className = 'fb-checks'
    const mkSep = () => { const s = document.createElement('span'); s.className = 'fb-onlysep'; return s }

    const onlyBtns = [] // every built button, so a press can release its group-mates
    let prevGroup
    for (const it of ((slots.only && slots.only.items) || [])) {
      if (prevGroup !== undefined && it.group !== prevGroup) row.appendChild(mkSep())
      prevGroup = it.group
      const b = document.createElement('button'); b.type = 'button'
      b.className = 'fb-hidebtn fb-onlybtn'
      const ico = document.createElement('span')
      ico.className = 'fb-hideico' + (it.grey ? ' fb-ico-grey' : '')
      if (typeof it.node === 'function') ico.appendChild(it.node())
      else if (it.key === 'i_owe_them') ico.appendChild(myTodosIcon())
      else ico.textContent = it.icon || '\u2022'
      b.appendChild(ico)
      let on = !!it.active
      const paintBtn = () => {
        b.classList.toggle('fb-only-on', on)
        b.title = it.label + (it.title ? ' \u2014 ' + it.title : '') +
          (on ? '\nONLY THESE \u2014 click to stop restricting' : '\nclick to show only these')
        b.setAttribute('aria-pressed', String(on))
      }
      paintBtn()
      const fire = () => { if (slots.only && slots.only.onChange) slots.only.onChange(it.key, on) }
      const entry = {
        group: it.group,
        isOn: () => on,
        release: () => { on = false; paintBtn(); fire() }
      }
      onlyBtns.push(entry)
      b.addEventListener('click', () => {
        on = !on
        paintBtn()
        // Pressing one ON RELEASES the others in its group. They are mutually exclusive — with
        // AND semantics, two of them leave an empty list — so the second press REPLACES the first
        // rather than emptying the view. Turning one OFF leaves its group-mates alone
        // (user, 2026-09-12). Items with no `group` are independent and never release anything.
        if (on && it.group !== undefined) {
          for (const other of onlyBtns) {
            if (other !== entry && other.group === it.group && other.isOn()) other.release()
          }
        }
        fire()
      })
      row.appendChild(b)
    }

    // ---- the repo cut ("#") -----------------------------------------------------------------
    // The button IS the state: "#" means no cut; anything else carries the chosen words ("Repos
    // only", "Hide repos") or the repo's own name, so the active cut is readable with the chooser
    // shut. Value: 'all' | 'only' | 'none' | '<repo slug>' (renderUtils.repoFilterMatches applies
    // it). Hidden, separator and all, until the loaded data actually touches a repo.
    if (slots.repos) {
      const sep = mkSep()
      if (slots.only && (slots.only.items || []).length) row.appendChild(sep)
      const useShared = slots.repos.shared !== false
      let localRepo = slots.repos.active || REPO_FILTER_ALL
      const getVal = () => (useShared ? shared.repo : localRepo)
      const setVal = (v) => { if (useShared) shared.repo = v; else localRepo = v }
      const repoList = () => (typeof slots.repos.items === 'function' ? slots.repos.items() : (slots.repos.items || [])) || []
      const FIXED = [[REPO_FILTER_ALL, 'Show all'], ['only', 'Repos only'], ['none', 'Hide repos']]

      const wrap = document.createElement('span'); wrap.className = 'fb-repo-wrap'
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'fb-repobtn'
      const pop = document.createElement('div'); pop.className = 'fb-pop fb-repo-pop'; pop.style.display = 'none'

      const paintBtn = () => {
        const repos = repoList()
        const val = getVal()
        const fixed = FIXED.find(f => f[0] === val)
        const named = repos.find(r => r.slug === val)
        const on = val !== REPO_FILTER_ALL
        btn.textContent = !on ? '#' : '# ' + (fixed ? fixed[1] : (named ? named.name : val))
        btn.classList.toggle('fb-repo-on', on)
        btn.title = on
          ? 'Showing ' + (fixed ? fixed[1].toLowerCase() : (named ? 'the ' + named.slug + ' repo only' : val)) +
            '\nclick to choose another repo cut'
          : 'Every repo (and everything with none) \u2014 click to show only work in a repo, hide it, or pick one repo'
        // nothing in the data touches a repo and no cut is on: the button has nothing to say
        const show = (repos.length || on) ? '' : 'none'
        wrap.style.display = show
        sep.style.display = show
      }
      const closePop = () => { pop.style.display = 'none' }
      const buildPop = () => {
        pop.textContent = ''
        const repos = repoList()
        const opt = (v, label, title) => {
          const b = document.createElement('button'); b.type = 'button'
          b.className = 'fb-repo-opt' + (v === getVal() ? ' active' : '')
          b.textContent = label
          if (title) b.title = title
          b.addEventListener('click', () => {
            setVal(v)
            paintBtn()
            closePop()
            if (slots.repos.onChange) slots.repos.onChange(v)
          })
          pop.appendChild(b)
        }
        for (const [v, label] of FIXED) opt(v, label)
        if (repos.length) { const hr = document.createElement('div'); hr.className = 'fb-repo-hr'; pop.appendChild(hr) }
        // '#' in front of each repo name, the same mark the button carries once one is picked
        for (const r of repos) opt(r.slug, '# ' + r.name, r.slug)
      }
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        if (pop.style.display !== 'none') { closePop(); return }
        buildPop()
        pop.style.display = ''
      })
      document.addEventListener('click', (e) => {
        if (pop.style.display === 'none') return
        if (pop.contains(e.target) || btn.contains(e.target)) return
        closePop()
      })
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop() })

      wrap.appendChild(btn); wrap.appendChild(pop)
      row.appendChild(wrap)
      paintBtn()
      refreshRepos = paintBtn
    }

    g.appendChild(row)
    bar.appendChild(g)
  }

  // ---- hide (the standard exclusion toggles — pages pass the items that apply) ----
  // ICON buttons, not checkboxes ("check a green box to hide" read backwards — user, 2026-08-19).
  // Each item: { key, icon ('☑️' / '⚙' / '✍️' / '⏱' / '👥📥'…), label, active, title, grey }.
  // Resting state = the kind is SHOWING (plain icon). Pressing it HIDES the kind, shown the same
  // way everywhere: the icon dims and a red no-entry ring (circle + diagonal) overlays it.
  // The tooltip always says the current state and what a click does.
  if (slots.hide) {
    const g = group(slots.hide.label || 'hide')
    const row = document.createElement('div'); row.className = 'fb-checks'
    for (const it of (slots.hide.items || [])) {
      const b = document.createElement('button'); b.type = 'button'
      b.className = 'fb-hidebtn'
      const ico = document.createElement('span')
      ico.className = 'fb-hideico' + (it.grey ? ' fb-ico-grey' : '')
      ico.textContent = it.icon || '•'
      b.appendChild(ico)
      const slash = document.createElement('span'); slash.className = 'fb-noslash'
      b.appendChild(slash)
      let hidden = !!it.active
      const paint = () => {
        b.classList.toggle('fb-hidden', hidden)
        b.title = it.label + (it.title ? ' — ' + it.title : '') +
          (hidden ? '\nHIDDEN — click to show' : '\nshowing — click to hide')
        b.setAttribute('aria-pressed', String(hidden))
      }
      paint()
      b.addEventListener('click', () => {
        hidden = !hidden
        paint()
        if (slots.hide.onChange) slots.hide.onChange(it.key, hidden)
      })
      row.appendChild(b)
    }
    g.appendChild(row)
    bar.appendChild(g)
  }

  // ---- page actions (e.g. the Dashboard's "Check Mail Here") ----
  if (slots.actions && (slots.actions.items || []).length) {
    const g = group(slots.actions.label || '')
    const row = document.createElement('div'); row.className = 'fb-actions'
    for (const it of slots.actions.items) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'fb-actionbtn'
      b.textContent = it.label
      if (it.title) b.title = it.title
      b.addEventListener('click', () => it.onClick && it.onClick())
      row.appendChild(b)
    }
    g.appendChild(row)
    bar.appendChild(g)
  }

  // ---- search ----
  // Shared across the shell's views by default (see `shared` above): what you typed on one view
  // is still typed on the next. refresh() re-syncs the box from the shared value, which is how a
  // view hidden while you searched elsewhere catches up when you come back to it.
  if (slots.search) {
    const g = group(slots.search.label || 'search'); g.classList.add('fb-search-group')
    const useShared = slots.search.shared !== false
    const inp = document.createElement('input')
    inp.type = 'search'; inp.className = 'fb-search'
    inp.placeholder = slots.search.placeholder || 'Filter…'
    inp.autocomplete = 'off'
    if (useShared) inp.value = shared.search
    inp.addEventListener('input', () => {
      const v = inp.value.trim()
      if (useShared) shared.search = v
      if (slots.search.onChange) slots.search.onChange(v)
    })
    if (useShared) refreshSearch = () => { if (inp.value.trim() !== shared.search) inp.value = shared.search }
    g.appendChild(inp)
    bar.appendChild(g)
  }

  // ---- add ----
  // Deliberately LAST and after search: everything before it narrows what you are looking at,
  // this makes something new. Same section chrome as the rest so it reads as part of the bar.
  if (slots.add && (slots.add.items || []).length) {
    const g = group(slots.add.label || 'add'); g.classList.add('fb-add-group')
    const row = document.createElement('div'); row.className = 'fb-adds'
    for (const it of slots.add.items) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'fb-addbtn'
      b.textContent = it.label
      if (it.title) b.title = it.title
      b.addEventListener('click', () => { if (it.onPick) it.onPick() })
      row.appendChild(b)
    }
    g.appendChild(row)
    bar.appendChild(g)
  }

  host.appendChild(bar)
  return {
    getSinceMs: () => sinceMsForPreset(tfState.key, tfState.custom),
    // the data moved (projects loaded, a repo appeared) or another view changed a SHARED filter:
    // re-evaluate whether the # button shows, and re-sync the search box
    refresh: () => { refreshRepos(); refreshSearch() }
  }
}
