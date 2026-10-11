// agentslabInspect.js — the TURN INSPECTION modal of the AI agents page. Two layers, clearly
// separated, so the user can judge what else in a transcript might be worth keeping:
//   1. FINAL — the item exactly as the thread viewer will show it once the turn is analysed
//      (header rows + the stored dialogue body). This is what superlazy keeps.
//   2. DERIVED + RAW — not stored anywhere: the turn's facts (duration, models, token usage, tool
//      mix, thinking volume, files) and every raw transcript record behind the turn, one
//      collapsible row each, with long strings truncated until "show full" is pressed.
// Read-only; opens through the shared modal shell (modalStack.js) like every other modal.

import { openModalShell } from '../shared/modalStack.js'
import { fmtTs, fmtDuration, TURN_MARKERS, isAgentMarker, turnStats, effortLine } from '../jobs/analyze_thread/sessionDigest.js'
import { el } from './agentslabUi.js'

const TRUNC = 600
const fmtInt = (n) => Number(n || 0).toLocaleString()
const kb = (n) => (Number(n || 0) / 1024).toFixed(1) + ' KB'
const clockOf = (ms) => { try { return new Date(ms).toTimeString().slice(0, 8) } catch (e) { return '?' } }

// ---- section 1: the final viewer rendering -------------------------------------------------------

function headTable (rows) {
  const t = el('table', 'wl-head')
  for (const r of rows) {
    if (!r) continue
    const tr = el('tr')
    tr.appendChild(el('th', null, r[0]))
    const td = el('td'); if (typeof r[1] === 'string') td.textContent = r[1]; else td.appendChild(r[1])
    tr.appendChild(td); t.appendChild(tr)
  }
  return t
}

// the stored body, with the two speaker markers highlighted (the viewer shows plain text today;
// colouring the markers is the one liberty taken here so the dialogue is scannable)
function dialogue (body) {
  const pre = el('pre', 'wl-tm-body')
  for (const line of String(body || '').split('\n')) {
    if (line === TURN_MARKERS.you) pre.appendChild(el('span', 'wl-you', line))
    else if (isAgentMarker(line)) pre.appendChild(el('span', 'wl-agent', line))
    else pre.appendChild(document.createTextNode(line))
    pre.appendChild(document.createTextNode('\n'))
  }
  return pre
}

function finalSection (item) {
  const sec = el('div', 'wl-tm-section final')
  const h = el('h3', null, 'As the viewer will show it')
  h.appendChild(el('span', 'wl-muted', '— this is what superlazy stores (the `inputs` record) and what the thread modal opens'))
  sec.appendChild(h)
  const turnState = item.turn_state === 'unanswered' ? ' — no answer (left mid-turn)' : item.turn_state === 'mid_tool' ? ' — stopped mid-tool' : ''
  sec.appendChild(headTable([
    ['Session', item.title],
    ['Turn', item.turn_n + ' of ' + item.turns_total + turnState],
    item.repo_name ? ['Repo', item.repo_name + (item.branch ? ' (' + item.branch + ')' : '')] : null,
    ['With', (item.agent_name || 'AI agent') + ' (agent, team member)'],
    ['When', fmtTs(item.date)],
    ['Thread', item.thread_id + (item.in_reply_to ? ' · continues ' + item.in_reply_to : '')]
  ]))
  sec.appendChild(dialogue(item.body_text))
  sec.appendChild(el('div', 'wl-muted', 'Stored body: ' + fmtInt(String(item.body_text || '').length) + ' chars. The model reads a cut of it: the prompt\'s head and the answer\'s tail, with the previous turn inlined in full.'))
  return sec
}

// ---- section 2: derived facts -----------------------------------------------------------------------

function fact (label, value) {
  const d = el('div', 'wl-fact')
  d.appendChild(el('b', null, label))
  d.appendChild(document.createTextNode(value == null || value === '' ? '—' : String(value)))
  return d
}

function factsSection (turn, session) {
  const sec = el('div', 'wl-tm-section derived')
  const h = el('h3', null, 'Turn facts')
  h.appendChild(el('span', 'wl-muted', '— derived from the transcript; the EFFORT line below is what the item stores (inputs.work_stats, also on the event); the rest is not kept'))
  sec.appendChild(h)
  const st = turnStats(turn)
  sec.appendChild(el('div', 'wl-tm-effort', 'effort: ' + effortLine(st) + (st.asked_question ? ' · ended with a question to you' : '')))
  const g = el('div', 'wl-facts')
  const dur = turn.lastTs && turn.ts ? turn.lastTs - turn.ts : null
  const tools = Object.entries(turn.tools || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + (v > 1 ? '×' + v : '')).join(' ')
  g.appendChild(fact('Duration', dur != null ? fmtDuration(dur) + ' (' + fmtInt(Math.round(dur / 1000)) + ' s)' : null))
  g.appendChild(fact('Prompt / answer chars', fmtInt(turn.promptChars) + ' / ' + fmtInt(turn.assistantTextChars) + (turn.assistantText ? ' (recap ' + fmtInt(turn.assistantText.length) + ')' : '')))
  g.appendChild(fact('Assistant messages', turn.assistantMsgs + (turn.stopReason ? ' · last stop: ' + turn.stopReason : '')))
  g.appendChild(fact('Tool calls', Object.values(turn.tools || {}).reduce((n, v) => n + v, 0) + (tools ? ' · ' + tools : '')))
  g.appendChild(fact('Tool output dropped', fmtInt(turn.toolResultChars) + ' chars (' + kb(turn.toolResultChars) + ')'))
  g.appendChild(fact('Thinking (dropped)', turn.thinkingChars ? fmtInt(turn.thinkingChars) + ' chars' : 'none'))
  g.appendChild(fact('Model(s)', (turn.models || []).join(', ')))
  const u = turn.usage || {}
  g.appendChild(fact('Tokens in / out', fmtInt(u.input) + ' / ' + fmtInt(u.output)))
  g.appendChild(fact('Cache read / write', fmtInt(u.cache_read) + ' / ' + fmtInt(u.cache_write)))
  g.appendChild(fact('API errors in turn', turn.apiErrors || 0))
  g.appendChild(fact('Files changed', (turn.files || []).length ? turn.files.map(f => String(f).split('/').pop()).join(', ') : 'none'))
  g.appendChild(fact('Lines touched (proxy)', '+' + (turn.linesAdded || 0) + ' / −' + (turn.linesRemoved || 0)))
  g.appendChild(fact('Continuations folded in', (turn.continuations || []).length ? turn.continuations.map(c => '“' + c + '”').join(', ') : 'none'))
  g.appendChild(fact('Ended with a question', turn.askedQuestion ? 'yes' : 'no'))
  g.appendChild(fact('Pasted lines collapsed from the prompt', turn.pastedLines || 0))
  g.appendChild(fact('Git commits in this turn', (turn.commits || []).length ? turn.commits.map(c => c.hash.slice(0, 7) + ' “' + c.message + '”' + (c.files != null ? ' (' + c.files + ' files, +' + c.insertions + '/−' + c.deletions + ')' : '')).join(' · ') : 'none'))
  g.appendChild(fact('Plan written', turn.plan || 'no'))
  if (turn.n === 1 && session.repoState) {
    const rs = session.repoState
    g.appendChild(fact('Git at session start (stored, not shown to the model)', 'branch ' + (rs.branch || '?') + ' · ' + rs.uncommitted.length + ' uncommitted file(s) · recent: ' + rs.recent_commits.map(c => c.hash.slice(0, 7)).join(', ')))
  }
  g.appendChild(fact('Checklist at this point', Array.isArray(turn.todos) ? turn.todos.length + ' item(s), ' + turn.todos.filter(t => t.status !== 'completed').length + ' open' : 'none'))
  g.appendChild(fact('Session', session.turns.length + ' turns · ' + fmtTs(session.firstTs) + ' → ' + fmtTs(session.lastTs) + ' · v' + (session.version || '?') + ' · ' + (session.entrypoint || '?')))
  sec.appendChild(g)
  if (turn.files && turn.files.length) {
    const d = el('details'); d.appendChild(el('summary', 'wl-muted', 'full paths of the files changed'))
    d.appendChild(el('pre', 'wl-tm-body', turn.files.join('\n')))
    sec.appendChild(d)
  }
  return sec
}

// ---- section 3: raw records -----------------------------------------------------------------------------

// one-line description of a record for its summary row
function describe (r) {
  const c = r.message && r.message.content
  const blocks = Array.isArray(c) ? c : (typeof c === 'string' ? [{ type: 'text', text: c }] : [])
  const parts = []
  for (const b of blocks) {
    if (!b) continue
    if (b.type === 'text') parts.push('text ' + fmtInt(String(b.text || '').length) + 'ch')
    else if (b.type === 'tool_use') parts.push('tool_use ' + (b.name || '?') + (b.input && b.input.file_path ? ' ' + String(b.input.file_path).split('/').pop() : b.input && b.input.command ? ' `' + String(b.input.command).slice(0, 60) + '`' : ''))
    else if (b.type === 'tool_result') { const t = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(x => x && x.text || '').join('') : ''; parts.push('tool_result ' + fmtInt(t.length) + 'ch' + (b.is_error ? ' ERROR' : '')) }
    else if (b.type === 'thinking') parts.push('thinking ' + fmtInt(String(b.thinking || '').length) + 'ch')
    else parts.push(b.type)
  }
  let kind = r.type
  if (r.type === 'user' && blocks.some(b => b && b.type === 'tool_result')) kind = 'tool_result'
  if (r.type === 'user' && r.isMeta) kind = 'user (meta)'
  let extra = ''
  if (r.type === 'assistant' && r.message) extra = (r.message.stop_reason ? ' · stop ' + r.message.stop_reason : '') + (r.message.usage ? ' · out ' + fmtInt(r.message.usage.output_tokens) + ' tok' : '')
  if (r.type === 'system') extra = ' · ' + (r.subtype || '') + (r.error && r.error.message ? ' — ' + r.error.message : '')
  if (r.type === 'file-history-delta') extra = ' · ' + String(r.trackingPath || '').split('/').pop()
  if (r.type === 'attachment') extra = ' · ' + ((r.attachment && r.attachment.type) || '')
  if (r.type === 'ai-title') extra = ' · ' + (r.aiTitle || '')
  if (r.type === 'summary') extra = ' · compaction summary ' + fmtInt(String(r.summary || '').length) + 'ch'
  return { kind, summary: (parts.join(' · ') + extra).trim() }
}

const kindClass = (kind) => kind.startsWith('user') ? 'k-user' : kind === 'assistant' ? 'k-assistant' : kind === 'tool_result' ? 'k-tool_result' : kind === 'system' ? 'k-system' : 'k-other'

// pretty JSON with long strings cut (the whole point of "not a dump")
function truncatedJson (v, cap) {
  const walk = (x) => {
    if (typeof x === 'string') return x.length > cap ? x.slice(0, cap) + ' …[' + fmtInt(x.length - cap) + ' more chars]' : x
    if (Array.isArray(x)) return x.map(walk)
    if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = walk(x[k]); return o }
    return x
  }
  return JSON.stringify(walk(v), null, 2)
}

function recordRow (r, i) {
  const { kind, summary } = describe(r)
  const d = el('details', 'wl-rec ' + kindClass(kind))
  d.dataset.kind = kind
  const sm = el('summary')
  sm.appendChild(el('span', 'wl-rec-n', '#' + i))
  sm.appendChild(el('span', 'wl-rec-t', r.timestamp ? clockOf(Date.parse(r.timestamp)) : '—'))
  sm.appendChild(el('span', 'wl-rec-kind', kind))
  sm.appendChild(el('span', 'wl-rec-sum', summary))
  d.appendChild(sm)
  let full = false
  const pre = el('pre', null, '')
  const paint = () => { pre.textContent = full ? JSON.stringify(r, null, 2) : truncatedJson(r, TRUNC) }
  d.addEventListener('toggle', () => { if (d.open && !pre.textContent) paint() })
  const act = el('div', 'wl-rec-actions')
  const b = el('button', 'wl-btn wl-btn-small', 'show full strings')
  b.addEventListener('click', (e) => { e.preventDefault(); full = !full; b.textContent = full ? 'truncate strings' : 'show full strings'; paint() })
  act.appendChild(b)
  d.appendChild(pre); d.appendChild(act)
  return d
}

function rawSection (turn, session) {
  const sec = el('div', 'wl-tm-section derived')
  const recs = turn.raw || []
  const h = el('h3', null, 'Raw records behind this turn (' + recs.length + ')')
  h.appendChild(el('span', 'wl-muted', '— the transcript lines from your prompt to the next one, NOT stored; strings are cut at ' + TRUNC + ' chars until you ask for them'))
  sec.appendChild(h)
  if (!recs.length) { sec.appendChild(el('div', 'wl-muted', '(no raw records — the session file could not be re-read)')); return sec }
  const filters = el('div', 'wl-raw-filters')
  const kinds = [...new Set(recs.map(r => describe(r).kind))]
  const shown = new Set(kinds)
  const rows = recs.map((r, i) => recordRow(r, i + 1))
  const apply = () => rows.forEach(row => { row.hidden = !shown.has(row.dataset.kind) })
  for (const k of kinds) {
    const lab = el('label'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = true
    cb.addEventListener('change', () => { if (cb.checked) shown.add(k); else shown.delete(k); apply() })
    lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + k + ' (' + recs.filter(r => describe(r).kind === k).length + ')'))
    filters.appendChild(lab)
  }
  const bytes = recs.reduce((n, r) => n + JSON.stringify(r).length, 0)
  filters.appendChild(el('span', 'wl-muted', kb(bytes) + ' of transcript for this turn'))
  sec.appendChild(filters)
  for (const row of rows) sec.appendChild(row)
  if (turn.n === 1 && session.rawPre && session.rawPre.length) {
    const d = el('details'); d.appendChild(el('summary', 'wl-muted', session.rawPre.length + ' session-level record(s) before the first prompt'))
    session.rawPre.forEach((r, i) => d.appendChild(recordRow(r, i + 1)))
    sec.appendChild(d)
  }
  return sec
}

// ---- the modal ---------------------------------------------------------------------------------------------

// item: the dry-run inputs record; turn/session: the parsed session (buildSession with keepRaw)
export function openTurnModal ({ item, turn, session }) {
  const { modal } = openModalShell({ className: 'wl-turn-modal' })
  modal.appendChild(el('div', 'wl-tm-title', (item.title || '(untitled session)') + ' — turn ' + item.turn_n + ' of ' + item.turns_total))
  modal.appendChild(el('div', 'wl-tm-sub', item.msg_id + ' · ' + (item.repo_name || item.repo_slug || '') + ' · ' + fmtTs(item.date)))
  modal.appendChild(finalSection(item))
  if (turn) {
    modal.appendChild(factsSection(turn, session))
    modal.appendChild(rawSection(turn, session))
  } else {
    modal.appendChild(el('div', 'wl-tm-section derived', 'The session file could not be re-read for the raw view.'))
  }
}
