// adopt.js — turn the bootstrap MAP into the app's real stores.
//
// The bootstrap produces one picture of a mailbox in a single pass; everything downstream (the
// dashboard, the per-message analysis, check-for-new-mail) reads the ordinary stores. This module
// is the only bridge between the two, and it writes records that are INDISTINGUISHABLE from ones
// the per-message engine would have written — same id minting (projectStore), same to-do shape,
// same profile shape, same auto-process shape. Anything else and the first new email would find a
// store it cannot reason about.
//
// What it writes:
//   projects   — one per mapped project, with its to-dos
//   profiles   — one per mapped person, plus one per auto-file sender (with the standing action)
//   settings   — your addresses, the business context, the model, training_wip cleared
//   accounts   — the account marked trained, with the CURSOR that makes new mail start here
//   events     — one summary event, PLUS one per message the map actually cited as evidence
//   bodies     — the cited messages themselves, so that evidence opens as real mail
//
// WHY ONLY THE CITED MESSAGES. The window is read as a whole and most of it never becomes anything
// a user would look up; the model described the projects, not each email. Storing an event for
// every message would fill the feed with rows carrying no summary and no importance — clutter by
// construction. The messages the map QUOTES are the ones with somewhere to go: each becomes an
// event carrying the to-dos it produced, and its body is stored so the evidence chip opens it. The
// summary event says plainly that this is what happened, so an empty-looking feed reads as a
// decision rather than a bug.
//
// THE CURSOR IS THE IMPORTANT ONE. Ingestion treats `date >= cursor` as unprocessed, and the
// bootstrap writes no per-message events, so the processed-set backstop cannot help: the cursor is
// set one millisecond PAST the newest message in the window. Everything the bootstrap read is
// behind it, everything that arrives later is ahead of it.

import { createProjectStore } from '../analyze_thread/projectStore.js'
import { DEFAULT_THREAD_CONTEXT_DAYS } from '../analyze_thread/config.js'
import { DEFAULT_CONTEXT_CHARS } from '../analyze_thread/assemble.js'
import { FILE_TO_PROJECT } from '../analyze_thread/autoProcess.js'
import { AUTOMATED_CATEGORIES } from '../analyze_thread/workflows.js'

const CATEGORY_KEYS = new Set(AUTOMATED_CATEGORIES.map((c) => c.key))
const lower = (s) => String(s || '').trim().toLowerCase()
const clampImp = (v, d = 3) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : d
}

// A to-do in the shape reconcile.js mints, so later analysis can edit it like any other.
// `asof` is the date of the EMAIL that raised it where we know it, not the moment setup ran —
// otherwise every item in a month of mail claims to have appeared today.
function todoFrom (t, id, projectId, asof, ranAt, meta) {
  const isRead = t.direction === 'read_only'
  const srcId = (t.evidence_msg_ids || [])[0] || null
  const src = (meta && srcId && meta[srcId]) || null
  return {
    todo_id: id,
    project_id: projectId,
    direction: ['i_owe_them', 'they_owe_me', 'team_owes', 'read_only'].includes(t.direction) ? t.direction : 'i_owe_them',
    short_description: t.short_description || '',
    description: t.description || '',
    sender: t.sender || null,
    importance: clampImp(t.importance),
    importance_locked: false,
    owner: isRead ? null : (t.owner || null),
    owners: [],
    counterparty: isRead ? null : (t.counterparty || null),
    status: t.status === 'in_progress' ? 'in_progress' : 'open',
    // Provenance says BOOTSTRAP, not a single message: this item was inferred from the whole
    // window, and pinning it on one email would misrepresent where it came from.
    // SAME SHAPE as reconcile.pushEvidence, thread_id included. The ✉ button opens the highest-asof
    // evidence entry with { msg_id, thread_id } — omit the thread and the viewer has no context to
    // resolve the message against, and shows a plausible WRONG email rather than failing outright.
    evidence: [{
      type: 'bootstrap',
      source: 'bootstrap',
      thread_id: (src && src.thread_id) || null,
      msg_id: srcId,
      asof,
      reason: 'found while reading your recent mail as a whole',
      who: (src && src.from_address) || null,
      summary: (src && src.subject) || null,
      adopted_asof: ranAt
    }],
    evidence_msg_id: srcId,
    due_hint: t.due_hint || null,
    due_earliest: /^\d{4}-\d{2}-\d{2}$/.test(String(t.due_earliest || '')) ? t.due_earliest : null,
    due_latest: /^\d{4}-\d{2}-\d{2}$/.test(String(t.due_latest || '')) ? t.due_latest : null,
    change_reason: null,
    created_asof: asof,
    resolved_asof: null
  }
}

// The date of the first message a map entry cites, so items and projects carry the email's clock.
const dateOfEvidence = (ids, msgDates, fallback) => {
  for (const id of (ids || [])) {
    const d = Number(msgDates && msgDates[id]) || 0
    if (d) return d
  }
  return fallback
}

/**
 * Write the map into the stores.
 *
 * @param {Object}   o
 * @param {Object}   o.persist        createPersistence() result
 * @param {Object}   o.map            the assembled bootstrap output
 * @param {Object}   o.account        { account_id, account_email, provider, source_id }
 * @param {Set}      o.meSet          the user's own addresses
 * @param {Object}   o.window         { fromMs, newestMs, messages, threads, days }
 * @param {Object}  [o.model]         { provider, family } used for the run
 * @param {number}  [o.cost]          what the bootstrap spent
 * @param {Object}  [o.existing]      persist.loadAll() result, when the stores are not empty
 * @param {Function}[o.onProgress]    (stage, done, total)
 * @returns {Promise<Object>} counts written
 */
export async function adoptBootstrap ({
  persist, map, account, meSet, window: win, model = null, cost = 0,
  existing = null, msgDates = null, msgMeta = null, partialThreadIds = null, onProgress = null
}) {
  const asof = Date.now()
  const step = (stage, done, total) => { if (onProgress) onProgress({ stage, done, total }) }
  const accountEmail = lower(account.account_email)
  const sourceTag = 'email:' + accountEmail

  // Mint ids past anything already stored — a second account's bootstrap must not collide with the
  // first one's projects.
  const store = createProjectStore()
  store.hydrate((existing && existing.projects) || [])
  // threads that started before the window: what the setup saw of them is a fragment. Recorded per
  // project so the app can say "history incomplete" instead of implying it read the whole story.
  const partial = new Set(partialThreadIds || [])

  // ---- projects + their to-dos ---------------------------------------------------------------
  const projects = (map.projects || []).filter((p) => p && p.name)
  const writtenProjects = []
  let n = 0
  for (const mp of projects) {
    const p = store.ensureProject({ project_id: store.mintProjectId(), name: mp.name, asof })
    p.summary = mp.summary || ''
    p.keywords = (mp.keywords || []).map(lower).filter(Boolean).slice(0, 10)
    p.status = mp.status_guess === 'done' ? 'archived' : 'active'
    p.thread_ids = [...new Set((mp.thread_ids || []).filter(Boolean))]
    p.sources = [sourceTag]
    p.partial_threads = p.thread_ids.filter((t) => partial.has(t))
    // dated by the mail it was found in, so the board's recency ordering means something from the
    // very first screen
    const projDates = (mp.evidence_msg_ids || []).map((id) => Number(msgDates && msgDates[id]) || 0).filter(Boolean)
    p.created_asof = projDates.length ? Math.min(...projDates) : (win.fromMs || asof)
    p.last_active_asof = projDates.length ? Math.max(...projDates) : (Number(win.newestMs) || asof)

    for (const [addr, info] of Object.entries(mp.participants || {})) {
      const a = lower(addr)
      if (!a) continue
      p.participants[a] = {
        role: meSet.has(a) ? 'me' : (['me', 'team', 'external'].includes(info && info.role) ? info.role : 'external'),
        role_note: (info && info.role_note) || '',
        last_updated_asof: asof
      }
    }
    p.participant_emails = Object.keys(p.participants)

    for (const t of (mp.todos || [])) {
      if (!t || !(t.short_description || t.description)) continue
      const raisedAt = dateOfEvidence(t.evidence_msg_ids, msgDates, p.last_active_asof)
      p.todos.push(todoFrom(t, store.mintTodoId(), p.project_id, raisedAt, asof, msgMeta))
      if (raisedAt > p.last_active_asof) p.last_active_asof = raisedAt
    }
    // the project's own importance follows its work, exactly as the engine computes it
    store.recomputeImportance(p)
    if (mp.importance && !p.todos.length) p.importance = clampImp(mp.importance)
    for (const tid of p.thread_ids) store.linkThread(tid, p.project_id)

    await persist.saveProject(p)
    writtenProjects.push(p)
    step('projects', ++n, projects.length)
  }

  const todoCount = writtenProjects.reduce((t, p) => t + (p.todos || []).length, 0)

  // ---- people --------------------------------------------------------------------------------
  const seenAddresses = new Set()
  const profiles = (map.profiles || []).filter((pr) => pr && lower(pr.address) && !meSet.has(lower(pr.address)))
  n = 0
  for (const pr of profiles) {
    const address = lower(pr.address)
    if (seenAddresses.has(address)) continue
    seenAddresses.add(address)
    await persist.saveProfile({
      address,
      display_name: pr.name || '',
      profile: {
        summary: pr.summary || '',
        relationship: pr.relationship || 'unknown',
        responsibilities: pr.responsibilities ? [{ id: 'r1', text: String(pr.responsibilities), source: 'model', locked: false, asof: null }] : [],
        user_tone: pr.tone_note || null,
        llm_importance: clampImp(pr.llm_importance),
        responsiveness_note: null,
        auto_processes: [],
        last_profiled_asof: asof,
        // PROVISIONAL on purpose: a bootstrap profile is a first impression from one window, so
        // ordinary analysis stays free to refine it. Only the graduation re-profile solidifies.
        solidified_asof: null,
        user_edited: false
      },
      manual_rank: null,
      interaction_data: {},
      sources: [sourceTag],
      stub: false
    })
    step('people', ++n, profiles.length)
  }

  // ---- senders to stop reading ---------------------------------------------------------------
  // Same standing action the per-message workflow learns, so their next message short-circuits
  // before any LLM call — which is where the running cost actually falls.
  const autofile = (map.autofile_candidates || []).filter((a) => a && lower(a.sender) && !meSet.has(lower(a.sender)))
  n = 0
  for (const a of autofile) {
    const address = lower(a.sender)
    if (seenAddresses.has(address)) continue
    seenAddresses.add(address)
    const disposition = CATEGORY_KEYS.has(a.category) ? a.category : 'newsletter'
    await persist.saveProfile({
      address,
      display_name: a.name || '',
      profile: {
        summary: a.reason || 'Automated bulk sender.',
        relationship: 'automated',
        responsibilities: [],
        user_tone: null,
        llm_importance: 1,
        responsiveness_note: null,
        auto_processes: [{
          type: FILE_TO_PROJECT,
          active: true,
          details: { project_id: null, disposition },
          locked: false,          // the model proposed it and the user reviewed it — not user-set
          suggested: null,
          source: 'bootstrap',
          asof
        }],
        last_profiled_asof: asof,
        solidified_asof: null,
        user_edited: false
      },
      manual_rank: null,
      interaction_data: {},
      sources: [sourceTag],
      stub: false
    })
    step('autofile', ++n, autofile.length)
  }

  // ---- settings ------------------------------------------------------------------------------
  const prevSettings = (existing && existing.settings) || {}
  const settings = {
    ...prevSettings,
    your_addresses: [...meSet],
    business_context: map.business_context || '',
    business_context_asof: asof,
    history_days: win.days,
    // the per-message engine's own dials, defaulted here so the FIRST new email after setup finds a
    // complete settings record instead of falling back field by field
    thread_context_days: prevSettings.thread_context_days != null ? prevSettings.thread_context_days : DEFAULT_THREAD_CONTEXT_DAYS,
    analysis_context_chars: prevSettings.analysis_context_chars || DEFAULT_CONTEXT_CHARS,
    default_model: model || null,
    automated_autopilot: true,
    events_retention_days: prevSettings.events_retention_days || 90,
    training_wip: false,          // the map IS the training — no page should redirect back here
    bootstrap_asof: asof,
    bootstrap_cost: Number(cost) || 0
  }
  await persist.saveSettings(settings)
  step('settings', 1, 1)

  // ---- the account, and the watermark new mail starts from -----------------------------------
  const prior = ((existing && existing.accounts) || []).find((r) => r.account_id === account.account_id) || {}
  await persist.saveAccount({
    ...prior,
    account_id: account.account_id,
    account_email: account.account_email,
    provider: account.provider || 'gmail',
    source_id: account.source_id || null,
    status: 'trained',
    backfill_done: true,
    backfill_from: win.fromMs,
    history_days: win.days,
    // one past the newest message the bootstrap saw — see the header
    cursor: (Number(win.newestMs) || asof) + 1,
    last_processed_asof: Number(win.newestMs) || asof,
    messages_processed: ((prior.messages_processed || 0) + (win.messages || 0))
  })
  step('account', 1, 1)

  // ---- the cited mail: stored, and linked to what it produced --------------------------------
  // The event id is the engine's own deterministic ev_<msgid>_<hash>, so re-saving upserts rather
  // than duplicating — and the message counts as HANDLED, which is the same belt-and-braces the
  // cursor gives us.
  let cited = 0
  const meta = msgMeta || {}
  const citedIds = [...new Set([
    ...(map.projects || []).flatMap((p) => [
      ...(p.evidence_msg_ids || []),
      ...(p.todos || []).flatMap((t) => t.evidence_msg_ids || [])
    ]),
    ...(map.profiles || []).flatMap((p) => p.evidence_msg_ids || []),
    ...(map.autofile_candidates || []).flatMap((a) => a.evidence_msg_ids || [])
  ])].filter((id) => meta[id])

  // what each message produced, so its event names real tasks instead of "no to-do changes"
  const producedBy = new Map()
  for (const p of writtenProjects) {
    for (const t of p.todos) {
      const src = t.evidence_msg_id
      if (!src) continue
      if (!producedBy.has(src)) producedBy.set(src, [])
      producedBy.get(src).push({
        type: 'created',
        project_id: p.project_id,
        todo_id: t.todo_id,
        short: t.short_description || t.description || ''
      })
    }
  }

  for (const id of citedIds) {
    const m = meta[id]
    await persist.saveEmailBody({
      msg_id: m.msg_id,
      account_id: account.account_id,
      thread_id: m.thread_id,
      from_address: lower(m.from_address),
      from_name: m.from_name || '',
      to_addresses: m.to_addresses || [],
      cc_addresses: m.cc_addresses || [],
      subject: m.subject || '',
      date: m.date,
      body_text: m.body_text || '',
      body_html: '',
      has_attachments: !!m.has_attachments,
      captured_asof: asof
    }).catch(() => {})
    await persist.addEvent({
      kind: 'message',
      // read as part of one pass rather than analysed on its own — the feed marks it as such
      via_workflow: 'bootstrap',
      msg_id: m.msg_id,
      account_id: account.account_id,
      thread_id: m.thread_id,
      source_id: account.source_id || null,
      asof: m.date,
      subject: m.subject || '',
      from_address: lower(m.from_address),
      to_addresses: [...(m.to_addresses || []), ...(m.cc_addresses || [])].map((x) => lower(x && x.address)).filter(Boolean),
      body_snippet: String(m.body_text || '').slice(0, 800),
      summary: 'Read during setup and quoted as evidence for the items below.',
      changes: producedBy.get(id) || [],
      cost: 0,
      llm_calls: 0,
      model: (model && model.provider) || null
    }).catch(() => {})
    cited++
    step('mail', cited, citedIds.length)
  }

  // ---- one event, so the feed can explain where all this came from ---------------------------
  await persist.addEvent({
    kind: 'bootstrap',
    account_id: account.account_id,
    source_id: account.source_id || null,
    // the window's own end, so the feed places it with the mail it read rather than at "now"
    asof: Number(win.newestMs) || asof,
    adopted_asof: asof,
    subject: 'Set up from ' + (win.messages || 0) + ' emails',
    summary: 'Read ' + (win.messages || 0) + ' emails over ' + win.days + ' days in ONE pass and built ' +
      projects.length + ' project(s) with ' + todoCount + ' open item(s), ' +
      profiles.length + ' person profile(s) and ' + autofile.length + ' auto-file sender(s). ' +
      'Only the ' + cited + ' email(s) the analysis quoted as evidence were stored individually — ' +
      'the rest were read together and are summarised in the projects, so this feed shows them ' +
      'nowhere else. That is on purpose, not a gap.',
    from_address: accountEmail,
    cost: Number(cost) || 0,
    model: (model && (model.provider + (model.family ? ' · ' + model.family : ''))) || null,
    importance: 3
  }).catch(() => {}) // an events write must never lose the adoption above it

  return {
    projects: projects.length,
    todos: todoCount,
    cited,
    profiles: profiles.length,
    autofile: autofile.length,
    cursor: (Number(win.newestMs) || asof) + 1
  }
}
