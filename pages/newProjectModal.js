// newProjectModal.js — the CREATE modal for a project, opened from "+ Add Project" on the
// dashboard's board tools. Deliberately the same language as the project EDIT modal (name row +
// priority dots + a blue save), but with only the two fields a project can have before it holds
// any work. Creating is the host's job (it owns the store + persistence): this module just
// collects name + priority and hands them over via onCreate, which returns the live project so
// the caller can open it straight away and start adding tasks. Text-only (textContent).

import { openModalShell } from '../shared/modalStack.js'
import { div, span, btn, el, impColor } from '../shared/renderUtils.js'

// opts: {
//   onCreate: (name, importance) => project | null   — creates + persists; returns the project
//   onCreated: (project) => void                     — fired after a successful create (host
//                                                      repaints and may open the new project)
// }
export function openNewProjectModal ({ onCreate, onCreated } = {}) {
  const { modal, close } = openModalShell({ className: 'epv-modal-wide pe-modal', onClose: null, guardOutsideClick: true })
  let draftImp = 3

  const body = div('pe-body')
  modal.appendChild(body)
  body.appendChild(div('epv-modal-title', 'New project'))
  body.appendChild(div('pe-note', 'A project is a bucket of to-dos. Name it, then add to-dos on the “+ Add” tab that opens next — incoming mail can be filed here too.'))

  const nameRow = div('pe-row')
  nameRow.appendChild(span('pe-lbl', 'Name'))
  const nameIn = el('input', 'pe-name')
  nameIn.type = 'text'
  nameIn.placeholder = 'e.g. Q3 budget review'
  nameRow.appendChild(nameIn)
  body.appendChild(nameRow)

  const prioRow = div('pe-row')
  prioRow.appendChild(span('pe-lbl', 'Priority'))
  const prio = div('pe-prio')
  const note = span('pe-note', '3/5')
  const paintPrio = () => {
    prio.textContent = ''
    for (let n = 1; n <= 5; n++) {
      const b = btn('pe-prio-btn' + (n <= draftImp ? ' on' : ''), null, () => { draftImp = n; paintPrio() })
      if (n <= draftImp) b.style.background = impColor(draftImp)
      b.title = 'Set project priority ' + n + '/5'
      prio.appendChild(b)
    }
    note.textContent = draftImp + '/5'
  }
  paintPrio()
  prioRow.appendChild(prio)
  prioRow.appendChild(note)
  body.appendChild(prioRow)

  const err = div('pe-note pe-err')
  err.style.display = 'none'
  body.appendChild(err)

  const create = () => {
    const name = nameIn.value.trim()
    if (!name) { nameIn.focus(); return }
    if (!onCreate) return
    const p = onCreate(name, draftImp)
    if (!p) { err.textContent = 'Could not create the project — reload the page and try again.'; err.style.display = ''; return }
    close()
    if (onCreated) onCreated(p)
  }
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') create() })

  const foot = div('pe-factions')
  foot.appendChild(btn('pe-tbtn', 'Cancel', () => close()))
  const mk = btn('pe-tbtn pe-tbtn-save', 'Create project', create)
  mk.title = 'Create the project and open it'
  foot.appendChild(mk)
  body.appendChild(foot)

  setTimeout(() => nameIn.focus(), 0)
  return { close }
}
