// requestauditlab.js — the REQUEST AUDIT LAB page (dev tool). Every LLM exchange the per-message
// engine made while recording was on (settings.llm_audit — jobs/analyze_thread/llmAudit.js), as
// request chains: the analysis call plus its request_more / repair rounds, each with the cost of
// every part (cached prefix read, new input, cache writes by TTL, output) and the exact bytes that
// went over the wire. Calls that ran on a $0 local connector are priced as "eq" equivalents.
import { createPersistence } from '../jobs/analyze_thread/persist.js'
import { SYSTEM_PROMPT, PROMPT_VERSION } from '../jobs/analyze_thread/prompt.js'
import { renderTopBar } from '../shared/topbar.js'
import { ensurePriceMap } from '../shared/eqPricing.js'
import { readAuditSettings, setAuditSettings, loadExchanges, loadBlob, groupExchanges } from './requestAuditData.js'
import { setStatus, renderTotals, renderSystemPrompt, renderRuns } from './requestAuditUi.js'

renderTopBar('requestauditlab')

const $ = (id) => document.getElementById(id)
const persist = createPersistence(freezr)
const state = { on: false, days: 3, rows: [] }

function paintToggle () {
  const b = $('raToggle')
  b.textContent = state.on ? '● Recording ON — click to stop' : '○ Recording OFF — click to start'
  b.className = 'ra-btn ra-btn-primary' + (state.on ? ' recording' : '')
  $('raDays').value = state.days
}

async function refresh () {
  setStatus('Loading recorded requests…', 'busy')
  try {
    await ensurePriceMap()
    const hours = Number($('raWindow').value) || 0
    state.rows = await loadExchanges(persist, { hours })
    const runs = groupExchanges(state.rows)
    renderTotals($('raTotals'), runs)
    renderSystemPrompt($('raSystem'), { text: SYSTEM_PROMPT, version: PROMPT_VERSION, versionsSeen: [...new Set(state.rows.map(r => r.prompt_version))] })
    renderRuns($('raList'), runs, { loadBlob: (hash) => loadBlob(persist, hash) })
    setStatus((state.on ? 'Recording ON' : 'Recording OFF') + ' · ' + state.rows.length + ' exchange' + (state.rows.length === 1 ? '' : 's') +
      ' in the last ' + (hours ? hours + 'h' : 'retention window') + ' · records are kept ' + state.days + ' day' + (state.days === 1 ? '' : 's'), state.on ? 'ok' : '')
  } catch (e) {
    setStatus('Could not load: ' + ((e && e.message) || e) + (/no such|not found|404/i.test(String(e && e.message)) ? ' — the llm_audit table needs the app re-installed from files' : ''), 'error')
  }
}

async function toggle () {
  $('raToggle').disabled = true
  try {
    await setAuditSettings(persist, { on: !state.on, days: Number($('raDays').value) })
    state.on = !state.on
    state.days = Math.min(30, Math.max(1, Number($('raDays').value) || 3))
    paintToggle()
    setStatus(state.on ? 'Recording ON — the next check (background or foreground) records every LLM exchange.' : 'Recording OFF — existing records stay until they age out.', state.on ? 'ok' : 'warn')
  } catch (e) { setStatus('Could not save: ' + ((e && e.message) || e), 'error') } finally { $('raToggle').disabled = false }
}

async function clearAll () {
  if (!window.confirm('Delete every recorded request? (Recording stays ' + (state.on ? 'ON' : 'OFF') + '.)')) return
  setStatus('Deleting…', 'busy')
  try { const n = await persist.clearAudit(); setStatus('Deleted ' + n + ' record(s).', 'ok'); await refresh() } catch (e) { setStatus('Delete failed: ' + ((e && e.message) || e), 'error') }
}

async function init () {
  const s = await readAuditSettings(persist)
  state.on = s.on; state.days = s.days
  paintToggle()
  $('raToggle').onclick = toggle
  $('raRefresh').onclick = refresh
  $('raClear').onclick = clearAll
  $('raWindow').onchange = refresh
  $('raDays').onchange = async () => { const d = Math.min(30, Math.max(1, Number($('raDays').value) || 3)); state.days = d; $('raDays').value = d; await setAuditSettings(persist, { days: d }).catch(() => {}) }
  await refresh()
}
init()
