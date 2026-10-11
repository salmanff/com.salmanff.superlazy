// newNoteModal.js — the ADD / EDIT modal for a manual NOTE (meeting notes etc — the notes
// channel, specs/superlazy-inputs.md). Same visual language as the project modals (pe- classes).
// The modal collects title / when / attendees / body / optional project pre-link and hands the
// note to submitNote below, which persists it PENDING-FIRST and then analyses it under the run
// lock (jobs/analyze_thread/noteIngest.js). Editing an already-analysed note goes through the
// SAME modal prefilled: saving bumps the revision and re-analyses as an amendment (§6.4).
// Text-only rendering (textContent).

import { openModalShell } from '../shared/modalStack.js'
import { div, span, btn, el } from '../shared/renderUtils.js'
import { mintNoteIds, noteInputRecord, noteContentHash, deriveNoteTitle, runNoteIngestion } from '../jobs/analyze_thread/noteIngest.js'

// "alice@x.com, Sarah (accounting)" -> [{ address }, { name }] — a token with an @ is an
// address (an optional "Name <addr>" form is honored); anything else is a name-only attendee.
export function parseAttendees (text) {
  return String(text || '').split(',').map(t => t.trim()).filter(Boolean).map(t => {
    const angled = t.match(/^(.*)<([^>]+@[^>]+)>$/)
    if (angled) return { name: angled[1].trim(), address: angled[2].trim() }
    if (t.includes('@') && !t.includes(' ')) return { address: t }
    return { name: t }
  })
}
const attendeesToText = (participants) => (participants || [])
  .map(p => (p.name && p.address) ? (p.name + ' <' + p.address + '>') : (p.address || p.name))
  .filter(Boolean).join(', ')

// Persist + analyse one note (fresh or an edit). Called by the modal; exported for tests.
//   { freezr, persist, fields: { title, body, attendees, dateMs, linkedProjectId }, existing? }
// existing = the stored inputs record being EDITED. Returns runNoteIngestion's result, plus
// { unchanged: true } when an edit didn't actually change the content.
export async function submitNote ({ freezr, persist, fields, existing = null, onEvent = null }) {
  let rec
  if (existing) {
    const participants = parseAttendees(fields.attendees).map(a => ({
      address: String(a.address || '').toLowerCase(), name: (a.name || '').trim(), kind: 'attendee'
    })).filter(p => p.address || p.name)
    const next = {
      ...existing,
      title: (fields.title || '').trim() || deriveNoteTitle(fields.body),
      body_text: (fields.body || '').trim(),
      participants,
      date: Number(fields.dateMs) || existing.date,
      linked_project_id: fields.linkedProjectId || existing.linked_project_id || null
    }
    next.content_hash = noteContentHash(next)
    if (next.content_hash === existing.content_hash) return { ok: true, unchanged: true }
    // amendment (§6.4): keep the superseded body — the retention promise covers what the user wrote
    next.revision = (Number(existing.revision) || 1) + 1
    next.edited_asof = Date.now()
    next.prior_revisions = [...(existing.prior_revisions || []), {
      revision: Number(existing.revision) || 1,
      title: existing.title || '',
      body_text: existing.body_text || '',
      participants: existing.participants || [],
      date: existing.date || 0,
      edited_asof: existing.edited_asof || null
    }]
    next.status = 'pending'
    rec = next
  } else {
    rec = noteInputRecord({
      ...mintNoteIds(),
      title: fields.title,
      body: fields.body,
      attendees: parseAttendees(fields.attendees),
      date: fields.dateMs,
      authorAddress: fields.authorAddress,
      authorName: fields.authorName || '',
      linkedProjectId: fields.linkedProjectId || null
    })
  }
  const saved = await persist.saveInput(rec) // PENDING-FIRST: the note is never lost
  if (!saved) return { ok: false, error: 'could not save the note' }
  return runNoteIngestion({ freezr, persist, inputRec: rec, onEvent })
}

// Transient message on the topbar's grey note line (#topbarNote, present on every page). The
// mail-tools poller repaints that line on its own cadence, so a flash needs no cleanup discipline:
// we restore the previous text after ms unless something else has already repainted it.
function flashTopbarNote (text, ms = 5000) {
  const host = document.getElementById('topbarNote')
  if (!host) return
  const prev = host.textContent
  host.textContent = text
  setTimeout(() => { if (host.textContent === text) host.textContent = prev }, ms)
}

// Attach a type-ahead dropdown to an input. items() → [{ key, label, insert }].
// multi: complete the token after the last comma (attendees); single: whole value (project).
// onPick(item) fires on selection; typing that no longer matches a pick clears it via onClear.
function attachSuggest (input, { items, multi = false, onPick = null, onClear = null } = {}) {
  const wrap = input.parentElement
  wrap.classList.add('nn-sugwrap')
  const list = div('nn-suggest')
  list.style.display = 'none'
  wrap.appendChild(list)
  let rows = []
  let sel = -1

  const tokenOf = () => {
    const v = input.value
    if (!multi) return v.trim()
    const i = v.lastIndexOf(',')
    return v.slice(i + 1).trim()
  }
  const apply = (item) => {
    if (multi) {
      const v = input.value
      const i = v.lastIndexOf(',')
      input.value = (i >= 0 ? v.slice(0, i + 1) + ' ' : '') + item.insert + ', '
    } else {
      input.value = item.insert
    }
    hide()
    if (onPick) onPick(item)
    input.focus()
  }
  const hide = () => { list.style.display = 'none'; sel = -1 }
  const paint = () => {
    const q = tokenOf().toLowerCase()
    list.textContent = ''
    rows = []
    if (!q) { hide(); return }
    const hits = (items() || []).filter(it => it.label.toLowerCase().includes(q)).slice(0, 8)
    if (!hits.length) { hide(); return }
    hits.forEach((it, i) => {
      const b = btn('nn-sugrow', it.label, () => apply(it))
      if (i === sel) b.classList.add('on')
      list.appendChild(b)
      rows.push({ it, el: b })
    })
    list.style.display = ''
  }
  input.addEventListener('input', () => { sel = -1; if (onClear) onClear(); paint() })
  input.addEventListener('keydown', (e) => {
    if (list.style.display === 'none') return
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, rows.length - 1); paint() } else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint() } else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); apply(rows[sel].it) } else if (e.key === 'Escape') hide()
  })
  input.addEventListener('blur', () => setTimeout(hide, 150)) // let a click on a row land first
}

// opts: {
//   persist, freezr?          — persistence + api (freezr defaults to the global)
//   projects: [project]       — for the pre-link picker (active, any order)
//   people: [{address,name}]  — the attendees autocomplete source (profiles)
//   authorAddress             — ME (settings.your_addresses[0])
//   authorName?               — display name for the author
//   existing?                 — the inputs record to EDIT (prefills; save = amendment)
//   defaultProjectId?         — preselect the picker (e.g. opened from a project card)
//   onDone(result, rec)       — after a successful save+analysis (or deferral); host repaints
// }
export function openNewNoteModal (opts = {}) {
  const F = opts.freezr || (typeof freezr !== 'undefined' ? freezr : null)
  const existing = opts.existing || null
  const { modal, close } = openModalShell({ className: 'epv-modal-wide pe-modal', onClose: null, guardOutsideClick: true })

  const body = div('pe-body')
  modal.appendChild(body)
  body.appendChild(div('epv-modal-title', existing ? 'Edit note' : 'New note'))
  body.appendChild(div('pe-note', existing
    ? 'Saving re-analyses the note as a revision — its existing to-dos are updated, not duplicated.'
    : 'Meeting notes, a call debrief, anything worth tracking — the AI reads it like an email and files to-dos into projects.'))

  const row = (label, field) => {
    const r = div('pe-row')
    r.appendChild(span('pe-lbl', label))
    r.appendChild(field)
    body.appendChild(r)
    return field
  }

  const titleIn = el('input', 'pe-name')
  titleIn.type = 'text'
  titleIn.placeholder = 'optional — the first line of the note is used if left empty'
  if (existing) titleIn.value = existing.title || ''
  row('Title', titleIn)

  const whenIn = el('input', 'pe-name nn-when')
  whenIn.type = 'datetime-local'
  const toLocal = (ms) => {
    const d = ms ? new Date(ms) : new Date()
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  whenIn.value = toLocal(existing ? existing.date : null)
  row('When', whenIn)

  const attIn = el('input', 'pe-name')
  attIn.type = 'text'
  attIn.placeholder = 'alice@example.com, Sarah (accounting) — emails or names, comma-separated'
  if (existing) attIn.value = attendeesToText(existing.participants)
  row('Attendees', attIn)
  attachSuggest(attIn, {
    multi: true,
    items: () => (opts.people || [])
      .filter(p => p && p.address)
      .map(p => ({ key: p.address, label: (p.name ? p.name + ' <' + p.address + '>' : p.address), insert: (p.name ? p.name + ' <' + p.address + '>' : p.address) }))
  })

  const projs = (opts.projects || []).filter(p => p && p.project_id)
  let chosenProjectId = null
  const projIn = el('input', 'pe-name')
  projIn.type = 'text'
  projIn.placeholder = 'start typing a project name — or leave empty to let the AI choose'
  const preset = existing ? existing.linked_project_id : opts.defaultProjectId
  if (preset) {
    const pp = projs.find(p => p.project_id === preset)
    if (pp) { chosenProjectId = pp.project_id; projIn.value = pp.name || pp.project_id }
  }
  row('Project', projIn)
  attachSuggest(projIn, {
    items: () => projs.map(p => ({ key: p.project_id, label: p.name || p.project_id, insert: p.name || p.project_id })),
    onPick: (it) => { chosenProjectId = it.key },
    onClear: () => { chosenProjectId = null }
  })
  // typed-but-not-picked still counts when it names exactly one project
  const resolveProject = () => {
    if (chosenProjectId) return chosenProjectId
    const t = projIn.value.trim().toLowerCase()
    if (!t) return null
    const hits = projs.filter(p => String(p.name || '').toLowerCase() === t)
    return hits.length === 1 ? hits[0].project_id : null
  }

  const bodyIn = el('textarea', 'nn-body')
  bodyIn.placeholder = 'The notes themselves. Decisions, who agreed to what, deadlines…'
  if (existing) bodyIn.value = existing.body_text || ''
  body.appendChild(bodyIn)

  const err = div('pe-note pe-err')
  err.style.display = 'none'
  body.appendChild(err)

  const showErr = (m) => { err.textContent = m; err.style.display = '' }

  // NON-BLOCKING SAVE (user, 2026-08-22): validate, CLOSE the modal at once, and run the
  // save + analysis detached. Status lives in the topbar: a transient line here for the
  // outcome, and — while the analysis actually runs — the yellow processing strip, which
  // reads the run lock's progress.stage ('analysing your note — …') on its own.
  const save = () => {
    err.style.display = 'none'
    const text = bodyIn.value.trim()
    if (!text) { showErr('The note is empty.'); bodyIn.focus(); return }
    const title = titleIn.value.trim() || deriveNoteTitle(text)
    const fields = {
      title,
      body: text,
      attendees: attIn.value,
      dateMs: whenIn.value ? new Date(whenIn.value).getTime() : Date.now(),
      linkedProjectId: resolveProject(),
      authorAddress: opts.authorAddress || '',
      authorName: opts.authorName || ''
    }
    close()
    flashTopbarNote('📝 Saving note “' + title + '”…', 4000)
    submitNote({ freezr: F, persist: opts.persist, existing, fields })
      .then((result) => {
        if (result && result.unchanged) { flashTopbarNote('📝 Note unchanged — nothing to re-analyse.', 5000); return }
        if (result && result.deferred) {
          flashTopbarNote('📝 Note saved — a mail check is running; it will be analysed when that check finishes.', 8000)
          return // the run's own strip takes over; its onRefreshed reloads the page after
        }
        if (result && result.ok === false) {
          flashTopbarNote('⚠️ Note analysis failed (' + (result.error || result.skipped || 'unknown') + ') — the note is saved and will be retried on the next mail check.', 10000)
          if (opts.onDone) opts.onDone(result)
          return
        }
        flashTopbarNote('📝 Note analysed and filed.', 6000)
        if (opts.onDone) opts.onDone(result)
      })
      .catch((e) => {
        flashTopbarNote('⚠️ Note analysis failed (' + ((e && e.message) || e) + ') — the note is saved and will be retried on the next mail check.', 10000)
      })
  }

  const actions = div('pe-row nn-actions')
  const saveBtn = btn('pe-tbtn pe-tbtn-save', existing ? 'Save changes' : 'Save note', save)
  const cancelBtn = btn('pe-tbtn', 'Cancel', () => close())
  actions.appendChild(saveBtn)
  actions.appendChild(cancelBtn)
  body.appendChild(actions)
  titleIn.focus()
}
