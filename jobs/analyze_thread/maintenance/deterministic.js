// jobs/analyze_thread/maintenance/deterministic.js — the NO-LLM maintenance passes (specs/superlazy-weekly-cleanup.md §10.1).
// Every pass is a pure PREVIEW: it reads state and returns proposal rows; nothing mutates here.
// Applying accepted rows is applyProposals.js's job. Lab-first is the governing principle — these
// run from the /cleanup page (housekeeping panel; D3/D4 feed the clean-up state block) and only later, once tuned, from a scheduled job.

import { effImportance } from '../dueDates.js'
import { threadsOfTodo, isMailThreadId } from '../projectStore.js'

const DAY = 24 * 3600e3

// Default for events_retention_days when the user has never set one (the clean-up page knob seeds
// from settings and writes changes back, so this is only the very first value they see).
export const DEFAULT_EVENTS_RETENTION_DAYS = 90
const openish = (t) => t && (t.status === 'open' || t.status === 'in_progress')
const lc = (s) => String(s || '').toLowerCase()

// Paged scan of the whole events collection, newest-modified first (the only reliably indexed
// order). Calls onRow for every record; keeps nothing itself so a big log doesn't balloon memory
// beyond what the caller collects.
export async function scanEvents (freezr, onRow, onProgress) {
  let skip = 0
  let scanned = 0
  while (true) {
    const rows = await freezr.query('events', {}, { count: 500, skip, sort: { _date_modified: -1 } })
    if (!rows || !rows.length) break
    for (const r of rows) { scanned++; onRow(r) }
    if (onProgress) onProgress(scanned)
    if (rows.length < 500) break
    skip += rows.length
  }
  return scanned
}

// ---- D5 — orphan thread links ----------------------------------------------------------------
// A project's thread_ids once only ever grew (projectMerge unions them), so a thread a mis-filed or
// later-moved to-do brought in stayed linked after every to-do left — and kept handing the model
// the project's full list on each new message of that thread, and listing it on the card. Links
// can shrink now (projectStore.unlinkThread, 2026-10-04) but existing orphans need sweeping. A
// linked thread is KEPT when a to-do's evidence still cites it, or when a message on that thread
// recorded a change to this project (metadata-only messages leave no evidence); everything else
// is an ORPHAN. Chat stream ids follow the same rule (reported separately — that link is what
// hands the model the project's list on the channel's next chunk, so it is kept while anything
// cites it). One row per project with orphans: { project_id, name, orphans, orphanChat, keptCited,
// keptTouched }; the row becomes one `unlink_threads` proposal.
const MESSAGE_KINDS = new Set(['message', 'workflow_short_circuit', 'skipped', 'mail_action'])
export async function previewOrphanThreads ({ freezr, store, onProgress }) {
  const touched = new Map() // thread_id -> Set(project_id) a message on the thread changed
  const scanned = await scanEvents(freezr, (r) => {
    if (!r || !r.thread_id || !MESSAGE_KINDS.has(r.kind)) return
    const pids = [r.project_id, ...((r.changes || []).map(c => c && c.project_id))].filter(Boolean)
    if (!pids.length) return
    if (!touched.has(r.thread_id)) touched.set(r.thread_id, new Set())
    for (const pid of pids) touched.get(r.thread_id).add(pid)
  }, onProgress)
  const rows = []
  for (const p of store.all()) {
    if (!p || p.merged_into || p.status === 'archived') continue
    const cited = new Set()
    for (const t of (p.todos || [])) for (const tid of threadsOfTodo(t)) cited.add(tid)
    const orphans = []
    let keptCited = 0; let keptTouched = 0
    for (const tid of (p.thread_ids || [])) {
      if (cited.has(tid)) { keptCited++; continue }
      const by = touched.get(tid)
      if (by && by.has(p.project_id)) { keptTouched++; continue }
      orphans.push(tid)
    }
    if (!orphans.length) continue
    rows.push({ project_id: p.project_id, name: p.name || p.project_id, orphans, orphanChat: orphans.filter(t => !isMailThreadId(t)).length, keptCited, keptTouched })
  }
  rows.sort((a, b) => b.orphans.length - a.orphans.length)
  return { scanned, rows, total: rows.reduce((n, r) => n + r.orphans.length, 0) }
}

// ---- D1 — events pruning preview -----------------------------------------------------------
// Criterion: the record has not been TOUCHED for retentionDays (_date_modified — the one clock
// that is reliably indexed and can't lie about "still in use": an upserted re-process refreshes
// it). Returns ONE bulk proposal's worth of data: ids to delete, counts by kind, size estimate.
export async function previewEventsPruning ({ freezr, retentionDays, onProgress }) {
  const days = Number(retentionDays)
  if (!days || days <= 0) return { disabled: true, reason: 'events_retention_days is 0 (keep forever)' }
  const cutoff = Date.now() - days * DAY
  const ids = []
  const byKind = {}
  let approxChars = 0
  let oldest = null
  let newest = null
  const scanned = await scanEvents(freezr, (r) => {
    const touched = Number(r._date_modified) || Number(r._date_created) || 0
    if (touched >= cutoff) return
    ids.push(r._id)
    const k = r.kind || r.type || 'unknown'
    byKind[k] = (byKind[k] || 0) + 1
    approxChars += JSON.stringify(r).length
    if (oldest == null || touched < oldest) oldest = touched
    if (newest == null || touched > newest) newest = touched
  }, onProgress)
  return { disabled: false, cutoff, scanned, total: ids.length, ids, byKind, approxChars, oldest, newest }
}

// D1 apply — delete the accepted ids, a few at a time. Returns { deleted, failed }.
export async function applyEventsPruning ({ freezr, ids, onProgress }) {
  let deleted = 0
  let failed = 0
  for (let i = 0; i < ids.length; i += 5) {
    const batch = ids.slice(i, i + 5)
    await Promise.all(batch.map(id =>
      freezr.delete('events', id).then(() => { deleted++ }, () => { failed++ })
    ))
    if (onProgress) onProgress(deleted + failed, ids.length)
  }
  return { deleted, failed }
}

// ---- D2 — interaction_data rebuild preview --------------------------------------------------
// Recompute the MAIL interaction stats per address from the events log, from scratch, and diff
// against what the profiles store carries (incremental counters drift across
// reruns / skipped windows). Two honest approximations, both surfaced to the user:
//   · only messages the analyzer PROCESSED have events — unanalysed mail counts for nothing;
//   · reply pairing is thread-adjacency (previous message in the thread), not the true
//     In-Reply-To parent the live counter uses.
const MAIL_FIELDS = ['messages_from', 'messages_to', 'replies_by_user', 'reply_ms_by_user', 'replies_by_them', 'reply_ms_by_them', 'reply_median_ms_by_user', 'reply_median_ms_by_them', 'first_seen_asof', 'last_seen_asof']

// True median of the reply latencies (ms). Non-responses never enter the sample set — only
// actual reply pairs do — so this is "when they DO answer, how long does it typically take",
// immune to the one answered-after-a-weekend outlier that drags a mean. Only the rebuild can
// compute it (the live counters keep no samples); it refreshes on every D2 run.
const median = (arr) => {
  if (!arr || !arr.length) return null
  const s = arr.slice().sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

export async function previewInteractionRebuild ({ freezr, profiles, meSet, onProgress }) {
  const me = meSet || new Set()
  const msgs = []
  const seen = new Set()
  let oldestEventMs = null
  const scanned = await scanEvents(freezr, (r) => {
    if (r.error) return
    if (!['message', 'workflow_short_circuit'].includes(r.kind)) return
    if (r.channel && r.channel !== 'mail') return
    const key = (r.account_id || '*') + '|' + (r.msg_id || r._id)
    if (seen.has(key)) return
    seen.add(key)
    const asof = Number(r.asof) || 0
    if (oldestEventMs == null || asof < oldestEventMs) oldestEventMs = asof
    msgs.push({
      thread_id: r.thread_id || r.msg_id || r._id,
      asof,
      from: lc(r.from_address),
      to: (r.to_addresses || []).map(lc).filter(Boolean)
    })
  }, onProgress)

  // recompute — mirrors profiles.recordMessage, with prev-in-thread standing in for the parent
  const rebuilt = new Map()
  const samples = new Map() // address -> { user: [ms…], them: [ms…] } — the latencies behind the medians
  const at = (a) => {
    if (!rebuilt.has(a)) rebuilt.set(a, { messages_from: 0, messages_to: 0, replies_by_user: 0, reply_ms_by_user: 0, replies_by_them: 0, reply_ms_by_them: 0, first_seen_asof: null, last_seen_asof: null })
    return rebuilt.get(a)
  }
  const sampleAt = (a) => {
    if (!samples.has(a)) samples.set(a, { user: [], them: [] })
    return samples.get(a)
  }
  const byThread = new Map()
  for (const m of msgs) {
    if (!byThread.has(m.thread_id)) byThread.set(m.thread_id, [])
    byThread.get(m.thread_id).push(m)
  }
  for (const list of byThread.values()) {
    list.sort((a, b) => a.asof - b.asof)
    let prev = null
    for (const m of list) {
      const fromMe = me.has(m.from)
      if (m.from && !fromMe) {
        const d = at(m.from)
        d.messages_from++
        if (!d.first_seen_asof) d.first_seen_asof = m.asof
        d.last_seen_asof = Math.max(Number(d.last_seen_asof) || 0, m.asof)
      }
      if (fromMe) {
        for (const a of m.to) { if (!me.has(a)) at(a).messages_to++ }
      }
      if (prev && prev.from && prev.from !== m.from && m.asof > prev.asof) {
        const delta = m.asof - prev.asof
        if (fromMe && !me.has(prev.from)) {
          const d = at(prev.from)
          d.replies_by_user++
          d.reply_ms_by_user += delta
          sampleAt(prev.from).user.push(delta)
        } else if (!fromMe && me.has(prev.from) && m.from) {
          const d = at(m.from)
          d.replies_by_them++
          d.reply_ms_by_them += delta
          sampleAt(m.from).them.push(delta)
        }
      }
      prev = m
    }
  }
  // medians from the collected samples; stamped so consumers can tell how fresh they are
  const mediansAsof = Date.now()
  for (const [a, s] of samples) {
    const d = at(a)
    d.reply_median_ms_by_user = median(s.user)
    d.reply_median_ms_by_them = median(s.them)
    if (d.reply_median_ms_by_user != null || d.reply_median_ms_by_them != null) d.reply_medians_asof = mediansAsof
  }

  // diff against the store — one row per profile where any mail field differs.
  // CROSS-CHANNEL GUARD: first/last_seen_asof are stamped by EVERY channel (Slack chunks and
  // meeting notes too — profiles.recordMessage), but this rebuild only sees mail. For a profile
  // any non-mail channel has touched (interaction_data.counts exists), the rebuild KEEPS the
  // stored seen-dates — replacing them with mail-only dates would erase e.g. an earlier Slack
  // first-sighting.
  const rows = []
  for (const p of profiles.all()) {
    if (me.has(p.address)) continue
    const stored = p.interaction_data || {}
    const rb = { messages_from: 0, messages_to: 0, replies_by_user: 0, reply_ms_by_user: 0, replies_by_them: 0, reply_ms_by_them: 0, reply_median_ms_by_user: null, reply_median_ms_by_them: null, first_seen_asof: null, last_seen_asof: null, ...(rebuilt.get(p.address) || {}) }
    const crossChannel = !!(stored.counts && Object.keys(stored.counts).length)
    if (crossChannel) {
      rb.first_seen_asof = stored.first_seen_asof != null ? stored.first_seen_asof : null
      rb.last_seen_asof = stored.last_seen_asof != null ? stored.last_seen_asof : null
    }
    const fieldsChanged = MAIL_FIELDS.filter(f => (Number(stored[f]) || 0) !== (Number(rb[f]) || 0))
    if (!fieldsChanged.length) continue
    rows.push({
      address: p.address,
      name: p.display_name || p.address,
      stored: Object.fromEntries(MAIL_FIELDS.map(f => [f, stored[f] != null ? stored[f] : 0])),
      rebuilt: rb,
      fieldsChanged,
      crossChannel, // seen-dates kept from the store (non-mail channels stamp them too)
      noEvents: !rebuilt.has(p.address) // stored counts but the log has nothing — pruned or pre-events history
    })
  }
  rows.sort((a, b) => b.fieldsChanged.length - a.fieldsChanged.length)
  return { rows, scanned, msgCount: msgs.length, oldestEventMs }
}

// ---- D3 — dormant-project detection ---------------------------------------------------------
// Active projects with NO open to-dos and no activity for dormantMonths. PREVIEW ONLY: archiving
// itself is the clean-up's `archive_project` op (the projects_archive collection, maintenance/archive.js).
export function previewDormantProjects ({ store, dormantMonths }) {
  const months = Number(dormantMonths) || 3
  const cutoff = Date.now() - months * 30 * DAY
  const rows = []
  for (const p of store.all()) {
    if (p.status !== 'active' || p.merged_into) continue
    const todos = p.todos || []
    if (todos.some(openish)) continue
    const last = Number(p.last_active_asof) || Number(p.created_asof) || 0
    if (last >= cutoff) continue
    rows.push({
      project_id: p.project_id,
      name: p.name || p.project_id,
      last_active_asof: last,
      totalTodos: todos.length,
      participants: (p.participant_emails || Object.keys(p.participants || {})).length
    })
  }
  rows.sort((a, b) => a.last_active_asof - b.last_active_asof)
  return { rows, cutoff, months }
}

// ---- D4 — forgotten-items finder -------------------------------------------------------------
// Open to-dos that are old, low-priority, and untouched — the items the per-message prompts will
// eventually stop carrying (task-send policy) and that nothing else ever resurfaces. No apply of
// its own: feeds the lab's list and the AI review's stale-verdict section.
export function previewForgottenItems ({ store, minAgeDays = 30, maxImportance = 3, quietDays = 21 }) {
  const now = Date.now()
  const rows = []
  for (const p of store.all()) {
    if (p.status !== 'active' || p.merged_into) continue
    for (const t of (p.todos || [])) {
      if (!openish(t)) continue
      const imp = effImportance(t)
      if (imp > maxImportance) continue
      const created = Number(t.created_asof) || 0
      if (!created || created > now - minAgeDays * DAY) continue
      const lastTouch = Math.max(created, ...(t.evidence || []).map(e => Number(e && e.asof) || 0))
      if (lastTouch > now - quietDays * DAY) continue
      rows.push({
        project_id: p.project_id,
        project_name: p.name || p.project_id,
        todo_id: t.todo_id,
        short: t.short_description || t.description || '(no description)',
        direction: t.direction,
        importance: imp,
        importance_locked: !!t.importance_locked,
        created_asof: created,
        last_touch_asof: lastTouch,
        age_days: Math.round((now - created) / DAY),
        quiet_days: Math.round((now - lastTouch) / DAY)
      })
    }
  }
  rows.sort((a, b) => a.last_touch_asof - b.last_touch_asof)
  return { rows, minAgeDays, maxImportance, quietDays }
}
