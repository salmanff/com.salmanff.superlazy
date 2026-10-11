// projectStore.js — PERMANENT core (Part 1: in-memory; Part 2: durable `projects` collection).
// The cross-thread home of the to-do list. A project owns its to-dos; threads merely reference
// the projects they touch. This store mints stable ids, tracks thread↔project links, exposes the
// linked-projects detail and the lightweight catalog the analysis request needs, and is mutated
// by reconcile.js from the model's output. See specs/pipeline-walkthrough.md §9 (Reconcile).

import { effImportance } from './dueDates.js'

// Max open-item EFFECTIVE priority (a to-do's "lower until due" hold counts while it is in force);
// manual project overrides preserve the effective value. The hold is date-dependent, so a project
// re-rates on the next recompute (every hydrate / edit) once a held to-do's due window opens.
export function recomputeImportance (p) {
  if (!p) return
  const opens = (p.todos || []).filter(t => t.status === 'open' || t.status === 'in_progress')
  p.computed_importance = Math.max(1, ...opens.map(t => effImportance(t)))
  if (!p.importance_locked) p.importance = p.computed_importance
}

// ---- thread links on a bare project RECORD (no store) ------------------------------------------
// The same three operations the store's methods perform, as pure functions, so the browser code
// that edits project objects without a store (ui.js moveTodo / mergeProject) keeps the links
// honest too. `thread_ids` is additive across writers (projectMerge unions it), so an unlink is a
// TOMBSTONE in `unlinked_threads`: the merge subtracts those, and a later real link (linkThread)
// clears the tombstone again. See specs/pipeline-backlog.md "Thread ↔ project association".
export function linkThreadOnRecord (p, threadId) {
  if (!p || !threadId) return false
  if (!Array.isArray(p.thread_ids)) p.thread_ids = []
  if (Array.isArray(p.unlinked_threads) && p.unlinked_threads.includes(threadId)) p.unlinked_threads = p.unlinked_threads.filter(t => t !== threadId)
  if (p.thread_ids.includes(threadId)) return false
  p.thread_ids.push(threadId)
  return true
}
export function unlinkThreadOnRecord (p, threadId) {
  if (!p || !threadId) return false
  const had = Array.isArray(p.thread_ids) && p.thread_ids.includes(threadId)
  if (had) p.thread_ids = p.thread_ids.filter(t => t !== threadId)
  if (!Array.isArray(p.unlinked_threads)) p.unlinked_threads = []
  if (!p.unlinked_threads.includes(threadId)) p.unlinked_threads.push(threadId)
  return had
}
// A thread id that names ONE conversation worth linking by id — a mail thread. A Slack stream id
// ('slack:<team>:<conversation>[:<parent>]') is a whole channel or DM: every chunk of it shares
// the id, so one chunk filed into a project would drag the entire channel onto its Messages tab.
// Agent sessions ('cc:<repo>:<session>') and notes ('note_<id>') are one conversation each but
// their items are always cited as evidence, so they need no id-level link either.
export const isMailThreadId = (tid) => !!tid && !/^(slack:|cc:|note_)/.test(String(tid))
// the threads a to-do's evidence came from (mail thread ids, chat stream ids, session ids)
export const threadsOfTodo = (t) => [...new Set(((t && t.evidence) || []).map(e => e && e.thread_id).filter(Boolean))]
// A to-do has just LEFT `project` (moved / reassigned / merged away): release the threads it
// brought, unless another to-do still in the project cites them. Links otherwise only ever grew,
// so a mis-filed thread stayed on the wrong project after the user had corrected every to-do
// (user, 2026-10-04: "unrelated threads on a project"). Returns the thread ids released.
export function releaseTodoThreadsOnRecord (project, todo) {
  if (!project || !todo) return []
  const out = []
  for (const tid of threadsOfTodo(todo)) {
    const stillCited = (project.todos || []).some(t => t !== todo && t.todo_id !== todo.todo_id && threadsOfTodo(t).includes(tid))
    if (stillCited) continue
    if (unlinkThreadOnRecord(project, tid)) out.push(tid)
  }
  return out
}

export function createProjectStore () {
  const projects = new Map()        // project_id -> project record
  const threadLinks = new Map()     // thread_id -> Set(project_id)
  let pseq = 0                       // project id counter
  let tseq = 0                       // GLOBAL todo id counter (ids unique across projects)
  let rseq = 0                       // GLOBAL suggested-response id counter

  const mintProjectId = () => 'p_' + (++pseq).toString(36).padStart(2, '0')
  const mintTodoId = () => 't_' + (++tseq).toString(36).padStart(2, '0')
  const mintResponseId = () => 'r_' + (++rseq).toString(36).padStart(2, '0')

  // USER-minted ids (a project created by hand on the board, a task typed into "+ Add").
  // The sequence above is only unique WITHIN one hydrated store — a browser tab and the analyzer
  // (or two tabs) hydrate separately and would both mint p_04 for DIFFERENT projects, leaving two
  // rows fighting over one key. A user id is unique by construction instead (timestamp + random),
  // and the '_u_' marker keeps it out of the sequence counters (seqOf ignores it), so the
  // analyzer's ids stay short. See projectMerge.js for the incident behind this.
  const uidTail = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
  const mintUserProjectId = () => 'p_u_' + uidTail()
  const mintUserTodoId = () => 't_u_' + uidTail()

  function get (id) { return projects.get(id) || null }
  function all () { return [...projects.values()] }

  // Drop a project from the working set (the Edit-project modal's "Delete project"). Also unhooks
  // its thread links, so a later message on one of those threads is matched fresh rather than
  // routed to a project that no longer exists. The DURABLE delete is persist.deleteProject.
  function remove (id) {
    if (!id || !projects.has(id)) return false
    projects.delete(id)
    for (const [tid, set] of threadLinks) {
      set.delete(id)
      if (!set.size) threadLinks.delete(tid)
    }
    return true
  }

  // Load previously persisted project records into a fresh store and bump the id counters past
  // every id already in use — WITHOUT this, a new session would mint p_01/t_01 again and collide
  // with stored records. Call once, before any minting. (The persistence layer itself lands with
  // the ingestion build; this makes the store safe for it.)
  const seqOf = (id, prefix) => {
    const s = String(id || '')
    if (!s.startsWith(prefix)) return 0
    const rest = s.slice(prefix.length)
    if (rest.includes('_')) return 0 // a user-minted id (p_u_… / t_u_…) — not part of the sequence
    const n = parseInt(rest, 36)
    return Number.isFinite(n) ? n : 0
  }
  // Advance the id counters past `records` without loading them — a store that starts EMPTY on
  // purpose (the sessions page's bootstrap dry run) must still mint p_/t_/r_ ids beyond the real
  // catalog's, or saving its projects later overwrites real ones.
  function seedIds (records) {
    for (const p of (records || [])) {
      if (!p || !p.project_id) continue
      pseq = Math.max(pseq, seqOf(p.project_id, 'p_'))
      for (const t of (p.todos || [])) tseq = Math.max(tseq, seqOf(t.todo_id, 't_'))
      for (const r of (p.responses || [])) rseq = Math.max(rseq, seqOf(r.response_id, 'r_'))
    }
  }
  function hydrate (records) {
    for (const p of (records || [])) {
      if (!p || !p.project_id) continue
      if (!Array.isArray(p.sources)) p.sources = [] // records written before source tagging existed
      if (!Array.isArray(p.thread_ids)) p.thread_ids = []
      if (!Array.isArray(p.unlinked_threads)) p.unlinked_threads = []
      // a tombstoned thread never links, whatever an older writer's copy still carried
      if (p.unlinked_threads.length) p.thread_ids = p.thread_ids.filter(t => !p.unlinked_threads.includes(t))
      recomputeImportance(p)
      projects.set(p.project_id, p)
      pseq = Math.max(pseq, seqOf(p.project_id, 'p_'))
      for (const t of (p.todos || [])) tseq = Math.max(tseq, seqOf(t.todo_id, 't_'))
      for (const r of (p.responses || [])) rseq = Math.max(rseq, seqOf(r.response_id, 'r_'))
      for (const tid of (p.thread_ids || [])) {
        if (!threadLinks.has(tid)) threadLinks.set(tid, new Set())
        threadLinks.get(tid).add(p.project_id)
      }
    }
  }

  function ensureProject ({ project_id, name, asof }) {
    let p = projects.get(project_id)
    if (!p) {
      p = {
        project_id,
        name: name || 'Untitled project',
        summary: '',
        keywords: [],            // precise, search-worthy tags maintained by the model (future: similar/completed-project matching)
        importance: 3,           // EFFECTIVE importance (user override if locked, else computed)
        computed_importance: 3,  // always the max of open todos (shown as the dot RIM, even when locked)
        participants: {},        // address -> { role: me|team|external, role_note, last_updated_asof }
        participant_emails: [],  // flat, searchable array of just the participant emails (= keys of participants)
        todos: [],               // embedded to-do objects (see reconcile.normalizeTodo)
        responses: [],           // embedded suggested-reply objects (answers/delegations/reminders)
        thread_ids: [],
        unlinked_threads: [],    // tombstones: threads deliberately released (see unlinkThread) — the save-time merge subtracts them
        // WHICH source(s) fed this project — 'email:<address of the mail account>' (see addSource in
        // persist.js). Union, because two accounts can both touch one project. It is what makes a
        // per-account "forget this account" possible: a project whose sources reduce to nothing when
        // one account is removed can be deleted; one that is still fed by another account stays.
        sources: [],
        status: 'active',
        created_asof: asof,
        last_active_asof: asof
      }
      projects.set(project_id, p)
    }
    return p
  }

  function linkThread (threadId, projectId) {
    if (!threadId) return
    if (!threadLinks.has(threadId)) threadLinks.set(threadId, new Set())
    threadLinks.get(threadId).add(projectId)
    linkThreadOnRecord(projects.get(projectId), threadId)
  }
  // Release one thread from one project — tombstoned, so the 3-way merge does not re-union it
  // back from a stale copy (projectMerge.mergeStored).
  function unlinkThread (threadId, projectId) {
    if (!threadId) return false
    const set = threadLinks.get(threadId)
    if (set) { set.delete(projectId); if (!set.size) threadLinks.delete(threadId) }
    return unlinkThreadOnRecord(projects.get(projectId), threadId)
  }
  // a to-do has just left `project`: release the threads only it brought (releaseTodoThreadsOnRecord)
  function releaseTodoThreads (project, todo) {
    const released = releaseTodoThreadsOnRecord(project, todo)
    for (const tid of released) {
      const set = threadLinks.get(tid)
      if (set) { set.delete(project.project_id); if (!set.size) threadLinks.delete(tid) }
    }
    return released
  }

  // The full project records a thread is linked to (the model edits these in place).
  function linkedProjectsFor (threadId) {
    const ids = threadLinks.get(threadId)
    if (!ids) return []
    return [...ids].map(id => projects.get(id)).filter(Boolean)
  }


  // FALLBACK linking: projects whose to-dos cite any of these message ids as evidence. Used when
  // a thread has no direct link — e.g. a bootstrap-written thread id that doesn't byte-match the
  // provider's (the bootstrap model echoes surrogate ids; an unmapped echo is stored as-is).
  // Direct links stay authoritative; this recovers the association via the messages themselves.
  function projectsCitingMessages (msgIds) {
    const want = new Set([...(msgIds || [])].filter(Boolean))
    if (!want.size) return []
    const out = []
    for (const p of projects.values()) {
      const hit = (p.todos || []).some(t => (t.evidence || []).some(e => e && want.has(e.msg_id)))
      if (hit) out.push(p)
    }
    return out
  }

  const openish = (t) => t.status === 'open' || t.status === 'in_progress'

  // The lightweight catalog of OTHER active projects (everything not in excludeIds), for the
  // model to spot cross-cutting links / pull detail / start anew. Includes participants — the
  // strongest cheap matching signal (same people ⇒ likely same project).
  function catalog (excludeIds = []) {
    const skip = new Set(excludeIds)
    return all()
      .filter(p => p.status === 'active' && !skip.has(p.project_id))
      .map(p => ({
        project_id: p.project_id,
        name: p.name,
        summary: p.summary,
        keywords: p.keywords || [],
        importance: p.importance,
        open_todo_count: p.todos.filter(openish).length,
        last_active_asof: p.last_active_asof,
        participants: (p.participant_emails && p.participant_emails.length) ? p.participant_emails : Object.keys(p.participants),
        // the repos feeding this project ('repo:<slug>' source tags). Agent-session items carry NO
        // participants, so for them the repo is the strongest cheap matching signal there is.
        repos: (p.sources || []).filter(t => String(t).startsWith('repo:')).map(t => String(t).slice(5).split('-').filter(Boolean).pop())
      }))
      .sort((a, b) => (b.last_active_asof || 0) - (a.last_active_asof || 0))
  }

  // Deterministic append of a read_only to-do to an EXISTING project — the path a workflow uses to
  // file a message WITHOUT the LLM (reconcile is for LLM deltas). Mints the id, builds the same
  // to-do shape reconcile.normalizeTodo produces, links the thread, recomputes importance. Returns
  // { todo, project }. See workflows.js (newsletter shortCircuit).
  function addReadOnlyTodo ({ projectId, short_description, description, sender, importance, change_reason, asof, msgId, threadId, channel }) {
    const project = ensureProject({ project_id: projectId, asof })
    const todo = {
      todo_id: mintTodoId(),
      project_id: project.project_id,
      direction: 'read_only',
      short_description: short_description || '',
      description: description || '',
      sender: sender || null,
      importance: Math.max(1, Math.min(5, Math.round(Number(importance) || 1))),
      importance_locked: false,
      owner: null,
      owners: [],
      counterparty: null,
      status: 'open',
      evidence: [{ type: channel || 'mail', source: channel || 'mail', thread_id: threadId || null, msg_id: msgId || null, asof, reason: change_reason || null, who: sender || null }],
      evidence_msg_id: null,
      due_hint: null,
      change_reason: change_reason || null,
      created_asof: asof,
      resolved_asof: null
    }
    project.todos.push(todo)
    linkThread(threadId, project.project_id)
    project.last_active_asof = asof
    recomputeImportance(project)
    return { todo, project }
  }

  return {
    projects, threadLinks,
    mintProjectId, mintTodoId, mintResponseId, mintUserProjectId, mintUserTodoId,
    get, all, remove, hydrate, seedIds, ensureProject, linkThread, unlinkThread, releaseTodoThreads, linkedProjectsFor, projectsCitingMessages, catalog, recomputeImportance, openish,
    addReadOnlyTodo
  }
}
