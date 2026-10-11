// agentslabUi.js — DOM rendering for the AI agents page (agentslab.html): status line,
// the repo roster and the formation-preview table. The per-turn inspection modal is
// agentslabInspect.js. No data access, no state.

import { fmtTs, effortLine } from '../jobs/analyze_thread/sessionDigest.js'

const $ = (id) => document.getElementById(id)
export const el = (tag, cls, text) => {
  const d = document.createElement(tag)
  if (cls) d.className = cls
  if (text != null) d.textContent = text
  return d
}

export function setStatus (text, kind = '') {
  const s = $('wlStatus')
  s.textContent = text
  s.className = 'wl-status' + (kind ? ' ' + kind : '')
}
export function setElapsed (ms) { $('wlElapsed').textContent = ms != null ? Math.round(ms / 1000) + 's' : '' }

// the slug is the cwd slugified — its tail is the repo folder name
export const repoLabel = (slug) => String(slug || '').split('-').filter(Boolean).slice(-3).join('-')

// ---- repo roster -------------------------------------------------------------------------------

// ---- formation preview -------------------------------------------------------------------------

const clip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n - 1) + '…' }
const tailClip = (t, n) => { t = String(t || '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : '…' + t.slice(t.length - n + 1) }

export function renderPreview (items, { openIdx, onOpen }) {
  const tb = $('wlRows')
  tb.innerHTML = ''
  $('wlTableWrap').hidden = !items.length
  items.forEach((it, i) => {
    const tr = el('tr', 'wl-row' + (openIdx === i ? ' open' : ''))
    tr.appendChild(el('td', null, fmtTs(it.date)))
    const t = el('td', 'wl-title', it.title); t.title = it.thread_id; tr.appendChild(t)
    tr.appendChild(el('td', 'wl-num', it.turn_n + '/' + it.turns_total))
    const st = el('td'); st.appendChild(el('span', 'wl-state ' + (it.context_only ? 'stale' : it.turn_state === 'ended' ? 'quiet' : 'interrupted'), it.context_only ? 'context only' : it.turn_state))
    if (it.context_only) st.title = 'older than the first-read window: the live checks keep it as thread context but do not analyse it (the dry run analyses it)'
    tr.appendChild(st)
    const { prompt, answer } = it._parts
    tr.appendChild(el('td', 'wl-title', clip(prompt, 110)))
    tr.appendChild(el('td', 'wl-title', tailClip(answer, 130)))
    const eff = el('td', 'wl-flags', effortLine(it.work_stats) + (it.turn_kind === 'question' ? ' · asks you' : '')); tr.appendChild(eff)
    tr.addEventListener('click', () => onOpen(i))
    tb.appendChild(tr)
  })
}

export function renderProjection (summary, items) {
  const chars = items.reduce((n, it) => n + String(it.body_text || '').length, 0)
  $('wlProjection').textContent = summary
    ? (items.length - (summary.contextOnly || 0)) + ' turn item(s) would be queued from ' + summary.sessions + ' session(s)' + (summary.contextOnly ? ' (+ ' + summary.contextOnly + ' older than the first-read window, stored as thread context only)' : '') +
      (summary.held ? ' · ' + summary.held + ' open turn(s) held (their sessions are still live)' : '') +
      ' · ~' + Math.round(chars / 4).toLocaleString() + ' tokens of dialogue in total (each item is analysed on its own, with its previous turn inlined)' +
      (summary.truncated ? ' · TRUNCATED by the per-run caps — the next run continues' : '') +
      (summary.errors.length ? ' · ERRORS: ' + summary.errors.map(e => e.message).join(' | ') : '') +
      ' · mode ' + JSON.stringify(summary.by_account)
    : ''
}

