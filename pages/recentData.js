// recentData.js — data + digest model for the RECENT page. The page answers "what happened since
// I last checked?", so the window is cut on the event's PROCESSED time (_date_created — when
// superlazy handled it), not the message's own date: after a training run over old mail,
// everything just learned correctly counts as new. Each item still carries the message's own
// date for display. Events are loaded here; projects/profiles/settings come from persist.loadAll
// (the page needs the live project objects for the explore panel anyway).

// Windowed pull of the events collection — the log grows without bound, so nobody downloads it
// whole any more. Pages newest-first on _date_modified (the one reliably indexed field; events
// are written once and never updated, so its order matches the processed clock) and keeps what
// it has loaded:
//   ensureSince(sinceMs) — page until everything down to the window's cut is loaded. Do NOT call
//                          with sinceMs 0/falsy ("All") — that means "everything"; use ensureCount.
//   ensureCount(n)       — page until n rows are loaded (the "All" cap), or the log runs dry.
//   loadOlder()          — one more page (the "Load older ↓" button); returns just the new rows
//                          so callers can merge them into their own working copy.
import { reposOfProject, parseSearch, repoQueryMatches } from '../shared/renderUtils.js'
import { eventWho, isMaintenanceEdit } from './eventsUi.js'

//
// Pages by a _date_modified CURSOR, not skip: the freezr server answers a date-sorted query from
// its 'Recent' cache, which holds only the newest 1000 rows, so any skip past 1000 came back empty
// and every page stopped there. A `$lte` cursor is a different query shape that goes to the DB.
// `$lte` (not `$lt`) so rows sharing the boundary millisecond are not lost; `seen` drops the
// repeats, and a page that is ALL repeats (a full page of one millisecond) steps past it with `$lt`.
export function createEventsLoader ({ pageSize = 500 } = {}) {
  const rows = []
  const seen = new Set()
  let cursor = null
  let strict = false
  let exhausted = false
  async function loadOlder () {
    if (exhausted) return []
    const q = cursor == null ? {} : { _date_modified: { [strict ? '$lt' : '$lte']: cursor } }
    const page = (await freezr.query('events', q, { count: pageSize, sort: { _date_modified: -1 } })) || []
    if (page.length < pageSize) exhausted = true
    const fresh = page.filter(r => r && !seen.has(r._id))
    for (const r of fresh) seen.add(r._id)
    if (page.length) cursor = page[page.length - 1]._date_modified
    strict = !fresh.length
    if (strict && cursor == null) exhausted = true
    rows.push(...fresh)
    return fresh
  }
  const oldestLoaded = () => (rows.length ? processedClock(rows[rows.length - 1]) : Infinity)
  async function ensureSince (sinceMs) {
    while (!exhausted && oldestLoaded() >= sinceMs) await loadOlder()
    return rows
  }
  async function ensureCount (n) {
    while (!exhausted && rows.length < n) await loadOlder()
    return rows
  }
  return { rows: () => rows, ensureSince, ensureCount, loadOlder, hasMore: () => !exhausted, loadedCount: () => rows.length }
}

// when superlazy DID this (the "since you last checked" clock)
export const processedClock = (ev) => {
  const c = Number(ev._date_created) || Date.parse(ev._date_created) || 0
  return c || Number(ev.asof) || 0
}

const VERB = {
  created: 'added',
  resolved: 'resolved',
  cancelled: 'cancelled',
  in_progress: 'started',
  open: 'reopened',
  moved: 'moved',
  absorbed: 'added to',
  rejected: 'set aside'
}

// One "action" = one human-readable thing that happened to one item. The digest is built from
// these: filtered (priority / search / who), then regrouped into the For-you / Resolved /
// per-project views. Shape: { when, msgDate, who, whoAddr, verb, glyph, short, dir, imp, done,
//                 project_id, todo_id, msg_id, thread_id, account_id, subject, snippet, manual,
//                 who_kind }
// who_kind is eventsUi.eventWho's answer for the event ('manual' | 'auto' | 'superlazy') — what
// the bar's three WHO buttons test. `manual` stays the RENDERING shape (a hand-edit line with no
// message behind it): a clean-up change renders like one but is SuperLazy's, so it carries
// manual:true with who_kind:'superlazy' and who:'the clean-up' (user, 2026-10-04: clean-up items
// were showing up as "you resolved …" in "since last night").
function actionsFromEvent (ev, { getProject, nameOf }) {
  const when = processedClock(ev)
  const who_kind = eventWho(ev)
  const out = []
  const lookupTodo = (pid, tid) => {
    const p = pid && getProject(pid)
    return (p && (p.todos || []).find(t => t.todo_id === tid)) || null
  }

  // Auto-file DECISIONS (a sender put on autopilot, or a straddle flagged on an already-learned
  // one). These carry no `changes`, so without their own branch they would produce no action rows
  // and be invisible here — the one place the user would look. They rank by the EVENT's own
  // importance (4), deliberately above the importance-1 item the auto-file created, and expose
  // `autofile` so the row can offer a one-tap "don't auto-file these" (see recentUi.js).
  if (ev.kind === 'autofile_learned' || ev.kind === 'autofile_mismatch') {
    const addr = ev.address || ev.from_address || null
    const learned = ev.kind === 'autofile_learned'
    out.push({
      when,
      msgDate: Number(ev.asof) || when,
      who: (addr && (nameOf(addr) || addr)) || 'a sender',
      whoAddr: addr,
      verb: learned ? 'is now auto-filed to' : 'may be auto-filed wrongly —',
      glyph: '⚙',
      short: learned
        ? (ev.target_name || ev.category || 'a bucket')
        : ('filed as ' + (ev.category || '?') + ', labelled ' + (ev.by_label || '?')),
      dir: null,
      imp: ev.importance || 4,
      done: false,
      project_id: ev.project_id || null,
      todo_id: null,
      msg_id: ev.msg_id || null,
      thread_id: ev.thread_id || null,
      account_id: ev.account_id || null,
      subject: ev.subject || '',
      snippet: '',
      summary: ev.summary || '',
      manual: false,
      auto: true,
      who_kind,
      autofile: { address: addr, category: ev.category || null, kind: ev.kind }
    })
    return out
  }

  if (ev.kind === 'manual_edit') {
    // your own hand, or the clean-up's accepted proposal (isMaintenanceEdit) — the line reads
    // "the clean-up resolved …" and files under the SuperLazy button, never under Manual
    const cleanup = isMaintenanceEdit(ev)
    const who = cleanup ? 'the clean-up' : 'you'
    const glyph = cleanup ? '🧹' : '✍️'
    // BULK manual events ("✓ resolve all", project merge) carry their per-task list in
    // `changes` and have no single todo_id — one action per change, so each shows as the
    // real task (not "an item")
    if ((ev.changes || []).length) {
      for (const c of ev.changes) {
        const t = lookupTodo(c.project_id, c.todo_id)
        const done = c.type === 'status' && (c.to === 'resolved' || c.to === 'cancelled')
        const verb = c.type === 'status' ? (VERB[c.to] || ('set ' + (c.to || '?')))
          : (c.type === 'moved' ? VERB.moved : 'edited')
        out.push({
          when, msgDate: when, who, whoAddr: null, verb, glyph,
          short: c.short || (t && (t.short_description || t.description)) || '(untitled)',
          dir: t && t.direction, imp: (t && t.importance) || 3, done,
          project_id: c.project_id || null, todo_id: c.todo_id || null,
          msg_id: null, thread_id: null, subject: '', manual: true, who_kind
        })
      }
      return out
    }
    const t = lookupTodo(ev.project_id, ev.todo_id)
    const short = (t && (t.short_description || t.description)) || (ev.target === 'project' ? 'project priority' : 'an item')
    let verb
    if (ev.field === 'status') verb = VERB[ev.after] || ('set ' + ev.after)
    else if (ev.field === 'importance') verb = 'set priority ' + (ev.before || '?') + '→' + (ev.after || '?') + ' on'
    else verb = 'edited'
    out.push({
      when, msgDate: when, who, whoAddr: null, verb, glyph,
      short, dir: t && t.direction, imp: (t && t.importance) || 3,
      done: ev.field === 'status' && (ev.after === 'resolved' || ev.after === 'cancelled'),
      project_id: ev.project_id || null, todo_id: ev.todo_id || null,
      msg_id: null, thread_id: null, subject: '', manual: true, who_kind
    })
    return out
  }

  const whoAddr = ev.from_address || null
  const who = (whoAddr && (nameOf(whoAddr) || whoAddr)) || (ev.via_workflow ? 'auto-processed' : 'someone')
  for (const c of (ev.changes || [])) {
    const isReply = typeof c.short === 'string' && c.short.startsWith('reply:')
    const t = lookupTodo(c.project_id, c.todo_id)
    let verb, glyph, done = false
    if (isReply) { verb = 'drafted a reply for'; glyph = '↩' } else if (c.type === 'created') {
      verb = VERB.created; glyph = '＋'
      // reflect the todo's CURRENT state so For-you checkboxes stay truthful after a resolve
      done = !!(t && (t.status === 'resolved' || t.status === 'cancelled'))
    } else if (c.type === 'status') {
      verb = VERB[c.to] || ('set ' + (c.to || '?')); glyph = (c.to === 'resolved') ? '✅' : '→'
      done = c.to === 'resolved' || c.to === 'cancelled'
    } else if (c.type === 'moved') { verb = VERB.moved; glyph = '⇄' } else if (c.type === 'absorbed') { verb = VERB.absorbed; glyph = '⤵' } else if (c.type === 'rejected') { verb = VERB.rejected; glyph = '✗' } else { verb = c.type; glyph = '•' }
    out.push({
      when,
      msgDate: Number(ev.asof) || when,
      who: isReply ? 'superlazy' : who, // reply drafts are the app's work, not the sender's
      whoAddr,
      verb,
      glyph,
      short: isReply ? ((t && (t.short_description || t.description)) || c.short) : (c.short || (t && (t.short_description || t.description)) || '(untitled)'),
      dir: t && t.direction,
      imp: ev.importance || (t && t.importance) || 3, // an event may out-rank its own item (see autofile_learned)
      done,
      project_id: c.project_id || null,
      todo_id: c.todo_id || null,
      msg_id: ev.msg_id || null,
      thread_id: ev.thread_id || null,
      account_id: ev.account_id || null,
      subject: ev.subject || '',
      snippet: ev.body_snippet || '',
      summary: ev.summary || '', // the model's one-sentence message summary (prompt ≥0.15)
      manual: false,
      auto: !!ev.via_workflow,
      who_kind
    })
  }
  return out
}

// Build the whole digest for one window. Filters (minImp, q, who) apply at the ACTION level; empty
// groups fall away. `who` is the bar's pressed WHO button ('manual' | 'auto' | 'superlazy', or
// null for no restriction) — tested against each action's who_kind, so pressing Manual shows
// ONLY what you did by hand and the clean-up's accepted changes drop out with everything else
// of SuperLazy's. Returns { stats, forMe, resolved, projects } where projects is an ordered
// array of { project, actions[], maxImp, lastWhen, people:Set, emails, autoProcessed }.
export function buildDigest ({ events, getProject, nameOf, sinceMs = 0, minImp = 0, q = '', who = null }) {
  const windowed = events.filter(ev => processedClock(ev) >= sinceMs)

  const stats = {
    emails: 0, autoProcessed: 0, forMe: 0, forTeam: 0, resolved: 0, edits: 0, errors: 0,
    cost: windowed.reduce((s, e) => s + (Number(e.cost) || 0), 0)
  }
  for (const ev of windowed) {
    if (ev.kind === 'message') stats.emails++
    else if (ev.kind === 'workflow_short_circuit') { stats.emails++; stats.autoProcessed++ } else if (ev.kind === 'manual_edit') stats.edits++
    if (ev.error) stats.errors++
    const ld = ev.latest_delta || {}
    if (ld.new_for_me) stats.forMe++
    if (ld.new_for_team) stats.forTeam++
  }

  // every action in the window, newest first
  let actions = []
  for (const ev of windowed) actions.push(...actionsFromEvent(ev, { getProject, nameOf }))
  actions.sort((a, b) => b.when - a.when)
  stats.resolved = actions.filter(a => a.verb === 'resolved').length

  // ---- filters (who + priority + search) ----
  if (who) actions = actions.filter(a => a.who_kind === who)
  if (minImp) actions = actions.filter(a => (a.imp || 3) >= minImp)
  if (q) {
    const sq = parseSearch(q)
    if (sq.repo !== null) {
      // "#name": repos only — an action matches through the repos of the project it touched
      actions = actions.filter(a => a.project_id && repoQueryMatches(reposOfProject(getProject(a.project_id) || {}), sq.repo))
    } else {
      const needle = sq.needle
      actions = actions.filter(a => {
        const proj = a.project_id ? (getProject(a.project_id) || {}) : {}
        return [a.short, a.who, a.subject, proj.name, ...reposOfProject(proj).flatMap(r => [r.name, r.slug])]
          .filter(Boolean).join(' ').toLowerCase().includes(needle)
      })
    }
  }

  // ---- the views ----
  // Automation DECISIONS get their own section rather than being folded into a project story:
  // putting a sender on autopilot is a standing choice the user never explicitly made, and the
  // window in which they can cheaply overrule it is right now. Highest first.
  const decisions = actions.filter(a => a.autofile)
  decisions.sort((x, y) => (y.imp - x.imp) || (y.when - x.when))

  // ---- the three task views ----
  // For you: new obligations STILL on you (created i_owe_them), deduped to the newest touch per
  // to-do. Anything resolved/cancelled since (done reflects the todo's CURRENT status) belongs
  // in the Resolved section, not on your plate.
  const seenTodo = new Set()
  const forMe = []
  for (const a of actions) {
    if (a.verb !== 'added' || a.dir !== 'i_owe_them') continue
    if (a.done) continue
    if (a.todo_id && seenTodo.has(a.todo_id)) continue
    if (a.todo_id) seenTodo.add(a.todo_id)
    forMe.push(a)
  }
  forMe.sort((x, y) => (y.imp - x.imp) || (y.when - x.when))

  const resolved = actions.filter(a => a.verb === 'resolved')

  // Per-project activity, chronological inside each project (a readable "what happened" story)
  const byProject = new Map()
  for (const a of actions) {
    if (a.autofile) continue // shown in its own Decisions section — don't double-render
    if (!a.project_id) continue
    const p = getProject(a.project_id)
    if (!p) continue
    if (!byProject.has(a.project_id)) {
      byProject.set(a.project_id, { project: p, actions: [], maxImp: 0, lastWhen: 0, people: new Set(), emails: new Set(), autoProcessed: 0 })
    }
    const g = byProject.get(a.project_id)
    g.actions.push(a)
    g.maxImp = Math.max(g.maxImp, a.imp || 0)
    g.lastWhen = Math.max(g.lastWhen, a.when)
    if (a.who && a.who !== 'auto-processed' && a.who !== 'the clean-up') g.people.add(a.who)
    if (a.msg_id) g.emails.add(a.msg_id)
    if (a.auto) g.autoProcessed++
  }
  const projects = [...byProject.values()]
  for (const g of projects) g.actions.sort((a, b) => a.when - b.when) // oldest→newest reads as a story
  projects.sort((a, b) => (b.maxImp - a.maxImp) || (b.lastWhen - a.lastWhen))

  return { stats, forMe, resolved, projects, decisions, windowedCount: windowed.length }
}
