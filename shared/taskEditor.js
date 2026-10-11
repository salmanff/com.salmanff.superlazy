// taskEditor.js — the EDIT modal for ONE task, opened from the ▸ on any task row. Staged
// fields with an explicit Save: task name, details, due date, and the project it lives in —
// a searchable picker (same look as the old project-editor move) that can also create a brand
// new project. Mutations flow through the injected ui.js ops (editTodo / moveTodo /
// createProject), which record manual_edit events; persistence runs through the page's
// manual-event listener like every other edit. Text-only (textContent).
//
// Below the Save/Cancel row it shows the task's HISTORY — the whole todo.evidence trail, newest
// first (the buttons sit ABOVE it: the trail can run long, and Save must never be off-screen). It needs NO query: evidence travels on the project record. Entries backed by an email
// open THAT message in the shared thread viewer, so "why did it decide that?" is one click from
// "what changed". The Priority row carries the revert-to-SuperLazy's-reading offer, beside the
// "set by you" note that says the override is in force.

import { openModalShell } from './modalStack.js'
import {
  div, span, btn, el, impBadge, impColor, fmtDateTime,
  evidenceTrailOf, evidenceSummary, kindDisc
} from './renderUtils.js'
import { resolveDueRange, todayIso, effImportance } from '../jobs/analyze_thread/dueDates.js'
import { createDueField } from './dueField.js'
import { openEmailViewer, emailViewerReady } from './emailViewer.js'
import { wireBulletContinuation } from './subTasks.js'

// opts: {
//   projects: () => array of ALL live projects (move targets — the current one is excluded),
//   self: [your addresses] — never guessed as the Who counterpart,
//   people: () => [{ address, name }] — known people, for the Who field's autocomplete,
//   ops: { editTodo(project, todo, fields), moveTodo(sourceProject, targetProject, todo),
//          createProject(name) => project | null },
//   onChange: () => void — fired after Save (host repaints)
// }
export function openTaskEditor (todo, project, { projects, self, people, ops, onChange } = {}) {
  const { modal, close } = openModalShell({ className: 'te-modal', guardOutsideClick: true })
  let draftShort = todo.short_description || ''
  let draftDesc = todo.description || ''
  let draftDue = todo.due_hint || ''
  let draftDir = todo.direction || 'read_only'
  let draftImp = Number(todo.importance) || 3
  let draftDemote = Math.max(0, Math.min(3, Number(todo.due_demote) || 0)) // "lower until due" hold
  let target = null // staged destination: a live project, or { create: name }
  let pickerOpen = false // the project list only shows after "Move project…" is pressed
  let pickQuery = ''

  // the person slot the current direction reads from — joint owners show comma-separated
  const whoOf = (dir) => (dir === 'i_owe_them')
    ? (todo.counterparty || '')
    : ((dir === 'they_owe_me' || dir === 'team_owes')
        ? ((todo.owners && todo.owners.length > 1) ? todo.owners.join(', ') : (todo.owner || ''))
        : '')
  // best guess at the counterpart: the message SENDER — or, when you sent it (sender is you),
  // the counterparty slot, which holds who you wrote to; evidence actors as a last resort
  const selfSet = new Set((self || []).map(a => String(a).toLowerCase()))
  const isSelf = (a) => { const s = String(a || '').toLowerCase(); return !s || s === 'you' || selfSet.has(s) }
  const guessWho = () => {
    const cands = [todo.sender, todo.counterparty, todo.owner, ...(todo.evidence || []).map(e => e.who).reverse()]
    for (const c of cands) if (!isSelf(c)) return c
    return ''
  }
  // display names for history actors — same source as the Who autocomplete
  const nameOf = (addr) => {
    const a = String(addr || '').toLowerCase()
    const hit = ((people && people()) || []).find(p => String(p.address || '').toLowerCase() === a)
    return (hit && hit.name) || addr
  }
  let draftWho = whoOf(draftDir)
  let whoTouched = false // once you type in Who, direction changes stop overwriting it
  let carriedWho = draftWho // the last non-empty Who — survives a hop through read_only

  // the machine window behind the due text — kept current while typing (debounced, with a
  // loader) so the user can SEE the interpreted dates; anchored to NOW, not any email date.
  // The control itself is dueField.js, shared with the project card's "+ Add" tab; these mirror
  // its state so save() (and the priority row's until-due hold) can read it.
  let draftDueRange = { earliest: todo.due_earliest || null, latest: todo.due_latest || null }
  let dueField = null // the live control, rebuilt by every paint()

  const body = div('te-body')
  modal.appendChild(body)

  let saving = false
  async function save () {
    if (saving) return
    saving = true
    const fields = {
      short_description: draftShort.trim() || todo.short_description,
      description: draftDesc.trim(),
      due_hint: draftDue.trim() || null,
      direction: draftDir,
      importance: draftImp, // unchanged values are skipped by editTodo; a change locks it as yours
      due_demote: draftDemote || null // "lower until due" hold — user-only, the model never sets it
    }
    // a changed due text carries its machine window along — the live preview usually resolved
    // it already; otherwise (saved before the debounce fired) resolve now
    if (fields.due_hint !== (todo.due_hint || null)) {
      const r = (dueField && dueField.isResolved())
        ? draftDueRange
        : (fields.due_hint ? await resolveDueRange(fields.due_hint) : { earliest: null, latest: null })
      fields.due_earliest = r.earliest
      fields.due_latest = r.latest
    }
    // the Who lands in the slot the chosen direction reads from. Comma-separated = several
    // people jointly (stored owner = first, owners = the full list, like the analyser writes);
    // blank = unassigned (both slots cleared).
    const whoList = draftWho.split(',').map(s => s.trim()).filter(Boolean)
    if (draftDir === 'i_owe_them') {
      fields.counterparty = whoList.join(', ') || null
    } else if (draftDir === 'they_owe_me' || draftDir === 'team_owes') {
      fields.owner = whoList[0] || null
      fields.owners = whoList.length > 1 ? whoList : []
    }
    // a direction change also resets the slot the OLD direction used, to whoMapping.js's shape —
    // otherwise the old list lingers there and comes back as extra people on the next read
    if (draftDir !== (todo.direction || 'read_only')) {
      const me = (self && self[0]) || null
      if (draftDir === 'i_owe_them') { fields.owner = me; fields.owners = [] }
      if (draftDir === 'they_owe_me') fields.counterparty = me
      if (draftDir === 'team_owes') fields.counterparty = null
    }
    ops.editTodo(project, todo, fields)
    if (target) {
      const dest = target.create ? ops.createProject(target.create) : target
      if (dest && dest !== project) ops.moveTodo(project, dest, todo)
    }
    if (onChange) onChange()
    close()
  }

  function field (label, input) {
    const row = div('pe-row')
    row.appendChild(span('pe-lbl', label))
    row.appendChild(input)
    return row
  }

  function paint () {
    body.textContent = ''
    body.appendChild(div('epv-modal-title', 'Edit to-do'))

    const shortIn = el('input', 'pe-name')
    shortIn.type = 'text'; shortIn.value = draftShort
    shortIn.placeholder = 'What needs to happen'
    shortIn.addEventListener('input', () => { draftShort = shortIn.value })
    shortIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') save() })
    body.appendChild(field('To-do', shortIn))

    const descIn = el('textarea', 'te-desc')
    descIn.rows = 3; descIn.value = draftDesc
    descIn.placeholder = 'Details (optional) — start a line with "- " for checklist lines'
    descIn.addEventListener('input', () => { draftDesc = descIn.value })
    wireBulletContinuation(descIn) // Enter continues a "- [ ]" list; Enter on an empty bullet exits it
    // grows to fit its content (sub-task lists make descriptions taller than 3 rows now) — same
    // scrollHeight trick as the add tab's task box, capped so a huge paste still scrolls
    const growDesc = () => {
      descIn.style.height = 'auto'
      descIn.style.height = Math.min(descIn.scrollHeight + 2, 420) + 'px'
    }
    descIn.addEventListener('input', growDesc)
    setTimeout(growDesc, 0) // after it's in the DOM — scrollHeight is 0 before mount
    body.appendChild(field('Details', descIn))

    // repaints just the bits of the Priority row that depend on the DUE WINDOW (the half-tone
    // held-back circles and the ⏲ hold's live/inert state) — assigned once that row is built,
    // so the due control can call it the moment the interpreted dates change
    let paintPrioHold = () => {}

    // the shared due control (dueField.js): half-width box + asap / today / tomorrow / next wk
    // quick-fills, with the interpreted window in small print under it. The "+ Add" tab on a
    // project card renders the exact same thing.
    dueField = createDueField({
      value: draftDue,
      range: draftDueRange,
      onRangeChange: (r) => {
        draftDue = dueField.getText()
        draftDueRange = r
        paintPrioHold() // the until-due hold goes live/inert with the date
      }
    })
    dueField.input.addEventListener('input', () => { draftDue = dueField.input.value })
    body.appendChild(field('Due', dueField.wrap))
    body.appendChild(dueField.note)

    // priority 1–5 (staged) — same dot-button language as the project editor's header row.
    // With an until-due hold active, the EFFECTIVE priority fills solid and the held-back
    // circle(s) render half-tone — the "4 that acts as a 3" reads at a glance (user, 2026-08-27)
    const notYetDue = () => { const ref = draftDueRange.earliest || draftDueRange.latest; return !!ref && ref > todayIso() }
    const prio = div('pe-prio')
    const prioBtns = []
    for (let n = 1; n <= 5; n++) {
      const b = btn('pe-prio-btn', null, () => { draftImp = n; paint() })
      prio.appendChild(b)
      prioBtns.push(b)
    }
    const prioWrap = div('te-prio-wrap')
    prioWrap.appendChild(prio)
    const machineImp = Number(todo.llm_importance) || null
    prioWrap.appendChild(span('pe-note', draftImp + '/5' + (todo.importance_locked ? ' · set by you' : '')))
    // "decrease priority before due date": cycles −1 → −2 → −3 → off (user, 2026-08-27). The
    // hold only bites while the due window starts in the future (dueDates.effImportance), so
    // it shows inert without one.
    const dmB = btn('te-demote', null, () => { draftDemote = (draftDemote + 1) % 4; paintPrioHold() })
    prioWrap.appendChild(dmB)
    paintPrioHold = () => {
      const effN = Math.max(1, draftImp - ((draftDemote && notYetDue()) ? draftDemote : 0))
      prioBtns.forEach((b, i) => {
        const n = i + 1
        const half = n > effN && n <= draftImp
        b.className = 'pe-prio-btn' + (n <= draftImp ? ' on' : '') + (half ? ' pe-prio-half' : '')
        b.style.background = n <= draftImp ? impColor(draftImp) : ''
        b.title = half ? ('Set priority ' + n + '/5 — currently held down until due') : ('Set priority ' + n + '/5')
      })
      dmB.className = 'te-demote' + (draftDemote ? ' on' : '') + (draftDemote && !notYetDue() ? ' inert' : '')
      dmB.textContent = '⏲ ' + (draftDemote ? '−' + draftDemote + ' until due' : 'lower until due')
      dmB.title = 'Treat this to-do as ' + (draftDemote ? (draftDemote + ' lower') : 'lower priority') +
        ' until its due date arrives — click to cycle −1 / −2 / −3 / off' +
        (notYetDue() ? '' : ' (takes effect only while a future due date is set)')
    }
    paintPrioHold()
    // HANDING IT BACK — ONE action, ONE phrasing: release the lock AND restore what SuperLazy
    // worked out, in one go. Offered only while the user's override is actually in force. The
    // number is appended when we have it (llm_importance, stamped by reconcile). A HAND-ADDED
    // task is importance_locked with no machine reading and always will be, so the numberless
    // form stays: it releases the lock and lets the model price the task on its next read.
    if (todo.importance_locked && ops && ops.revertImportance) {
      const machine = machineImp
      const known = machine && machine !== todo.importance
      const rv = btn('te-revert', '↩ revert to automated priority' + (known ? ' ' + machine : ''), () => {
        ops.revertImportance(project, todo)
        draftImp = todo.importance
        paint()
        if (onChange) onChange()
      })
      rv.title = known
        ? 'Drop your override and put this back to the ' + machine + '/5 SuperLazy worked out, so it keeps it up to date'
        : 'Drop your override so SuperLazy sets this priority again. It has no stored reading for this to-do yet, so the NUMBER STAYS AS IT IS until the next analysis reads this to-do'
      prioWrap.appendChild(rv)
    }
    body.appendChild(field('Priority', prioWrap))

    // who-owes bucket — turn a read item into an I-owe, hand it to the team, etc.
    const dirSel = el('select', 'te-dir')
    for (const d of [
      { key: 'i_owe_them', label: 'I owe — my to-dos' },
      { key: 'they_owe_me', label: '📥 Owed to me' },
      { key: 'team_owes', label: '👥 Team owes' },
      { key: 'read_only', label: '📖 To read / FYI' }
    ]) {
      const o = el('option', null, d.label)
      o.value = d.key
      if (d.key === draftDir) o.selected = true
      dirSel.appendChild(o)
    }
    body.appendChild(field('Ownership', dirSel))

    // WHO the direction points at — changing Ownership re-guesses it (message sender, or the
    // recipient when you sent it) until you type your own value. Blank = unassigned; several
    // people go comma-separated. Known people autocomplete after two typed letters.
    const whoIn = el('input', 'pe-name')
    whoIn.type = 'text'
    whoIn.autocomplete = 'off'
    const whoState = () => {
      whoIn.disabled = draftDir === 'read_only'
      whoIn.placeholder = draftDir === 'read_only'
        ? '— (read items have no owner)'
        : (draftDir === 'i_owe_them'
            ? 'who it’s for — email or name (blank = nobody specific)'
            : 'who owes it — email or name; comma-separate several; blank = unassigned')
    }
    whoIn.value = draftWho
    whoState()

    // ---- autocomplete: suggest known people once the CURRENT comma-separated token has 2+
    // letters; picking a row replaces just that token with the address ----------------------
    const whoSug = div('te-who-sug')
    whoSug.style.display = 'none'
    const closeSug = () => { whoSug.style.display = 'none'; whoSug.textContent = '' }
    const paintSug = () => {
      const all = (people ? people() : []) || []
      const parts = whoIn.value.split(',')
      const token = parts[parts.length - 1].trim().toLowerCase()
      if (token.length < 2 || !all.length) { closeSug(); return }
      const already = new Set(parts.slice(0, -1).map(s => s.trim().toLowerCase()).filter(Boolean))
      const hits = all.filter(p => p && p.address && !already.has(String(p.address).toLowerCase()) &&
        ((String(p.name || '').toLowerCase().includes(token)) || String(p.address).toLowerCase().includes(token)))
        .slice(0, 6)
      if (!hits.length) { closeSug(); return }
      whoSug.textContent = ''
      for (const p of hits) {
        const row = btn('te-who-sugrow', null, () => {
          parts[parts.length - 1] = ' ' + p.address
          draftWho = parts.join(',').replace(/^\s+/, '')
          whoIn.value = draftWho
          whoTouched = true
          closeSug()
          whoIn.focus()
        })
        if (p.name) row.appendChild(span('te-who-sugname', p.name))
        row.appendChild(span('te-who-sugaddr', p.address))
        // mousedown fires before the input's blur — without this the row dies under the click
        row.addEventListener('mousedown', (e) => e.preventDefault())
        whoSug.appendChild(row)
      }
      whoSug.style.display = ''
    }
    whoIn.addEventListener('input', () => { draftWho = whoIn.value; whoTouched = true; paintSug() })
    whoIn.addEventListener('blur', () => setTimeout(closeSug, 150))
    whoIn.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSug(); e.stopPropagation() } })

    dirSel.addEventListener('change', () => {
      draftDir = dirSel.value
      if (!whoTouched) {
        // the Who is ONE list whatever the direction (whoMapping.js) — carry it across rather
        // than re-reading the new direction's slot: an I-owe item keeps its people in
        // counterparty and ME in owner, so re-reading dropped all but one of joint people
        if (draftWho.trim()) carriedWho = draftWho
        const fromSlot = whoOf(draftDir).split(',').map(s => s.trim()).filter(s => !isSelf(s)).join(', ')
        draftWho = draftDir === 'read_only' ? '' : (carriedWho || fromSlot || guessWho())
        whoIn.value = draftWho
      }
      whoState()
      closeSug()
    })
    const whoWrap = div('te-who-wrap')
    whoWrap.appendChild(whoIn)
    whoWrap.appendChild(whoSug)
    body.appendChild(field('Who', whoWrap))

    // ---- project (staged move — applied on Save). Just the name up front; the searchable
    // list only appears once "Move project…" is pressed ----------------------------------------
    body.appendChild(div('epv-modal-head', 'Project'))
    const cur = div('te-projline')
    cur.appendChild(span('proj-mark'))
    cur.appendChild(span('te-projname', project.name || project.project_id))
    if (target) {
      cur.appendChild(span('te-projarrow', '→'))
      cur.appendChild(span('te-projname te-projnew', target.create ? '➕ ' + target.create + ' (new)' : (target.name || target.project_id)))
      cur.appendChild(btn('pe-tbtn', 'Undo move', () => { target = null; pickerOpen = false; paint() }))
    } else {
      const mv = btn('pe-tbtn', pickerOpen ? 'Cancel move ▴' : 'Move project… ▾', () => { pickerOpen = !pickerOpen; pickQuery = ''; paint() })
      mv.title = 'Move this to-do to another project (or a new one)'
      cur.appendChild(mv)
    }
    body.appendChild(cur)

    if (pickerOpen && !target) {
      const pick = div('pe-movepick')
      const search = el('input', 'pe-msearch')
      search.type = 'search'
      search.placeholder = 'Find a project — or type a name to create one'
      search.value = pickQuery
      search.addEventListener('input', () => { pickQuery = search.value; paintPickList() })
      pick.appendChild(search)
      const listHost = div('pe-mplist')
      pick.appendChild(listHost)
      const paintPickList = () => {
        listHost.textContent = ''
        const q = pickQuery.trim().toLowerCase()
        const others = (projects ? projects() : []).filter(p => p && !p.merged_into && p.project_id !== project.project_id)
        const hits = others
          .filter(p => !q || String(p.name || '').toLowerCase().includes(q))
          .sort((a, b) => (b.importance || 0) - (a.importance || 0))
        for (const p of hits.slice(0, 8)) {
          const row = btn('pe-mprow', null, () => { target = p; pickerOpen = false; pickQuery = ''; paint() })
          row.appendChild(span('proj-mark'))
          row.appendChild(span('pe-mprow-name', p.name || p.project_id))
          row.appendChild(impBadge(p.importance || 3))
          listHost.appendChild(row)
        }
        if (hits.length > 8) listHost.appendChild(div('pe-note', '+ ' + (hits.length - 8) + ' more — keep typing to narrow'))
        if (ops.createProject && pickQuery.trim()) {
          const mk = btn('pe-mprow pe-mprow-new', null, () => { target = { create: pickQuery.trim() }; pickerOpen = false; pickQuery = ''; paint() })
          mk.appendChild(span('pe-mprow-name', '➕ Create new project “' + pickQuery.trim() + '”'))
          listHost.appendChild(mk)
        }
        if (!hits.length && !pickQuery.trim()) listHost.appendChild(div('pe-note', 'No other projects yet — type a name to create one.'))
      }
      paintPickList()
      body.appendChild(pick)
      setTimeout(() => search.focus(), 0)
    }

    // Save / Cancel sit ABOVE the history, not under it: a task with a long trail pushed them
    // off the bottom of the modal, so editing a well-travelled task meant scrolling past its
    // whole story to commit the change (user, 2026-08-31).
    const foot = div('te-actions')
    const saveBtn = btn('pe-tbtn pe-tbtn-save', 'Save', async () => {
      saveBtn.disabled = true; saveBtn.textContent = 'Saving…' // the due text may need one quick LLM call
      try { await save() } catch (e) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; saving = false }
    })
    foot.appendChild(saveBtn)
    foot.appendChild(btn('pe-tbtn', 'Cancel', () => close()))
    body.appendChild(foot)

    body.appendChild(historySection())
  }

  // ---- HISTORY: every recorded change to this task, newest first --------------------------
  // Reads todo.evidence only — no query, so it works on every page and on tasks whose emails
  // have long been pruned. Old entries lacking `who` / `changed` / `type` degrade to a plain
  // "updated" line rather than breaking the list.
  function historySection () {
    const wrap = div('te-hist')
    wrap.appendChild(div('epv-modal-head', 'History'))
    const trail = evidenceTrailOf(todo).reverse() // newest first
    if (!trail.length) {
      wrap.appendChild(div('epv-empty', 'No recorded history for this to-do yet.'))
      return wrap
    }
    const oldest = trail[trail.length - 1]
    for (const e of trail) {
      const sum = evidenceSummary(e, { first: e === oldest, nameOf, self: self || [], todo })
      const openable = !!(sum.msg && emailViewerReady())
      const row = openable
        ? btn('te-hist-row clickable', null, () => openEmailViewer({
            msg_id: sum.msg.msg_id, thread_id: sum.msg.thread_id,
            project_id: project && project.project_id // opened from this task ⇒ project-filtered sidebar
          }))
        : div('te-hist-row' + (sum.manual ? ' manual' : ''))
      row.appendChild(kindDisc(sum.manual ? 'manual' : 'message'))

      const mid = div('te-hist-mid')
      const head = div('te-hist-head')
      head.appendChild(span('te-hist-verb', sum.verb))
      if (sum.actor) head.appendChild(span('te-hist-who', '— ' + sum.actor))
      // a standing instruction that shaped this change (prompt 0.54): the trail is where the user
      // finds out WHY an item looks the way it does, so a rule that moved it belongs here
      for (const rid of (e.rules || [])) {
        const r = span('te-hist-rule', 'instruction ' + rid)
        r.title = 'A standing instruction the model says changed this analysis'
        head.appendChild(r)
      }
      mid.appendChild(head)

      // the field-level diff, when the writer recorded one ("priority 3 → 5"). Long values
      // (rewritten descriptions especially) truncate at 70 chars here — the "show full text ⌄"
      // line under the row unfolds them in full
      const longChanges = []
      for (const c of sum.changed) {
        if (String(c.from == null ? '' : c.from) === String(c.to == null ? '' : c.to)) continue
        const d = div('te-hist-diff')
        d.appendChild(span('te-hist-field', FIELD_LABEL[c.field] || c.field))
        d.appendChild(span('te-hist-val', shortVal(c.from)))
        d.appendChild(span('te-hist-arrow', '→'))
        d.appendChild(span('te-hist-val to', shortVal(c.to)))
        mid.appendChild(d)
        if (isLongVal(c.from) || isLongVal(c.to)) longChanges.push(c)
      }
      // the model's reason for the change, then its read of the message itself
      const reasonLine = sum.detail ? div('te-hist-reason', sum.detail) : null
      if (reasonLine) mid.appendChild(reasonLine)
      if (sum.summary) mid.appendChild(div('te-hist-sum', sum.summary))

      row.appendChild(mid)

      const when = span('te-hist-when', fmtDateTime(sum.when))
      when.title = openable ? 'open the email behind this change' : ''
      row.appendChild(when)
      wrap.appendChild(row)

      // ---- the fold: FULL before/after text for long diffs, selectable for copy-paste. The
      // point is recoverability (user, 2026-08-25): when a later rewrite (the model's,
      // typically) loses a phrasing the user had put in by hand, this is where they see it
      // happened and can lift their old text back out. The "show details" toggle rides on the
      // END of the entry's own reason line ("you edited the details — show details") — a
      // separate line was one line too loud (user, 2026-08-25) — muted grey, not link-blue.
      // It's a span, not a button: openable rows ARE <button>s and can't nest another one.
      if (longChanges.length) {
        const full = div('te-hist-full')
        full.style.display = 'none'
        for (const c of longChanges) {
          full.appendChild(div('te-hist-full-field', FIELD_LABEL[c.field] || c.field))
          const before = div('te-hist-full-block before')
          before.appendChild(div('te-hist-full-lbl', 'before'))
          const bt = el('pre', 'te-hist-full-text'); bt.textContent = String(c.from == null || c.from === '' ? '—' : c.from)
          before.appendChild(bt)
          const after = div('te-hist-full-block after')
          after.appendChild(div('te-hist-full-lbl', 'after'))
          const at = el('pre', 'te-hist-full-text'); at.textContent = String(c.to == null || c.to === '' ? '—' : c.to)
          after.appendChild(at)
          full.appendChild(before); full.appendChild(after)
        }
        const tog = span('te-hist-fulltoggle', 'show details')
        tog.title = 'Unfold the full before/after text of this change'
        tog.addEventListener('click', (ev) => {
          ev.stopPropagation() // never open the email behind the row
          const open = full.style.display !== 'none'
          full.style.display = open ? 'none' : ''
          tog.textContent = open ? 'show details' : 'hide details'
        })
        const host = reasonLine || head
        host.classList.add('has-fulltoggle') // lifts the 2-line clamp so the toggle can't be clipped
        host.appendChild(document.createTextNode(' — '))
        host.appendChild(tog)
        wrap.appendChild(full)
      }
    }
    return wrap
  }

  paint()
}

// how each tracked field reads in the history diff
const FIELD_LABEL = {
  short_description: 'name',
  description: 'details',
  importance: 'priority',
  due_hint: 'due',
  due_demote: 'until-due hold',
  direction: 'ownership',
  status: 'status',
  owner: 'owner',
  counterparty: 'for'
}
// diff values are shown inline — a whole re-written description would swamp the row
const shortVal = (v) => {
  const t = String(v == null || v === '' ? '—' : v)
  return t.length > 70 ? t.slice(0, 70) + '…' : t
}
// a value the inline diff can't show whole — these get the "show full text" fold under the row
const isLongVal = (v) => { const t = String(v == null ? '' : v); return t.length > 70 || t.includes('\n') }
