// jobs/analyze_thread/maintenance/ops.js — the OPERATIONS vocabulary (specs/superlazy-weekly-cleanup.md §2.4
// "How you express a change"): the structured language every clean-up proposal is written in.
// Three jobs, all pure: VALIDATE a proposal's ops against the live stores (unknown ids, tmp ids,
// one-todo-one-structural-proposal, the checklist guard on restructures, user-set flags);
// DESCRIBE each op as an old → new row for the review surface; FINGERPRINT a proposal so an
// ignored one is never shown again. Applying is applyProposals.js's job.

import { entriesOf } from '../responsibilities.js'

export const OPS = ['merge_project', 'create_project', 'move_todo', 'resolve_todo', 'cancel_todo', 'snooze_todo', 'set_todo', 'create_todo',
  'archive_project', 'rename_project', 'set_project_summary', 'update_profile', 'set_auto_process', 'set_manual_rank',
  'add_instruction', 'disable_instruction', 'rewrite_instruction', 'rescope_instruction',
  // housekeeping (deterministic passes, lab only)
  'prune_events', 'rebuild_interaction', 'unlink_threads']

// ops that CLAIM a to-do — a to-do may be claimed by at most one proposal in a run
const CLAIMING = new Set(['move_todo', 'resolve_todo', 'cancel_todo', 'snooze_todo'])
const DIRECTIONS = ['i_owe_them', 'they_owe_me', 'team_owes', 'read_only']
const DISPOSITIONS = ['newsletter', 'admin', 'social', 'promotions']
const SCOPES = ['sender', 'domain', 'account', 'all']
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t }
const openish = (t) => t && (t.status === 'open' || t.status === 'in_progress')
const checklistLines = (s) => String(s || '').split(/\r?\n/).filter(l => /^\s*- \[( |x|X)\]/.test(l)).length

/**
 * @param {Object} proposal   { group, title, description, evidence, ops }
 * @param {Object} ctx        { store, profiles, instructions: [records], bucketIds: Set, claimed: Set (mutated) }
 * @returns {{ ok, ops, problems: [string], flags: [string], touches: { projects:Set, todos:Set, addresses:Set } }}
 */
export function validateProposal (proposal, ctx) {
  const { store, profiles, instructions = [], bucketIds = new Set(), claimed = new Set() } = ctx
  const problems = []; const flags = []
  const touches = { projects: new Set(), todos: new Set(), addresses: new Set() }
  const tmp = new Set()
  const ops = Array.isArray(proposal.ops) ? proposal.ops : []
  const out = []
  const proj = (id) => (id && store.get(id)) || null
  const todo = (pid, tid) => { const p = proj(pid); return p ? (p.todos || []).find(t => t.todo_id === tid) || null : null }
  const findTodo = (tid) => { for (const p of store.all()) { const t = (p.todos || []).find(x => x.todo_id === tid); if (t) return { p, t } } return null }
  const instr = (id) => instructions.find(i => i && i.instruction_id === id) || null
  const needProj = (id, label) => { const p = proj(id); if (!p) problems.push(label + ': unknown project ' + id); else { touches.projects.add(id); if (bucketIds.has(id)) flags.push('touches a BUCKET project (' + (p.name || id) + ')') } return p }
  const claim = (tid) => { if (claimed.has(tid)) problems.push('to-do ' + tid + ' is already claimed by another proposal'); else claimed.add(tid) }
  const localClaims = []

  for (const raw of ops) {
    if (!raw || typeof raw !== 'object' || !OPS.includes(raw.op)) { problems.push('unknown operation ' + JSON.stringify(raw).slice(0, 80)); continue }
    const o = { ...raw }
    switch (o.op) {
      case 'merge_project': {
        const s = needProj(o.source_project_id, 'merge'); const t = needProj(o.target_project_id, 'merge')
        if (s && t && s === t) problems.push('merge: source and target are the same project')
        break
      }
      case 'create_project': {
        if (!o.tmp_id || !/^[a-z][a-z0-9_]*$/i.test(o.tmp_id)) problems.push('create_project needs a tmp_id')
        else if (tmp.has(o.tmp_id)) problems.push('duplicate tmp_id ' + o.tmp_id)
        else tmp.add(o.tmp_id)
        if (!String(o.name || '').trim()) problems.push('create_project needs a name')
        break
      }
      case 'move_todo': {
        const from = needProj(o.from_project_id, 'move')
        const t = from && (from.todos || []).find(x => x.todo_id === o.todo_id)
        if (from && !t) {
          const f = findTodo(o.todo_id)
          if (f) { o.from_project_id = f.p.project_id; touches.projects.add(f.p.project_id) } else problems.push('move: unknown to-do ' + o.todo_id)
        }
        if (!tmp.has(o.to_project_id)) needProj(o.to_project_id, 'move destination')
        if (o.todo_id) { touches.todos.add(o.todo_id); localClaims.push(o.todo_id) }
        break
      }
      case 'resolve_todo': case 'cancel_todo': case 'snooze_todo': {
        let t = todo(o.project_id, o.todo_id)
        if (!t) { const f = findTodo(o.todo_id); if (f) { o.project_id = f.p.project_id; t = f.t } }
        if (!t) problems.push(o.op + ': unknown to-do ' + o.todo_id)
        else {
          touches.projects.add(o.project_id); touches.todos.add(o.todo_id); localClaims.push(o.todo_id)
          if (!openish(t)) problems.push(o.op + ': ' + o.todo_id + ' is already ' + t.status)
          if (t.importance_locked || t.manual_locked) flags.push('to-do ' + o.todo_id + ' carries a user-set value')
          if (o.op === 'snooze_todo' && !ISO_DAY.test(String(o.until || ''))) problems.push('snooze needs until = YYYY-MM-DD')
        }
        break
      }
      case 'set_todo': {
        let t = todo(o.project_id, o.todo_id)
        if (!t) { const f = findTodo(o.todo_id); if (f) { o.project_id = f.p.project_id; t = f.t } }
        if (!t) { problems.push('set_todo: unknown to-do ' + o.todo_id); break }
        touches.projects.add(o.project_id); touches.todos.add(o.todo_id)
        const f = o.fields && typeof o.fields === 'object' ? o.fields : {}
        const clean = {}
        for (const k of ['importance', 'who', 'direction', 'short_description', 'description', 'due_hint']) if (f[k] != null) clean[k] = f[k]
        if (clean.importance != null) { clean.importance = Math.max(1, Math.min(5, Math.round(Number(clean.importance) || 3))); if (t.importance_locked) flags.push('priority of ' + o.todo_id + ' is USER-SET') }
        if (clean.direction != null && !DIRECTIONS.includes(clean.direction)) problems.push('set_todo: bad direction ' + clean.direction)
        if (clean.who != null && !Array.isArray(clean.who)) clean.who = [String(clean.who)]
        if (!Object.keys(clean).length) problems.push('set_todo: no fields to set')
        o.fields = clean
        break
      }
      case 'create_todo': {
        needProj(o.project_id, 'create_todo')
        const t = o.todo || {}
        if (!String(t.short_description || '').trim()) problems.push('create_todo needs a short_description')
        if (t.direction && !DIRECTIONS.includes(t.direction)) problems.push('create_todo: bad direction ' + t.direction)
        break
      }
      case 'archive_project': {
        const p = needProj(o.project_id, 'archive')
        if (p) { for (const t of (p.todos || [])) if (openish(t)) { touches.todos.add(t.todo_id); localClaims.push(t.todo_id); if (t.importance_locked) flags.push('open to-do ' + t.todo_id + ' is USER-SET and would close') } }
        break
      }
      case 'rename_project': { const p = needProj(o.project_id, 'rename'); if (!String(o.name || '').trim()) problems.push('rename needs a name'); if (p && p.name_locked) flags.push('name is user-set'); break }
      case 'set_project_summary': { needProj(o.project_id, 'summary'); if (!String(o.summary || '').trim()) problems.push('set_project_summary needs text'); break }
      case 'update_profile': {
        const pr = profiles && profiles.get(o.address)
        if (!pr) { problems.push('update_profile: no profile for ' + o.address); break }
        touches.addresses.add(String(o.address).toLowerCase())
        const f = o.fields && typeof o.fields === 'object' ? o.fields : {}
        const clean = {}
        for (const k of ['summary', 'relationship', 'responsibilities', 'llm_importance']) if (f[k] != null) clean[k] = f[k]
        if (clean.llm_importance != null) clean.llm_importance = Math.max(1, Math.min(5, Math.round(Number(clean.llm_importance) || 3)))
        // responsibilities is a LIST of entries (responsibilities.js). A proposal may only refresh the
        // MODEL's entries: the user's own are preserved by the applier whatever arrives here, so a
        // proposal that tries to restate one is flagged rather than silently half-applied.
        if (clean.responsibilities != null) {
          const list = Array.isArray(clean.responsibilities) ? clean.responsibilities : [clean.responsibilities]
          clean.responsibilities = list.map(e => (typeof e === 'string' ? e : (e && e.text) || '')).map(t => String(t).trim()).filter(Boolean)
          if (!clean.responsibilities.length) delete clean.responsibilities
          const mine = entriesOf(pr.profile).filter(e => e.source === 'user').map(e => e.text.toLowerCase())
          if (clean.responsibilities && mine.length && clean.responsibilities.some(t => mine.includes(t.toLowerCase()))) {
            flags.push('restates a USER-SET responsibility (it is kept either way)')
          }
        }
        if (!Object.keys(clean).length) problems.push('update_profile: no fields')
        if (pr.profile && pr.profile.user_edited) flags.push('USER-EDITED profile')
        if (pr.profile && pr.profile.solidified_asof) flags.push('SOLID profile')
        o.fields = clean
        break
      }
      case 'set_auto_process': {
        if (!(profiles && profiles.get(o.address))) problems.push('set_auto_process: no profile for ' + o.address)
        else touches.addresses.add(String(o.address).toLowerCase())
        const p = needProj(o.project_id, 'auto-process target')
        if (p && !bucketIds.has(o.project_id)) flags.push('target is not an existing bucket')
        if (!DISPOSITIONS.includes(o.disposition)) problems.push('set_auto_process: bad disposition ' + o.disposition)
        break
      }
      case 'set_manual_rank': {
        if (!(profiles && profiles.get(o.address))) problems.push('set_manual_rank: no profile for ' + o.address)
        else touches.addresses.add(String(o.address).toLowerCase())
        o.rank = Math.max(1, Math.min(5, Math.round(Number(o.rank) || 3)))
        break
      }
      case 'add_instruction': {
        if (!SCOPES.includes(o.scope)) problems.push('add_instruction: bad scope ' + o.scope)
        if (o.scope !== 'all' && !String(o.match || '').trim()) problems.push('add_instruction: scope ' + o.scope + ' needs a match')
        if (!String(o.text || '').trim()) problems.push('add_instruction needs text')
        break
      }
      case 'disable_instruction': case 'rewrite_instruction': case 'rescope_instruction': {
        const i = instr(o.instruction_id)
        if (!i) { problems.push(o.op + ': unknown instruction ' + o.instruction_id); break }
        if (o.op === 'rewrite_instruction' && !String(o.text || '').trim()) problems.push('rewrite needs text')
        if (o.op === 'rescope_instruction' && !SCOPES.includes(o.scope)) problems.push('rescope: bad scope ' + o.scope)
        if (i.author === 'user' || !i.author) flags.push('rule ' + i.instruction_id + ' was written by the user')
        break
      }
      case 'prune_events': { if (!Array.isArray(o.ids) || !o.ids.length) problems.push('prune_events needs ids'); break }
      case 'rebuild_interaction': { if (!(profiles && profiles.get(o.address))) problems.push('rebuild_interaction: no profile for ' + o.address); break }
      case 'unlink_threads': {
        // release thread links from a project (deterministic.previewOrphanThreads). Only ids the
        // project still carries count — a link something else already released is simply dropped.
        const p = needProj(o.project_id, 'unlink threads')
        const want = (Array.isArray(o.thread_ids) ? o.thread_ids : []).map(t => String(t || '')).filter(Boolean)
        o.thread_ids = p ? want.filter(t => (p.thread_ids || []).includes(t)) : want
        if (!o.thread_ids.length) problems.push('unlink_threads: none of the thread ids are linked to ' + o.project_id)
        break
      }
    }
    out.push(o)
  }
  // restructure guard: a set_todo(description) + cancel_todo(children) in one proposal must carry a checklist line per child
  const cancels = out.filter(o => o.op === 'cancel_todo').length
  const descOps = out.filter(o => o.op === 'set_todo' && o.fields && o.fields.description != null)
  if (cancels && descOps.length) {
    const lines = descOps.reduce((n, o) => n + checklistLines(o.fields.description), 0)
    if (lines < cancels) problems.push('restructure: the new description has ' + lines + ' checklist line(s) for ' + cancels + ' absorbed to-do(s)')
  }
  const isNote = !ops.length
  if (isNote && proposal.group !== 'learn') problems.push('a proposal with no operations is only allowed in the learn group')
  for (const tid of new Set(localClaims)) claim(tid)
  return { ok: problems.length === 0, ops: out, problems, flags: [...new Set(flags)], touches, isNote }
}

/** Old → new rows for the review surface, one per op. */
export function describeOps (ops, ctx) {
  const { store, profiles, instructions = [] } = ctx
  const proj = (id) => (id && store.get(id)) || null
  const pname = (id) => { const p = proj(id); return p ? '“' + (p.name || id) + '”' : id }
  const todo = (pid, tid) => { const p = proj(pid); return p ? (p.todos || []).find(t => t.todo_id === tid) : null }
  const tshort = (pid, tid) => { const t = todo(pid, tid); return t ? '“' + clip(t.short_description || t.description, 70) + '”' : tid }
  const instr = (id) => instructions.find(i => i && i.instruction_id === id) || null
  const rows = []
  const tmpNames = {}
  for (const o of ops) {
    switch (o.op) {
      case 'merge_project': { const s = proj(o.source_project_id); const t = proj(o.target_project_id); rows.push({ label: 'merge', before: pname(o.source_project_id) + (s ? ' (' + (s.todos || []).length + ' to-dos)' : '') + ' + ' + pname(o.target_project_id) + (t ? ' (' + (t.todos || []).length + ')' : ''), after: 'one project ' + pname(o.target_project_id) + ' — the other is retired' }); break }
      case 'create_project': tmpNames[o.tmp_id] = o.name; rows.push({ label: 'new project', before: '(none)', after: '“' + o.name + '”' + (o.summary ? ' — ' + clip(o.summary, 160) : '') + ' · imp ' + (o.importance || 3) }); break
      case 'move_todo': rows.push({ label: 'move', before: tshort(o.from_project_id, o.todo_id) + ' in ' + pname(o.from_project_id), after: 'in ' + (tmpNames[o.to_project_id] ? '“' + tmpNames[o.to_project_id] + '” (new)' : pname(o.to_project_id)) }); break
      case 'resolve_todo': case 'cancel_todo': { const t = todo(o.project_id, o.todo_id); rows.push({ label: o.op === 'resolve_todo' ? 'resolve' : 'cancel', before: tshort(o.project_id, o.todo_id) + (t ? ' [' + t.status + ' · imp ' + (t.importance || 3) + ']' : ''), after: o.op === 'resolve_todo' ? 'resolved' : 'cancelled' }); break }
      case 'snooze_todo': rows.push({ label: 'snooze', before: tshort(o.project_id, o.todo_id), after: 'resurfaces ' + o.until + ' (lower priority until then)' }); break
      case 'set_todo': { const t = todo(o.project_id, o.todo_id) || {}; for (const [k, v] of Object.entries(o.fields || {})) rows.push({ label: k, before: (tshort(o.project_id, o.todo_id)) + '\n' + clip(Array.isArray(t[k]) ? t[k].join(', ') : (t[k] == null ? '(none)' : t[k]), 600), after: clip(Array.isArray(v) ? v.join(', ') : v, 600) }); break }
      case 'create_todo': { const t = o.todo || {}; rows.push({ label: 'new to-do', before: 'in ' + pname(o.project_id), after: '“' + (t.short_description || '') + '” [' + (t.direction || '') + ' · who: ' + ((t.who || []).join(', ') || '—') + ' · imp ' + (t.importance || 3) + ']' + (t.description ? '\n' + clip(t.description, 300) : '') }); break }
      case 'archive_project': { const p = proj(o.project_id); const opens = p ? (p.todos || []).filter(openish) : []; rows.push({ label: 'archive', before: pname(o.project_id) + (p ? ' · ' + (p.todos || []).length + ' to-dos · ' + opens.length + ' open' : ''), after: 'moved to the archive' + (opens.length ? '; closes: ' + opens.map(t => clip(t.short_description, 40)).join(' · ') : '') }); break }
      case 'rename_project': rows.push({ label: 'rename', before: pname(o.project_id), after: '“' + o.name + '”' }); break
      case 'set_project_summary': { const p = proj(o.project_id); rows.push({ label: 'summary', before: (p && p.summary) || '(none)', after: o.summary }); break }
      case 'update_profile': {
        const pr = profiles && profiles.get(o.address); const cur = (pr && pr.profile) || {}
        for (const [k, v] of Object.entries(o.fields || {})) {
          // responsibilities is a list: show the CURRENT lines against the proposed ones, and say
          // which of the current ones are the user's (those survive the change whatever is proposed)
          const before = k === 'responsibilities'
            ? (entriesOf(cur).map(e => e.text + (e.source === 'user' ? ' [YOURS — kept]' : '')).join('\n') || '(none)')
            : (cur[k] == null ? '(none)' : String(cur[k]))
          // mirror the applier exactly (applyModelResponsibilities): the user's entries come first
          // and survive, and a proposed line that merely restates one is dropped rather than doubled
          let after
          if (k === 'responsibilities') {
            const mine = entriesOf(cur).filter(e => e.source === 'user')
            const minetext = new Set(mine.map(e => e.text.toLowerCase()))
            const proposed = (Array.isArray(v) ? v : [v]).map(x => String((x && x.text) || x || '').trim())
              .filter(t => t && !minetext.has(t.toLowerCase()))
            after = [...mine.map(e => e.text + ' [YOURS — kept]'), ...proposed].join('\n')
          } else after = String(v)
          rows.push({ label: (pr && pr.display_name ? pr.display_name + ' · ' : o.address + ' · ') + k, before, after })
        }
        break
      }
      case 'set_auto_process': rows.push({ label: 'auto-file', before: o.address, after: 'file into ' + pname(o.project_id) + ' as ' + o.disposition }); break
      case 'set_manual_rank': { const pr = profiles && profiles.get(o.address); rows.push({ label: 'rank', before: o.address + ' · ' + (pr && pr.manual_rank != null ? 'manual ' + pr.manual_rank : 'learned ' + ((pr && pr.profile && pr.profile.llm_importance) || '?')), after: 'manual rank ' + o.rank }); break }
      case 'add_instruction': rows.push({ label: 'new rule', before: '(none)', after: '[' + o.scope + (o.match ? ' ' + o.match : '') + '] ' + o.text }); break
      case 'disable_instruction': { const i = instr(o.instruction_id); rows.push({ label: 'retire rule', before: i ? '[' + i.scope + (i.match ? ' ' + i.match : '') + '] ' + i.text : o.instruction_id, after: 'disabled (kept, never deleted)' }); break }
      case 'rewrite_instruction': { const i = instr(o.instruction_id); rows.push({ label: 'rewrite rule', before: i ? i.text : o.instruction_id, after: o.text }); break }
      case 'rescope_instruction': { const i = instr(o.instruction_id); rows.push({ label: 'rescope rule', before: i ? i.scope + (i.match ? ' ' + i.match : '') : o.instruction_id, after: o.scope + (o.match ? ' ' + o.match : '') }); break }
      case 'prune_events': rows.push({ label: 'prune', before: o.ids.length + ' events older than the retention', after: 'deleted' }); break
      case 'rebuild_interaction': rows.push({ label: 'stats', before: o.address, after: 'interaction stats recomputed' }); break
      case 'unlink_threads': { const p = proj(o.project_id); const n = p ? (p.thread_ids || []).length : 0; const k = (o.thread_ids || []).length; rows.push({ label: 'thread links', before: pname(o.project_id) + ' · ' + n + ' linked thread' + (n === 1 ? '' : 's'), after: k + ' released (no to-do cites them, no message changed the project on them) · ' + Math.max(0, n - k) + ' kept' }); break }
    }
  }
  return rows
}

/** Stable identity of a proposal: group + the ids it acts on. Ignored fingerprints are never shown again. */
export function fingerprint (proposal) {
  const ids = []
  for (const o of (proposal.ops || [])) {
    for (const k of ['source_project_id', 'target_project_id', 'project_id', 'from_project_id', 'to_project_id', 'todo_id', 'address', 'instruction_id']) if (o[k]) ids.push(String(o[k]).toLowerCase())
    if (o.op === 'add_instruction') ids.push('add:' + String(o.scope) + ':' + String(o.match || '').toLowerCase())
    if (o.op === 'unlink_threads') ids.push('threads:' + (o.thread_ids || []).map(String).sort().join('+')) // the SAME orphans again = the same proposal; new ones = a new one
  }
  if (!ids.length) ids.push('text:' + String(proposal.title || proposal.question || proposal.headline || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80))
  return (proposal.group || proposal.section || '?') + '|' + [...new Set(ids)].sort().join(',')
}
