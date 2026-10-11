// reprofiler.js — PERMANENT core. The dedicated ONE-PERSON profile call, fired by the engine
// (graduation at N messages; drift when the fit score sinks) or by the user ("Update profile
// with AI"). Unlike the per-message analysis — whose attention belongs to to-dos — this call's
// only job is the person: it gets the current profile as a HYPOTHESIS, the drift log as the
// accumulated case against it, the recent message bodies as primary evidence, the
// person's project participation as the distilled relationship record, and recent bodies BOTH
// ways (the user-sent ones are the source of user_tone). Context sizes come from
// profileTuning.js. DOM-free; freezr is injected (browser or background job alike).
//
// History is provided by the CALLER as rows { msg_id, thread_id, date, from_address, to_addresses,
// subject, snippet, clean_text? } via one of the two builders below — the engine builds from its
// in-memory session, the People page from persisted events + email_bodies.

import { PROFILE_TUNING } from './profileTuning.js'
import { responsibilitiesForPrompt } from './responsibilities.js'

const DAY_MS = 24 * 60 * 60 * 1000

function fmtDate (ms) {
  try { return new Date(Number(ms)).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' } catch (e) { return String(ms) }
}
const lc = (s) => String(s || '').toLowerCase()
const trunc = (s, n) => {
  const t = String(s || '').replace(/\r/g, '').trim()
  return t.length > n ? t.slice(0, n) + '\n[… truncated]' : t
}
function snippet (text, n = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n) + '…' : s
}

export const REPROFILE_SYSTEM_PROMPT = `You maintain the PERSON PROFILES of superlazy, a mail dashboard. Profiles describe who each correspondent is TO THE USER (whose address is tagged [ME]): a short summary, a relationship, their responsibilities (what they handle / what the user delegates to them — this powers delegation suggestions), a standing 1-5 importance, and user_tone — how THE USER writes to THIS person.

This call is about ONE person. You are given the CURRENT profile (treat it as a hypothesis, not a verdict), the person's project participation, interaction stats, an index of recent correspondence, and recent message bodies both ways. Reconcile all of it into the profile that is true NOW.

Rules:
- Ground every claim in the material given (or fetched via request_more). Never invent.
- summary: 2-3 tight sentences max — who they are to the user, current affiliation/role, anything durable that changes how their mail should be read.
- relationship: one of manager | colleague | client | vendor | friend | family | other | unknown (pick the closest).
- responsibilities: a LIST, one entry per kind of work they handle for/with the user; [] when genuinely unknown. Entries marked [USER-SET] in the current profile are the USER'S OWN WORDS — they are kept whatever you send, so do NOT repeat them, reword them, or write anything that contradicts them. Send only the entries YOU would write today; yours replace your previous ones.
- llm_importance: 1-5 standing importance (5 super important, 1 newsletter/no-response). Change it conservatively — only when the evidence clearly moves it.
- user_tone: 1-2 lines describing how THE USER writes TO this person — register/formality, typical greeting and sign-off, brevity, warmth, language if not English. Derive it ONLY from messages the user sent them; with fewer than ${PROFILE_TUNING.MIN_USER_SAMPLES_FOR_TONE} user-sent samples, return the existing value or null — never guess. This is the USER'S voice toward them, NOT the person's own style.
- The drift log is the analyser's accumulated case — address it explicitly: your change_note should say what you did about it.
- "The profile stands" is a first-class outcome: when the evidence does NOT justify changes, return the no_change shape with a reason — do not invent changes to justify the call.
- If, and only if, you cannot judge responsibly with what you were given, return a request_more instead (bounded; the caller resolves and re-sends): { "request_more": [ { "kind": "message_body", "msg_id": "..." }, { "kind": "project_detail", "project_id": "..." } ] }

Output valid JSON only — no prose, no code fences — exactly ONE of:
{ "profile": { "summary": "string", "relationship": "string", "responsibilities": ["one entry per kind of work — YOUR OWN only"], "llm_importance": 3, "user_tone": "string | null", "change_note": "one line for the audit log — what changed and why" } }
{ "no_change": true, "reason": "one line — why the current profile stands" }
{ "request_more": [ ... ] }`

// ---- history builders ------------------------------------------------------------------------

// Shared shaping: newest-first rows involving the person, the index window (lookback, extended
// for sparse senders), and pre-cap volume counts for the trend line.
function shapeHistory (rows, address, asof, tuning) {
  const t = tuning || PROFILE_TUNING
  const addr = lc(address)
  const all = rows
    .filter(r => r && (lc(r.from_address) === addr || (r.to_addresses || []).some(a => lc(a) === addr)))
    .sort((a, b) => (Number(b.date) || 0) - (Number(a.date) || 0))
  const fromThem = all.filter(r => lc(r.from_address) === addr)
  const now = Number(asof) || 0
  const counts = {
    d30: fromThem.filter(r => now - Number(r.date) <= 30 * DAY_MS).length,
    d90: fromThem.filter(r => now - Number(r.date) <= 90 * DAY_MS).length,
    total: fromThem.length
  }
  let index = all.filter(r => now - Number(r.date) <= t.INDEX_LOOKBACK_DAYS * DAY_MS)
  if (index.length < t.INDEX_MIN_ROWS) index = all.slice(0, t.INDEX_MIN_ROWS) // sparse sender: old rows beat no rows
  index = index.slice(0, t.INDEX_ROWS_MAX)
  return { rows: index, allRows: all, counts }
}

// Engine-side: from the session's in-memory normalized messages (session.allById). Rows carry
// clean_text, so no extra fetching is needed.
export function historyFromSession ({ allById, address, asof, tuning } = {}) {
  const rows = []
  for (const m of (allById ? allById.values() : [])) {
    rows.push({
      msg_id: m.msg_id,
      thread_id: m.thread_id || null,
      date: m.date,
      from_address: lc(m.from && m.from.address),
      to_addresses: [...(m.to || []), ...(m.cc || [])].map(x => lc(x && x.address)).filter(Boolean),
      subject: m.subject || '',
      clean_text: m.clean_text || ''
    })
  }
  return shapeHistory(rows, address, asof, tuning)
}

// Page-side: from persisted analysis events (+ email_bodies for the rows that will be inlined
// in full). getBody({ account_id, msg_id }) → stored body record | null (persist.getEmailBody).
export async function historyFromEvents ({ events, address, meSet, asof, tuning, getBody } = {}) {
  const t = tuning || PROFILE_TUNING
  const rows = []
  const seen = new Set()
  for (const ev of (events || [])) {
    if (!ev || !ev.msg_id || seen.has(ev.msg_id)) continue
    if (!['message', 'workflow_short_circuit'].includes(ev.kind)) continue
    seen.add(ev.msg_id)
    rows.push({
      msg_id: ev.msg_id,
      thread_id: ev.thread_id || null,
      account_id: ev.account_id || null,
      date: ev.asof,
      from_address: lc(ev.from_address),
      to_addresses: (ev.to_addresses || []).map(lc),
      subject: ev.subject || '',
      clean_text: ev.body_snippet || ''
    })
  }
  const shaped = shapeHistory(rows, address, asof, tuning)
  // upgrade the rows that assembly will inline (baseline candidates) from snippet to full body
  if (getBody) {
    const me = new Set([...(meSet || [])].map(lc))
    const addr = lc(address)
    const fromThem = shaped.allRows.filter(r => r.from_address === addr).slice(0, t.BASELINE_BODIES_FROM_THEM)
    const fromUser = shaped.allRows.filter(r => me.has(r.from_address)).slice(0, t.BASELINE_BODIES_FROM_USER)
    for (const r of [...fromThem, ...fromUser]) {
      try {
        const body = await getBody({ account_id: r.account_id, msg_id: r.msg_id })
        if (body && body.body_text) r.clean_text = body.body_text
      } catch (e) { /* snippet stays */ }
    }
  }
  return shaped
}

// ---- context assembly --------------------------------------------------------------------------

function renderIndexRow (r, meSet, inlined) {
  const me = (a) => (meSet && meSet.has(lc(a)) ? ' [ME]' : '')
  const to = (r.to_addresses || []).map(a => a + me(a)).join(', ')
  return `- (msg_id: ${r.msg_id}) ${fmtDate(r.date)} · From ${r.from_address}${me(r.from_address)} · to: ${to || '—'} · "${r.subject || ''}" · ${snippet(r.clean_text)}` +
    (inlined.has(r.msg_id) ? ' [shown in full below]' : '')
}

function renderBody (r, meSet, cap) {
  const me = (a) => (meSet && meSet.has(lc(a)) ? ' [ME]' : '')
  return [
    `from: ${r.from_address}${me(r.from_address)} · (msg_id: ${r.msg_id}) · ${fmtDate(r.date)}`,
    `subject: ${r.subject || ''}`,
    '',
    trunc(r.clean_text || '(no body available)', cap)
  ].join('\n')
}

function personTodosOf (p, addr) {
  const involves = (t) => [t.owner, t.counterparty, t.sender, ...(t.owners || [])].some(x => lc(x) === addr)
  const mine = (p.todos || []).filter(involves)
  return {
    open: mine.filter(t => t.status === 'open' || t.status === 'in_progress'),
    done: mine.filter(t => t.status === 'resolved' || t.status === 'cancelled')
  }
}

const todoLine = (t) => `    - (${t.direction}, ${t.status}) "${t.short_description || ''}"`

// Build the user message. person = the profile-store record; store = createProjectStore();
// history = { rows, allRows, counts } from a builder above; trigger = 'graduation' | 'drift' |
// 'user_request'; extraDetail = resolved request_more strings from earlier rounds.
export function assembleReprofile ({ person, store, history, tuning, trigger, asof, meSet, extraDetail } = {}) {
  const t = tuning || PROFILE_TUNING
  const addr = person.address
  const pr = person.profile || {}
  const me = new Set([...(meSet || [])].map(lc))
  const d = person.interaction_data || {}

  const nowLine = `Treat the current moment as ${fmtDate(asof)} — judge with information up to then; ignore anything dated after it.`
  const triggerLine = {
    graduation: `TRIGGER: graduation — this person has now sent ${d.messages_from || 0} messages; their provisional first-pass profile should be ESTABLISHED properly from the full material (including user_tone).`,
    user_request: 'TRIGGER: the user asked for this profile to be re-checked and updated now.'
  }[trigger] || `TRIGGER: ${trigger || 'unspecified'}.`

  const parts = [
    nowLine,
    triggerLine,
    '',
    `## The person: ${person.display_name || addr} <${addr}>`,
    '',
    '## Current profile (the hypothesis to test)',
    `- summary: ${pr.summary || '(none)'}`,
    `- relationship: ${pr.relationship || 'unknown'}`,
    `- responsibilities: ${responsibilitiesForPrompt(pr) || '(unknown)'}`,
    `- user_tone: ${pr.user_tone || '(not yet learned)'}`,
    `- standing importance: ${person.manual_rank != null ? person.manual_rank + ' (USER-SET manual_rank — do not return llm_importance changes; they will be ignored)' : (pr.llm_importance || 3) + ' (llm)'}`,
    `- last profiled: ${pr.last_profiled_asof ? fmtDate(pr.last_profiled_asof) : 'never'}${pr.solidified_asof ? '' : ' — still PROVISIONAL (first-pass, formed inline from single messages)'}`,
    '',
    '## Interaction stats',
    `- messages from them: ${d.messages_from || 0} (last 30 days: ${history.counts.d30}, last 90: ${history.counts.d90}, in loaded history: ${history.counts.total}); messages the user sent them: ${d.messages_to || 0}`,
    `- they replied to the user ${d.replies_by_them || 0}x${d.replies_by_them ? ' (' + (d.reply_median_ms_by_them != null ? 'median ' + Math.round(d.reply_median_ms_by_them / 3600000) : 'avg ' + Math.round(d.reply_ms_by_them / d.replies_by_them / 3600000)) + 'h)' : ''}; the user replied to them ${d.replies_by_user || 0}x${d.replies_by_user ? ' (' + (d.reply_median_ms_by_user != null ? 'median ' + Math.round(d.reply_median_ms_by_user / 3600000) : 'avg ' + Math.round(d.reply_ms_by_user / d.replies_by_user / 3600000)) + 'h)' : ''}`,
    `- first seen: ${d.first_seen_asof ? fmtDate(d.first_seen_asof) : '?'}; last seen: ${d.last_seen_asof ? fmtDate(d.last_seen_asof) : '?'}`
  ]

  const inlined = new Set()

  // ---- project participation ----
  const projects = (store ? store.all() : []).filter(p => p && p.participants && p.participants[addr])
    .sort((a, b) => (Number(b.last_active_asof) || 0) - (Number(a.last_active_asof) || 0))
  parts.push('', '## Project participation (the distilled relationship record)')
  if (!projects.length) parts.push('(no formal project participation recorded)')
  projects.slice(0, t.PROJECTS_IN_FULL_MAX).forEach(p => {
    const part = p.participants[addr] || {}
    const { open, done } = personTodosOf(p, addr)
    parts.push(`### [${p.project_id}] "${p.name}" (importance ${p.importance}${p.last_active_asof ? ', last active ' + fmtDate(p.last_active_asof) : ''})`)
    parts.push(`  summary: ${p.summary || '(none)'}`)
    parts.push(`  their role: ${part.role || '?'}${part.role_note ? ' — ' + part.role_note : ''}`)
    const shown = [...open.slice(0, t.TODOS_PER_PROJECT_EACH_WAY), ...done.slice(-t.TODOS_PER_PROJECT_EACH_WAY)]
    if (shown.length) parts.push(`  their to-dos (${open.length} open, ${done.length} closed):\n` + shown.map(todoLine).join('\n'))
  })
  if (projects.length > t.PROJECTS_IN_FULL_MAX) {
    parts.push('Also on: ' + projects.slice(t.PROJECTS_IN_FULL_MAX).map(p => `"${p.name}"`).join(', '))
  }
  // informal presence: threads they appear on that map to projects they hold no role in
  if (store && store.linkedProjectsFor) {
    const formal = new Set(projects.map(p => p.project_id))
    const informal = new Map()
    for (const r of history.allRows) {
      if (!r.thread_id) continue
      for (const p of (store.linkedProjectsFor(r.thread_id) || [])) {
        if (!formal.has(p.project_id)) informal.set(p.project_id, { name: p.name, n: (informal.get(p.project_id) || { n: 0 }).n + 1 })
      }
    }
    if (informal.size) {
      parts.push('Appears on (incl. cc, no recorded role): ' + [...informal.values()].slice(0, 10).map(x => `"${x.name}" (${x.n} msgs)`).join(', '))
    }
  }

  // ---- baseline bodies (tone + current normal) ----
  const notInlined = (r) => !inlined.has(r.msg_id)
  const fromThem = history.allRows.filter(r => r.from_address === addr && r.clean_text).filter(notInlined).slice(0, t.BASELINE_BODIES_FROM_THEM)
  fromThem.forEach(r => inlined.add(r.msg_id))
  const fromUser = history.allRows.filter(r => me.has(r.from_address) && r.clean_text).slice(0, t.BASELINE_BODIES_FROM_USER)
  fromUser.forEach(r => inlined.add(r.msg_id))
  if (fromThem.length) {
    parts.push('', '## Recent messages FROM them (full — their current baseline)')
    for (const r of fromThem) parts.push('', renderBody(r, me, t.BASELINE_BODY_MAX_CHARS))
  }
  if (fromUser.length) {
    parts.push('', `## Recent messages the USER sent them (full — the source of user_tone${fromUser.length < t.MIN_USER_SAMPLES_FOR_TONE ? '; FEWER THAN ' + t.MIN_USER_SAMPLES_FOR_TONE + ' samples — do not derive user_tone from these' : ''})`)
    for (const r of fromUser) parts.push('', renderBody(r, me, t.BASELINE_BODY_MAX_CHARS))
  }

  // ---- index + extras ----
  parts.push('', '## Recent correspondence index (request a body with request_more if you need it)')
  parts.push(history.rows.length ? history.rows.map(r => renderIndexRow(r, me, inlined)).join('\n') : '(no history rows available)')

  if (extraDetail && extraDetail.length) {
    parts.push('', '## Additional detail you requested', extraDetail.join('\n\n'))
  }

  parts.push('', 'Produce the profile that is true as of ' + fmtDate(asof) + '. Output JSON only — the profile shape, the no_change shape, or a request_more.')
  return parts.join('\n')
}

// ---- the call ----------------------------------------------------------------------------------

function coerce (response) {
  if (response && typeof response === 'object') return response
  let s = String(response || '').trim()
  s = s.replace(/^```(json)?/i, '').replace(/```$/, '').trim()
  const first = s.indexOf('{')
  const last = s.lastIndexOf('}')
  if (first > 0 || last < s.length - 1) { if (first >= 0 && last > first) s = s.slice(first, last + 1) }
  try { return JSON.parse(s) } catch (e) { return null }
}

function classify (o) {
  if (!o || typeof o !== 'object') return { error: 'not an object' }
  if (Array.isArray(o.request_more)) return { type: 'request_more' }
  if (o.no_change) return { type: 'no_change' }
  if (o.profile && typeof o.profile === 'object' && o.profile.summary) return { type: 'profile' }
  return { error: 'output is neither profile, no_change, nor request_more' }
}

function resolveRequests (reqs, { history, store }) {
  const byId = new Map(history.allRows.map(r => [r.msg_id, r]))
  const details = []
  for (const r of (reqs || [])) {
    if (r.kind === 'message_body' && r.msg_id && byId.has(r.msg_id)) {
      const m = byId.get(r.msg_id)
      details.push(`Requested message (msg_id: ${m.msg_id}) — from ${m.from_address} · ${fmtDate(m.date)} · "${m.subject || ''}"\n${m.clean_text || '(no body available)'}`)
    } else if (r.kind === 'project_detail' && r.project_id && store && store.get(r.project_id)) {
      const p = store.get(r.project_id)
      const todos = (p.todos || []).map(t => `  [${t.todo_id}] (${t.direction}, ${t.status}, imp ${t.importance}) "${t.short_description || ''}" — ${t.description || ''}`).join('\n')
      details.push(`Requested project [${p.project_id}] "${p.name}"\n  summary: ${p.summary || '(none)'}\n${todos || '  (no to-dos)'}`)
    } else {
      details.push(`Could not resolve request: ${JSON.stringify(r)} — judge with what you have.`)
    }
  }
  return details
}

// Run one re-profile end to end: assemble → LLM (bounded request_more loop) → apply to the
// profile store. Returns { ok, outcome: 'updated' | 'no_change' | 'skipped', applied?, reason?,
// cost, rounds, meta? }. The CALLER persists (saveProfile / event) — this stays storage-free.
export async function runReprofile ({ freezr, model, profiles, store, address, history, tuning, trigger, asof, meSet, userRequested } = {}) {
  const t = tuning || PROFILE_TUNING
  const person = profiles.get(address)
  if (!person) return { ok: false, outcome: 'skipped', reason: 'no profile for ' + address, cost: 0, rounds: 0 }

  // thinking off — same reasoning as analyze.js: structured output at volume, and default
  // thinking on recent models can consume the whole output budget before the JSON is written
  const opts = { context: REPROFILE_SYSTEM_PROMPT, responseType: 'json', max_tokens: t.REPROFILE_MAX_TOKENS, thinking: false }
  if (model && model.provider) opts.provider = model.provider
  if (model && model.family) opts.family = model.family

  const extraDetail = []
  let rounds = 0
  let cost = 0
  let meta = null
  while (true) {
    const userMessage = assembleReprofile({ person, store, history, tuning: t, trigger, asof, meSet, extraDetail })
    let res = await freezr.llm.ask(userMessage, opts)
    if (!res || res.success === false) return { ok: false, outcome: 'skipped', reason: 'llm.ask failed: ' + (res && res.response), cost, rounds }
    cost += (res.meta && res.meta.cost && res.meta.cost.totalCost) || 0
    meta = res.meta || {}
    let parsed = coerce(res.response)
    let c = classify(parsed)
    if (c.error) {
      // one repair attempt, same discipline as analyze.js
      res = await freezr.llm.ask(userMessage + `\n\nYour previous reply was invalid (${c.error}). Reply again with ONLY valid JSON — the profile shape, no_change, or request_more.`, opts)
      cost += (res && res.meta && res.meta.cost && res.meta.cost.totalCost) || 0
      parsed = coerce(res && res.response)
      c = classify(parsed)
      if (c.error) return { ok: false, outcome: 'skipped', reason: 'invalid reprofile output: ' + c.error, cost, rounds }
    }
    if (c.type === 'request_more' && rounds < t.REPROFILE_FETCH_ROUNDS_MAX) {
      extraDetail.push(...resolveRequests(parsed.request_more, { history, store }))
      rounds++
      continue
    }
    if (c.type === 'request_more') return { ok: false, outcome: 'skipped', reason: 'kept requesting detail past the fetch cap', cost, rounds }
    if (c.type === 'no_change') {
      // a checked-and-stands verdict still solidifies + resets the drift accumulator — otherwise
      // the same drift would re-trigger this call forever
      const applied = profiles.applyReprofile(address, { change_note: 'no change: ' + (parsed.reason || 'profile stands') }, { asof, userRequested })
      return { ok: true, outcome: 'no_change', applied, reason: parsed.reason || null, cost, rounds, meta }
    }
    const applied = profiles.applyReprofile(address, parsed.profile, { asof, userRequested })
    if (!applied) return { ok: false, outcome: 'skipped', reason: 'profile is user-edited — result not applied', cost, rounds, meta }
    return { ok: true, outcome: 'updated', applied, reason: parsed.profile.change_note || null, cost, rounds, meta }
  }
}
