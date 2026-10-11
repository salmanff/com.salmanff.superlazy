// jobs/analyze_thread/maintenance/rulesInput.js — the DETERMINISTIC statistics the clean-up's rules and learn
// sections read (specs/superlazy-weekly-cleanup.md §3): the user's hand edits over the window,
// graded (maintenance spec §8.2); each standing instruction's usage — offered / cited / overridden
// after — from the analysis events' rules_offered / rules_applied; and scope overlaps between
// instructions. The model never counts: it reads counts and drafts wording.

const DAY = 24 * 3600e3
const lc = (s) => String(s || '').toLowerCase()
const clip = (s, n) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
const CHECK_LINE = /^\s*- \[( |x|X)\]/m

const isUserEdit = (ev) => ev && ev.kind === 'manual_edit' && (ev.source_id === 'user' || ev.source === 'manual')
const isAnalysis = (ev) => ev && (ev.kind === 'message' || ev.kind === 'workflow_short_circuit')

// a description edit that only flips checklist boxes is progress, not dissent
function onlyTicksChanged (before, after) {
  const norm = (s) => String(s || '').replace(/- \[(x|X| )\]/g, '- [ ]')
  return CHECK_LINE.test(String(after || '')) && norm(before) === norm(after)
}

/**
 * Grade the user's hand edits into readable, citable lines.
 * @returns {Array<{ id, asof, grade, field, project_id, todo_id, sender, text, ev }>}
 */
export function gradeHandEdits (events, { store, profiles = null, nameOf = null, analysisByTodo = null } = {}) {
  const projName = (id) => { const p = store && store.get(id); return p ? (p.name || id) : (id || '?') }
  const todoOf = (pid, tid) => { const p = store && store.get(pid); return p && (p.todos || []).find(t => t.todo_id === tid) }
  const who = (a) => { const s = lc(a); if (!s) return ''; const n = nameOf && nameOf(s); return n ? n + ' <' + s + '>' : s }
  const out = []
  let seq = 0
  const push = (ev, grade, text, extra = {}) => {
    out.push({ id: 'e' + String(++seq).padStart(4, '0'), asof: Number(ev.asof) || Number(ev._date_created) || 0, grade, field: ev.field || null, project_id: ev.project_id || null, todo_id: ev.todo_id || extra.todo_id || null, sender: extra.sender || null, text, ev })
  }
  const sorted = events.filter(isUserEdit).sort((a, b) => (Number(a.asof) || 0) - (Number(b.asof) || 0))
  for (const ev of sorted) {
    const pid = ev.project_id
    const pname = projName(pid)
    if (ev.target === 'bulk') {
      for (const c of (ev.changes || [])) {
        const t = todoOf(pid, c.todo_id)
        const sender = (t && t.sender) || null
        push(ev, 'CORRECTION', 'bulk ' + (ev.after || '') + ' ' + (c.todo_id || '') + ' "' + clip((t && t.short_description) || c.short || '', 60) + '" in ' + pid + ' "' + clip(pname, 40) + '"' + (sender ? ' · sender ' + who(sender) : ''), { todo_id: c.todo_id, sender })
      }
      continue
    }
    if (ev.target === 'project') {
      const grade = (ev.field === 'importance' || ev.field === 'name' || ev.field === 'summary') ? 'EDIT' : 'EDIT'
      push(ev, grade, 'project ' + (ev.field || '') + ' ' + clip(ev.before, 60) + ' → ' + (ev.auto ? 'auto (' + clip(ev.after, 60) + ')' : clip(ev.after, 60)) + ' on ' + pid + ' "' + clip(pname, 40) + '"')
      continue
    }
    if (ev.target === 'profile') {
      push(ev, 'EDIT', 'profile ' + (ev.field || '') + ' for ' + who(ev.address) + ': ' + clip(ev.before, 50) + ' → ' + clip(ev.after, 50))
      continue
    }
    // to-do level
    const t = todoOf(pid, ev.todo_id)
    const sender = ev.sender || (t && t.sender) || (ev.context && ev.context.sender) || null
    const where = (ev.todo_id || '') + ' "' + clip((t && t.short_description) || ev.short || '', 60) + '" in ' + (pid || '?') + ' "' + clip(pname, 40) + '"' + (sender ? ' · sender ' + who(sender) : '')
    const f = ev.field
    if (f === 'status' && ev.after === 'cancelled') { push(ev, 'CORRECTION', 'cancelled ' + where, { sender }); continue }
    if (f === 'status') { push(ev, 'EDIT', 'status ' + ev.before + ' → ' + ev.after + ' on ' + where, { sender }); continue }
    if (f === 'direction') {
      const off = ev.before === 'i_owe_them' && (ev.after === 'team_owes' || ev.after === 'they_owe_me')
      push(ev, off ? 'CORRECTION' : 'EDIT', 'direction ' + ev.before + ' → ' + ev.after + ' on ' + where, { sender }); continue
    }
    if (f === 'importance') {
      const baseline = t && (t.llm_importance != null ? t.llm_importance : null)
      const proven = baseline != null && Number(ev.before) === Number(baseline)
      push(ev, proven ? 'PROVEN OVERRIDE' : 'EDIT', 'priority ' + ev.before + ' → ' + ev.after + ' on ' + where, { sender }); continue
    }
    if (f === 'description' && onlyTicksChanged(ev.before, ev.after)) continue
    if (f === 'short_description' || f === 'description') {
      const baseline = t && (f === 'short_description' ? t.llm_short_description : t.llm_description)
      const proven = baseline != null && String(ev.before || '') === String(baseline)
      push(ev, proven ? 'PROVEN OVERRIDE' : 'EDIT', f + ' rewritten on ' + where + ': "' + clip(ev.before, 60) + '" → "' + clip(ev.after, 60) + '"', { sender }); continue
    }
    if (f === 'project' || f === 'moved') { push(ev, 'EDIT', 'moved ' + where + ' → ' + clip(ev.after, 40), { sender }); continue }
    if (f === 'merged') { push(ev, 'EDIT', 'merged project "' + clip(ev.before, 40) + '" into "' + clip(ev.after, 40) + '"'); continue }
    if (f === 'deleted') { push(ev, 'CORRECTION', 'deleted project "' + clip(ev.before, 40) + '" (' + (ev.count || 0) + ' to-dos)'); continue }
    if (f === 'owner' || f === 'counterparty' || f === 'who') { push(ev, 'EDIT', 'who ' + clip(ev.before, 40) + ' → ' + clip(ev.after, 40) + ' on ' + where, { sender }); continue }
    if (f === 'due_hint' || f === 'due_demote') { push(ev, 'EDIT', f + ' ' + clip(ev.before, 30) + ' → ' + clip(ev.after, 30) + ' on ' + where, { sender }); continue }
    if (f === 'auto_process' || f === 'autofile') { push(ev, 'CORRECTION', 'auto-process changed for ' + who(ev.address) + ': ' + clip(ev.before, 40) + ' → ' + clip(ev.after, 40)); continue }
    push(ev, 'EDIT', (f || 'edit') + ' ' + clip(ev.before, 40) + ' → ' + clip(ev.after, 40) + ' on ' + where, { sender })
  }
  return out
}

/**
 * Per-instruction usage over the window. `overridden` = a graded hand edit on a to-do whose most
 * recent analysis event (before the edit, within 7 days) cited the rule.
 */
export function instructionUsage (instructions, events, handEdits, { nowMs = Date.now(), recentEditDays = 14 } = {}) {
  const analyses = events.filter(isAnalysis)
  // todo_id -> [{ asof, rules_applied }] from the events' changes
  const byTodo = new Map()
  for (const ev of analyses) {
    const cited = ev.rules_applied || []
    if (!cited.length) continue
    for (const c of (ev.changes || [])) {
      if (!c.todo_id) continue
      if (!byTodo.has(c.todo_id)) byTodo.set(c.todo_id, [])
      byTodo.get(c.todo_id).push({ asof: Number(ev.asof) || 0, cited })
    }
  }
  return (instructions || []).filter(i => i && i.instruction_id).map(i => {
    let offered = 0; let cited = 0; let lastOffered = 0
    for (const ev of analyses) {
      if ((ev.rules_offered || []).includes(i.instruction_id)) { offered++; lastOffered = Math.max(lastOffered, Number(ev.asof) || 0) }
      if ((ev.rules_applied || []).includes(i.instruction_id)) cited++
    }
    let overridden = 0
    for (const e of handEdits) {
      if (e.grade === 'EDIT' || !e.todo_id) continue
      const prior = (byTodo.get(e.todo_id) || []).filter(a => a.asof <= e.asof && e.asof - a.asof <= 7 * DAY && a.cited.includes(i.instruction_id))
      if (prior.length) overridden++
    }
    const edited = Math.max(Number(i.created_asof) || 0, Number(i.edited_asof) || 0)
    return {
      instruction_id: i.instruction_id, status: i.status || 'active', scope: i.scope, match: i.match || null, text: i.text, author: i.author || 'user',
      created_asof: i.created_asof || null, offered, cited, overridden, last_offered: lastOffered || null,
      recently_edited: edited > 0 && (nowMs - edited) < recentEditDays * DAY
    }
  }).sort((a, b) => String(a.instruction_id).localeCompare(String(b.instruction_id)))
}

/** Pairs where one active instruction's match set is inside another's (sender ⊂ domain ⊂ account ⊂ all). */
export function scopeOverlaps (instructions) {
  const act = (instructions || []).filter(i => i && i.status === 'active')
  const domainOf = (m) => { const s = lc(m); const at = s.indexOf('@'); return at >= 0 ? s.slice(at) : null }
  const out = []
  for (const a of act) {
    for (const b of act) {
      if (a === b) continue
      let inside = false
      if (b.scope === 'all' && a.scope !== 'all') inside = true
      else if (b.scope === 'domain' && a.scope === 'sender' && domainOf(a.match) && domainOf(a.match) === lc(b.match)) inside = true
      if (inside) out.push({ inner: a.instruction_id, inner_scope: a.scope + (a.match ? ' ' + a.match : ''), outer: b.instruction_id, outer_scope: b.scope + (b.match ? ' ' + b.match : '') })
    }
  }
  return out.sort((x, y) => (x.inner + x.outer).localeCompare(y.inner + y.outer))
}
