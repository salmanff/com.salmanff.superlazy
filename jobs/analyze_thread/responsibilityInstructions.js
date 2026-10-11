// responsibilityInstructions.js — a STANDING INSTRUCTION made from a line the user typed on a
// person's card ("What they handle"), only when the user asks for it (the person editor's
// "Add as standing instruction" button). (user, 2026-10-04)
//
// Why it exists: on the regression battery, haiku routed work by a card line alone far less often
// than by a standing instruction (****) invoice 0/3 vs 3/3; testConfidential/cases.md). Sonnet
// follows card lines well, so nothing is converted automatically — the editor warns on a small
// model and offers the button.
//
// The text is a NON-AI template: the user's line goes in verbatim and the template only says what
// to use it for; it never decides direction, team vs external or priority — the user's own words do.
//
// An instruction made here is AUTOMATED: it carries origin = 'responsibility' plus the person and
// line it came from, so the app can tell it from instructions the user wrote, keep it in step when
// the line is edited, and switch it off when the line is removed. Instructions the user wrote are
// never touched by anything in this module.

export const ORIGIN_RESPONSIBILITY = 'responsibility'

export function responsibilityInstructionText ({ name, address, text }) {
  const who = String(address || '').toLowerCase()
  const nm = String(name || who).trim()
  const line = String(text || '').trim().replace(/\s+/g, ' ').replace(/"/g, '”')
  return `The user has added the following responsibility for ${nm} <${who}>: "${line}". Please follow these instructions specifically when assigning a to-do to "i_owe_them" or "team_owes".`
}

export const isAutomatedInstruction = (r) => !!r && r.origin === ORIGIN_RESPONSIBILITY

// the ACTIVE instruction made from one card line, if any
export function linkedInstruction (instructions, address, respId) {
  const a = String(address || '').toLowerCase()
  return (instructions || []).find(r => isAutomatedInstruction(r) && r.status === 'active' &&
    r.origin_address === a && r.origin_resp_id === respId) || null
}

// make the instruction for one card line (the button). iStore mints a non-colliding id.
export function makeResponsibilityInstruction (iStore, { name, address, entry, asof = Date.now() }) {
  const rec = iStore.add({
    scope: 'all',
    match: null,
    text: responsibilityInstructionText({ name, address, text: entry.text }),
    label: 'From ' + String(name || address).trim() + '’s card',
    asof
  })
  if (!rec) return null
  rec.origin = ORIGIN_RESPONSIBILITY
  rec.origin_address = String(address || '').toLowerCase()
  rec.origin_resp_id = entry.id
  rec.origin_text = entry.text
  return rec
}

// keep automated instructions in step with the card after an edit or removal. Returns the records
// it changed (the caller persists them): an edited line rewrites its instruction's text; a removed
// line disables it. Instructions the user wrote are never in the result.
export function syncResponsibilityInstructions (instructions, { name, address, entries }) {
  const a = String(address || '').toLowerCase()
  const byId = new Map((entries || []).filter(e => e && e.source === 'user').map(e => [e.id, e]))
  const changed = []
  for (const r of (instructions || [])) {
    if (!isAutomatedInstruction(r) || r.status !== 'active' || r.origin_address !== a) continue
    const e = byId.get(r.origin_resp_id)
    if (!e) { r.status = 'disabled'; changed.push(r); continue }
    if (e.text !== r.origin_text) {
      r.text = responsibilityInstructionText({ name, address: a, text: e.text })
      r.origin_text = e.text
      changed.push(r)
    }
  }
  return changed
}
