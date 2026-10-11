// projectEditor.js — the EDIT modal for one project, opened from the △ at the end of the project
// name. It is about the PROJECT ITSELF and nothing else: rename + priority (staged, applied with
// Save), the people involved as clickable chips (→ the person editor), and merging this project
// into another, and — behind a two-step confirmation — deleting it outright. It carried a second,
// thinner copy of the card's task list — selection checkboxes,
// bulk resolve, a per-task ✏️ — which was pure duplication of the card sitting right behind it,
// and is gone (user, 2026-08-21). All mutations go through the injected ops (ui.js), which record
// manual_edit events and persist through the page's manual-event listener. Text-only.

import { openModalShell } from './modalStack.js'
import { div, span, btn, el, impBadge, impColor, personChip } from './renderUtils.js'

// the people on a project = everyone who raised or must act on its to-dos (same rule as the card)
function peopleOf (project) {
  const set = new Set()
  for (const t of (project.todos || [])) {
    if (t.sender) set.add(t.sender)
    if (t.owner) set.add(t.owner);
    (t.owners || []).forEach(o => o && set.add(o))
  }
  if (!set.size) (project.participant_emails || Object.keys(project.participants || {})).forEach(e => set.add(e))
  return [...set]
}

// opts: {
//   projects: () => array of ALL live projects (merge targets — the current one is excluded),
//   nameOf: (address) => display name | null,
//   onOpenPerson: (address) => void          — person chips / owner names open the person editor
//   ops: { renameProject(project, name), setProjectImportanceTo(project, n),
//          revertProjectImportance(project) — OPTIONAL: the "(Auto)" unlock,
//          mergeProject(source, target),
//          deleteProject(project) — async, OPTIONAL: omitted (or null) and no Delete is offered },
//   onChange: () => void — fired after every applied change (host repaints)
// }
export function openProjectEditor (project, { projects, nameOf, onOpenPerson, ops, onChange } = {}) {
  const { modal, close } = openModalShell({ className: 'epv-modal-wide pe-modal', onClose: onChange, guardOutsideClick: true })
  let mergeOpen = false        // the merge-target picker only shows once the button is pressed
  let mergeQuery = ''
  // STAGED header edits — applied by the Save button, not on the fly
  let draftName = project.name || ''
  let draftSummary = project.summary || ''
  let draftImp = project.importance || 3
  let draftAuto = false // "Auto" pressed: on Save, unlock so the priority follows the to-dos again
  const autoImp = () => project.computed_importance || project.importance || 3

  const body = div('pe-body')
  modal.appendChild(body)

  const changed = () => { if (onChange) onChange() }
  const nice = (a) => (nameOf && nameOf(a)) || a

  function saveHeader () {
    const nm = draftName.trim()
    if (nm && nm !== project.name) ops.renameProject(project, nm)
    if (ops.editProjectSummary && draftSummary.trim() !== (project.summary || '')) ops.editProjectSummary(project, draftSummary)
    if (draftAuto) { if (ops.revertProjectImportance) ops.revertProjectImportance(project) } else if (draftImp !== (project.importance || 3)) ops.setProjectImportanceTo(project, draftImp)
    draftName = project.name || ''
    draftSummary = project.summary || ''
    draftImp = project.importance || 3
    draftAuto = false
    changed(); paint()
  }

  function paint () {
    body.textContent = ''

    // ---- header: name + priority (staged) + Save --------------------------------------------
    body.appendChild(div('epv-modal-title', 'Edit project'))

    const ppl = peopleOf(project)
    if (ppl.length) {
      const prow = div('pe-people')
      prow.appendChild(span('pe-lbl', 'People'))
      const chips = div('pe-people-chips')
      for (const a of ppl) {
        chips.appendChild(personChip(nice(a), onOpenPerson ? () => onOpenPerson(a) : null,
          { title: a + (onOpenPerson ? ' — edit profile & special instructions' : '') }))
      }
      prow.appendChild(chips)
      body.appendChild(prow)
    }

    const nameRow = div('pe-row')
    nameRow.appendChild(span('pe-lbl', 'Name'))
    const nameIn = el('input', 'pe-name')
    nameIn.type = 'text'; nameIn.value = draftName
    nameIn.addEventListener('input', () => { draftName = nameIn.value })
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveHeader() })
    nameRow.appendChild(nameIn)
    body.appendChild(nameRow)
    // the AI's own name, offered back when the user has overridden it (llm_name = the last
    // automated copy, stamped by reconcile — same pattern as the task llm_* baselines)
    if (project.llm_name && project.llm_name !== draftName) {
      const r = div('pe-row')
      r.appendChild(span('pe-lbl', ''))
      const b = btn('pe-restore', '↺ AI name: “' + project.llm_name + '”', () => { draftName = project.llm_name; paint() })
      b.title = 'Restore the analyzer’s own name (staged — press Save to apply)'
      r.appendChild(b)
      body.appendChild(r)
    }

    // ---- description (the project SUMMARY — the memory later analyses rely on) ---------------
    const descRow = div('pe-row pe-frow')
    descRow.appendChild(span('pe-lbl', 'Descr.'))
    const descIn = el('textarea', 'nn-body pe-desc')
    descIn.placeholder = 'One-line roll-up of where this effort stands (the AI keeps maintaining it; your edit is recorded and may be rewritten by later mail)'
    descIn.value = draftSummary
    descIn.addEventListener('input', () => { draftSummary = descIn.value })
    descRow.appendChild(descIn)
    body.appendChild(descRow)
    if (project.llm_summary && project.llm_summary !== draftSummary) {
      const r = div('pe-row')
      r.appendChild(span('pe-lbl', ''))
      const b = btn('pe-restore', '↺ AI description: “' + (project.llm_summary.length > 90 ? project.llm_summary.slice(0, 90) + '…' : project.llm_summary) + '”', () => { draftSummary = project.llm_summary; paint() })
      b.title = 'Restore the analyzer’s own description (staged — press Save to apply)'
      r.appendChild(b)
      body.appendChild(r)
    }

    const prioRow = div('pe-row')
    prioRow.appendChild(span('pe-lbl', 'Priority'))
    const prio = div('pe-prio')
    for (let n = 1; n <= 5; n++) {
      const b = btn('pe-prio-btn' + (n <= draftImp ? ' on' : ''), null, () => { draftImp = n; draftAuto = false; paint() })
      if (n <= draftImp) b.style.background = impColor(draftImp)
      b.title = 'Set project priority ' + n + '/5'
      prio.appendChild(b)
    }
    prioRow.appendChild(prio)
    const setByYou = project.importance_locked && !draftAuto
    prioRow.appendChild(span('pe-note', draftImp + '/5' + (draftAuto ? ' · auto' : setByYou ? ' · set by you' : '')))
    // (Auto): only offered while the priority is user-set — staged like everything else here
    if (project.importance_locked && ops.revertProjectImportance) {
      const ab = btn('pe-restore', draftAuto ? '(Auto ✓)' : '(Auto)', () => { draftAuto = !draftAuto; draftImp = draftAuto ? autoImp() : (project.importance || 3); paint() })
      ab.title = 'Hand the priority back to SuperLazy — it follows the top open to-do (' + autoImp() + '/5). Press Save to apply'
      prioRow.appendChild(ab)
    }
    const saveBtn = btn('pe-tbtn pe-tbtn-save', 'Save', saveHeader)
    saveBtn.title = 'Save the name, description + priority'
    prioRow.appendChild(saveBtn)
    body.appendChild(prioRow)

    // ---- merge this project into another (same picker language as the task editor's move) ----
    if (ops.mergeProject && projects) {
      const mrow = div('pe-row')
      mrow.appendChild(span('pe-lbl', 'Merge'))
      const mb = btn('pe-tbtn', mergeOpen ? 'Cancel merge ▴' : 'Merge into another project… ▾', () => { mergeOpen = !mergeOpen; mergeQuery = ''; paint() })
      mb.title = 'Move ALL to-dos and drafts into another project; this project is retired'
      mrow.appendChild(mb)
      body.appendChild(mrow)
      if (mergeOpen) {
        const pick = div('pe-movepick')
        const search = el('input', 'pe-msearch')
        search.type = 'search'
        search.placeholder = 'Find the project to merge into…'
        search.value = mergeQuery
        search.addEventListener('input', () => { mergeQuery = search.value; paintMergeList() })
        pick.appendChild(search)
        const listHost = div('pe-mplist')
        pick.appendChild(listHost)
        const paintMergeList = () => {
          listHost.textContent = ''
          const q = mergeQuery.trim().toLowerCase()
          const others = (projects() || []).filter(p => p && !p.merged_into && p.project_id !== project.project_id)
          const hits = others
            .filter(p => !q || String(p.name || '').toLowerCase().includes(q))
            .sort((a, b) => (b.importance || 0) - (a.importance || 0))
          for (const p of hits.slice(0, 8)) {
            const row = btn('pe-mprow', null, () => {
              const n = (project.todos || []).length
              if (!window.confirm('Merge “' + (project.name || 'this project') + '” into “' + (p.name || '') + '”? All ' + n + ' to-do(s) move there and this project is retired.')) return
              ops.mergeProject(project, p)
              changed()
              close()
            })
            row.appendChild(span('proj-mark'))
            row.appendChild(span('pe-mprow-name', p.name || p.project_id))
            row.appendChild(impBadge(p.importance || 3))
            listHost.appendChild(row)
          }
          if (hits.length > 8) listHost.appendChild(div('pe-note', '+ ' + (hits.length - 8) + ' more — keep typing to narrow'))
          if (!hits.length) listHost.appendChild(div('pe-note', 'No other projects to merge into.'))
        }
        paintMergeList()
        body.appendChild(pick)
        setTimeout(() => search.focus(), 0)
      }
    }

    // ---- AI re-organization (the one-project review, specs/superlazy-weekly-cleanup.md §10.2): one cheap LLM call
    // over this project's own task list proposes splits / sub-task groupings / a truer name or
    // summary — each applied only on an explicit per-proposal click in the review modal.
    if (ops.proposeReorg) {
      const rrow = div('pe-row')
      rrow.appendChild(span('pe-lbl', 'AI'))
      const rb = btn('pe-tbtn', '⚙ Review this project…', () => { close(); ops.proposeReorg(project) })
      rb.title = 'Ask the AI to review this project’s structure (split it, fold related to-dos into checklist lines, rename) — nothing changes until you apply a proposal'
      rrow.appendChild(rb)
      body.appendChild(rrow)
    }

    // (the TASKS list that used to live here is gone — user, 2026-08-21. The project card
    //  behind this modal already lists every task, in the richer shared rows, with the same task
    //  editor one click away; a second, thinner copy of the same list was pure duplication.)

    // Footer: DELETE hard left, Done hard right — opposite ends of the row, so the irreversible
    // button is nowhere near the one you press to dismiss the modal (user, 2026-09-01). Delete is
    // appended FIRST and carries margin-right:auto, which is what opens the gap between them.
    const foot = div('pe-foot')
    // DELETE — the one irreversible action here, so it is a two-step: the button arms, and only
    // the armed button (which spells out that there is no undo) actually deletes. It disarms
    // itself if left alone (user, 2026-08-31).
    if (ops.deleteProject) {
      const n = (project.todos || []).length
      const zone = div('pe-danger')
      let armed = false
      let armTimer = null
      const b = btn('pe-tbtn pe-tbtn-danger', null, async () => {
        if (!armed) {
          armed = true
          paintDel()
          armTimer = setTimeout(() => { armed = false; paintDel() }, 6000)
          return
        }
        clearTimeout(armTimer)
        b.disabled = true
        b.textContent = 'Deleting…'
        try {
          await ops.deleteProject(project)
          changed()
          close()
        } catch (e) {
          armed = false
          b.disabled = false
          paintDel()
          zone.appendChild(div('pe-note pe-danger-err', 'Could not delete: ' + ((e && e.message) || e)))
        }
      })
      const paintDel = () => {
        b.classList.toggle('armed', armed)
        b.textContent = armed
          ? '⚠ Are you sure? You cannot undo this action'
          : '🗑 Delete project'
        b.title = armed
          ? 'Click again to permanently delete “' + (project.name || 'this project') + '”' +
            (n ? ' and its ' + n + ' to-do(s)' : '') + '. This CANNOT be undone.'
          : 'Permanently delete this project' + (n ? ' and its ' + n + ' to-do(s)' : '') + ' — you will be asked to confirm'
      }
      paintDel()
      zone.appendChild(b)
      foot.appendChild(zone)
    }
    foot.appendChild(btn('pe-tbtn', 'Done', () => close()))
    body.appendChild(foot)
  }

  paint()
  return { close }
}
