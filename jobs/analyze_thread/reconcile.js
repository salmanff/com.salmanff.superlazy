// reconcile.js — PERMANENT core (v0.3). Apply the model's projects-nested OUTPUT to the
// in-memory project store: mint project + todo ids (mapping tmp_ids), reassign todos that moved
// projects, maintain each todo's evidence list, enforce invariants (resolution
// needs evidence), keep per-project summary/importance/participants current, and compute the
// latest_delta surface + new/changed sets for the UI. See specs/pipeline-walkthrough.md §9.

import { storedFromWho, whoListFrom } from './whoMapping.js' // 2026-09-19 shim — see that file; deletable after a storage migration

const ACTION_DIRECTIONS = new Set(['i_owe_them', 'they_owe_me', 'team_owes'])

function clampImportance (v, dflt) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.max(1, Math.min(5, n))
}

function normalizeTodo (t, id, ctx) {
  const direction = ACTION_DIRECTIONS.has(t.direction) ? t.direction : (t.direction === 'read_only' ? 'read_only' : 'i_owe_them')
  const isRead = direction === 'read_only'
  const whoStored = isRead ? { owner: null, owners: [], counterparty: null } : storedFromWho(t, ctx)
  return {
    todo_id: id,
    project_id: null, // stamped by reconcile once the owning project id is known
    direction,
    short_description: t.short_description || '',
    description: t.description || '',
    sender: t.sender || ctx.from || null,   // who RAISED/assigned it (default: the message sender)
    importance: clampImportance(t.importance, 3),
    importance_locked: !!t.importance_locked, // user set the priority — the model must not override
    // 2026-09-19: the model now sends ONE `who` — one person or several — and whoMapping spreads
    // it across the stored fields exactly as the task editor does, so an analyser-written item and
    // a hand-edited one look the same. It also honours an older reply still sending the old
    // fields. Delete with that shim.
    ...whoStored,
    status: t.status || 'open',
    evidence: [],
    evidence_msg_id: t.evidence_msg_id || null,
    due_hint: t.due_hint || null,
    due_earliest: isoDate(t.due_earliest),
    due_latest: isoDate(t.due_latest),
    change_reason: t.change_reason || null,
    // THE MODEL'S OWN BASELINE — the last values the LLM set for these fields, kept beside the
    // live ones so a manual edit is always distinguishable from (and revertable to) the machine's
    // reading. Stamped by stampLlmBaseline() whenever the model actually emits the field; never
    // touched by a manual edit, so `importance !== llm_importance` IS "the user overrode this".
    llm_importance: null,
    llm_short_description: null,
    llm_description: null,
    created_asof: null,
    resolved_asof: null
  }
}

// Record what the MODEL set, on the fields a user is likely to override later. Only fields the
// model actually emitted are stamped (`emitted`) — a field it never saw keeps the previous
// baseline rather than being overwritten with a carried-forward value.
const LLM_BASELINE = { importance: 'llm_importance', short_description: 'llm_short_description', description: 'llm_description' }
function stampLlmBaseline (todo, emitted) {
  for (const [field, key] of Object.entries(LLM_BASELINE)) {
    if (emitted && !emitted.has(field)) continue
    todo[key] = todo[field] != null ? todo[field] : null
  }
}

// The field-level diff of what this message did to a to-do. Kept OFF the event's `changes` list
// (which drives the Recent/Events feeds — a priority nudge does not deserve its own feed row) and
// carried in the event's own `todo_edits` instead, so the detail is on the record for a future
// detailed view without adding noise to the current ones.
const TRACKED_EDITS = ['importance', 'short_description', 'description', 'direction', 'due_hint', 'status']
function diffTodo (before, after) {
  const out = []
  if (!before) return out
  for (const field of TRACKED_EDITS) {
    const b = before[field] != null ? before[field] : null
    const a = after[field] != null ? after[field] : null
    if (String(b == null ? '' : b) !== String(a == null ? '' : a)) out.push({ field, from: b, to: a })
  }
  return out
}

// machine due window — accept only clean ISO dates from the model
const isoDate = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null)

const RESP_KINDS = new Set(['answer', 'delegate', 'reminder'])
const asArr = (v) => Array.isArray(v) ? v.filter(Boolean) : (v ? [v] : [])

// A suggested reply (answer / delegation / reminder). Lightweight; merged like todos.
function normalizeResponse (r, id, ctx, dirFallback) {
  const direction = ACTION_DIRECTIONS.has(r.direction) || r.direction === 'read_only' ? r.direction : (dirFallback || 'i_owe_them')
  return {
    response_id: id,
    todo_id: r.todo_id || null,
    project_id: null,
    direction,
    kind: RESP_KINDS.has(r.kind) ? r.kind : 'answer',
    to: asArr(r.to),
    cc: asArr(r.cc),
    subject: r.subject || null,
    body: r.body || '',
    reminder_at: r.reminder_at != null ? (Number(r.reminder_at) || null) : null,
    status: ['suggested', 'edited', 'sent', 'dismissed'].includes(r.status) ? r.status : 'suggested',
    created_asof: null,
    change_reason: r.change_reason || null
  }
}

// Append an evidence entry (dedup by msg_id) to a todo's audit trail. `who` = the analysed
// message's sender — the ACTOR of this change, so activity timelines can say "Bob added…".
// `changed` = [{ field, from, to }] — the field-level diff this message applied, so the task's
// history can say "priority 3 → 5" rather than only the model's prose reason.
function pushEvidence (list, ctx, reason, changed) {
  const out = Array.isArray(list) ? list.slice() : []
  const edits = (changed && changed.length) ? changed : null
  const existing = ctx.msgId ? out.find(e => e.msg_id === ctx.msgId && e.thread_id === ctx.threadId) : null
  if (existing) {
    // same message touching the item twice in one batch — enrich the entry it already has
    if (edits) existing.changed = [...(existing.changed || []), ...edits]
    return out
  }
  // type/source = the item's CHANNEL (specs/superlazy-inputs.md; legacy records say 'email' —
  // readers only ever test for 'manual', so the two spellings coexist harmlessly).
  // via = the conversation title for chat items ("Slack DM: A, B") — the attribution readers
  // show it because a chunk's `who` (its first author) is very often the user themself.
  // rules: the standing instructions the model said it applied to THIS message (prompt 0.54), so a
  // to-do's own trail shows which instruction shaped it. Omitted entirely when none were cited —
  // this trail is stored on every item and an empty array on all of them is pure weight.
  const rules = (ctx.rules && ctx.rules.length) ? ctx.rules.slice() : undefined
  out.push({ type: ctx.channel || 'mail', source: ctx.source || ctx.channel || 'mail', thread_id: ctx.threadId || null, msg_id: ctx.msgId || null, asof: ctx.asof, reason: reason || null, who: ctx.from || null, via: ctx.via || undefined, summary: ctx.summary || null, changed: edits, rules })
  return out
}

// Tmp-shaped ids ('n1', 'p2', …) are the per-reply scratch names the prompt instructs for NEW
// items. They are NEVER legitimate store ids (minted ids are t_xx / p_xx / *_u_*), so one arriving
// as a todo_id/project_id is always a model slip on a new item — even if a record with that id
// exists in the store (five leaked 'n1' todos did, until the 2026-08-22 repair).
const TMP_SHAPED = /^[np]\d+$/

const ROLES = new Set(['me', 'team', 'external'])

const isClosed = (s) => s === 'resolved' || s === 'cancelled'

// Fields a to-do rendered as a BRIEF one-liner may carry back (specs/pipeline-walkthrough.md
// §6, What the model may change at each tier). Everything else the model cannot have seen, so everything else is preserved.
const BRIEF_EDITABLE = new Set(['status', 'evidence_msg_id', 'change_reason', 'importance',
  'due_hint', 'due_earliest', 'due_latest'])

// store: createProjectStore(); output: model analysis object;
// ctx: { asof, msgId, threadId, briefProjectIds?, tmpTodo?, tmpProj? } — briefProjectIds names the
// projects that were rendered at BRIEF tier, whose to-dos merge field-by-field instead of
// replacing the record. tmpTodo/tmpProj: tmp_id -> minted id maps. In a BATCH the engine passes
// the SAME two objects to every entry's reconcile call, so a later entry can cite a to-do/project
// an earlier entry created by its tmp_id ("n1", "p1") — without this each entry could only
// re-create the item, and a back-and-forth thread batched into one call duplicated its task once
// per message.
export function reconcile (store, output, ctx) {
  const briefSet = new Set(ctx.briefProjectIds || [])
  // Global index of where every todo currently lives (for reassignment + carry-forward).
  const todoIndex = new Map() // todo_id -> { project, todo }
  for (const p of store.all()) for (const t of p.todos) todoIndex.set(t.todo_id, { project: p, todo: t })

  const tmpTodo = ctx.tmpTodo || {}   // todo tmp_id -> minted id (shared across a batch's entries)
  const tmpProj = ctx.tmpProj || {}   // project tmp_id -> minted id (shared across a batch's entries)
  const changes = []
  const roleChanges = []
  const todoEdits = []   // field-level diffs for the event's `todo_edits` (see diffTodo)
  const newIds = new Set()
  const changedIds = new Set()
  const touchedProjectIds = []   // needs PERSISTING (any real change, incl. read-only filings)
  // needs a fresh row in the cached snapshot's updates section — MATERIAL changes only. A
  // read-only filing changes nothing the catalog row exists for (name/summary/keywords/people,
  // the duplicate-avoidance signals), and reads are the highest-volume touch there is (every
  // auto-filed newsletter/receipt) — counting them burned the snapshot cache far ahead of the
  // user's configured cadence.
  const snapshotTouchIds = []

  for (const op of (output.projects || [])) {
    // resolve / mint the project id. A tmp_id an EARLIER batch entry already minted resolves to
    // that project — whether cited as project_id (the instructed form) or re-emitted as "new" with
    // the same tmp_id (a model slip) — so later messages edit it instead of duplicating it.
    let pid = op.project_id ? (tmpProj[String(op.project_id)] || op.project_id) : null
    let isNewProject = op.new === true || !pid
    if (isNewProject && op.tmp_id && tmpProj[String(op.tmp_id)]) {
      pid = tmpProj[String(op.tmp_id)]
      isNewProject = false
    }
    // ID-ADOPTION GUARD (2026-08-22 incident): a project_id that matches NOTHING in the store is
    // the model's invention — a tmp id emitted as project_id ('p1'), or a hallucinated id. It must
    // NEVER be adopted: ensureProject would mint a project WITH the bogus id, which is how a
    // project with id 'p1' leaked into storage — and once a tmp-shaped id EXISTS, every later
    // model slip citing that tmp hits the leaked record instead of creating what it meant to.
    if (!isNewProject && pid && (TMP_SHAPED.test(String(pid)) || !store.get(pid))) isNewProject = true
    if (isNewProject) {
      const given = pid
      pid = store.mintProjectId()
      if (op.tmp_id) tmpProj[String(op.tmp_id)] = pid
      // map the slip too, so later entries in this same reply citing it resolve to this project
      if (given && !tmpProj[String(given)]) tmpProj[String(given)] = pid
    }
    // NO-OP DETECTION. Models (Opus especially) echo back projects they merely LOOKED AT —
    // every requested project, every linked project, unchanged. Treating an echo as a touch
    // was a compounding cost bug: the echoed project got linked to the thread, its
    // last_active bumped (full-tier render for days), and its row forced into the cached
    // snapshot's updates section — so the NEXT run sent and received even more. A project
    // entry now counts as touched only when something actually changed.
    let metaChanged = isNewProject
    const changesBefore = changes.length
    const p = store.ensureProject({ project_id: pid, name: op.name, asof: ctx.asof })
    // llm_name / llm_summary = the LAST AUTOMATED COPY (same pattern as the todo llm_* baselines):
    // manual edits change name/summary but never these, so field !== llm_field means "user override"
    // and the editor can offer the AI's version back.
    if (op.name) { if (op.name !== p.name) { p.name = op.name; metaChanged = true } p.llm_name = op.name }
    if (typeof op.summary === 'string') { if (op.summary !== p.summary) { p.summary = op.summary; metaChanged = true } p.llm_summary = op.summary }
    // a user-locked project importance is authoritative — the model may not override it
    if (op.importance != null && !p.importance_locked) {
      const imp = clampImportance(op.importance, p.importance)
      if (imp !== p.importance) { p.importance = imp; metaChanged = true }
    }
    // keywords: the model returns the FULL list only when changing it (replace); omission preserves
    if (Array.isArray(op.keywords)) {
      const kw = [...new Set(op.keywords.map(k => String(k || '').toLowerCase().trim()).filter(Boolean))].slice(0, 10)
      if (kw.join('') !== (p.keywords || []).join('')) { p.keywords = kw; metaChanged = true }
    }
    // participants may arrive as the contract's address-keyed MAP, or — under native structured
    // output, whose strict schemas cannot express a map with arbitrary keys — as an ARRAY of
    // { address, role, role_note } (analysisSchema.js). The array is normalised to the map HERE, on
    // arrival, so nothing below needs to know which provider answered and the stored shape is one.
    if (Array.isArray(op.participants)) {
      const asMap = {}
      for (const row of op.participants) {
        if (row && row.address) asMap[String(row.address)] = { role: row.role, role_note: row.role_note }
      }
      op.participants = asMap
    }
    // participants: per-project ROLE (teamness, v2) + volatile role_note. Edit in place so a
    // participant the model didn't re-mention keeps their prior role/note.
    if (op.participants && typeof op.participants === 'object') {
      for (const [rawAddr, v] of Object.entries(op.participants)) {
        const addr = String(rawAddr).toLowerCase()
        const prior = p.participants[addr] || {}
        const note = (v && (v.role_note || v.note)) || (typeof v === 'string' ? v : prior.role_note) || ''
        const role = (v && ROLES.has(v.role)) ? v.role : (prior.role || null)
        if (prior.role && role && prior.role !== role) {
          roleChanges.push({ project_id: pid, address: addr, from: prior.role, to: role })
        }
        if ((prior.role || null) !== role || (prior.role_note || '') !== note) metaChanged = true
        p.participants[addr] = { role, role_note: note, last_updated_asof: ctx.asof }
      }
    }
    p.participant_emails = Object.keys(p.participants)

    // MERGE the returned to-dos into the project's existing list — do NOT replace it.
    // The model returns only NEW or CHANGED items; items it doesn't re-emit are PRESERVED.
    // (Omission never deletes — that was the wholesale-replace bug. An item leaves the open set
    //  only via an explicit status flip to resolved/cancelled, which still needs evidence.)
    const upsert = (todo) => {
      const i = p.todos.findIndex(x => x.todo_id === todo.todo_id)
      if (i >= 0) p.todos[i] = todo; else p.todos.push(todo)
    }
    for (const rt of (op.todos || [])) {
      // batch-scoped tmp references: an id an earlier entry minted for a tmp_id means THAT item —
      // whether cited as todo_id (the instructed form) or re-emitted as "new" with the same tmp_id
      // (a model slip). Either way fall through to the existing-todo path so this entry updates it
      // in place instead of creating a duplicate.
      const mappedId = (rt.todo_id && tmpTodo[String(rt.todo_id)]) ||
        (rt.new === true && rt.tmp_id && tmpTodo[String(rt.tmp_id)]) || null
      const realId = mappedId || rt.todo_id
      let isNew = !mappedId && (rt.new === true || !rt.todo_id)
      // ID-ADOPTION GUARD (2026-08-22 incident): a todo_id that exists NOWHERE in the store is the
      // model's invention — usually a NEW item emitted with its tmp id in the todo_id slot ("n1",
      // no new flag). Treat it as new and MINT. The old adopt-the-string path put five 'n1' todos
      // into storage over time; a later slip citing 'n1' then MATCHED one of them and reconcile
      // "moved" a resolved to-do from an unrelated project, rewrote its text and reopened it —
      // hijacking its whole evidence trail across projects.
      if (!isNew && !mappedId && (TMP_SHAPED.test(String(rt.todo_id)) || !todoIndex.has(String(rt.todo_id)))) isNew = true
      // CITATION GUARD (2026-09-25, the signed-contract case): the guard above turns an unknown id into a NEW
      // item — right for a tmp id in the wrong slot, wrong for a REFERENCE that missed. A model that
      // has only seen a project's catalog row and wants to resolve one of its to-dos writes a status
      // change against a name it invents ("review-contract", new:false, no text). Minting
      // that produced a blank resolved row (t_18y) and an event claiming a resolution that never
      // happened. No content ⇒ it was never a creation: drop it and say so. (The engine now answers
      // the underlying problem by re-asking with the project's real ids — engine.js implicit round.)
      if (isNew && !mappedId && rt.new !== true && rt.todo_id && !TMP_SHAPED.test(String(rt.todo_id)) &&
        !String(rt.short_description || '').trim() && !String(rt.description || '').trim()) {
        changes.push({ type: 'rejected', project_id: pid, todo: { todo_id: String(rt.todo_id), short_description: '', status: rt.status || null },
          note: 'cited unknown todo_id "' + rt.todo_id + '" (' + (rt.status || '?') + ') with no content — a to-do the model was not shown; dropped, not minted' })
        continue
      }
      if (isNew) {
        const id = store.mintTodoId()
        if (rt.tmp_id) tmpTodo[String(rt.tmp_id)] = id
        // map a slip-id too, so later entries in this reply citing it resolve to this item
        if (rt.todo_id && !mappedId && (TMP_SHAPED.test(String(rt.todo_id)) || !todoIndex.has(String(rt.todo_id))) && !tmpTodo[String(rt.todo_id)]) tmpTodo[String(rt.todo_id)] = id
        const todo = normalizeTodo(rt, id, ctx)
        todo.project_id = pid
        todo.created_asof = ctx.asof
        stampLlmBaseline(todo) // everything on a brand-new item is the model's own reading
        todo.evidence = pushEvidence([], ctx, todo.change_reason)
        if (isClosed(todo.status)) todo.resolved_asof = ctx.asof
        p.todos.push(todo)
        newIds.add(id)
        changes.push({ type: 'created', project_id: pid, todo })
        continue
      }
      // existing todo (referenced by todo_id, possibly via a batch tmp_id) — may be moving
      // into this project from another
      const prior = todoIndex.get(realId)
      // BRIEF tier: the model only saw a one-liner, so a returned object is a PATCH, not a
      // replacement — start from the stored record and take only the fields it was allowed to set.
      // Without this, unshown fields (description, evidence trail, owner…) would be blanked by
      // normalizeTodo's defaults on every quiet-project update.
      const briefPatch = prior && briefSet.has(pid)
      if (briefPatch) {
        const merged = { ...prior.todo }
        for (const k of Object.keys(rt)) {
          if (!BRIEF_EDITABLE.has(k)) continue
          if (rt[k] == null) continue
          if (k === 'importance') { if (!prior.todo.importance_locked) merged.importance = clampImportance(rt[k], prior.todo.importance) } else if (k === 'due_earliest' || k === 'due_latest') merged[k] = isoDate(rt[k])
          else merged[k] = rt[k]
        }
        merged.project_id = pid
        const pt0 = prior.todo
        let changedBrief = false
        if (pt0.status !== merged.status) {
          // The citation must come from THIS reply (rt), not the merged record: merged starts as a
          // copy of the stored todo, and every bootstrap-adopted todo already carries the
          // evidence_msg_id of the mail that RAISED it — so checking merged lets the model resolve
          // anything without citing what resolved it, which is exactly what this guard exists to
          // stop. (The old data happened to have no ids on stored todos, so the hole was invisible
          // until a bootstrap-built store hit it.)
          if (isClosed(merged.status) && !rt.evidence_msg_id) {
            merged.status = pt0.status
            changes.push({ type: 'rejected', project_id: pid, todo: merged, note: 'resolution without evidence_msg_id — kept ' + pt0.status })
          } else {
            if (isClosed(merged.status)) merged.resolved_asof = ctx.asof
            changes.push({ type: 'status', project_id: pid, todo: merged, from: pt0.status, to: merged.status })
            changedBrief = true
          }
        }
        if (pt0.importance !== merged.importance) {
          // the model re-set the priority: that IS the new machine baseline
          merged.llm_importance = merged.importance
          changedBrief = true
        }
        if (changedBrief) {
          const edits = diffTodo(pt0, merged)
          merged.evidence = pushEvidence(pt0.evidence, ctx, merged.change_reason, edits)
          for (const e of edits) todoEdits.push({ project_id: pid, todo_id: merged.todo_id, ...e })
          changedIds.add(merged.todo_id)
        }
        if (prior.project !== p) {
          prior.project.todos = prior.project.todos.filter(x => x !== prior.todo)
          if (store.releaseTodoThreads) store.releaseTodoThreads(prior.project, prior.todo) // its threads leave with it
          changes.push({ type: 'moved', project_id: pid, from_project: prior.project.project_id, todo: merged })
          changedIds.add(merged.todo_id)
        }
        upsert(merged)
        continue
      }
      const todo = normalizeTodo(rt, realId, ctx)
      todo.project_id = pid
      todo.evidence = prior ? (prior.todo.evidence || []).slice() : pushEvidence([], ctx, todo.change_reason)
      todo.created_asof = prior ? prior.todo.created_asof : ctx.asof
      if (!rt.sender && prior) todo.sender = prior.todo.sender || todo.sender   // keep original sender if omitted
      // carry forward fields the request render doesn't round-trip — the model can't re-emit what it never saw
      if (prior) {
        if (rt.due_hint == null) {
          todo.due_hint = prior.todo.due_hint || null
          todo.due_earliest = prior.todo.due_earliest || null
          todo.due_latest = prior.todo.due_latest || null
        }
        // 2026-09-19: `who` is one field, so it carries forward as one decision — the model
        // either named somebody on this pass or it did not (whoMapping.js).
        if (todo.direction !== 'read_only' && !whoListFrom(rt).length) {
          todo.owner = prior.todo.owner || null
          todo.owners = prior.todo.owners || []
          todo.counterparty = prior.todo.counterparty || null
        }
        // Text fields too: a to-do rendered as a ONE-LINER (inside a full-tier project) carries
        // only its short_description, so a model editing it cannot re-emit the description —
        // an empty/omitted text field on an EXISTING to-do means "unseen", never "erase".
        if (!rt.short_description) todo.short_description = prior.todo.short_description || todo.short_description
        if (!rt.description) todo.description = prior.todo.description || todo.description
        // USER-ONLY fields the model never sees and must never clear: the "lower priority until
        // due" hold (set in the task editor; read by dueDates.effImportance)
        if (prior.todo.due_demote != null) todo.due_demote = prior.todo.due_demote
        // the machine baselines are OURS, never the model's to re-emit — carry them, then let
        // stampLlmBaseline below overwrite only the fields this reply actually carried
        for (const key of Object.values(LLM_BASELINE)) todo[key] = prior.todo[key] != null ? prior.todo[key] : null
      }
      // which fields did the model actually emit? (a to-do rendered as a one-liner carries only
      // its short_description, so an omitted description means "unseen", not "cleared")
      const emitted = new Set()
      if (rt.importance != null && !(prior && prior.todo.importance_locked)) emitted.add('importance')
      if (rt.short_description) emitted.add('short_description')
      if (rt.description) emitted.add('description')
      stampLlmBaseline(todo, emitted)
      // a user-locked priority is authoritative — keep the user's importance, ignore the model's
      if (prior && prior.todo.importance_locked) { todo.importance = prior.todo.importance; todo.importance_locked = true }
      if (prior && prior.project !== p) {
        // reassignment: drop from the old project (it's not yet in p — upsert will add it)
        prior.project.todos = prior.project.todos.filter(x => x !== prior.todo)
        if (store.releaseTodoThreads) store.releaseTodoThreads(prior.project, prior.todo) // its threads leave with it
        changes.push({ type: 'moved', project_id: pid, from_project: prior.project.project_id, todo })
        changedIds.add(todo.todo_id)
        todo.evidence = pushEvidence(todo.evidence, ctx, 'reassigned to ' + p.name)
      }

      let touched = false
      const pt = prior && prior.todo
      if (pt && pt.status !== todo.status) {
        if (isClosed(todo.status) && !todo.evidence_msg_id) {
          // INVARIANT: resolution needs evidence — reject the flip
          todo.status = pt.status
          changes.push({ type: 'rejected', project_id: pid, todo, note: 'resolution without evidence_msg_id — kept ' + pt.status })
        } else {
          if (isClosed(todo.status)) todo.resolved_asof = ctx.asof
          changes.push({ type: 'status', project_id: pid, todo, from: pt.status, to: todo.status })
          touched = true
        }
      } else if (!pt) {
        // referenced an id we don't have — treat as a new item rather than dropping it
        changes.push({ type: 'created', project_id: pid, todo })
        newIds.add(todo.todo_id)
      }
      // an already-closed item that stays closed keeps its original close time
      if (pt && isClosed(pt.status) && isClosed(todo.status) && !todo.resolved_asof) todo.resolved_asof = pt.resolved_asof
      if (pt && (pt.importance !== todo.importance ||
                 pt.short_description !== todo.short_description ||
                 pt.description !== todo.description ||
                 pt.direction !== todo.direction)) {
        touched = true
      }
      if (touched) {
        const edits = diffTodo(pt, todo)
        todo.evidence = pushEvidence(todo.evidence, ctx, todo.change_reason, edits)
        for (const e of edits) todoEdits.push({ project_id: pid, todo_id: todo.todo_id, ...e })
        changedIds.add(todo.todo_id)
      }
      upsert(todo)
    }
    store.recomputeImportance(p)

    // MERGE suggested responses (same delta principle as todos: omission preserves).
    if (Array.isArray(op.responses)) {
      if (!Array.isArray(p.responses)) p.responses = []
      const byRid = new Map(p.responses.map(r => [r.response_id, r]))
      for (const rr of op.responses) {
        const isNewR = rr.new === true || !rr.response_id
        const rid = isNewR ? store.mintResponseId() : rr.response_id
        const prior = byRid.get(rid)
        const mappedTodoId = rr.todo_id ? (tmpTodo[String(rr.todo_id)] || rr.todo_id) : (prior ? prior.todo_id : null)
        const todo = mappedTodoId ? p.todos.find(t => t.todo_id === mappedTodoId) : null
        const resp = normalizeResponse(rr, rid, ctx, todo ? todo.direction : null)
        resp.project_id = pid
        resp.todo_id = mappedTodoId || null
        resp.created_asof = prior ? prior.created_asof : ctx.asof
        if (rr.subject == null && prior) resp.subject = prior.subject   // subject isn't rendered back — keep it on update
        // The model no longer SEES existing suggestions (assemble sends only a count), so it can
        // only ever emit "new" ones. Without this, every message would pile another draft onto the
        // same to-do: a new response REPLACES the live suggestion for the same (todo_id, kind).
        // Sent/dismissed ones are history and are never touched.
        let i = p.responses.findIndex(x => x.response_id === rid)
        if (i < 0 && isNewR && resp.todo_id) {
          i = p.responses.findIndex(x => x.todo_id === resp.todo_id && x.kind === resp.kind &&
            (x.status === 'suggested' || x.status === 'edited'))
          if (i >= 0) resp.response_id = p.responses[i].response_id // keep the id the UI already knows
        }
        if (i >= 0) p.responses[i] = resp; else p.responses.push(resp)
        changes.push({ type: prior ? 'response_updated' : 'response', project_id: pid, response: resp })
      }
    }

    // The touch decision (see NO-OP DETECTION above): link + activity-bump + updates-section
    // entry ONLY when this entry changed something real. A 'rejected' change is the model
    // ATTEMPTING a change we refused — nothing in the store moved, so it does not count.
    const realChanges = changes.slice(changesBefore).filter(c => c.type !== 'rejected')
    if (metaChanged || realChanges.length) {
      store.linkThread(ctx.threadId, pid)
      p.last_active_asof = ctx.asof
      touchedProjectIds.push(pid)
      // Does the CATALOG ROW need re-sending? Only when project metadata changed, or an
      // ACTIONABLE to-do (not a read_only FYI) was created/changed here. A project whose only
      // change is a filed read keeps its snapshot row until the next scheduled render.
      const actionable = realChanges.some(c => !(c.todo && c.todo.direction === 'read_only'))
      if (metaChanged || actionable) snapshotTouchIds.push(pid)
    } else {
      console.info('[superlazy] model echoed project [' + pid + '] "' + (p.name || '') + '" with no changes — ignored (not linked, not touched)')
    }
  }

  // ACCOUNT-FOR VERDICTS (prompt 0.61). One { todo_id, verdict, reason } per line of the request's
  // "Open items to account for" block. A resolved / cancelled / in_progress verdict is a status
  // change with THIS message as evidence; open keeps the item as it is. A to-do the reply ALSO
  // returned as a full object in projects[] is left to that object (it may rewrite more than the
  // status). Unknown ids are dropped — the block only ever lists real ones, so an unknown id here
  // is a slip, never a creation.
  const returnedIds = new Set()
  for (const op of (output.projects || [])) for (const t of (op.todos || [])) if (t && t.todo_id) returnedIds.add(String(tmpTodo[String(t.todo_id)] || t.todo_id))
  const closedByVerdict = []
  for (const v of (Array.isArray(output.account_for) ? output.account_for : [])) {
    if (!v || !v.todo_id) continue
    const id = String(tmpTodo[String(v.todo_id)] || v.todo_id)
    const prior = todoIndex.get(id)
    if (!prior) { console.warn('[superlazy] account_for cites an unknown todo_id ' + id + ' — dropped'); continue }
    if (returnedIds.has(id)) continue
    const verdict = String(v.verdict || '')
    if (!['resolved', 'cancelled', 'in_progress'].includes(verdict)) continue
    const t = prior.todo
    if (t.status === verdict || isClosed(t.status)) continue
    const pid = prior.project.project_id
    const merged = { ...t, status: verdict, change_reason: v.reason || null, evidence_msg_id: ctx.msgId || t.evidence_msg_id || null }
    if (isClosed(verdict)) merged.resolved_asof = ctx.asof
    const edits = diffTodo(t, merged)
    merged.evidence = pushEvidence(t.evidence, ctx, merged.change_reason, edits)
    for (const e of edits) todoEdits.push({ project_id: pid, todo_id: id, ...e })
    const i = prior.project.todos.indexOf(t)
    if (i >= 0) prior.project.todos[i] = merged; else prior.project.todos.push(merged)
    todoIndex.set(id, { project: prior.project, todo: merged })
    changes.push({ type: 'status', project_id: pid, todo: merged, from: t.status, to: verdict })
    changedIds.add(id)
    if (isClosed(verdict)) closedByVerdict.push(id)
    if (!touchedProjectIds.includes(pid)) touchedProjectIds.push(pid)
    if (!snapshotTouchIds.includes(pid)) snapshotTouchIds.push(pid)
    // a message that moves an item in a project is on that project: link the thread, so later
    // messages on it get the project's full list rather than a catalog row
    if (ctx.threadId && typeof store.linkThread === 'function') store.linkThread(ctx.threadId, pid)
    if ((Number(ctx.asof) || 0) > (Number(prior.project.last_active_asof) || 0)) prior.project.last_active_asof = ctx.asof
    if (typeof store.recomputeImportance === 'function') store.recomputeImportance(prior.project)
  }

  // RETIRE SUPERSEDED DRAFTS (user, 2026-09-27: "old suggested replies should disappear when
  // there is a new email or action on the thread"). This message is newer than any unedited
  // suggestion drafted against its thread, so each of those now answers a conversation that has
  // moved on: dismissed durably, stamped so the 3-way project merge keeps the dismissal. A draft
  // this very message produced (created_asof == ctx.asof) survives, as does one the user EDITED
  // (their own work in progress). The UI applies the same rule from the evidence trail
  // (expandableProjectView.isSupersededResponse) and from the events log for messages that
  // never reach reconcile (skipped / auto-filed ones).
  if (ctx.threadId && ctx.asof) {
    for (const p of store.all()) {
      let retired = false
      for (const r of (p.responses || [])) {
        if (!r || r.status !== 'suggested' || r.kind === 'reminder') continue
        if ((Number(r.created_asof) || 0) >= Number(ctx.asof)) continue
        const t = r.todo_id && (p.todos || []).find(x => x.todo_id === r.todo_id)
        if (!t || !(t.evidence || []).some(e => e.msg_id && e.thread_id === ctx.threadId)) continue
        r.status = 'dismissed'
        r.dismiss_reason = 'superseded: a newer message arrived on the thread'
        r.dismissed_asof = Number(ctx.asof)
        retired = true
      }
      if (retired && !touchedProjectIds.includes(p.project_id)) touchedProjectIds.push(p.project_id)
    }
  }

  // latest_delta — map tmp ids to minted ones
  const mapId = (id) => tmpTodo[String(id)] || id
  const ld = output.latest_delta || {}
  // new_for_me / new_for_team are DERIVED from what was actually created, not taken from the
  // model (2026-09-19): the app knows every minted to-do's direction, so the badges provably match
  // the items on screen. The model was asked for these until prompt 0.52 and was inconsistent —
  // 6 events claimed new_for_me with nothing created.
  const createdDirs = changes.filter(c => c.type === 'created' && c.todo).map(c => c.todo.direction)
  const latest_delta = {
    new_for_me: createdDirs.includes('i_owe_them'),
    new_for_team: createdDirs.includes('team_owes'),
    new_todo_ids: (ld.new_todo_ids || []).map(mapId),
    resolved: [...new Set([...(ld.resolved || []).map(mapId), ...closedByVerdict])]
  }

  return {
    projects: store.all(),
    touched_project_ids: touchedProjectIds,
    // subset of the above whose CATALOG ROW changed materially (see snapshotTouchIds)
    snapshot_touch_ids: snapshotTouchIds,
    latest_delta,
    changes,
    role_changes: roleChanges,
    todo_edits: todoEdits,
    new_ids: [...newIds],
    changed_ids: [...changedIds],
    tmp_project_map: tmpProj
  }
}
