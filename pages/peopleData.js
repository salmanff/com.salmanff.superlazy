// peopleData.js — pure aggregation for the People page: joins profiles × projects/todos × events
// into per-person view models, plus the search/filter/sort applied to the list. No DOM, no freezr.

import { fileToProject } from '../jobs/analyze_thread/autoProcess.js'
import { entriesOf, responsibilitiesText } from '../jobs/analyze_thread/responsibilities.js'
import { effImportance } from '../jobs/analyze_thread/dueDates.js'
import { parseSearch } from '../shared/renderUtils.js'

const norm = (a) => String(a || '').toLowerCase().trim()

// A person's effective rank: the user's manual_rank overrides the model's llm_importance.
export function effectiveRank (profile) {
  if (profile.manual_rank != null && profile.manual_rank !== '') return Number(profile.manual_rank)
  return Number((profile.profile && profile.profile.llm_importance) || 3)
}

// Derived responsiveness numbers from the accumulators in interaction_data.
export function deriveInteraction (profile) {
  const d = (profile && profile.interaction_data) || {}
  const avg = (ms, n) => (n > 0 ? ms / n : null)
  // the maintenance rebuild (the clean-up page's housekeeping, D2) stores true medians of the reply latencies — prefer
  // them (outlier-immune) and fall back to the running mean for profiles it hasn't touched yet
  const typ = (medianMs, totalMs, n) => (medianMs != null ? Number(medianMs) : avg(Number(totalMs) || 0, Number(n) || 0))
  return {
    messagesFrom: Number(d.messages_from) || 0,
    messagesTo: Number(d.messages_to) || 0,
    avgReplyByThem: typ(d.reply_median_ms_by_them, d.reply_ms_by_them, d.replies_by_them),
    repliesByThem: Number(d.replies_by_them) || 0,
    avgReplyByUser: typ(d.reply_median_ms_by_user, d.reply_ms_by_user, d.replies_by_user),
    repliesByUser: Number(d.replies_by_user) || 0,
    firstSeen: Number(d.first_seen_asof) || null,
    lastSeen: Number(d.last_seen_asof) || null
  }
}

export function fmtDuration (ms) {
  if (ms == null || !isFinite(ms) || ms <= 0) return null
  const mins = ms / 60000
  if (mins < 60) return Math.max(1, Math.round(mins)) + 'm'
  const hrs = mins / 60
  if (hrs < 48) return Math.round(hrs * 10) / 10 + 'h'
  return Math.round(hrs / 24) + 'd'
}

const openish = (t) => t.status === 'open' || t.status === 'in_progress'

// Collapse history entries ({ ev, dir }, newest-first) into thread groups: the newest message
// of each thread leads; the rest sit under it as "earlier in this thread". Exported — the shared
// messageHistory.js view (People page + the project card's Messages tab) groups with this.
export function groupByThread (entries) {
  const groups = new Map() // thread key -> { thread_id, entries }
  for (const e of entries) {
    const key = e.ev.thread_id || 'msg:' + (e.ev.msg_id || Math.random())
    if (!groups.has(key)) groups.set(key, { thread_id: e.ev.thread_id || null, entries: [] })
    groups.get(key).entries.push(e)
  }
  return [...groups.values()] // insertion order = newest-first already
}

// Does this to-do involve the person (as owner, counterparty, sender or co-owner)?
function involves (todo, addr) {
  if (norm(todo.owner) === addr || norm(todo.counterparty) === addr || norm(todo.sender) === addr) return true
  return Array.isArray(todo.owners) && todo.owners.some(o => norm(o) === addr)
}

export const DIRECTIONS = ['i_owe_them', 'they_owe_me', 'team_owes', 'read_only']
export const DIR_LABELS = {
  i_owe_them: 'You owe them',
  they_owe_me: 'They owe you',
  team_owes: 'Team items',
  read_only: 'FYI / watching'
}

// Build the per-person view models. profiles/projects are the hydrated store arrays; events is
// the (capped) events list; selfSet is the user's own lowercased addresses.
export function buildPeople ({ profiles, projects, events, selfSet }) {
  const self = selfSet || new Set()
  const byAddr = new Map()

  for (const prof of (profiles || [])) {
    const addr = norm(prof.address)
    if (!addr || self.has(addr)) continue
    // the sender's ACTIVE file_to_project auto-process (legacy auto_file* fields normalized)
    const fileEntry = fileToProject(prof.profile)
    byAddr.set(addr, {
      profile: prof,
      address: addr,
      name: prof.display_name && prof.display_name !== addr ? prof.display_name : addr,
      rank: effectiveRank(prof),
      disposition: (fileEntry && fileEntry.details && fileEntry.details.disposition) || null,
      autoProcess: !!fileEntry,
      stats: deriveInteraction(prof),
      open: { i_owe_them: [], they_owe_me: [], team_owes: [], read_only: [] },
      done: [],
      openCount: 0,
      oweCount: 0,   // open items the USER owes them
      owedCount: 0,  // open items THEY owe the user
      sharedProjects: [],
      msgEvents: [],
      lastActivity: deriveInteraction(prof).lastSeen || 0
    })
  }

  for (const p of (projects || [])) {
    const partAddrs = (p.participant_emails && p.participant_emails.length)
      ? p.participant_emails.map(norm)
      : Object.keys(p.participants || {}).map(norm)
    for (const a of partAddrs) {
      const person = byAddr.get(a)
      if (person) person.sharedProjects.push(p)
    }
    for (const t of (p.todos || [])) {
      for (const person of byAddr.values()) {
        if (!involves(t, person.address)) continue
        const entry = { todo: t, project: p }
        if (openish(t)) {
          const dir = DIRECTIONS.includes(t.direction) ? t.direction : 'read_only'
          person.open[dir].push(entry)
          person.openCount++
          if (dir === 'i_owe_them') person.oweCount++
          if (dir === 'they_owe_me') person.owedCount++
        } else {
          person.done.push(entry)
        }
        const when = Math.max(Number(t.created_asof) || 0, Number(t.resolved_asof) || 0)
        if (when > person.lastActivity) person.lastActivity = when
      }
    }
  }

  // A person's history: messages FROM them, messages the USER sent TO them, and third-party
  // mail they were on. Older events (before to_addresses was recorded) only match as received.
  for (const ev of (events || [])) {
    const from = norm(ev.from_address)
    const tos = Array.isArray(ev.to_addresses) ? ev.to_addresses.map(norm) : []
    const dirFor = (addr) => (from === addr ? 'received' : (self.has(from) ? 'sent' : 'other'))
    const touched = new Set()
    for (const addr of [from, ...tos]) {
      if (!addr || touched.has(addr)) continue
      touched.add(addr)
      const person = byAddr.get(addr)
      if (!person) continue
      person.msgEvents.push({ ev, dir: dirFor(addr) })
      const asof = Number(ev.asof) || 0
      if (asof > person.lastActivity) person.lastActivity = asof
    }
  }

  for (const person of byAddr.values()) {
    person.msgEvents.sort((a, b) => (Number(b.ev.asof) || 0) - (Number(a.ev.asof) || 0))
    person.msgThreads = groupByThread(person.msgEvents)
    person.sharedProjects.sort((a, b) => (Number(b.last_active_asof) || 0) - (Number(a.last_active_asof) || 0))
    for (const dir of DIRECTIONS) {
      person.open[dir].sort((a, b) => effImportance(b.todo) - effImportance(a.todo))
    }
    person.done.sort((a, b) => (Number(b.todo.resolved_asof) || 0) - (Number(a.todo.resolved_asof) || 0))
  }

  return [...byAddr.values()]
}

export const SORTS = {
  rank: { label: 'Importance', cmp: (a, b) => b.rank - a.rank || b.openCount - a.openCount },
  activity: { label: 'Recent activity', cmp: (a, b) => b.lastActivity - a.lastActivity },
  open: { label: 'Open items', cmp: (a, b) => b.openCount - a.openCount || b.rank - a.rank },
  volume: { label: 'Message volume', cmp: (a, b) => (b.stats.messagesFrom + b.stats.messagesTo) - (a.stats.messagesFrom + a.stats.messagesTo) },
  name: { label: 'Name', cmp: (a, b) => a.name.localeCompare(b.name) }
}

// Apply search text + min importance + sort + the bulk-sender cut to the full people list.
// minImp cuts on the PERSON's effective rank (manual override else the model's estimate).
// autoOnly is the filter bar's "show only auto-processed" button: OFF (the default since
// 2026-09-12) lists everyone, including the learned bulk senders — the old default hid them.
export function filterPeople (people, { q, minImp = 0, sort, autoOnly } = {}) {
  // "repo:name" searches REPOS ONLY and people are not in repos — so a repo query lists nobody,
  // rather than falling back to a text match on "freezr" in someone's profile (renderUtils.parseSearch)
  if (parseSearch(q).repo !== null) return []
  const needle = norm(q)
  let out = people.filter(p => {
    if (autoOnly && !p.autoProcess) return false
    if (minImp && (Number(p.rank) || 0) < minImp) return false
    if (needle) {
      const hay = [p.name, p.address,
        p.profile.profile && p.profile.profile.summary,
        p.profile.profile && p.profile.profile.relationship,
        p.profile.profile && responsibilitiesText(p.profile.profile)
      ].filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })
  const s = SORTS[sort] || SORTS.rank
  out = out.slice().sort(s.cmp)
  return out
}

// Plain-text meeting brief for one person (for the copy button).
export function meetingBrief (person) {
  const L = []
  const prof = person.profile.profile || {}
  L.push('MEETING BRIEF — ' + person.name + ' <' + person.address + '>')
  if (prof.relationship && prof.relationship !== 'unknown') L.push('Relationship: ' + prof.relationship)
  if (prof.summary) L.push(prof.summary)
  for (const e of entriesOf(prof)) L.push('Handles: ' + e.text + (e.source === 'user' ? ' (yours)' : ''))
  const them = fmtDuration(person.stats.avgReplyByThem)
  if (them) L.push('Typically replies in ~' + them)
  for (const dir of DIRECTIONS) {
    const items = person.open[dir]
    if (!items.length) continue
    L.push('')
    L.push(DIR_LABELS[dir].toUpperCase() + ':')
    for (const { todo, project } of items) {
      L.push('  • [' + (todo.importance || 3) + '] ' + (todo.short_description || todo.description || '') + '  (' + project.name + ')')
    }
  }
  if (person.sharedProjects.length) {
    L.push('')
    L.push('SHARED PROJECTS: ' + person.sharedProjects.map(p => p.name).join(' · '))
  }
  return L.join('\n')
}
