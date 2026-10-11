// setupUi.js — rendering for the setup (onboarding + training) page: the welcome/gate
// screens, the account picker, the current-message card, the latest-analysis card, the profile
// feed, the progress bar and the paused/done controls. The big projects board itself is rendered
// by the shared ui.js (renderProjectBoard).

import { impColor } from '../shared/renderUtils.js'
import { responsibilitiesText } from '../jobs/analyze_thread/responsibilities.js'

const el = (id) => document.getElementById(id)

const esc = (s) => String(s == null ? '' : s)

function div (cls, text) {
  const d = document.createElement('div')
  if (cls) d.className = cls
  if (text != null) d.textContent = text
  return d
}

// ---- welcome / onboarding screens -----------------------------------------------------------

// The welcome lead paragraph. parts: strings and/or { text, href } — links are real anchors.
export function setWelcomeLead (parts) {
  const host = el('welcomeLead')
  host.textContent = ''
  for (const p of parts) {
    if (typeof p === 'string') { host.appendChild(document.createTextNode(p)); continue }
    const a = document.createElement('a')
    a.href = p.href
    a.textContent = p.text
    host.appendChild(a)
  }
}

// mode 'gate': lead + one action link only. mode 'setup': the full first-run form.
export function showOnboarding (mode, { gateLinkText, gateLinkHref } = {}) {
  el('gateActions').style.display = mode === 'gate' ? '' : 'none'
  el('setupBody').style.display = mode === 'setup' ? '' : 'none'
  if (mode === 'gate' && gateLinkHref) {
    const a = el('gateLink')
    a.href = gateLinkHref
    a.textContent = gateLinkText || 'Open settings'
  }
}

// ---- account picker ---------------------------------------------------------------------

// ---- panel 1: the message being processed -------------------------------------------------

// ---- panel 2: the latest analysis (event) --------------------------------------------------

// ---- context the panel needs from the page ---------------------------------------------------

// ---- what this ONE email cost ----------------------------------------------------------------

// ---- panel 3: the profile feed (people learned + everything put on autopilot) ----------------
//
// Item shapes:
//   { address, after, reason }                      a profile the model created/updated
//   { address, disposition }                        a sender JUST learned → future mail auto-files
//   { kind: 'autofiled', address, target, subject }  a message filed WITHOUT the LLM (repeats merge)
//   { kind: 'autopilot',  address, target }          already on autopilot when this run started
//
// The last three are the ones the user must be able to COUNTER: a sender who mixes newsletters with
// real mail gets learned from the newsletter and their real mail then never reaches the model. So
// every autopilot row carries a "Don't auto-process" button. Making that visible DURING training is
// the whole point — it is the only moment the user sees the decision being made.

const feed = []
const turnedOff = new Set()   // addresses the user has just switched off (row shows the outcome)
let onAutoProcessOff = null   // (address) => Promise<boolean>
let onSetRank = null          // (address, n) => Promise<number|null> — the rank now in force
let rankOf = () => null       // (address) => { rank, manual } for the CURRENT state

// Priority 1-5, editable in place — the same manual_rank the People page sets, and the same
// "click the value again to clear it" behaviour. Being able to fix a person's priority while
// watching them be learned is the point: this is the moment the user disagrees with the model.
// The colours come from the shared importance scale (renderUtils.IMP_COLORS, mirrored in
// tokens.css --imp-1..5) — a rank button here must read the same as the same rank everywhere else.
function rankControl (address) {
  const cur = rankOf(address) || {}
  const rank = Number(cur.rank) || 0
  const wrap = div('su-rank')
  wrap.appendChild(div('su-rank-lbl', 'priority'))
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'su-rank-btn' + (n <= rank ? ' on' : '')
    if (n <= rank) b.style.background = impColor(rank)
    b.textContent = String(n)
    b.title = cur.manual
      ? 'You set ' + rank + '/5 — click ' + n + ' to change, or ' + rank + ' again to go back to the AI’s estimate'
      : 'The AI estimates ' + (rank || '?') + '/5 — click to set your own'
    b.addEventListener('click', async () => {
      if (!onSetRank) return
      wrap.classList.add('su-rank-busy')
      await onSetRank(address, n)
      renderProfileFeed()
    })
    wrap.appendChild(b)
  }
  wrap.appendChild(div('su-rank-note', cur.manual ? 'set by you' : 'AI estimate'))
  return wrap
}

const isAutopilot = (it) => !!(it.disposition || it.kind === 'autofiled' || it.kind === 'autopilot')

function autopilotControls (it) {
  const wrap = div('su-profile-auto')
  if (turnedOff.has(it.address)) {
    wrap.appendChild(div('su-profile-off', '✓ Auto-processing OFF — every future message from them is analysed.'))
    return wrap
  }
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'su-profile-offbtn'
  btn.textContent = 'Don’t auto-process this sender'
  btn.addEventListener('click', async () => {
    if (!onAutoProcessOff) return
    btn.disabled = true
    btn.textContent = 'switching off…'
    const ok = await onAutoProcessOff(it.address)
    if (ok) { turnedOff.add(it.address); renderProfileFeed() } else { btn.disabled = false; btn.textContent = 'Don’t auto-process this sender' }
  })
  wrap.appendChild(btn)
  return wrap
}

function renderProfileFeed () {
  const host = el('panelProfiles')
  host.textContent = ''
  if (!feed.length) { host.appendChild(div('su-muted', 'People and auto-filing decisions appear here as messages are analysed.')); return }
  for (const it of feed.slice(-30).reverse()) {
    const auto = isAutopilot(it)
    const row = div('su-profile' + (auto ? ' su-profile-autorow' : ''))
    const head = div('su-profile-head')
    head.appendChild(div('su-profile-addr', esc(it.address)))
    if (auto) head.appendChild(div('su-profile-chip', turnedOff.has(it.address) ? 'off' : 'auto-processed'))
    row.appendChild(head)

    const bits = []
    if (it.after && it.after.relationship && it.after.relationship !== 'unknown') bits.push(it.after.relationship)
    if (it.after && it.after.llm_importance != null) bits.push('imp ' + it.after.llm_importance)
    const respText = it.after && responsibilitiesText(it.after)
    if (respText) bits.push('handles: ' + respText)
    if (it.disposition) bits.push('just learned as “' + it.disposition + '” — their future mail is filed without being read by the AI')
    if (it.kind === 'autopilot') bits.push('already on autopilot' + (it.target ? ' → “' + it.target + '”' : '') + ' — their mail is filed without being read by the AI')
    if (it.kind === 'autofiled') {
      bits.push((it.n > 1 ? it.n + ' messages' : '1 message') + ' filed automatically' +
        (it.target ? ' → “' + it.target + '”' : '') + ' — not read by the AI')
    }
    row.appendChild(div('su-muted small', bits.join(' · ') || (it.after && it.after.summary) || ''))
    if (it.kind === 'autofiled' && it.subject) row.appendChild(div('su-profile-why small', 'latest: ' + esc(it.subject)))
    if (it.reason) row.appendChild(div('su-profile-why small', esc(it.reason)))
    const actions = div('su-profile-actions')
    if (onSetRank) actions.appendChild(rankControl(it.address))
    if (auto) actions.appendChild(autopilotControls(it))
    if (actions.children.length) row.appendChild(actions)
    host.appendChild(row)
  }
}

// ---- progress + controls --------------------------------------------------------------------

// Views: 'welcome' (onboarding), 'status' (tabs, training complete), 'progress' (live training).
// Any view choice dismisses the initial page-loading spinner.
export function showView (name) {
  const loading = el('pageLoading')
  if (loading) loading.style.display = 'none'
  el('welcomeView').style.display = name === 'welcome' ? '' : 'none'
  el('statusView').style.display = name === 'status' ? '' : 'none'
  el('progressView').style.display = name === 'progress' ? '' : 'none'
}

export function showTab (which) {
  // the Channels tab is gone (2026-09-09): Slack and agent-session setup live in each source's
  // detail on the Status tab
  if (which === 'channels') which = 'status'
  el('tabStatus').style.display = which === 'status' ? '' : 'none'
  el('tabRules').style.display = which === 'rules' ? '' : 'none'
  el('tabConnected').style.display = which === 'connected' ? '' : 'none'
  el('tabPrefs').style.display = which === 'prefs' ? '' : 'none'
  el('tabStatusBtn').classList.toggle('active', which === 'status')
  el('tabRulesBtn').classList.toggle('active', which === 'rules')
  el('tabConnectedBtn').classList.toggle('active', which === 'connected')
  el('tabPrefsBtn').classList.toggle('active', which === 'prefs')
}

