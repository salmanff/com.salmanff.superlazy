// checkMailPrompt.js — background mode OFF: the "shall I check your mail?" prompt on page load.
//
// With background mode off NOTHING checks mail on its own — that is the whole point of the mode,
// and it is what makes the app calm. The risk is the opposite failure: mail quietly going stale
// for days while the dashboard looks perfectly up to date. So on load, if the last check is older
// than STALE_MAIL_PROMPT_MS, the user is asked once, explicitly, and has to press a button.
//
// It NEVER starts a check by itself — that would be the auto-run this mode exists to remove.
// Dismissing is remembered for the browser session, so navigating between pages does not re-ask.

import { STALE_MAIL_PROMPT_MS } from '../jobs/analyze_thread/config.js'

const SNOOZE_KEY = 'sl_checkmail_snoozed_until'
const SNOOZE_MS = 60 * 60e3 // "Not now" quiets it for an hour of browsing

const agoText = (ms) => {
  const n = Number(ms) || 0
  if (!n) return 'never'
  const s = Math.max(0, Math.round((Date.now() - n) / 1000))
  if (s < 5400) return Math.round(s / 60) + ' minutes ago'
  if (s < 172800) return Math.round(s / 3600) + ' hours ago'
  return Math.round(s / 86400) + ' days ago'
}

const snoozedUntil = () => {
  try { return Number(window.sessionStorage.getItem(SNOOZE_KEY)) || 0 } catch (e) { return 0 }
}
const snooze = (ms) => {
  try { window.sessionStorage.setItem(SNOOZE_KEY, String(Date.now() + ms)) } catch (e) {}
}
export const clearMailPromptSnooze = () => {
  try { window.sessionStorage.removeItem(SNOOZE_KEY) } catch (e) {}
}

export function shouldPromptForCheck ({ mode, lastCheck }) {
  if (mode !== 'off') return false
  if (Date.now() < snoozedUntil()) return false
  return (Date.now() - (Number(lastCheck) || 0)) > STALE_MAIL_PROMPT_MS
}

const div = (cls, t) => {
  const d = document.createElement('div')
  if (cls) d.className = cls
  if (t != null) d.textContent = t
  return d
}

/**
 * Show the prompt. Resolves true if the user asked for a check, false otherwise.
 * @param {Object} o
 * @param {number} o.lastCheck        settings.newmail_last_check
 * @param {boolean} o.capable         background jobs COULD run — offer turning the mode on
 * @param {Function} [o.onTurnOnBackground]  called if the user picks "turn background on instead"
 */
export function openCheckMailPrompt ({ lastCheck, capable = false, onTurnOnBackground = null } = {}) {
  return new Promise((resolve) => {
    const overlay = div('su-pmodal-overlay')
    const card = div('su-pmodal')
    let settled = false
    const close = (answer) => {
      if (settled) return
      settled = true
      overlay.remove()
      resolve(answer)
    }

    card.appendChild(div('su-pmodal-title', '📬 Check for new messages?'))
    card.appendChild(div('su-pmodal-prog',
      (Number(lastCheck)
        ? 'SuperLazy last checked your accounts ' + agoText(lastCheck) + '.'
        : 'SuperLazy hasn’t checked for new messages in this session yet.') +
      ' Background checking is off, so new mail and messages simply wait until you ask.'))
    card.appendChild(div('su-pmodal-warn',
      '⚠ Checking runs in this browser tab — please leave the page open while it works. ' +
      'You can stop it at any time.'))

    if (capable) {
      const pitch = div('su-pmodal-pitch')
      pitch.appendChild(document.createTextNode('💡 Background checking is available on this server. Turn it on and SuperLazy keeps itself up to date on its own — no tab to keep open, no interruptions. '))
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'sl-mailbtn'
      b.textContent = 'Turn background checking on'
      b.addEventListener('click', () => {
        close(false)
        if (onTurnOnBackground) onTurnOnBackground()
      })
      pitch.appendChild(b)
      card.appendChild(pitch)
    }

    const actions = div('su-pmodal-actions')
    const later = document.createElement('button')
    later.type = 'button'
    later.className = 'sl-mailbtn'
    later.textContent = 'Not now'
    later.addEventListener('click', () => { snooze(SNOOZE_MS); close(false) })

    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'su-primary'
    go.textContent = 'Check now'
    go.addEventListener('click', () => { close(true) })

    actions.appendChild(later)
    actions.appendChild(go)
    card.appendChild(actions)

    overlay.appendChild(card)
    document.body.appendChild(overlay)
    go.focus()
  })
}
