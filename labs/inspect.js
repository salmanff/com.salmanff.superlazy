// inspect.js — the INSPECT page: analyse ONE message at a time with full wire visibility and
// decide per message whether to keep the result. Built for A/B-ing preferences: open two tabs,
// set different prefs (model / thinking / max tokens / fetch rounds / context), run the SAME
// message in each (Ignore keeps the cursor in place), and compare the exchanges side by side.
//
// Save   → persists exactly what a production run would (event, projects, profiles, body
//          snapshot, side events, cursor advance) via processor.commitPending().
// Ignore → discards the writes, keeps everything on screen, and rebuilds the runner from the
//          persisted snapshot so the same message can be re-run cleanly.

import { createInspector, runKnobs, SYSTEM_PROMPT } from './inspectRunner.js'

const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const d = document.createElement(tag)
  if (cls) d.className = cls
  if (text != null) d.textContent = text
  return d
}
const fmtDate = (ms) => { try { return new Date(Number(ms)).toLocaleString() } catch (e) { return String(ms) } }
const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(4)
const kchars = (s) => String(s || '').length.toLocaleString() + ' chars'

let inspector = null
let running = false
let lastRunBlock = null
let runCounter = 0

function setStatus (text, cls) {
  const s = $('inStatus')
  s.textContent = text
  s.className = 'in-status' + (cls ? ' ' + cls : '')
}

function detailsBlock (title, body, { open = false, mono = true } = {}) {
  const d = el('details', 'in-block')
  if (open) d.open = true
  const sum = el('summary', null, title)
  d.appendChild(sum)
  const pre = el('pre', null, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  if (!mono) pre.style.fontFamily = 'inherit'
  d.appendChild(pre)
  return d
}

function metaTable (rows) {
  const t = el('table', 'in-meta-table')
  for (const [k, v] of rows) {
    const tr = el('tr')
    tr.appendChild(el('td', null, k))
    tr.appendChild(el('td', null, String(v)))
    t.appendChild(tr)
  }
  return t
}

function renderKnobs () {
  const host = $('inKnobsBody')
  host.textContent = ''
  const knobs = runKnobs(inspector)
  for (const [k, v] of Object.entries(knobs)) {
    const chip = el('span', 'in-knob')
    const b = el('b', null, k.replace(/_/g, ' ') + ': ')
    chip.appendChild(b)
    chip.appendChild(document.createTextNode(String(v)))
    host.appendChild(chip)
  }
  $('inKnobs').hidden = false
}

function renderNext () {
  const env = inspector.processor.peekNext()
  const host = $('inNextMeta')
  host.textContent = ''
  if (!env) {
    host.textContent = 'Queue is empty — no unprocessed messages in the window.' +
      ' (If you expected Slack chunks: the browser console has a "[superlazy] slack:" line saying ' +
      'how many chunks formed, the pending-queue size, and any per-workspace errors.)'
    $('inRunBtn').disabled = true
  } else {
    const q = inspector.processor.remaining()
    host.appendChild(el('div', null, 'From: ' + (env.from_address || '?')))
    host.appendChild(el('div', null, 'Subject: ' + (env.subject || '(no subject)')))
    host.appendChild(el('div', null, 'Date: ' + fmtDate(env.date) + ' · account: ' + (env.account_id || '?')))
    // DEBUG (thread-linking investigation): the provider's thread id and what the store links
    // to it RIGHT NOW — a mismatch here, before any LLM call, means broken project.thread_ids
    const tidLine = el('div', 'in-muted', 'Thread: ' + (env.thread_id || '(none)'))
    tidLine.style.cssText = 'font-family: ui-monospace, Menlo, monospace; font-size: 11px; word-break: break-all; user-select: all;'
    host.appendChild(tidLine)
    const direct = inspector.processor.session.store.linkedProjectsFor(env.thread_id)
    host.appendChild(el('div', direct.length ? 'in-muted' : 'in-banner error',
      direct.length
        ? 'Projects directly linked to this thread: ' + direct.map(p => '[' + p.project_id + '] ' + p.name).join(' · ')
        : 'NO project is directly linked to this thread id — if it should be, a project record carries a stale/mangled thread_id (evidence-based fallback will still surface related projects in the request).'))
    host.appendChild(el('div', 'in-muted', q + ' message(s) queued (oldest first)' +
      (inspector.plan.retryCount ? ' — ' + inspector.plan.retryCount + ' of them retries of earlier failures' : '') +
      (inspector.plan.truncated ? ' — mailbox listing was TRUNCATED (window too big)' : '')))
    $('inRunBtn').disabled = false
  }
  $('inNext').hidden = false
}

function progressLine (ev) {
  if (!ev || !ev.type) return null
  if (ev.type === 'msg_start') return 'analysing "' + ((ev.msg && ev.msg.subject) || '?') + '"…'
  if (ev.type === 'loading') return 'loading thread…'
  if (ev.type === 'loading_progress') return 'loading thread body ' + (ev.i + 1) + '/' + ev.n + '…'
  if (ev.type === 'building_style') return 'building the writing-style guide from sent mail (one-off)…'
  if (ev.type === 'step_pending') return 'request assembled — waiting on the model (round ' + (ev.round + 1) + ')…'
  if (ev.type === 'llm_waiting') {
    const s = Math.round((ev.elapsedMs || 0) / 1000)
    return 'still waiting on the model… ' + Math.floor(s / 60) + 'm ' + (s % 60) + 's'
  }
  if (ev.type === 'fetch') return 'model asked for more detail (round ' + (ev.round + 1) + ') — answering…'
  if (ev.type === 'reprofile_start') return 're-profiling ' + ev.address + ' (' + ev.trigger + ')…'
  if (ev.type === 'batch_split') return 'the batch was too much for one call — retrying each message on its own…'
  if (ev.type === 'message_abandoned') return 'could not analyse "' + ((ev.msg && ev.msg.subject) || '') + '" — moving on…'
  return null
}

// ---- rendering one completed run --------------------------------------------------------------

function renderExchange (host, ex, i) {
  const sec = el('div', 'in-sec')
  const o = ex.opts || {}
  sec.appendChild(el('h2', null, 'LLM call ' + (i + 1) + ' — ' + ex.phase))
  sec.appendChild(metaTable([
    ['options', 'max_tokens ' + o.max_tokens + ' · thinking ' + String(o.thinking) +
      (o.effort ? ' · effort ' + o.effort : '') +
      ' · cache ' + (o.cache ? JSON.stringify(o.cache) : 'off') +
      ' · responseType ' + (o.responseType || 'text') +
      (o.provider || o.family ? ' · model ' + [o.provider, o.family].filter(Boolean).join('/') : ' · model: app default')],
    ['system prompt', (o.system_prompt_chars || 0).toLocaleString() + ' chars (identical every call — see block above)']
  ]))
  const turns = ex.turns || []
  turns.forEach((t, ti) => {
    const label = 'sent turn ' + (ti + 1) + '/' + turns.length + ' — ' + t.role + ' · ' + kchars(t.content) +
      (ti === 0 && t.role === 'user' && turns.length > 1 ? ' — DURABLE TURN (your situation + project catalog + auto-process rules; byte-identical across messages so the provider can cache it)' : '') +
      (t.cached ? ' — CACHE BREAKPOINT HERE (everything up to and including this turn is read from the provider cache; nothing after it is cache-written)' : '') +
      (ti === turns.length - 1 ? ' — VOLATILE (this message: people, linked projects, thread, body)' : '')
    sec.appendChild(detailsBlock(label, t.content))
  })
  if (ex.thinking) sec.appendChild(detailsBlock('received THINKING · ' + kchars(ex.thinking) + ' (billed as output)', ex.thinking))
  sec.appendChild(detailsBlock('received RESPONSE · ' + kchars(ex.response), ex.response || '(empty)', { open: ex.phase !== 'analysis' }))
  const m = ex.meta || {}
  const tk = m.tokensUsed || {}
  const det = (tk.other && tk.other.details) || {}
  const rd = (m.rawUsage && m.rawUsage.output_tokens_details) || {}
  sec.appendChild(metaTable([
    ['model used', m.model || '?'],
    ['tokens', 'in ' + ((tk.input && tk.input.qtty) || 0).toLocaleString() +
      ' · out ' + ((tk.output && tk.output.qtty) || 0).toLocaleString() +
      ' · cache read ' + (Number(det.cacheReadTokens) || 0).toLocaleString() +
      ' · cache write ' + (Number(det.cacheCreationTokens) || 0).toLocaleString() +
      ' · thinking ' + (Number(rd.thinking_tokens) || 0).toLocaleString()],
    ['cost of this call', fmtMoney(m.cost && m.cost.totalCost)]
  ]))
  host.appendChild(sec)
}

// The cache verdict for a completed run. THREE distinct things get conflated as "caching", and
// only the first is a problem:
//   1. the DURABLE TURN was re-rendered → its ~11k tokens were re-written at 1.25x. Detected from
//      OUR OWN state (session.snapshot.trigger), not from token counts.
//   2. a cache READ → the discount working (the durable prefix was reused).
//   3. a write covering the VOLATILE turn → expected on every message: the provider breakpoints the
//      last message too, so the new bytes get cached for any follow-up round. ~25% surcharge on that
//      block only, and it pays back whenever a request_more round happens.
function cacheBanner (exchanges) {
  const t = inspector.processor
  let read = 0
  let write = 0
  for (const ex of exchanges) {
    const det = (ex.meta && ex.meta.tokensUsed && ex.meta.tokensUsed.other && ex.meta.tokensUsed.other.details) || {}
    read += Number(det.cacheReadTokens) || 0
    write += Number(det.cacheCreationTokens) || 0
  }
  if (!t.session.cacheOpt) return el('div', 'in-banner ignored', 'CACHE: off for this run (disabled in settings, or a single-message run with no pinned durable turn).')
  const snap = t.session.snapshot
  const reRendered = !!(snap && snap.trigger !== 'pinned')
  if (!read && !write) return el('div', 'in-banner error', 'CACHE: requested but the provider reported NO cache traffic at all — the option may not be reaching the provider. Investigate.')
  const parts = []
  if (reRendered) {
    parts.push('the DURABLE TURN was re-rendered this run, so it was written fresh (' + (snap ? Math.round(snap.chars / 1000) + 'k chars' : '') +
      ') — trigger: ' + (snap ? snap.trigger : '?') + '. This should happen once per refresh cycle, NOT every run: if you see it every time, the pin is not being adopted (the console says why).')
  } else {
    parts.push('the durable turn was REUSED from the pin (no re-render)')
  }
  if (read) parts.push('read ' + read.toLocaleString() + ' tokens at ~10% — the discount working')
  else parts.push('⚠ but NO read reported: the provider found no matching cached prefix')
  if (write) parts.push('wrote ' + write.toLocaleString() + ' tokens at 1.25x' + (reRendered ? '' : ' (the volatile turn only — expected each message)'))
  const cls = reRendered ? 'ignored' : (read ? 'saved' : 'error')
  return el('div', 'in-banner ' + cls, 'CACHE: ' + parts.join(' · '))
}

function renderRun ({ envs, results, err, block }) {
  const t = inspector.processor
  const list = envs || []
  const many = list.length > 1
  block.textContent = ''
  block.appendChild(el('div', 'in-run-title', 'Run ' + runCounter + ' — ' + (many
    ? list.length + ' messages in one batched call'
    : '"' + ((list[0] && list[0].subject) || '(no subject)') + '"')))
  if (!many && list[0]) {
    block.appendChild(el('div', 'in-run-sub', 'from ' + (list[0].from_address || '?') + ' · ' + fmtDate(list[0].date) + ' · msg ' + list[0].msg_id))
  }

  if (err) block.appendChild(el('div', 'in-banner error', 'Run failed: ' + (err.message || err)))

  // shared per-run parts: the system prompt, the cache verdict, every LLM exchange
  block.appendChild(detailsBlock('SYSTEM PROMPT · ' + kchars(SYSTEM_PROMPT) + ' (identical on every call)', SYSTEM_PROMPT))
  const exchanges = t.session.exchangeCapture || []
  if (exchanges.length) block.appendChild(cacheBanner(exchanges))
  exchanges.forEach((ex, i) => renderExchange(block, ex, i))

  // per-message outcome sections
  const pend = t.pendingPersist || []
  const resFor = (env) => (results || []).find(r => r && r.msg_id === env.msg_id) || null
  list.forEach((env, k) => {
    const sec = el('div', 'in-sec')
    if (many) sec.appendChild(el('div', 'in-msg-head', 'Message ' + (k + 1) + '/' + list.length + ' — "' + (env.subject || '(no subject)') + '" · from ' + (env.from_address || '?') + ' · ' + fmtDate(env.date)))
    const p = pend.find(x => x.env && x.env.msg_id === env.msg_id)
    const result = resFor(env)
    const step = p && p.stepEvent
    const errEv = p && p.errorEvent
    if (result && result.viaWorkflow) {
      sec.appendChild(el('div', 'in-banner ignored', 'SHORT-CIRCUIT: auto-filed without any LLM call (sender is on autopilot). Save records the event; Ignore discards it.'))
    } else if (result && !result.ok) {
      sec.appendChild(el('div', 'in-banner error', 'Analysis failed: ' + ((errEv && errEv.message) || result.error || 'unknown') + ' — Save records the failure event exactly as a production run would.'))
    }
    if (step) {
      sec.appendChild(el('h2', null, many ? 'What would be saved for this message' : 'What would be saved'))
      if (step.output) sec.appendChild(detailsBlock('parsed analysis output (validated JSON)', step.output))
      if (step.applied) {
        // step.applied embeds `projects: store.all()` — the ENTIRE store (hundreds of kB of
        // internal state, never sent to the model, never persisted). Show only what reconcile
        // actually DID; the store snapshot would read as a terrifying, meaningless wall.
        const a = step.applied
        const slim = {
          touched_project_ids: a.touched_project_ids,
          changes: a.changes,
          latest_delta: a.latest_delta,
          role_changes: a.role_changes,
          new_ids: a.new_ids,
          changed_ids: a.changed_ids
        }
        sec.appendChild(detailsBlock('applied to the project store (reconciled changes only — ' + ((a.changes || []).length) + ' change(s), ' + ((a.touched_project_ids || []).length) + ' project(s) touched)', slim))
      }
      if (step.profUpdates && step.profUpdates.length) sec.appendChild(detailsBlock('profile updates', step.profUpdates))
      if (step.reprofiles && step.reprofiles.length) sec.appendChild(detailsBlock('re-profiles triggered (' + step.reprofiles.length + ')', step.reprofiles))
      if (step.triggersFired && step.triggersFired.length) sec.appendChild(detailsBlock('auto-process triggers fired', step.triggersFired))
      if (step.request_profile) sec.appendChild(detailsBlock('request profile (chars per section)', step.request_profile))
      sec.appendChild(metaTable([
        ['duration', Math.round((step.duration_ms || 0) / 1000) + 's'],
        ['LLM calls', step.llm_calls || 0],
        ['fetch rounds used', step.fetchRounds || 0],
        ['tokens (this message' + (many ? '’s share of the call' : '') + ')', step.tokens ? ('in ' + (step.tokens.input || 0).toLocaleString() + ' · out ' + (step.tokens.output || 0).toLocaleString() +
          (step.tokens.cache_read ? ' · cache read ' + step.tokens.cache_read.toLocaleString() : '') +
          (step.tokens.cache_write ? ' · cache write ' + step.tokens.cache_write.toLocaleString() : '') +
          (step.tokens.thinking ? ' · thinking ' + step.tokens.thinking.toLocaleString() : '')) : '—'],
        ['cost (this message' + (many ? '’s share' : '') + ')', fmtMoney(step.cost) + (step.cost_reprofiles ? ' (of which re-profiles ' + fmtMoney(step.cost_reprofiles) + ')' : '')]
      ]))
    }
    block.appendChild(sec)
  })

  block.appendChild(metaTable([
    ['run total', fmtMoney(list.reduce((n, env) => {
      const p = pend.find(x => x.env && x.env.msg_id === env.msg_id)
      return n + ((p && p.stepEvent && p.stepEvent.cost) || 0)
    }, 0))],
    ['session total', fmtMoney(t.session.totalCost)]
  ]))

  lastRunBlock = block
  return block
}

// Live request preview — rendered the moment the request is assembled (step_pending), BEFORE the
// model has replied, so the exact outgoing bytes can be read while the call is in flight.
function renderLivePreview (host, ev) {
  host.textContent = ''
  const snap = inspector.processor.session.snapshot
  host.appendChild(el('h2', null, 'REQUEST — assembled and sent (round ' + ((ev.round || 0) + 1) + '), waiting on the model…'))
  host.appendChild(detailsBlock('SYSTEM PROMPT · ' + kchars(SYSTEM_PROMPT), SYSTEM_PROMPT))
  if (snap && snap.text) {
    host.appendChild(detailsBlock('CACHED DURABLE TURN · ' + kchars(snap.text) + ' (situation + catalog + auto-process rules)', snap.text))
  }
  host.appendChild(detailsBlock('VOLATILE BLOCK · ' + kchars(ev.userMessage) + ' (this message)', ev.userMessage || '', { open: true }))
  host.appendChild(el('div', 'in-muted', 'The reply, usage and cost will appear here when the model answers.'))
}

// ---- actions -----------------------------------------------------------------------------------

async function runNext () {
  if (running || !inspector) return
  running = true
  $('inRunBtn').disabled = true
  $('inProgress').hidden = false
  const t = inspector.processor
  t.session.exchangeCapture.length = 0
  const env = t.peekNext()
  const count = Math.max(1, parseInt(($('inCountSel') && $('inCountSel').value) || '1', 10) || 1)

  // the run block goes up IMMEDIATELY — the request preview streams into it before the reply
  runCounter++
  const block = el('div', 'in-run')
  block.appendChild(el('div', 'in-run-title', 'Run ' + runCounter + ' — ' + (count > 1
    ? 'next ' + count + ' messages (one batched call)'
    : '"' + ((env && env.subject) || '(no subject)') + '"')))
  const live = el('div', 'in-sec')
  live.appendChild(el('div', 'in-muted', 'assembling the request…'))
  block.appendChild(live)
  $('inResults').appendChild(block)
  block.scrollIntoView({ behavior: 'smooth', block: 'start' })

  let out = null
  let err = null
  try {
    out = await t.inspectNext({
      count,
      onEvent: (ev) => {
        const line = progressLine(ev)
        if (line) $('inProgress').textContent = line
        if (ev.type === 'step_pending') renderLivePreview(live, ev)
        if (ev.type === 'llm_waiting') {
          const h = live.querySelector('h2')
          const s = Math.round((ev.elapsedMs || 0) / 1000)
          if (h) h.textContent = 'REQUEST — sent, waiting on the model… ' + Math.floor(s / 60) + 'm ' + (s % 60) + 's'
        }
      }
    })
  } catch (e) {
    err = e
    console.error('[superlazy inspect] run failed', e)
  }
  $('inProgress').hidden = true
  running = false
  if (out && out.done) { block.remove(); setStatus('Queue is empty — nothing to analyse.', 'in-ok'); return }
  renderRun({ envs: (out && out.envs) || (env ? [env] : []), results: out && out.results, err, block })
  block.scrollIntoView({ behavior: 'smooth', block: 'start' })
  if (err && !(inspector.processor.pendingPersist || []).length) {
    // nothing captured to save — reload the page to retry
    setStatus('The run failed before producing anything savable. Reload the page to retry.', 'in-err')
    return
  }
  $('inDecision').hidden = false
}

async function save () {
  if (!inspector) return
  $('inSaveBtn').disabled = true
  $('inIgnoreBtn').disabled = true
  try {
    const r = await inspector.processor.commitPending({ onEvent: () => {} })
    if (lastRunBlock) {
      const banner = el('div', 'in-banner saved', 'SAVED ' + (r.saved > 1 ? r.saved + ' messages' : '') +
        ' — event(s) written, cursor advanced. ' + r.remaining + ' message(s) remaining. ')
      if (!r.done) {
        // the results STAY on this page for review — the next message opens in a FRESH tab
        // (it replans from the advanced cursor, so the two tabs never fight over state)
        const nextBtn = el('button', 'in-btn in-btn-primary', 'Next message in new tab ↗')
        nextBtn.style.marginLeft = '8px'
        nextBtn.addEventListener('click', () => {
          window.open('/apps/com.salmanff.superlazy/inspect', '_blank', 'noopener')
        })
        banner.appendChild(nextBtn)
      }
      lastRunBlock.appendChild(banner)
    }
    // pin the durable turn so the NEXT session reads the cached prefix instead of re-writing it
    await inspector.pinSnapshot()
    setStatus(r.done
      ? 'Saved. Queue is empty.'
      : 'Saved. Results are kept here for review — open the next message in a new tab (or Analyse again in this one).', 'in-ok')
    renderNext()
  } catch (e) {
    if (lastRunBlock) lastRunBlock.appendChild(el('div', 'in-banner error', 'Save failed: ' + (e.message || e)))
    setStatus('Save failed: ' + (e.message || e), 'in-err')
  }
  $('inDecision').hidden = true
  $('inSaveBtn').disabled = false
  $('inIgnoreBtn').disabled = false
}

async function ignore () {
  if (!inspector) return
  $('inSaveBtn').disabled = true
  $('inIgnoreBtn').disabled = true
  inspector.processor.discardPending()
  if (lastRunBlock) {
    lastRunBlock.classList.add('in-run-stale')
    lastRunBlock.appendChild(el('div', 'in-banner ignored', 'IGNORED — nothing saved; the cursor did not move. Kept on screen for comparison.'))
  }
  $('inDecision').hidden = true
  // the in-memory stores were mutated by the analysis — rebuild from the persisted snapshot so
  // the same message can be re-run cleanly (results above are left untouched)
  setStatus('Discarded. Rebuilding a clean state so the same message can be re-run…')
  // the provider already cached this run's durable turn — pin it before rebuilding, so the
  // re-run (and every later session) READS that prefix instead of paying another write
  await inspector.pinSnapshot()
  await initInspector({ keepResults: true })
  $('inSaveBtn').disabled = false
  $('inIgnoreBtn').disabled = false
}

async function initInspector ({ keepResults = false } = {}) {
  if (!keepResults) $('inResults').textContent = ''
  $('inNext').hidden = true
  $('inKnobs').hidden = true
  setStatus('Loading state and planning the queue…')
  const fz = typeof freezr !== 'undefined' ? freezr : null
  let insp = null
  try {
    insp = await createInspector({
      freezr: fz,
      onScan: (p) => setStatus('Scanning the mailbox… ' + ((p && p.rows) || 0) + ' rows')
    })
  } catch (e) {
    setStatus('Failed to initialise: ' + (e.message || e), 'in-err')
    return
  }
  if (insp.error) {
    setStatus(insp.error, 'in-err')
    return
  }
  inspector = insp
  setStatus('Ready. ' + inspector.plan.total + ' unprocessed message(s) in the window. Nothing is saved without your say-so — and this page only holds the mail lock while a run is in flight.', 'in-ok')
  renderKnobs()
  renderNext()
}

function init () {
  $('inRunBtn').addEventListener('click', () => runNext())
  $('inSaveBtn').addEventListener('click', save)
  $('inIgnoreBtn').addEventListener('click', ignore)
  initInspector()
}

init()
