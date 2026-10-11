// bootstrapUi.js — rendering for the bulk-bootstrap page. Two jobs:
//   1. THE RUN BAR — one line that always says what is happening, for how long, and what it cost.
//   2. THE REVIEW — each section of the model's map rendered with the app's own entity identity
//      (renderUtils/entities.css: importance owns colour, direction is an emoji disc, people are
//      neutral initials discs) plus the control that lets the user CORRECT it.
//
// Corrections are collected here and handed back as plain text for the next refinement round —
// nothing is persisted (phase 1). Model output is untrusted: everything is built with
// textContent, never innerHTML.

import { avatarEl, impBadge, dirDisc, DIR_LABEL, div, span, btn } from '../shared/renderUtils.js'
import { responsibilitiesText } from '../jobs/analyze_thread/responsibilities.js'

export const el = (id) => document.getElementById(id)

// the addresses we TOLD the model are the user's (the ticked mailboxes) — used to filter its
// alias nominations down to genuinely new ones
let declaredMe = new Set()
export function setDeclaredMe (set) {
  declaredMe = new Set([...(set || [])].map(a => String(a).toLowerCase()))
}

// ---- the run bar --------------------------------------------------------------------------
export function setPhase (title, sub, kind = 'info') {
  el('phase').textContent = title
  el('phase').className = 'bs-phase bs-phase-' + kind
  if (sub != null) el('phaseSub').textContent = sub
}
export function setBusy (busy) {
  el('spinner').hidden = !busy
}
export function setElapsed (text) { el('elapsed').textContent = text }

const fmtMoney = (v) => '$' + (Number(v) || 0).toFixed(4)
const fmtK = (n) => (n >= 10000 ? Math.round(n / 1000) + 'k' : String(n))

export function setCost (total, calls) {
  el('cost').textContent = fmtMoney(total) + ' · ' + calls + ' call' + (calls === 1 ? '' : 's')
}

export function renderDumpStats (stats) {
  el('dumpStats').textContent = stats.messages + ' emails · ' + stats.threads + ' threads · ' +
    stats.windowFrom + '→' + stats.windowTo + ' · ' + fmtK(stats.estTokens) + ' tokens' +
    (stats.partialThreads ? ' · ' + stats.partialThreads + ' thread(s) start before the window' : '') +
    (stats.degraded ? ' · trimmed' : '')
}
export function showDumpPreview (text) { el('dumpPreview').textContent = text }

// An evidence chip anywhere on the page opens the raw material at that message.
export function jumpToDumpMessage (surrogateId) {
  activateTab('raw', { byUser: true })
  activateSub('input')
  const pre = el('dumpPreview')
  const i = pre.textContent.indexOf('--- msg ' + surrogateId)
  if (i < 0) return
  pre.scrollTop = (i / pre.textContent.length) * pre.scrollHeight
  pre.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

// One diagnostics line per call, accumulated ACROSS runs so different windows/models compare.
export function renderDiag ({ label, meta, durationMs, stats }) {
  const d = el('diag')
  if (d.textContent === '—') d.textContent = ''
  const cost = (meta && meta.cost) || {}
  const t = (meta && meta.tokensUsed) || {}
  const qt = (x) => (x && x.qtty) || 0
  const cache = (t.other && t.other.details) || {}
  d.appendChild(div('bs-diagline',
    label + ': ' + fmtMoney(cost.totalCost) +
    ' · in ' + fmtK(qt(t.input)) + ' / out ' + fmtK(qt(t.output)) +
    (cache.cacheCreationTokens ? ' · cache write ' + fmtK(cache.cacheCreationTokens) : '') +
    (cache.cacheReadTokens ? ' · cache read ' + fmtK(cache.cacheReadTokens) + ' (~90% off)' : '') +
    ' · ' + Math.round(durationMs / 1000) + 's · ' + ((meta && meta.model) || '?')))

  // The exact counts the provider reported and the rate they were costed at, so this number can be
  // checked against the provider's own billing page rather than taken on trust.
  const raw = (meta && meta.rawUsage) || {}
  const pr = (meta && meta.pricing) || null
  const rawBits = Object.keys(raw)
    .filter(k => typeof raw[k] === 'number' && raw[k] > 0)
    .map(k => k + '=' + raw[k])
  if (rawBits.length || pr) {
    d.appendChild(div('bs-diagline bs-diagraw',
      '    provider says ' + (rawBits.join(' ') || '(no usage returned — NOT counted)') +
      (pr ? ' · billed at $' + pr.input + '/M in, $' + pr.output + '/M out' +
        (pr.key && pr.key !== (meta && meta.model) ? ' (rate taken from ' + pr.key + ')' : '')
        : ' · NO PRICE FOUND — this call is costed at zero')))
  }
  if (stats) {
    const perMsg = (cost.totalCost || 0) / Math.max(1, stats.messages)
    d.appendChild(div('hint', '≈ ' + fmtMoney(perMsg) + ' per email'))
  }
}

// ---- the model's reasoning, kept for review --------------------------------------------------
export function appendThinking (label, text) {
  const pre = el('thinkText')
  if (!pre.dataset.started) { pre.dataset.started = '1'; pre.textContent = '' }
  if (pre.dataset.label !== label) {
    pre.dataset.label = label
    pre.textContent += (pre.textContent ? '\n\n' : '') + '───── ' + label + ' ─────\n'
  }
  pre.textContent += text || ''
  el('thinkStats').textContent = Math.round(pre.textContent.length / 1000) + 'k chars · kept for review'
  if (pre.scrollHeight - pre.scrollTop - pre.clientHeight < 80) pre.scrollTop = pre.scrollHeight
}
export function noteNoThinking (label) {
  const pre = el('thinkText')
  if (pre.dataset.started && pre.dataset.label === label) return
  if (!pre.dataset.started) { pre.dataset.started = '1'; pre.textContent = '' }
  pre.dataset.label = label
  pre.textContent += (pre.textContent ? '\n\n' : '') + '───── ' + label + ' ─────\n' +
    '(this model returned no reasoning — it wrote the map directly)\n'
}

export function showResume (message) {
  el('resumePanel').hidden = false
  el('resumeMsg').textContent = message
}
export function hideResume () { el('resumePanel').hidden = true }

// ---- LIVE progress ---------------------------------------------------------------------------
// Ticks from the moment the request is sent — BEFORE the first byte — because a big window can
// leave the model reading (or thinking) for minutes with nothing to show.
export function startProgress (label) {
  const t0 = Date.now()
  const p = { thinkChars: 0, outChars: 0, sections: 0, phase: 'waiting', note: '' }
  const paint = () => {
    const secs = Math.round((Date.now() - t0) / 1000)
    setElapsed(secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + (secs % 60) + 's')
    if (p.phase === 'waiting') {
      setPhase('Reading your mail…', label + ' — the model is taking in the whole window. On a big mailbox the first words take a few minutes.')
    } else if (p.phase === 'thinking') {
      setPhase('Working it out…', label + ' — thinking (' + fmtK(p.thinkChars) + ' chars so far — “Under the hood” → “How it reasoned” to watch).')
    } else {
      setPhase('Writing your map…', label + ' — ' + p.sections + ' section(s) in, ' + fmtK(p.outChars) + ' chars.' + (p.note ? ' ' + p.note : ''))
    }
  }
  paint()
  setBusy(true)
  const timer = setInterval(paint, 1000)
  return {
    onThinking: (text) => { p.phase = 'thinking'; p.thinkChars += (text || '').length; appendThinking(label, text) },
    onDelta: (text) => {
      if (p.phase !== 'writing' && !p.thinkChars) noteNoThinking(label)
      p.phase = 'writing'
      p.outChars += (text || '').length
    },
    onSection: () => { p.sections++ },
    note: (s) => { p.note = s },
    thoughtChars: () => p.thinkChars,
    stop: () => { clearInterval(timer); setBusy(false) }
  }
}

// ---- tabs ------------------------------------------------------------------------------------
// Each section is a tab, disabled until its first result arrives. The page FOLLOWS the model —
// switching to whichever tab just received data — until the user takes control (clicks a tab or
// starts editing); from then on new data only raises a "new" flag, so nothing yanks the view out
// from under someone who is reading or typing.
const tabState = { active: null, seen: new Set() }

export function activateTab (key) {
  tabState.active = key
  for (const b of document.querySelectorAll('.bs-tab')) {
    const on = b.dataset.tab === key
    b.classList.toggle('bs-tab-on', on)
    b.setAttribute('aria-selected', on ? 'true' : 'false')
    if (on) b.querySelector('.bs-tabnew').hidden = true
  }
  for (const p of document.querySelectorAll('.bs-panel-tab')) p.hidden = p.dataset.panel !== key
  el('tabsIdle').hidden = true
}

// Called as each section streams in. Enables the tab and keeps its count. The FIRST section to
// arrive opens its own tab (the situation, which is what the user should read first) and after that
// the page never moves itself — later sections only raise a "new" flag, so reading or typing is
// never interrupted.
function touchTab (key, count) {
  const b = document.querySelector('.bs-tab[data-tab="' + key + '"]')
  if (!b) return
  b.disabled = false
  if (count != null) b.querySelector('.bs-tabcount').textContent = ' ' + count
  const firstTime = !tabState.seen.has(key)
  tabState.seen.add(key)
  if (!tabState.active) activateTab(key)
  else if (tabState.active !== key && firstTime) b.querySelector('.bs-tabnew').hidden = false
}

// sub-tabs (used by the under-the-hood panel: what we sent / what came back)
export function activateSub (key) {
  for (const b of document.querySelectorAll('.bs-subtab')) b.classList.toggle('bs-subtab-on', b.dataset.sub === key)
  for (const p of document.querySelectorAll('.bs-subpanel')) p.hidden = p.dataset.subpanel !== key
}

export function resetTabs () {
  tabState.active = null
  tabState.seen.clear()
  for (const b of document.querySelectorAll('.bs-tab')) {
    // the under-the-hood tab is always available — it holds the run's own material, not results
    if (b.dataset.tab !== 'raw') b.disabled = true
    b.classList.remove('bs-tab-on')
    b.querySelector('.bs-tabnew').hidden = true
    const c = b.querySelector('.bs-tabcount')
    if (c) c.textContent = ''
  }
  for (const p of document.querySelectorAll('.bs-panel-tab')) p.hidden = true
  el('tabsIdle').hidden = false
}

// The banner above the tabs: what the user must still do, and the only way off this page.
// It stays silent while a run is streaming — the run bar is speaking then — and repaints itself
// every time an answer is typed, so the count in it is never stale.
let mapComplete = false
let questionsWaived = false
export function setMapComplete (v) { mapComplete = !!v; paintBanner() }
// "Ignore the questions" — the user's decision that this map is good enough as it stands.
export function waiveQuestions () { questionsWaived = true; paintBanner() }

function setBanner ({ message, kind = 'ask', adoptEnabled = false, skip = null } = {}) {
  const b = el('banner')
  b.hidden = !message && !adoptEnabled
  b.className = 'bs-banner bs-banner-' + kind
  el('bannerMsg').textContent = message || ''
  el('adoptBtn').disabled = !adoptEnabled
  el('skipQBtn').hidden = !skip
  if (skip) el('skipQBtn').textContent = skip
}

export function paintBanner () {
  if (!mapComplete) { setBanner({}); return }
  const total = counts.questions
  // Typed answers are not folded into the map until they are SENT — so an answer sitting in a box
  // must NOT unlock saving, or the user would save a map that does not contain what they just told it.
  if (!total || questionsWaived) {
    setBanner({
      kind: 'ok',
      adoptEnabled: true,
      message: !total
        ? 'Nothing outstanding — look through the tabs, then save and start using SuperLazy.'
        : 'Saving this map as it stands, without the questions. You can answer them later.'
    })
    return
  }
  const answered = readAnswers().filter(a => a.answer && a.answer.trim()).length
  setBanner({
    kind: 'ask',
    adoptEnabled: false,
    skip: answered >= total ? 'Ignore my answers' : 'Ignore the questions',
    message: answered >= total
      ? 'All ' + total + ' answered — press “Send my answers” on the Questions tab to fold them into the map. Nothing you typed counts until it is sent.'
      : 'SuperLazy has ' + (total - answered) + ' unanswered question' + (total - answered === 1 ? '' : 's') +
        '. Answering them is the quickest way to a map worth keeping — open the Questions tab.'
  })
}

// What the user has already SENT. The moment answers are on their way they stop being editable
// input — leaving them in the boxes invites re-sending the same thing, and re-typing over an answer
// that is already folded in. They move here instead, as a record of what was said.
export function noteSent (lines) {
  const list = (lines || []).map((l) => String(l || '').trim()).filter(Boolean)
  if (!list.length) return
  const host = el('sentNotesList')
  for (const line of list) host.appendChild(div('bs-sent-line', line))
  el('sentNotes').hidden = false
}

// ---- corrections the user makes while reviewing ----------------------------------------------
// Kept as plain lines; setup.js appends them to the next refinement turn.
const corrections = []
export function addCorrection (line) {
  corrections.push(line)
  paintPending()
  refreshAnswersBtn()
}
export function takeCorrections () { return corrections.slice() }
export function clearCorrections () { corrections.length = 0; paintPending() }
function paintPending () {
  const n = corrections.length
  const e = el('pendingNote')
  e.hidden = n === 0
  e.textContent = n + ' correction' + (n === 1 ? '' : 's') + ' ready to send'
}

// ---- progressive section rendering -----------------------------------------------------------
const counts = { projects: 0, todos: 0, profiles: 0, autofile: 0, questions: 0 }

export function resetResults () {
  for (const k of Object.keys(counts)) counts[k] = 0
  for (const id of ['questions', 'projects', 'people', 'autofile']) el(id).textContent = ''
  el('freeText').value = ''
  el('ctxSaved').textContent = ''
  el('saveCtxBtn').disabled = true
  el('sendAnswersBtn').disabled = true
  el('answersHint').textContent = ''
  resetTabs()
  mapComplete = false
  questionsWaived = false
  activateSub('input')
  el('rawJson').textContent = 'nothing back yet.'
  setBanner({})
}

// Enable "Send my answers" as soon as there is anything to send (an answer, a marked correction,
// or free text) — a disabled button with no explanation is the thing people get stuck on.
export function refreshAnswersBtn () {
  const answered = [...document.querySelectorAll('.bs-q-answer')].some(i => i.value.trim())
  const free = el('freeText').value.trim()
  const marked = corrections.length
  const any = answered || free || marked
  el('sendAnswersBtn').disabled = !any
  el('answersHint').textContent = any
    ? 'sends everything you have marked or written on any tab'
    : 'answer a question, or note a correction on another tab, to enable this'
  paintBanner()
  return any
}

// a small inline "tell it what's wrong" control: button → textarea + save → confirmation chip
function correctionControl (label, placeholder, onSave) {
  const wrap = div('bs-fix')
  const open = btn('bs-fixbtn', label, () => {
    open.hidden = true
    const box = div('bs-fixbox')
    const ta = document.createElement('textarea')
    ta.rows = 2
    ta.placeholder = placeholder
    box.appendChild(ta)
    const row = div('run-controls')
    row.appendChild(btn('su-primary', 'Save', () => {
      const v = ta.value.trim()
      if (!v) return
      onSave(v)
      box.remove()
      const done = span('bs-fixdone', '✓ noted — sent with your corrections')
      wrap.appendChild(done)
    }))
    row.appendChild(btn('', 'Cancel', () => { box.remove(); open.hidden = false }))
    box.appendChild(row)
    wrap.appendChild(box)
    ta.focus()
  })
  wrap.appendChild(open)
  return wrap
}

function evidenceChips (ids, maps, onJump) {
  const wrap = span('bs-evwrap')
  for (const real of (ids || []).slice(0, 6)) {
    const sur = (maps && maps.surrogateMsgId[real]) || real
    const chip = btn('chip bs-evchip', sur, () => onJump && onJump(sur))
    chip.title = 'show this email in the mail we sent'
    wrap.appendChild(chip)
  }
  return wrap
}

function addProject (p, maps, onJump) {
  counts.projects++
  counts.todos += (p.todos || []).length
  touchTab('projects', counts.projects)
  const card = div('bs-proj')
  const head = div('bs-proj-head')
  head.appendChild(span('proj-mark'))
  head.appendChild(span('bs-proj-name', p.name || '(unnamed)'))
  head.appendChild(impBadge(p.importance))
  if (p.status_guess && p.status_guess !== 'active') head.appendChild(span('chip bs-statechip', p.status_guess))
  card.appendChild(head)

  const body = div('bs-proj-body')
  if (p.summary) body.appendChild(div('bs-proj-sum', p.summary))
  for (const td of (p.todos || [])) {
    const row = div('task-row bs-tdrow')
    row.appendChild(dirDisc(td.direction, td.importance))
    const mid = div('task-mid')
    const short = div('task-short', td.short_description || td.description || '')
    short.style.borderLeftColor = 'transparent'
    mid.appendChild(short)
    const bits = []
    if (td.direction) bits.push(DIR_LABEL[td.direction] || td.direction)
    if (td.owner) bits.push(td.owner)
    if (td.status === 'in_progress') bits.push('in progress')
    if (td.due_hint) bits.push('due ' + td.due_hint)
    const meta = span('task-meta', bits.join(' · '))
    meta.appendChild(evidenceChips(td.evidence_msg_ids, maps, onJump))
    mid.appendChild(meta)
    row.appendChild(mid)
    row.appendChild(impBadge(td.importance))
    body.appendChild(row)
  }
  if (!(p.todos || []).length) body.appendChild(div('hint', 'no open items found for this project'))

  const foot = div('bs-proj-foot')
  if ((p.keywords || []).length) foot.appendChild(span('hint', p.keywords.join(' · ')))
  const people = Object.keys(p.participants || {})
  if (people.length) {
    const av = span('bs-avrow')
    for (const a of people.slice(0, 6)) {
      const v = p.participants[a] || {}
      av.appendChild(avatarEl(a, { size: 'xs', title: a + (v.role ? ' — ' + v.role + (v.role_note ? ': ' + v.role_note : '') : '') }))
    }
    foot.appendChild(av)
  }
  foot.appendChild(evidenceChips(p.evidence_msg_ids, maps, onJump))
  body.appendChild(foot)
  card.appendChild(body)
  el('projects').appendChild(card)
}

function addProfile (pr) {
  counts.profiles++
  touchTab('people', counts.profiles)
  const card = div('bs-person')
  const head = div('bs-person-head')
  head.appendChild(avatarEl(pr.name || pr.address, { rank: pr.llm_importance, size: 'sm' }))
  const who = div('bs-person-who')
  who.appendChild(div('bs-person-name', pr.name || pr.address || '?'))
  who.appendChild(div('bs-person-addr', pr.address || ''))
  head.appendChild(who)
  head.appendChild(span('chip bs-relchip', pr.relationship || 'unknown'))
  head.appendChild(impBadge(pr.llm_importance))
  card.appendChild(head)
  if (pr.summary) card.appendChild(div('bs-person-sum', pr.summary))
  const respText = responsibilitiesText(pr)
  if (respText) card.appendChild(div('hint', 'handles: ' + respText))
  if (pr.tone_note) card.appendChild(div('hint', 'you write to them: ' + pr.tone_note))
  card.appendChild(correctionControl(
    'This is wrong',
    'Who are they really? e.g. “Anna is my assistant, not a vendor — she handles scheduling and invoices”',
    (v) => addCorrection('About ' + (pr.address || pr.name) + ': ' + v)))
  el('people').appendChild(card)
}

function addAutofile (a) {
  counts.autofile++
  touchTab('autofile', counts.autofile)
  const row = div('bs-auto')
  const left = div('bs-auto-left')
  left.appendChild(span('bs-auto-glyph', '⚙'))
  const who = div('bs-auto-who')
  who.appendChild(div('bs-auto-sender', a.sender || '?'))
  who.appendChild(div('hint', (a.category || 'bulk') + ' — ' + (a.reason || '')))
  left.appendChild(who)
  row.appendChild(left)
  const action = btn('bs-auto-btn', 'Read this sender', () => {
    addCorrection('Do NOT auto-file ' + (a.sender || '') + ' — their mail can matter, keep analysing it.')
    row.classList.add('bs-auto-off')
    action.remove()
    row.appendChild(span('bs-fixdone', '✓ will keep being analysed'))
  })
  action.title = 'keep sending this sender to the AI instead of filing it unread'
  row.appendChild(action)
  el('autofile').appendChild(row)
}

let qSeq = 0
function addQuestion (it) {
  counts.questions++
  touchTab('questions', counts.questions)
  const row = div('bs-q')
  row.appendChild(div('bs-q-text', it.question || ''))
  if (it.why_it_matters) row.appendChild(div('hint', it.why_it_matters))

  // When the model offers options, ASK them as choices — a free-text box next to "a / b / c"
  // makes the reader retype an answer that was already written for them.
  const opts = (it.options || []).map(o => String(o || '').trim()).filter(Boolean)
  const free = document.createElement('input')
  free.type = 'text'
  free.className = 'bs-q-answer'
  free.dataset.qid = it.id || ''
  free.dataset.question = it.question || ''

  if (opts.length) {
    const name = 'q' + (++qSeq)
    const list = div('bs-choices')
    free.classList.add('bs-q-other')
    free.placeholder = 'something else…'
    free.hidden = true
    const mk = (text, isOther) => {
      const lab = document.createElement('label')
      lab.className = 'bs-choice'
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = name
      radio.value = isOther ? '' : text
      radio.addEventListener('change', () => {
        free.hidden = !isOther
        // the free box carries the answer either way, so readAnswers() stays one code path
        free.value = isOther ? '' : text
        if (isOther) free.focus()
        refreshAnswersBtn()
      })
      lab.appendChild(radio)
      lab.appendChild(document.createTextNode(' ' + text))
      list.appendChild(lab)
    }
    for (const o of opts) mk(o, false)
    mk('Something else', true)
    row.appendChild(list)
  } else {
    free.placeholder = 'your answer'
  }
  free.addEventListener('input', refreshAnswersBtn)
  row.appendChild(free)
  el('questions').appendChild(row)
}

// Route ONE streamed section to its panel — the single rendering entry point for the first run,
// every refinement round, and a resume.
export function applySection (s, maps, { onJump } = {}) {
  if (s.section === 'business_context') {
    el('contextEdit').value = s.markdown || ''
    touchTab('situation')
  } else if (s.section === 'project') addProject(s, maps, onJump)
  else if (s.section === 'profile') addProfile(s)
  else if (s.section === 'autofile') addAutofile(s)
  else if (s.section === 'question') addQuestion(s)
  else if (s.section === 'me') {
    // ONLY addresses we did not already declare are news. The model echoing back the mailbox we
    // told it about ("it thinks me@… is also yours") is noise that reads as a false alarm.
    const extra = (s.addresses || [])
      .map(a => String(a || '').trim())
      .filter(a => a && !declaredMe.has(a.toLowerCase()))
    if (!extra.length) return
    const note = div('bs-guide bs-guide-warn')
    note.appendChild(document.createTextNode(
      'Besides your mailbox, it believes these are also you: ' + extra.join(', ') +
      '. Worth checking — an assistant or a family member on the same mail is the usual mix-up. '))
    note.appendChild(btn('bs-fixbtn', 'One of these is not me', () => {
      const v = window.prompt('Which address is not yours?')
      if (v && v.trim()) {
        addCorrection(v.trim() + ' is NOT one of my addresses — treat them as another person.')
        refreshAnswersBtn()
      }
    }))
    el('questions').appendChild(note)
    touchTab('questions', counts.questions || undefined)
  }
}

export function showRawJson (output) { el('rawJson').textContent = JSON.stringify(output, null, 2) }

export function readAnswers () {
  return [...document.querySelectorAll('.bs-q-answer')].map(i => ({
    id: i.dataset.qid, question: i.dataset.question, answer: i.value
  }))
}
