// processingModal.js — the "keep this page open" modal for LIVE (in-browser) processing runs.
// While the LLM analysis runs in the browser tab, a refresh/close orphans the in-flight call and
// stops the run — so the modal (a) warns not to refresh, (b) shows live progress, (c) offers
// Recent/Events in a new window to watch along, (d) pitches the background-jobs grant when the
// user doesn't have it (a background job survives page closes), and (e) arms a beforeunload
// confirmation while a run is active. Stays up until the run finishes (then shows the summary
// with a Close button). Also exports setUnloadGuard for pages that show their own progress
// (the training view) instead of the modal.

const APP_PATH = '/apps/' + ((typeof freezrMeta !== 'undefined' && freezrMeta.appName) || 'com.salmanff.superlazy')

let overlay = null
let els = null
let unloadArmed = false

function guardUnload (e) { e.preventDefault(); e.returnValue = '' }

// Browser-native "leave site?" confirmation while a run is active.
export function setUnloadGuard (on) {
  if (!!on === unloadArmed) return
  unloadArmed = !!on
  if (on) window.addEventListener('beforeunload', guardUnload)
  else window.removeEventListener('beforeunload', guardUnload)
}

function div (cls, text) {
  const d = document.createElement('div')
  if (cls) d.className = cls
  if (text != null) d.textContent = text
  return d
}

function extLink (host, href, text) {
  const a = document.createElement('a')
  a.href = href
  a.target = '_blank'
  a.rel = 'noopener'
  a.textContent = text
  host.appendChild(a)
  return a
}

// phase: 'checking' (looking for new mail — opens instantly so there's never a no-modal window a
// user might refresh during) or 'processing' (the analysis run). Switch with setProcessingModalPhase.
export function openProcessingModal ({ kind = 'newmail', phase = 'processing', backgroundCapable = false, settingsHref = '', onStop } = {}) {
  closeProcessingModal()
  overlay = div('su-pmodal-overlay')
  const card = div('su-pmodal')

  const titleFor = (ph) => kind === 'training' ? '⏳ Building history…' : (ph === 'checking' ? '⏳ Checking for new messages…' : '⏳ Processing your new messages…')
  const title = div('su-pmodal-title', titleFor(phase))
  const prog = div('su-pmodal-prog', phase === 'checking' ? 'Looking for new messages…' : 'Preparing…')
  const latest = div('su-pmodal-latest', '')
  const bar = div('su-pmodal-bar')
  const fill = div('su-pmodal-fill')
  bar.appendChild(fill)
  card.appendChild(title)
  card.appendChild(prog)
  card.appendChild(latest)
  card.appendChild(bar)

  card.appendChild(div('su-pmodal-warn',
    '⚠ Please do NOT refresh or close this page. Processing runs in your browser — closing it stops the run. ' +
    '(It resumes safely later, but the message in flight is wasted and the restart takes a few minutes.)'))

  if (!backgroundCapable) {
    const pitch = div('su-pmodal-pitch')
    pitch.appendChild(document.createTextNode('💡 SuperLazy works better with background jobs: grant the background-jobs permission (or add a serverless key) in '))
    extLink(pitch, settingsHref || '#', 'your settings')
    pitch.appendChild(document.createTextNode(' — then processing keeps running even when this page is closed.'))
    card.appendChild(pitch)
  }

  const watch = div('su-pmodal-watch')
  watch.appendChild(document.createTextNode('You can watch results land in '))
  extLink(watch, APP_PATH + '/recent', 'Recent ↗')
  watch.appendChild(document.createTextNode(' or '))
  extLink(watch, APP_PATH + '/events', 'Events ↗')
  watch.appendChild(document.createTextNode(' (opens in a new window) while this runs.'))
  card.appendChild(watch)

  const actions = div('su-pmodal-actions')
  let stopBtn = null
  if (onStop) {
    stopBtn = document.createElement('button')
    stopBtn.type = 'button'
    stopBtn.className = 'su-danger'
    stopBtn.textContent = 'Stop processing'
    stopBtn.addEventListener('click', () => {
      stopBtn.disabled = true
      stopBtn.textContent = 'Stopping after the current message…'
      onStop()
    })
    actions.appendChild(stopBtn)
  }
  card.appendChild(actions)

  overlay.appendChild(card)
  document.body.appendChild(overlay)
  els = { title, prog, latest, fill, actions, stopBtn, titleFor }
  setUnloadGuard(true)
}

// Flip the title/language once planning finishes and real processing begins (the modal itself
// stays up — no flicker, no re-arm of the unload guard).
export function setProcessingModalPhase (phase) {
  if (!els) return
  els.title.textContent = els.titleFor(phase)
  if (phase === 'checking') els.prog.textContent = 'Looking for new messages…'
}

export function updateProcessingModal ({ done, total, cost, latest, stage } = {}) {
  if (!els) return
  if (total) {
    els.prog.textContent = done + ' / ' + total + ' message(s) · $' + Number(cost || 0).toFixed(4)
    els.fill.style.width = Math.min(100, Math.round(100 * done / total)) + '%'
  }
  // the stage narrates the silent stretches (waiting on the model, learning writing style) —
  // it wins over "latest", which only says what already finished
  if (stage) {
    els.latest.textContent = stage
  } else if (latest && latest.subject) {
    els.latest.textContent = 'latest: ' + latest.subject + (latest.from_address ? ' (' + latest.from_address + ')' : '')
  }
}

// The run ended (complete, stopped, or failed): keep the modal up with the outcome until the
// user closes it — per the design, it never silently disappears mid-story.
export function finishProcessingModal (summary, ok = true) {
  if (!els) return
  setUnloadGuard(false)
  els.title.textContent = ok ? '✓ Done' : '⚠ Stopped'
  els.prog.textContent = summary || ''
  els.latest.textContent = ''
  if (els.stopBtn) els.stopBtn.remove()
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'su-primary'
  close.textContent = 'Close'
  close.addEventListener('click', closeProcessingModal)
  els.actions.appendChild(close)
}

export function closeProcessingModal () {
  setUnloadGuard(false)
  if (overlay) overlay.remove()
  overlay = null
  els = null
}
