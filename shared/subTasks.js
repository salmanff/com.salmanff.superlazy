// subTasks.js — very light sub-tasks INSIDE a task, stored as checklist lines in the plain-text
// description (no schema change, no new records — user, 2026-08-24). One construct only:
//   - [ ] not done       - [x] done       - bare bullet (counts as not done)
// Flat by design — no indenting, no nesting, no other markdown. The description string stays the
// single source of truth: ticking a box rewrites its ONE line and persists through the normal
// editTodo path. Rendering is textContent-only DOM building — a description derives from email
// content via the LLM and must never be innerHTML'd.

const ITEM_RE = /^-\s+(?:\[( |x|X)\]\s*)?(.*)$/

// description → [{ raw, item, done, text }] — one entry per line, in order (index = line number)
export function parseSubTasks (description) {
  return String(description || '').split(/\r?\n/).map(raw => {
    const m = raw.trim().match(ITEM_RE)
    if (!m) return { raw, item: false, done: false, text: raw }
    return { raw, item: true, done: (m[1] || '').toLowerCase() === 'x', text: m[2] || '' }
  })
}

// how many checklist items, how many done — { total: 0 } means "no checklist here"
export function subTaskStats (description) {
  const items = parseSubTasks(description).filter(l => l.item)
  return { total: items.length, done: items.filter(l => l.done).length }
}

// flip line `idx` between not-done and done; returns the NEW description string (or the old one
// untouched when idx isn't a checklist line). A bare "- text" bullet ticks into "- [x] text".
export function toggleSubTask (description, idx) {
  const lines = String(description || '').split(/\r?\n/)
  const raw = lines[idx]
  if (raw == null) return description
  const m = raw.trim().match(ITEM_RE)
  if (!m) return description
  const done = (m[1] || '').toLowerCase() === 'x'
  const indent = raw.slice(0, raw.indexOf('-'))
  lines[idx] = indent + '- [' + (done ? ' ' : 'x') + '] ' + (m[2] || '')
  return lines.join('\n')
}

// The description as DOM: plain lines as text, checklist lines as rows whose checkbox appears on
// hover (CSS .subd-check) and whose text goes grey + struck when done. onToggle(lineIdx) makes
// the boxes live; without it they render as read-only state (frozen snapshots, styleguide).
export function renderDescriptionEl (description, { onToggle } = {}) {
  const wrap = document.createElement('div'); wrap.className = 'subd'
  parseSubTasks(description).forEach((l, idx) => {
    if (!l.item) {
      if (!l.raw.trim()) return // blank separator lines add nothing to the rendered block
      const t = document.createElement('div'); t.className = 'subd-text'; t.textContent = l.raw
      wrap.appendChild(t)
      return
    }
    const row = document.createElement('div'); row.className = 'subd-item' + (l.done ? ' done' : '')
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'subd-check'
    cb.checked = l.done
    cb.title = l.done ? 'Reopen this checklist line' : 'Mark this checklist line done'
    if (onToggle) {
      // the row updates ITSELF (class flip on the existing nodes) rather than being rebuilt:
      // removing the hovered checkbox from the DOM makes Chrome fire mouseleave on the ancestors,
      // which slammed the slide-open panel shut on every tick (user, 2026-08-24)
      cb.addEventListener('click', (e) => {
        e.stopPropagation()
        const nowDone = cb.checked // the click already flipped the input
        row.classList.toggle('done', nowDone)
        cb.title = nowDone ? 'Reopen this checklist line' : 'Mark this checklist line done'
        onToggle(idx)
      })
    } else cb.disabled = true
    row.appendChild(cb)
    const tx = document.createElement('span'); tx.className = 'subd-itemtext'; tx.textContent = l.text || '(blank)'
    row.appendChild(tx)
    wrap.appendChild(row)
  })
  return wrap
}

// Textarea nicety for wherever descriptions are TYPED (task editor / add form): Enter on a
// checklist line continues the list with a fresh "- [ ] " (or plain "- " if that's what the line
// used); Enter on an EMPTY bullet deletes it instead — the standard way out of a list.
export function wireBulletContinuation (textarea) {
  textarea.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
    const v = textarea.value
    const at = textarea.selectionStart
    if (at !== textarea.selectionEnd) return
    const lineStart = v.lastIndexOf('\n', at - 1) + 1
    const line = v.slice(lineStart, at)
    const m = line.match(/^-\s+(\[( |x|X)\]\s*)?/)
    if (!m) return
    e.preventDefault()
    const emptyBullet = line.trim().replace(/\[( |x|X)\]/, '').replace(/^-\s*/, '') === ''
    if (emptyBullet) {
      // exit the list: the bullet prefix goes, the line becomes blank
      textarea.setRangeText('', lineStart, at, 'start')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      return
    }
    const cont = '\n- ' + (m[1] ? '[ ] ' : '')
    textarea.setRangeText(cont, at, at, 'end')
    textarea.dispatchEvent(new Event('input', { bubbles: true })) // hosts with input listeners stay in sync
  })
}
