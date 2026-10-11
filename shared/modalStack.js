// modalStack.js — the shared modal SHELL, so modals can STACK: on the Recent page an email
// viewer opens ON TOP of the project modal, which sits on top of the page. Every modal in the
// app opens through here: one overlay per level (z-index rises with depth), the ✕ and
// click-outside close only their own level, and Escape closes only the TOPMOST modal.
// The overlay carries the sl-v2 class because modals append to document.body — OUTSIDE the
// page's #app.sl-v2 container — and entity components rendered inside (project cards, task
// rows, chips) must keep the v2 identity styles.
//
// FOCUS. Opening a modal moves focus INTO it. Without that the element you clicked keeps focus
// the whole time the modal is up, which is wrong twice over: tabbing starts behind the overlay,
// and pressing Escape — a keyboard event — flips the browser into keyboard-navigation mode, so
// the trigger suddenly matches :focus-visible and paints a focus ring the moment the modal
// closes. That is what put a blue outline round a task's name after opening its modal with the
// mouse and closing it with Escape (user, 2026-08-21).

const stack = []

function onKey (e) {
  if (e.key !== 'Escape' || !stack.length) return
  e.preventDefault()
  stack[stack.length - 1].close()
}

// Open a modal shell: overlay + box + ✕. Callers append their content to `modal`.
// onClose (optional) fires once, however the modal closes (✕, click-outside, Escape, close()).
// guardOutsideClick: for modals with TEXT ENTRY (task/project/person editors) — a stray single
// click outside must not throw the user's typing away, so it only pulses the box; closing from
// outside takes a DOUBLE click (or Cancel / ✕ / Escape). (user, 2026-08-19)
// Returns { overlay, modal, close }.
export function openModalShell ({ className = '', onClose = null, guardOutsideClick = false } = {}) {
  const overlay = document.createElement('div')
  overlay.className = 'epv-modal-overlay sl-v2'
  overlay.style.zIndex = String(9000 + stack.length) // deeper levels paint higher; stays under freezr's button (10000)
  const modal = document.createElement('div')
  modal.className = ('epv-modal ' + className).trim()
  modal.tabIndex = -1 // focusable programmatically, but never a tab stop of its own

  // UNSENT TYPING: a reply composer with unsaved text marks itself .rc-dirty (replyComposer.js).
  // Closing over it — ✕, Escape, close() — asks first; a stray click outside only pulses the box.
  const holdsTyping = () => !!(modal.querySelector && modal.querySelector('.rc-dirty'))
  const pulse = () => {
    modal.classList.remove('epv-modal-attn')
    void modal.offsetWidth // restart the animation
    modal.classList.add('epv-modal-attn')
  }
  const entry = {
    close () {
      if (stack.indexOf(entry) !== -1 && holdsTyping() && !window.confirm('Discard the reply you are writing?')) return
      const i = stack.indexOf(entry)
      if (i === -1) return // already closed
      stack.splice(i, 1)
      overlay.remove()
      if (!stack.length) document.removeEventListener('keydown', onKey)
      if (onClose) { try { onClose() } catch (e) { console.error('modal onClose failed', e) } }
    }
  }

  const x = document.createElement('button')
  x.type = 'button'; x.className = 'epv-modal-x'; x.textContent = '✕'
  x.addEventListener('click', () => entry.close())
  modal.appendChild(x)

  if (guardOutsideClick) {
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return
      // pulse the box so the near-miss is acknowledged without destroying any typed text
      pulse()
    })
    overlay.addEventListener('dblclick', (e) => { if (e.target === overlay) entry.close() })
  } else {
    overlay.addEventListener('click', (e) => {
      if (e.target !== overlay) return
      if (holdsTyping()) { pulse(); return }
      entry.close()
    })
  }
  overlay.appendChild(modal)
  document.body.appendChild(overlay)
  // take focus off whatever opened this (see FOCUS above), then hand it to the modal — content
  // that wants a particular field focuses it afterwards and wins, since it runs after this.
  try {
    const trigger = document.activeElement
    if (trigger && trigger !== document.body && trigger.blur) trigger.blur()
    modal.focus({ preventScroll: true })
  } catch (e) { /* focus is best-effort — never let it stop a modal opening */ }
  if (!stack.length) document.addEventListener('keydown', onKey)
  stack.push(entry)
  return { overlay, modal, close: () => entry.close() }
}
