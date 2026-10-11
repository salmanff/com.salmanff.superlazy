// replay.js — the DEMO page (/replay): plays a recorded stretch of SuperLazy back at demo speed.
// Each recorded input appears on the stage for a quarter of a second (configurable) and the to-do
// list underneath moves as it did on the day. It is a PLAYBACK, not a run: no LLM call, no mail
// fetch, nothing written — see replayEngine.js for how the board is reconstructed and what it can
// and cannot be faithful about.

import { createPersistence } from '../jobs/analyze_thread/persist.js'
import { createEventsLoader } from '../pages/recentData.js'
import { renderTopBar } from '../shared/topbar.js'
import { allReposOfProjects } from '../shared/renderUtils.js'
import { buildSteps, buildPool, boardAt, changedTodoIds, projectIdsOfSteps, eventProjectIds } from './replayEngine.js'
import { renderInput, renderBoard, renderProgress } from './replayStage.js'
import { exportReplay } from './replayExport.js'

renderTopBar('replay')

const el = (id) => document.getElementById(id)
const num = (v) => Number(v) || 0
const EVENTS_CAP = 2000 // newest 2000 (~6 weeks today); the log itself holds more (3.6k)

const data = { projects: [], events: [], names: new Map(), self: new Set() }
const run = { steps: [], pool: [], costs: [], idx: -1, playing: false, timer: null }

const nameOf = (a) => data.names.get(String(a || '').toLowerCase()) || null

// a manual_edit event names a todo_id / project_id and nothing else — these turn those ids into
// the words the stage shows
const lookup = {
  titleOf: (todoId) => {
    if (!todoId) return ''
    for (const p of data.projects) {
      const t = (p.todos || []).find(x => x.todo_id === todoId)
      if (t) return t.short_description || t.description || ''
    }
    return ''
  },
  projectNameOf: (projectId) => {
    const p = projectId && data.projects.find(x => x.project_id === projectId)
    return (p && p.name) || ''
  }
}

function setStatus (text, cls = 'info') {
  const s = el('rpStatus')
  s.className = 'rp-status ' + cls
  s.textContent = text
}

// ---- load: everything once, from the database --------------------------------------------------
async function load () {
  const persist = createPersistence(typeof freezr !== 'undefined' ? freezr : null)
  const loader = createEventsLoader()
  const [all] = await Promise.all([persist.loadAll(), loader.ensureCount(EVENTS_CAP)])
  data.projects = all.projects || []
  data.events = loader.rows()
  data.names = new Map((all.profiles || []).filter(p => p.address).map(p => [String(p.address).toLowerCase(), p.display_name || '']))
  data.self = new Set(((all.settings && all.settings.your_addresses) || []).map(a => String(a).toLowerCase()))

  const asofs = data.events.map(e => num(e.asof)).filter(Boolean)
  const newest = asofs.length ? Math.max(...asofs) : Date.now()
  const oldest = asofs.length ? Math.min(...asofs) : newest
  // a week of material is a good demo length; the whole log is one date change away
  el('rpFrom').value = isoDay(Math.max(oldest, newest - 7 * 864e5))
  el('rpFrom').min = isoDay(oldest)
  el('rpTo').min = isoDay(oldest)

  fillRepos()
  fillProjects()
  for (const id of ['rpFrom', 'rpTo', 'rpChMail', 'rpChWork', 'rpChMsg', 'rpKindAnalysed', 'rpKindAuto', 'rpKindManual', 'rpRepo']) {
    el(id).addEventListener('change', fillProjects)
  }
  setStatus('Loaded ' + data.events.length + ' recorded events (' + isoDay(oldest) + ' → ' + isoDay(newest) +
    ') over ' + data.projects.length + ' projects. Pick a window and build the replay.', 'ok')
}

const isoDay = (ms) => { try { return new Date(ms).toISOString().slice(0, 10) } catch (e) { return '' } }
const dayStart = (v) => { const ms = Date.parse(v + 'T00:00:00'); return Number.isFinite(ms) ? ms : 0 }
const dayEnd = (v) => { const ms = Date.parse(v + 'T23:59:59.999'); return Number.isFinite(ms) ? ms : 0 }

function fillRepos () {
  const sel = el('rpRepo')
  for (const r of allReposOfProjects(data.projects)) {
    const o = document.createElement('option')
    o.value = r.slug; o.textContent = '#' + r.name
    sel.appendChild(o)
  }
}

// The picker lists only the projects with activity under the CURRENT window + input filters (every
// filter except the project pick itself), each with its input count, newest activity first. Picks
// that are still in the list survive a filter change; picks that fell out of it are dropped.
function fillProjects () {
  const sel = el('rpProjects')
  const kept = pickedProjectIds()
  const active = new Map() // project_id -> { n, last }
  for (const s of buildSteps(data.events, { ...windowFilters(), projectIds: null })) {
    for (const id of eventProjectIds(s.ev)) {
      const a = active.get(id) || { n: 0, last: 0 }
      a.n++; a.last = Math.max(a.last, s.atMs)
      active.set(id, a)
    }
  }
  const list = data.projects.filter(p => active.has(p.project_id))
    .sort((a, b) => active.get(b.project_id).last - active.get(a.project_id).last)
  sel.textContent = ''
  for (const p of list) {
    const o = document.createElement('option')
    o.value = p.project_id
    o.textContent = (p.name || p.project_id) + ' (' + active.get(p.project_id).n + ')'
    o.selected = kept.has(p.project_id)
    sel.appendChild(o)
  }
  el('rpProjCount').textContent = list.length + ' active in this window'
}

// ---- build ---------------------------------------------------------------------------------
function pickedProjectIds () {
  return new Set([...el('rpProjects').selectedOptions].map(o => o.value))
}

function pickedChannels () {
  const set = new Set()
  if (el('rpChMail').checked) set.add('mail')
  if (el('rpChWork').checked) set.add('work')
  if (el('rpChMsg').checked) set.add('messages')
  return set
}

function pickedGroups () {
  const g = []
  if (el('rpKindAnalysed').checked) g.push('analysed')
  if (el('rpKindAuto').checked) g.push('auto')
  if (el('rpKindManual').checked) g.push('manual')
  return g
}

function windowFilters () {
  return {
    fromMs: dayStart(el('rpFrom').value),
    toMs: el('rpTo').value ? dayEnd(el('rpTo').value) : 0,
    channels: pickedChannels(),
    groups: pickedGroups(),
    repoFilter: el('rpRepo').value
  }
}

function build () {
  pause()
  const picked = pickedProjectIds()
  const repoFilter = el('rpRepo').value
  run.steps = buildSteps(data.events, { ...windowFilters(), projectIds: picked })
  // the board's scope: what the window touches (so the rows actually move), the picked projects,
  // or the lot
  const scope = el('rpScope').value === 'all'
    ? null
    : (picked.size ? picked : projectIdsOfSteps(run.steps))
  run.pool = buildPool(data.projects, { projectIds: scope, repoFilter })

  const has = run.steps.length > 0
  el('rpScrub').max = String(Math.max(0, run.steps.length - 1))
  el('rpScrub').value = '0'
  let total = 0
  run.costs = run.steps.map(st => (total += num(st.ev.cost)))
  for (const id of ['rpPlay', 'rpStep', 'rpRestart', 'rpScrub', 'rpPresent', 'rpExport']) el(id).disabled = !has
  el('rpBuilt').textContent = has
    ? run.steps.length + ' inputs · ' + run.pool.length + ' to-dos in scope · ' +
      Math.round(run.steps.length * Number(el('rpSecs').value || 0.25)) + 's to play'
    : 'Nothing recorded in that window with those filters.'
  run.idx = -1
  show(has ? 0 : -1)
  setStatus(has ? 'Ready — press play.' : 'No steps: widen the window or tick more input types.', has ? 'ok' : 'error')
}

// ---- playback -------------------------------------------------------------------------------
// one frame into { in, board, prog } — the live stage and the export both paint through here, so
// the exported replay is exactly what the page plays
function paint (i, slots) {
  const step = i >= 0 ? run.steps[i] : null
  const atMs = step ? step.atMs : 0
  renderInput(slots.in, step, { nameOf, lookup, self: data.self })
  const board = boardAt(run.pool, atMs || Date.now(), { cap: 3 })
  renderBoard(slots.board, board, { changed: step ? changedTodoIds(step.ev, run.pool) : new Set(), nameOf })
  renderProgress(slots.prog, { idx: i, total: run.steps.length, atMs, cost: i >= 0 ? run.costs[i] : 0 })
}

function show (i) {
  run.idx = i
  paint(i, { in: el('rpInput'), board: el('rpBoard'), prog: el('rpProgress') })
  el('rpScrub').value = String(Math.max(0, i))
}

async function doExport () {
  if (!run.steps.length) return
  pause()
  const btn = el('rpExport')
  btn.disabled = true
  setStatus('Exporting ' + run.steps.length + ' frames…', 'info')
  try {
    const first = isoDay(run.steps[0].atMs); const last = isoDay(run.steps[run.steps.length - 1].atMs)
    const r = await exportReplay({
      total: run.steps.length,
      shape: el('rpShape').value === 'full' ? 'full' : 'half',
      secs: Number(el('rpSecs').value || 0.25),
      paint,
      caption: run.steps.length + ' inputs, ' + first + ' to ' + last
    })
    setStatus('Exported ' + r.frames + ' frames (' + r.rows + ' distinct rows, ' + r.boards + ' boards) — superlazy-replay.html ' +
      Math.round(r.bytes / 1024) + ' KB + superlazy-replay.js. Put the .js in the host page\'s script_files.', 'ok')
  } catch (err) {
    setStatus('Export failed: ' + (err.message || err), 'error')
  } finally {
    btn.disabled = false
    show(Math.max(0, run.idx))
  }
}

function tick () {
  if (!run.playing) return
  if (run.idx >= run.steps.length - 1) { pause(); setStatus('Replay finished — ' + run.steps.length + ' inputs.', 'ok'); return }
  show(run.idx + 1)
  run.timer = setTimeout(tick, Math.max(50, Number(el('rpSecs').value || 0.25) * 1000))
}

function play () {
  if (!run.steps.length || run.playing) return
  run.playing = true
  el('rpPlay').textContent = '⏸ Pause'
  if (run.idx >= run.steps.length - 1) show(0)
  run.timer = setTimeout(tick, Math.max(50, Number(el('rpSecs').value || 0.25) * 1000))
}

function pause () {
  run.playing = false
  if (run.timer) { clearTimeout(run.timer); run.timer = null }
  el('rpPlay').textContent = '▶ Play'
}

// ---- present: scale the stage to fill the screen ----------------------------------------------
function fitStage () {
  const wrap = el('rpStageWrap')
  const stage = el('rpStage')
  if (!wrap.classList.contains('rp-presenting')) { stage.style.transform = ''; return }
  const scale = Math.min(wrap.clientWidth / stage.offsetWidth, wrap.clientHeight / stage.offsetHeight)
  stage.style.transform = 'scale(' + scale.toFixed(3) + ')'
}

function present () {
  const wrap = el('rpStageWrap')
  wrap.classList.add('rp-presenting')
  if (wrap.requestFullscreen) wrap.requestFullscreen().then(fitStage).catch(fitStage)
  else fitStage()
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) el('rpStageWrap').classList.remove('rp-presenting')
  fitStage()
})
window.addEventListener('resize', fitStage)

// ---- wiring ------------------------------------------------------------------------------------
function init () {
  el('rpBuild').addEventListener('click', build)
  el('rpPlay').addEventListener('click', () => (run.playing ? pause() : play()))
  el('rpStep').addEventListener('click', () => { pause(); show(Math.min(run.idx + 1, run.steps.length - 1)) })
  el('rpRestart').addEventListener('click', () => { pause(); show(0) })
  el('rpScrub').addEventListener('input', (e) => { pause(); show(Number(e.target.value) || 0) })
  el('rpPresent').addEventListener('click', present)
  el('rpExport').addEventListener('click', doExport)
  el('rpShape').addEventListener('change', () => {
    const stage = el('rpStage')
    stage.classList.toggle('rp-stage-half', el('rpShape').value === 'half')
    stage.classList.toggle('rp-stage-full', el('rpShape').value === 'full')
    fitStage()
  })
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return
    if (e.key === ' ') { e.preventDefault(); run.playing ? pause() : play() }
    if (e.key === 'ArrowRight') { pause(); show(Math.min(run.idx + 1, run.steps.length - 1)) }
    if (e.key === 'ArrowLeft') { pause(); show(Math.max(0, run.idx - 1)) }
  })
  renderInput(el('rpInput'), null)
  load().catch(err => setStatus('Could not load the recording: ' + (err.message || err), 'error'))
}

init()
