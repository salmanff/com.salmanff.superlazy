// jobs/analyze_thread/maintenance/applyProposals.js — apply ACCEPTED clean-up proposals to the real stores, one
// OPERATION at a time (ops.js is the vocabulary; specs/superlazy-weekly-cleanup.md §5). The one
// place maintenance mutates anything. Contract (specs/pipeline-walkthrough.md Part 3, "After a restructure, drop the pin"):
//   · the whole apply holds the ingestion run lock (kind 'audit') so a mail check never
//     interleaves with a store rewrite;
//   · every change is recorded as a manual_edit event (source 'maintenance', the run id on it) —
//     the same unified history user edits and LLM analyses go in;
//   · the stored durable-turn snapshot pin is CLEARED at the end, so the next analysis renders
//     (and re-caches) a catalog that reflects the new map.
// Each proposal applies best-effort: one failure never loses the rest. Within a proposal, ops run
// in order and a tmp_id minted by create_project is visible to the later ops of that proposal.

import { profileHistorySnapshot } from '../persist.js'
import { FILE_TO_PROJECT } from '../autoProcess.js'
import { applyEventsPruning } from './deterministic.js'
import { archiveProject } from './archive.js'
import { effImportance } from '../dueDates.js'

const openish = (t) => t && (t.status === 'open' || t.status === 'in_progress')
const clampImp = (n, d = 3) => Math.max(1, Math.min(5, Math.round(Number(n) || d)))

function recomputeImportance (p) {
  const opens = (p.todos || []).filter(openish)
  if (opens.length) p.computed_importance = Math.max(...opens.map(t => effImportance(t))) // the until-due hold counts
  if (!p.importance_locked && opens.length) p.importance = p.computed_importance
}

// apply order across proposals, so ids stay valid (spec §5.2)
const ORDER = ['stale', 'attention', 'split', 'merge', 'archive', 'people', 'rules', 'learn', 'housekeeping']

/**
 * @param {Object} o
 * @param {Object} o.freezr
 * @param {Object} o.persist       createPersistence() result
 * @param {Object} o.store         hydrated project store
 * @param {Object} o.profiles      hydrated profile store
 * @param {Object} o.instructions  createInstructionStore() result, hydrated
 * @param {Array}  o.items         accepted proposals: { key, group, ops (validated), title }
 * @param {string} o.runId
 * @param {Function} [o.onProgress] (done, total, note)
 * @returns {Promise<{ results: [{ key, ok, note, error }] }>}
 */
export async function applyAccepted ({ freezr, persist, store, profiles, instructions, items, runId, onProgress }) {
  const owner = 'cleanup-' + Math.random().toString(36).slice(2, 8)
  const got = await persist.acquireRunLock({ owner, kind: 'audit' })
  if (!got.ok) {
    const h = got.holder
    throw new Error('another run holds the ingestion lock' + (h ? ' (' + (h.kind || '') + ' by ' + (h.owner || '?') + ')' : '') + ' — wait for it to finish, then apply again')
  }
  const asof = Date.now()
  const ev = (fields, extra) => persist.addEvent({ type: 'manual_edit', kind: 'manual_edit', source: 'maintenance', source_id: 'maintenance', maintenance_run_id: runId || null, asof, ...fields, ...(extra || {}) })
    .catch(e => console.warn('[superlazy cleanup] event save failed:', e && e.message))
  const saveProject = (p) => persist.saveProject(p).catch(e => { throw new Error('project save failed: ' + e.message) })
  const saveProfile = (p) => persist.saveProfile(p).catch(e => { throw new Error('profile save failed: ' + e.message) })
  const saveInstruction = (r) => persist.saveInstruction(r).catch(e => { throw new Error('instruction save failed: ' + e.message) })
  const evidenceEntry = (reason) => ({ type: 'manual', source: 'maintenance', thread_id: null, msg_id: null, asof, reason, who: 'clean-up (accepted by you)' })
  const proj = (id) => { const p = store.get(id); if (!p) throw new Error('project not found: ' + id); return p }
  const todo = (pid, tid) => { const p = proj(pid); const t = (p.todos || []).find(x => x.todo_id === tid); if (!t) throw new Error('to-do not found: ' + tid); return { p, t } }
  let mapChanged = false

  const moveTodo = async (tid, fromId, toId, note) => {
    const from = proj(fromId); const to = proj(toId)
    const i = (from.todos || []).findIndex(t => t.todo_id === tid)
    if (i < 0) throw new Error('to-do ' + tid + ' not in ' + fromId)
    const t = from.todos.splice(i, 1)[0]
    // the threads only this to-do brought leave with it — a link that outlives its to-do is how a
    // mis-filed thread stayed on the wrong project (store.releaseTodoThreads; backlog 2026-10-04)
    store.releaseTodoThreads(from, t)
    t.project_id = to.project_id
    t.evidence = Array.isArray(t.evidence) ? t.evidence.slice() : []
    t.evidence.push(evidenceEntry(note))
    to.todos = to.todos || []
    to.todos.push(t)
    for (const e of t.evidence) if (e.thread_id) store.linkThread(e.thread_id, to.project_id)
    to.participants = to.participants || {}
    for (const a of [t.sender, t.owner, t.counterparty, ...(t.owners || []), ...(Array.isArray(t.who) ? t.who : [])]) {
      if (a && from.participants && from.participants[a] && !to.participants[a]) to.participants[a] = from.participants[a]
    }
    to.participant_emails = Object.keys(to.participants || {})
    to.last_active_asof = Math.max(Number(to.last_active_asof) || 0, asof)
    recomputeImportance(from); recomputeImportance(to)
    await saveProject(from); await saveProject(to)
    await ev({ field: 'project', target: 'todo', todo_id: tid, project_id: to.project_id, project_id_2: from.project_id, before: from.name || from.project_id, after: to.name || to.project_id })
    mapChanged = true
    return t
  }

  const handlers = {
    async merge_project (o) {
      const source = proj(o.source_project_id); const target = proj(o.target_project_id)
      if (source === target) throw new Error('source and target are the same')
      target.todos = target.todos || []
      let moved = 0
      for (const t of (source.todos || [])) {
        t.project_id = target.project_id
        t.evidence = Array.isArray(t.evidence) ? t.evidence.slice() : []
        t.evidence.push(evidenceEntry('merged from “' + (source.name || '') + '” into “' + (target.name || '') + '”'))
        target.todos.push(t); moved++
      }
      source.todos = []
      target.responses = target.responses || []
      for (const r of (source.responses || [])) { r.project_id = target.project_id; target.responses.push(r) }
      source.responses = []
      target.participants = target.participants || {}
      for (const [a, role] of Object.entries(source.participants || {})) if (!target.participants[a]) target.participants[a] = role
      target.participant_emails = Object.keys(target.participants)
      // the threads MOVE: linked to the target, released from the retired source (which otherwise
      // keeps answering linkedProjectsFor and listing the mail on its card)
      for (const tid of (source.thread_ids || []).slice()) { store.linkThread(tid, target.project_id); store.unlinkThread(tid, source.project_id) }
      source.merged_into = target.project_id
      recomputeImportance(source); recomputeImportance(target)
      target.last_active_asof = Math.max(Number(target.last_active_asof) || 0, asof)
      await saveProject(source); await saveProject(target)
      await ev({ field: 'merged', target: 'project', project_id: target.project_id, project_id_2: source.project_id, before: source.name || source.project_id, after: target.name || target.project_id, count: moved })
      mapChanged = true
      return 'merged “' + (source.name || '') + '” into “' + (target.name || '') + '” (' + moved + ' to-do(s))'
    },
    async create_project (o, tmp) {
      const dest = store.ensureProject({ project_id: store.mintUserProjectId(), name: o.name || 'Untitled project', asof })
      if (o.summary) { dest.summary = o.summary; dest.llm_summary = o.summary }
      if (o.importance) dest.importance = clampImp(o.importance)
      dest.llm_name = dest.name
      await saveProject(dest)
      await ev({ field: 'created', target: 'project', project_id: dest.project_id, before: null, after: dest.name })
      tmp[o.tmp_id] = dest.project_id
      mapChanged = true
      return 'created “' + dest.name + '”'
    },
    async move_todo (o, tmp) {
      const to = tmp[o.to_project_id] || o.to_project_id
      const t = await moveTodo(o.todo_id, o.from_project_id, to, 'moved by the clean-up into “' + (proj(to).name || '') + '”')
      return 'moved “' + (t.short_description || o.todo_id) + '” → “' + (proj(to).name || to) + '”'
    },
    async resolve_todo (o) { return setStatus(o, 'resolved') },
    async cancel_todo (o) { return setStatus(o, 'cancelled') },
    async snooze_todo (o) {
      const { p, t } = todo(o.project_id, o.todo_id)
      const before = t.due_hint || null
      t.due_hint = 'revisit by ' + o.until
      t.due_earliest = o.until; t.due_latest = o.until
      t.due_demote = 1 // lower priority until the window (the task editor's own "lower until due" choice)
      await saveProject(p)
      await ev({ field: 'due_hint', target: 'todo', todo_id: t.todo_id, project_id: p.project_id, before, after: t.due_hint })
      return '“' + (t.short_description || '') + '” snoozed until ' + o.until
    },
    async set_todo (o) {
      const { p, t } = todo(o.project_id, o.todo_id)
      const notes = []
      for (const [k, v] of Object.entries(o.fields || {})) {
        const before = t[k]
        if (k === 'importance') {
          if (t.importance_locked) { notes.push('priority kept (user-set)'); continue }
          t.importance = clampImp(v); t.llm_importance = t.importance
        } else if (k === 'who') {
          t.who = Array.isArray(v) ? v : [String(v)]
          if (t.direction === 'i_owe_them') t.counterparty = t.who[0] || null; else if (t.direction !== 'read_only') t.owner = t.who[0] || null
        } else t[k] = v
        await ev({ field: k, target: 'todo', todo_id: t.todo_id, project_id: p.project_id, before: Array.isArray(before) ? before.join(', ') : (before == null ? null : String(before)).slice(0, 300), after: (Array.isArray(v) ? v.join(', ') : String(v)).slice(0, 300) })
        notes.push(k)
      }
      recomputeImportance(p)
      await saveProject(p)
      return '“' + (t.short_description || '') + '”: ' + notes.join(', ') + ' changed'
    },
    async create_todo (o) {
      const p = proj(o.project_id)
      const td = o.todo || {}
      const dir = ['i_owe_them', 'they_owe_me', 'team_owes', 'read_only'].includes(td.direction) ? td.direction : 'read_only'
      const who = Array.isArray(td.who) ? td.who : []
      const t = {
        todo_id: store.mintUserTodoId(), project_id: p.project_id, direction: dir,
        short_description: td.short_description || '', description: td.description || '', sender: null,
        importance: clampImp(td.importance), importance_locked: false,
        who, owner: dir === 'they_owe_me' || dir === 'team_owes' ? (who[0] || null) : null, owners: [],
        counterparty: dir === 'i_owe_them' ? (who[0] || null) : null,
        status: 'open', evidence: [evidenceEntry('added by the clean-up')], evidence_msg_id: null,
        due_hint: td.due_hint || null, change_reason: 'clean-up', created_asof: asof, resolved_asof: null
      }
      p.todos = p.todos || []; p.todos.push(t)
      recomputeImportance(p); p.last_active_asof = Math.max(Number(p.last_active_asof) || 0, asof)
      await saveProject(p)
      await ev({ field: 'created', target: 'todo', todo_id: t.todo_id, project_id: p.project_id, before: null, after: t.short_description })
      return 'added “' + t.short_description + '” to “' + (p.name || '') + '”'
    },
    async archive_project (o, tmp, item) {
      const p = proj(o.project_id)
      const r = await archiveProject({ freezr, persist, store, project: p, runId, reason: item && item.description ? String(item.description).slice(0, 300) : null, asof })
      await ev({ field: 'archived', target: 'project', project_id: p.project_id, before: p.name || p.project_id, after: null, count: r.closed })
      mapChanged = true
      return 'archived “' + (p.name || '') + '”' + (r.closed ? ' (closed ' + r.closed + ' open to-do(s))' : '')
    },
    async rename_project (o) {
      const p = proj(o.project_id); const before = p.name || ''
      p.name = o.name; p.llm_name = o.name
      await saveProject(p)
      await ev({ field: 'name', target: 'project', project_id: p.project_id, before, after: p.name })
      mapChanged = true
      return 'renamed “' + before + '” → “' + p.name + '”'
    },
    async set_project_summary (o) {
      const p = proj(o.project_id); const before = p.summary || ''
      p.summary = o.summary; p.llm_summary = o.summary
      await saveProject(p)
      await ev({ field: 'summary', target: 'project', project_id: p.project_id, before, after: p.summary })
      mapChanged = true
      return 'summary updated for “' + (p.name || '') + '”'
    },
    async update_profile (o, tmp, item) {
      const prof = profiles.get(o.address)
      if (!prof) throw new Error('no profile for ' + o.address)
      const before = { ...prof.profile }
      const f = o.fields || {}
      const applied = profiles.applyReprofile(o.address, {
        summary: f.summary != null ? f.summary : before.summary,
        relationship: f.relationship != null ? f.relationship : before.relationship,
        // responsibilities: pass the proposal THROUGH applyModelResponsibilities (inside
        // applyReprofile) so the user's own entries are kept and only the model's are refreshed.
        // `undefined` when the proposal does not mention them — that leaves the list untouched.
        responsibilities: f.responsibilities != null ? f.responsibilities : undefined,
        llm_importance: f.llm_importance != null ? f.llm_importance : undefined,
        change_note: (item && item.description) || 'clean-up'
      }, { asof, userRequested: true })
      if (!applied) throw new Error('profile update was refused')
      if (before.solidified_asof || before.user_edited) {
        await persist.saveProfileHistory(profileHistorySnapshot(o.address, before, { manualRank: prof.manual_rank, source: 'reprofile:cleanup', reason: (item && item.title) || null, asof })).catch(() => {})
      }
      await saveProfile(prof)
      await ev({ field: 'profile', target: 'profile', address: o.address, before: (before.summary || '').slice(0, 300), after: String(f.summary != null ? f.summary : before.summary || '').slice(0, 300) })
      return 'profile updated for ' + o.address + ' (' + Object.keys(f).join(', ') + ')'
    },
    async set_auto_process (o) {
      const r = profiles.setAutoProcess(o.address, { type: FILE_TO_PROJECT, active: true, details: { project_id: o.project_id, disposition: o.disposition }, locked: false, suggested: false, source: 'user', asof })
      if (!r) throw new Error('could not set the auto-process for ' + o.address)
      await saveProfile(profiles.get(o.address))
      await ev({ field: 'auto_process', target: 'profile', address: o.address, before: null, after: 'file_to_project ' + o.project_id + ' (' + o.disposition + ')' })
      return o.address + ' now files into “' + (proj(o.project_id).name || o.project_id) + '”'
    },
    async set_manual_rank (o) {
      const prof = profiles.get(o.address)
      if (!prof) throw new Error('no profile for ' + o.address)
      const before = prof.manual_rank == null ? null : prof.manual_rank
      prof.manual_rank = o.rank
      await saveProfile(prof)
      await ev({ field: 'manual_rank', target: 'profile', address: o.address, before, after: o.rank })
      return o.address + ' ranked ' + o.rank
    },
    async add_instruction (o, tmp, item) {
      const rec = instructions.add({ scope: o.scope, match: o.match, text: o.text, asof })
      if (!rec) throw new Error('empty instruction')
      rec.author = 'model'
      rec.proposed_in_run = runId || null
      await saveInstruction(rec)
      await ev({ field: 'instruction', target: 'instructions', before: null, after: '[' + rec.scope + (rec.match ? ' ' + rec.match : '') + '] ' + rec.text.slice(0, 200) })
      return 'rule added [' + rec.instruction_id + ']'
    },
    async disable_instruction (o) {
      const rec = instructions.disable(o.instruction_id)
      if (!rec) throw new Error('unknown instruction ' + o.instruction_id)
      rec.edited_asof = asof
      await saveInstruction(rec)
      await ev({ field: 'instruction_status', target: 'instructions', before: 'active', after: 'disabled', instruction_id: rec.instruction_id })
      return 'rule [' + rec.instruction_id + '] disabled'
    },
    async rewrite_instruction (o) {
      const rec = instructions.all().find(i => i.instruction_id === o.instruction_id)
      if (!rec) throw new Error('unknown instruction ' + o.instruction_id)
      const before = rec.text
      rec.history = Array.isArray(rec.history) ? rec.history : []
      rec.history.push({ text: before, scope: rec.scope, match: rec.match, asof })
      rec.text = String(o.text).trim(); rec.label = rec.text.length > 42 ? rec.text.slice(0, 42) + '…' : rec.text
      rec.edited_asof = asof
      await saveInstruction(rec)
      await ev({ field: 'instruction_text', target: 'instructions', before: before.slice(0, 200), after: rec.text.slice(0, 200), instruction_id: rec.instruction_id })
      return 'rule [' + rec.instruction_id + '] rewritten'
    },
    async rescope_instruction (o) {
      const rec = instructions.all().find(i => i.instruction_id === o.instruction_id)
      if (!rec) throw new Error('unknown instruction ' + o.instruction_id)
      const before = rec.scope + (rec.match ? ' ' + rec.match : '')
      rec.history = Array.isArray(rec.history) ? rec.history : []
      rec.history.push({ text: rec.text, scope: rec.scope, match: rec.match, asof })
      rec.scope = o.scope
      rec.match = o.scope === 'all' ? null : (o.scope === 'domain' ? ('@' + String(o.match || '').toLowerCase().replace(/^.*@/, '')) : (o.scope === 'sender' ? String(o.match || '').toLowerCase() : String(o.match || '')))
      rec.edited_asof = asof
      await saveInstruction(rec)
      await ev({ field: 'instruction_scope', target: 'instructions', before, after: rec.scope + (rec.match ? ' ' + rec.match : ''), instruction_id: rec.instruction_id })
      return 'rule [' + rec.instruction_id + '] now ' + rec.scope + (rec.match ? ' ' + rec.match : '')
    },
    async prune_events (o) {
      const r = await applyEventsPruning({ freezr, ids: o.ids || [], onProgress: (done, total) => onProgress && onProgress(done, total, 'pruning events') })
      await ev({ field: 'pruned_events', target: 'events', before: (o.ids || []).length, after: null, count: r.deleted })
      return 'deleted ' + r.deleted + ' event(s)' + (r.failed ? ', ' + r.failed + ' failed' : '')
    },
    async unlink_threads (o) {
      const p = proj(o.project_id)
      const before = (p.thread_ids || []).length
      let released = 0
      for (const tid of (o.thread_ids || [])) if (store.unlinkThread(tid, p.project_id)) released++ // tombstoned — the save-time merge keeps the removal
      await saveProject(p)
      await ev({ field: 'threads', target: 'project', project_id: p.project_id, before, after: (p.thread_ids || []).length, count: released })
      return 'released ' + released + ' thread link' + (released === 1 ? '' : 's') + ' from “' + (p.name || '') + '”'
    },
    async rebuild_interaction (o) {
      const prof = profiles.get(o.address)
      if (!prof) throw new Error('no profile for ' + o.address)
      prof.interaction_data = { ...prof.interaction_data, ...o.rebuilt }
      await saveProfile(prof)
      return 'interaction stats replaced for ' + o.address
    }
  }

  async function setStatus (o, status) {
    const { p, t } = todo(o.project_id, o.todo_id)
    const before = t.status
    t.status = status; t.resolved_asof = asof
    t.evidence = Array.isArray(t.evidence) ? t.evidence.slice() : []
    t.evidence.push(evidenceEntry('clean-up: ' + status))
    recomputeImportance(p)
    await saveProject(p)
    await ev({ field: 'status', target: 'todo', todo_id: t.todo_id, project_id: p.project_id, before, after: status })
    return '“' + (t.short_description || '') + '” → ' + status
  }

  const results = []
  const ordered = items.slice().sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group))
  try {
    let done = 0
    for (const item of ordered) {
      const tmp = {}
      const notes = []
      let error = null
      for (const o of (item.ops || [])) {
        try {
          const h = handlers[o.op]
          if (!h) throw new Error('no handler for op ' + o.op)
          notes.push(await h(o, tmp, item))
        } catch (e) {
          error = (e && e.message) || String(e)
          break // the rest of THIS proposal is skipped; later proposals still run
        }
      }
      results.push({ key: item.key, ok: !error, note: notes.join('; ') || (item.ops && item.ops.length ? '' : 'note only — nothing to apply'), error })
      done++
      if (onProgress) onProgress(done, ordered.length, item.title || item.group)
      if (done % 5 === 0) await persist.renewRunLock({ owner }).catch(() => {})
    }
    if (mapChanged || results.some(r => r.ok)) await persist.stampSettingsFields({ snapshot_pin: null }).catch(() => {})
  } finally {
    await persist.releaseRunLock({ owner }).catch(() => {})
  }
  return { results }
}
