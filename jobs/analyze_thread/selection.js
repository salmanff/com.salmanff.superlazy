// selection.js — WHAT GOES IN WHICH CACHED BLOCK. Every membership formula for the durable turns
// lives here and nowhere else, so the hot/cold split can be tuned and measured without hunting
// through the renderer. Each rule is a plain object at the top of the file: change the numbers,
// re-run the suite, replay a case.
//
// WHY THE SPLIT IS ABOUT WRITES, NOT READS (measured 2026-09-19, 346 recorded calls).
// Both durable turns are read at the cached rate on EVERY call, so moving a project between them
// changes nothing about read cost — the two blocks together are the same bytes either way. What
// changes is how often those bytes are RE-WRITTEN: the hot block re-renders on the message
// thresholds (~every 9-25 messages in practice), the cold block weekly. A cache write costs
// 1.25x-2x the input rate, so the only thing that matters is keeping the FREQUENTLY REWRITTEN
// block small.
//
// The old rule — hot = "touched in the last 7 days" — put 67 of 117 projects (39,810 chars) in the
// block that gets rewritten every few messages and only 50 (26,913) in the weekly one. The rule
// below puts 28 projects (16,696 chars) in hot: a 58% cut in bytes written per refresh, with the
// same total in the prefix.

// EVERY NUMBER IN THIS FILE IS A TUNABLE, not a fact. They are listed in the tunables registry
// (specs/pipeline-walkthrough.md Part 2) and tracked in specs/pipeline-backlog.md. The intended end
// state is NOT to expose them one by one in Preferences but to wrap them into a single low /
// medium / high "how much context to buy" choice, the way analysis_context_chars already works —
// more projects, more profiles, more of everything, priced together.

const DAY_MS = 24 * 3600 * 1000

// ---- projects: which rows go in the HOT (frequently re-rendered) block -------------------------
// The union of three claims. Recency alone was the old rule and it was too generous; "most active"
// counts real touches (evidence entries), so a project with one stale timestamp does not hold a
// hot slot ahead of one being worked on daily.
export const HOT_PROJECTS = {
  recentBusinessDays: 2,  // the "right now" window — weekends do not count against a project
  recentTop: 10,          // …the most active this many, within it
  weekDays: 7,            // the "this week" window (calendar days)
  weekTop: 20,            // …the most active this many, within it
  starImportance: 4,      // importance at or above this is always hot, however quiet
  starWhenLocked: true    // a user-SET importance (importance_locked) is a star at any value
}

// ---- people: whose profiles ride in the COLD block ---------------------------------------------
// ON at 20 (user, 2026-09-19), and bought for QUALITY rather than cost — the arithmetic says it
// does not pay for itself, so the reason has to be the other thing it buys.
//
// Cost, measured over 346 recorded calls: the volatile people section is already a median 1,946
// chars, because CC'd people collapse to one names-only line and only the sender gets a full
// profile. A cold block of N profiles costs 0.1 x its bytes on EVERY call and only saves the
// sender's own line on the calls where that sender writes — 32% of calls at N=10, 41% at N=20.
// Net per call: +357 chars-equivalent at N=10, +970 at N=20, +2,689 at N=50. No size wins.
//
// What it buys: the model knows who someone is when they are MENTIONED IN A BODY rather than
// sitting on the thread — today it sees nothing about them. Whether that changes an analysis is a
// measurement still to make, not an assumption.
export const COLD_PROFILES = {
  enabled: true,
  top: 20,               // by total correspondence (messages_from + messages_to)
  seenWithinDays: 0      // 0 = no recency filter; e.g. 7 to require a sighting this week
}

// ---- people: how much profile each ROLE ON THIS MESSAGE gets in the volatile block --------------
// Measured 2026-09-20 over 742 real mail items, at batch size 10 (so these are per-CALL deltas
// against a ~27,000-char volatile block):
//
//   today (to: brief, cc: collapsed)        mean 2,923 chars    —
//   to: full + first 2 cc: brief            mean 3,657        +734   (+2.7%)   <- this rule
//   to: full + ALL cc: brief                mean 4,130      +1,207   (+4.5%)
//   ALL to: and cc: full                    mean 4,772      +1,849   (+6.8%)
//
// The cap is not about the bytes — even the maximalist option is under 7% of the block, against a
// linked-projects section averaging 20,124. It is about WHERE the bytes go. The cc distribution is
// sharply bimodal: 76% of messages have 0 or 1 cc, and a 9% tail runs to 27. Sending every cc in
// full spends almost the whole extra allowance on that tail — mass distributions, exactly the mail
// where another profile is least likely to change an assignment. Two covers the real cc's; the tail
// stays collapsed, and `request_more: person_detail` is the escape hatch when one of them matters.
//
// UNPROVEN, and worth remembering before tuning these up: the premise is that thin recipient
// profiles cause project mis-assignment. The competing explanation is that catalog rows already
// carry each project's participant addresses, so address-matching needs no profile at all. Replay
// a mis-assigned case before spending more here.
export const RECIPIENT_PROFILES = {
  toDetail: 'full',   // 'full' | 'brief' | 'name' — direct (to:) recipients
  ccDetail: 'brief',  // …the first `ccCount` cc'd people
  ccCount: 2          // the rest stay in the collapsed names-only line
}

/** Timestamp `n` business days before `from`, skipping Saturdays and Sundays. */
export function businessDaysAgo (n, from = Date.now()) {
  const d = new Date(Number(from) || Date.now())
  let left = Math.max(0, Number(n) || 0)
  while (left > 0) {
    d.setTime(d.getTime() - DAY_MS)
    const day = d.getDay()
    if (day !== 0 && day !== 6) left--
  }
  return d.getTime()
}

/**
 * How much really happened on a project since `since`: evidence entries written in the window,
 * plus to-dos created in it, plus one for the project's own last-active stamp. Counting touches
 * rather than reading one timestamp is what separates "worked on daily" from "brushed once".
 */
export function projectActivity (p, since) {
  if (!p) return 0
  let n = 0
  for (const t of (p.todos || [])) {
    for (const e of (t.evidence || [])) if ((Number(e && e.asof) || 0) >= since) n++
    if ((Number(t.created_asof) || 0) >= since) n++
  }
  if ((Number(p.last_active_asof) || 0) >= since) n++
  return n
}

/** True when the user has singled this project out — a locked importance, or a high one. */
export function isStarProject (p, rule = HOT_PROJECTS) {
  if (!p) return false
  if (rule.starWhenLocked && p.importance_locked) return true
  return (Number(p.importance) || 0) >= (Number(rule.starImportance) || Infinity)
}

/**
 * The project_ids that belong in the HOT block: the most active few right now, the most active
 * handful this week, and every starred project. Everything else — the quiet majority — rides in
 * the weekly cold block.
 *
 * @param {Array} projects full project records (store.all()), not catalog rows: the formula needs
 *                         todos/evidence to count activity and importance_locked to spot a star.
 * @returns {Set<string>}
 */
export function hotProjectIds (projects, { asof = Date.now(), rule = HOT_PROJECTS } = {}) {
  const live = (projects || []).filter(p => p && (p.status || 'active') === 'active')
  const clock = Number(asof) || Date.now()
  const pick = (since, top) => {
    const inWindow = live.filter(p => (Number(p.last_active_asof) || 0) >= since)
    // ties broken by last_active_asof then project_id, so membership is stable between renders
    inWindow.sort((a, b) => projectActivity(b, since) - projectActivity(a, since) ||
      (Number(b.last_active_asof) || 0) - (Number(a.last_active_asof) || 0) ||
      (a.project_id < b.project_id ? -1 : 1))
    return inWindow.slice(0, Math.max(0, Number(top) || 0))
  }
  const ids = new Set()
  for (const p of pick(businessDaysAgo(rule.recentBusinessDays, clock), rule.recentTop)) ids.add(p.project_id)
  for (const p of pick(clock - (Number(rule.weekDays) || 0) * DAY_MS, rule.weekTop)) ids.add(p.project_id)
  for (const p of live) if (isStarProject(p, rule)) ids.add(p.project_id)
  return ids
}

/**
 * The addresses whose profiles ride in the COLD block — the top `top` correspondents. Empty when
 * the rule is disabled, in which case every profile keeps riding in the volatile block as before.
 * @param {Array} profileRecords profile records ({ address, interaction_data, … })
 */
export function coldProfileAddresses (profileRecords, { asof = Date.now(), rule = COLD_PROFILES } = {}) {
  if (!rule || !rule.enabled) return new Set()
  const clock = Number(asof) || Date.now()
  const floor = rule.seenWithinDays ? clock - rule.seenWithinDays * DAY_MS : 0
  const total = (p) => {
    const d = (p && p.interaction_data) || {}
    return (Number(d.messages_from) || 0) + (Number(d.messages_to) || 0)
  }
  return new Set((profileRecords || [])
    .filter(p => p && p.address && (!floor || (Number((p.interaction_data || {}).last_seen_asof) || 0) >= floor))
    .sort((a, b) => total(b) - total(a) || (a.address < b.address ? -1 : 1))
    .slice(0, Math.max(0, Number(rule.top) || 0))
    .map(p => String(p.address).toLowerCase()))
}
