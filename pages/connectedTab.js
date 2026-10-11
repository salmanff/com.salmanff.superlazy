// connectedTab.js — the "Connected apps" tab on Setup & Prefs: the approval + oversight surface
// for INTER-APP SUBSCRIPTIONS (specs/interapp-subscriptions.md). Shows each requesting app's
// identity (server-verified message sender), its prompt VERBATIM, and what it asked to receive;
// nothing is ever delivered until the user approves here. Data layer: subscriptionsData.js.

import {
  intakeRequests, listSubscriptions, approveSubscription, denySubscription,
  pauseSubscription, resumeSubscription, revokeSubscription, derivePrefilter,
  flushDeliveries, deliveredCount, updatePrefilter
} from './subscriptionsData.js'

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const STATUS_LABEL = {
  pending: 'Waiting for your approval',
  active: 'Active',
  paused: 'Paused',
  denied: 'Denied',
  revoked: 'Revoked',
  cancelled: 'Cancelled by the app'
}

function pill (status) {
  const tone = status === 'active' ? '#1a7f37' : (status === 'pending' ? '#b45309' : '#6b7280')
  return '<span style="display:inline-block;padding:2px 10px;border-radius:10px;font-size:12px;color:#fff;background:' + tone + '">' +
    esc(STATUS_LABEL[status] || status) + '</span>'
}

// The pre-filter editor — shown on pending AND active/paused cards. This is SUPERLAZY'S dial,
// not the requester's: a hit forces a closer AI read even for auto-filed senders, so it trades
// AI cost for coverage. Editing it never needs the requester's re-approval.
function pfEditorHtml (pf) {
  const p = pf || {}
  return '<div class="su-onboard-block" style="background:rgba(127,127,127,.06);padding:8px;border-radius:6px">' +
    '<p class="small" style="margin:0 0 6px"><b>Pre-filter</b> (yours to tune — matching mail gets a full AI read ' +
      'even from senders that are normally auto-filed without one; empty = only mail the AI already reads is checked, ' +
      'so auto-filed senders may be missed):</p>' +
    '<label class="small">Subject keywords (comma-separated)<br>' +
      '<input type="text" data-role="kw" style="width:100%" value="' + esc((p.subject_keywords || []).join(', ')) + '"></label>' +
    '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px">' +
      '<label class="small">Attachment types (e.g. pdf)<br>' +
        '<input type="text" data-role="att" style="width:160px" value="' + esc((p.attachment_types || []).join(', ')) + '"></label>' +
      '<label class="small">Sender domains<br>' +
        '<input type="text" data-role="dom" style="width:200px" value="' + esc((p.from_domains || []).join(', ')) + '"></label>' +
      '<label class="small" style="align-self:end"><input type="checkbox" data-role="anyatt"' + (p.has_attachments ? ' checked' : '') + '> any attachment counts</label>' +
    '</div>' +
  '</div>'
}

function collectPrefilter (card) {
  const list = (role) => String((card.querySelector('[data-role="' + role + '"]') || {}).value || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  const anyatt = card.querySelector('[data-role="anyatt"]')
  return {
    subject_keywords: list('kw'),
    attachment_types: list('att').map(s => s.replace(/^\./, '')),
    from_domains: list('dom'),
    has_attachments: !!(anyatt && anyatt.checked)
  }
}

function fillPrefilter (card, pf) {
  const set = (role, v) => { const el = card.querySelector('[data-role="' + role + '"]'); if (el) el.value = v }
  set('kw', (pf.subject_keywords || []).join(', '))
  set('att', (pf.attachment_types || []).join(', '))
  set('dom', (pf.from_domains || []).join(', '))
  const anyatt = card.querySelector('[data-role="anyatt"]')
  if (anyatt) anyatt.checked = pf.has_attachments === true
}

function cardHtml (sub, delivered) {
  const wants = sub.include_original
    ? '<b>the AI’s answer PLUS the original email and its attachments</b>'
    : 'the AI’s answer only (no original email)'
  const editable = sub.status === 'pending' || sub.status === 'active' || sub.status === 'paused'
  const pendingControls =
    '<div class="su-status-tools" style="flex-wrap:wrap;gap:8px">' +
      '<button type="button" class="su-secondary" data-act="suggest">Suggest pre-filter</button>' +
      '<button type="button" class="su-primary" data-act="approve">Approve</button>' +
      '<button type="button" class="su-danger" data-act="deny">Deny</button>' +
    '</div>'
  const activeControls =
    '<div class="su-status-tools" style="flex-wrap:wrap;gap:8px">' +
      '<button type="button" class="su-secondary" data-act="savepf">Save pre-filter</button>' +
      '<span data-role="pfsaved" class="su-muted small"></span>' +
      '<button type="button" class="su-secondary" data-act="pause" style="margin-left:auto">Pause</button>' +
      '<button type="button" class="su-danger" data-act="revoke">Revoke</button>' +
    '</div>'
  const pausedControls =
    '<div class="su-status-tools" style="flex-wrap:wrap;gap:8px">' +
      '<button type="button" class="su-secondary" data-act="savepf">Save pre-filter</button>' +
      '<span data-role="pfsaved" class="su-muted small"></span>' +
      '<button type="button" class="su-primary" data-act="resume" style="margin-left:auto">Resume</button>' +
      '<button type="button" class="su-danger" data-act="revoke">Revoke</button>' +
    '</div>'
  return '<div class="su-onboard-block" data-sub="' + esc(sub.sub_id) + '" style="margin-bottom:14px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">' +
      '<b>' + esc(sub.label || sub.requester_app) + '</b>' + pill(sub.status) +
    '</div>' +
    '<div class="su-muted small">from app: <code>' + esc(sub.requester_app) + '</code>' +
      (sub.status === 'active' ? ' · delivered: ' + delivered : '') + '</div>' +
    (sub.status_reason ? '<div class="su-muted small">' + esc(sub.status_reason) + '</div>' : '') +
    '<p class="small" style="margin:8px 0 4px"><b>Its exact request</b> (this text is sent to the AI with every matching check):</p>' +
    '<pre style="white-space:pre-wrap;background:rgba(127,127,127,.08);padding:8px;border-radius:6px;font-size:12px">' + esc(sub.prompt) + '</pre>' +
    '<p class="small">If a message matches, superlazy sends that app ' + wants + '.</p>' +
    (editable ? pfEditorHtml(sub.prefilter) : '') +
    (sub.status === 'pending' ? pendingControls : sub.status === 'active' ? activeControls : sub.status === 'paused' ? pausedControls : '') +
  '</div>'
}

export async function renderConnectedTab (container) {
  if (!container) return
  container.innerHTML = '<p class="su-muted"><span class="freezr-spinner"></span> Checking for app requests…</p>'
  let intake = null
  let flush = null
  try { intake = await intakeRequests() } catch (e) { console.warn('[superlazy] intake failed:', e) }
  try { flush = await flushDeliveries() } catch (e) { console.warn('[superlazy] flush failed:', e) }

  let subs = []
  try { subs = await listSubscriptions() } catch (e) {
    container.innerHTML = '<p class="su-muted">Could not load subscriptions: ' + esc((e && e.message) || e) + '</p>'
    return
  }

  const counts = {}
  for (const s of subs) counts[s.sub_id] = s.status === 'active' ? await deliveredCount(s.sub_id) : 0

  const head = '<h2>Connected apps</h2>' +
    '<p class="su-muted">Other apps on your freezr can ask superlazy to forward them emails matching a request ' +
    '(for example an invoice app asking for all invoices). Each request needs your approval here, is checked by ' +
    'the AI during normal mail processing, and can be paused or revoked at any time.</p>' +
    (flush && (flush.sent || flush.pending)
      ? '<p class="su-muted small">Deliveries: ' + flush.sent + ' sent just now' +
        (flush.failed ? ', ' + flush.failed + ' failed (will retry)' : '') +
        (flush.dropped ? ', ' + flush.dropped + ' dropped' : '') + '.</p>'
      : '')

  if (!subs.length) {
    container.innerHTML = head + '<p class="su-muted">No app requests yet' +
      (intake ? ' (checked ' + intake.seen + ' inbox message(s))' : '') + '.</p>'
    return
  }

  container.innerHTML = head + subs.map(s => cardHtml(s, counts[s.sub_id] || 0)).join('')

  for (const card of container.querySelectorAll('[data-sub]')) {
    const sub = subs.find(s => s.sub_id === card.dataset.sub)
    if (!sub) continue
    card.addEventListener('click', async (ev) => {
      const act = ev.target && ev.target.dataset && ev.target.dataset.act
      if (!act) return
      ev.target.disabled = true
      try {
        if (act === 'suggest') {
          ev.target.textContent = 'Deriving…'
          const pf = await derivePrefilter(sub.prompt)
          fillPrefilter(card, pf)
          ev.target.textContent = 'Suggest pre-filter'
          ev.target.disabled = false
          return
        }
        if (act === 'savepf') {
          await updatePrefilter(sub, collectPrefilter(card))
          const note = card.querySelector('[data-role="pfsaved"]')
          if (note) note.textContent = 'saved — applies from the next mail check'
          ev.target.disabled = false
          return
        }
        if (act === 'approve') {
          await approveSubscription(sub, collectPrefilter(card))
        }
        if (act === 'deny') await denySubscription(sub, 'denied by you')
        if (act === 'pause') await pauseSubscription(sub)
        if (act === 'resume') await resumeSubscription(sub)
        if (act === 'revoke') {
          if (!window.confirm('Revoke this subscription? ' + (sub.requester_app) + ' stops receiving matches. Already-delivered items are not taken back.')) {
            ev.target.disabled = false
            return
          }
          await revokeSubscription(sub)
        }
        await renderConnectedTab(container) // re-render with fresh state
      } catch (e) {
        ev.target.disabled = false
        window.alert('That did not work: ' + ((e && e.message) || e))
      }
    })
  }
}
