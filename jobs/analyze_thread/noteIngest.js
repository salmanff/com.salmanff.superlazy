// noteIngest.js — ingestion of MANUAL NOTES (channel 'notes', specs/superlazy-inputs.md §6.2).
// Two callers:
//   - the Add/Edit-note modal (newNoteModal.js): the note is persisted PENDING-FIRST (never lost,
//     even if analysis fails), then runNoteIngestion analyses it immediately under the same run
//     lock every mail check uses;
//   - the mail run's tail (ingest.js): drainPendingInputs picks up notes typed while a run held
//     the lock, or whose save-time analysis errored.
// A note needs NO MailSource: its entry carries priorMsgs directly (a one-item synthetic thread),
// so the session is created with source: null — engine.processBatch never touches the source for
// entries given whole, and resolveRequests reads session.allById / the store only.
//
// NOTE: ingest.js and this file import each other (sessionPrefsFrom here, drainPendingInputs
// there). Both are call-time function bindings, so the ES-module cycle is harmless.

import { createSession, processBatch } from './engine.js'
import { eventFromStep } from './persist.js'
import { normalizeMessage } from './normalize.js'
import { createProfileStore } from './profiles.js'
import { createProjectStore } from './projectStore.js'
import { createInstructionStore } from './instructionStore.js'
import { sessionPrefsFrom } from './ingest.js'
import { LOCK_STALE_MS, STEP_TIMEOUT_MS, isEnvironmentalFailure } from './config.js'

export const MANUAL_ACCOUNT_ID = 'manual'
export const NOTE_SOURCE_TAG = 'note:manual'

const lc = (s) => String(s || '').toLowerCase()

// A stalled request must never hold the RUN LOCK hostage (observed 2026-08-22: a job died at the
// run tail with the lock still held — every later check skipped with "processed elsewhere" until
// the stale window passed). Same pattern as processor.withTimeout: the abandoned promise is not
// cancelled, but the caller moves on and the lock gets released.
const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(label)), ms)
  promise.then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
})
export const newNoteOwnerId = () => 'tab:note:' + Math.random().toString(36).slice(2) + Date.now().toString(36)

// Same FNV-1a as persist.hash32 — content identity for edit detection (§6.4).
function hash32 (str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(36)
}
export const noteContentHash = ({ title, body_text, participants }) =>
  hash32([title || '', body_text || '', ...(participants || []).map(p => (p.address || '') + '~' + (p.name || ''))].join('|'))

// Mint a fresh note's ids. The thread is synthetic and one-item (§4): note_<msg_id>.
export function mintNoteIds () {
  const msgId = 'n_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
  return { msg_id: msgId, thread_id: 'note_' + msgId }
}

// A title is a LABEL, not analysis input (the model reads the whole body) — so it is optional:
// pasted meeting notes shouldn't force the user to type a headline twice. Fallback = the first
// non-empty line, stripped of markdown furniture, clipped on a word boundary.
export function deriveNoteTitle (body) {
  const line = String(body || '').split('\n').map(l => l.trim()).find(Boolean) || ''
  const clean = line.replace(/^[#>*\-•\s]+/, '').trim() || 'Untitled note'
  if (clean.length <= 70) return clean
  const cut = clean.slice(0, 70)
  const sp = cut.lastIndexOf(' ')
  return (sp > 40 ? cut.slice(0, sp) : cut) + '…'
}

// Build the `inputs` record for a manual note (status pending — analysis comes after the save).
// attendees: [{ address?, name? }] — address may be empty (name-only, §9). authorAddress = ME.
export function noteInputRecord ({ msg_id, thread_id, title, body, attendees, date, authorAddress, authorName, itemKind, linkedProjectId }) {
  const participants = (attendees || [])
    .map(a => ({ address: lc(a.address), name: (a.name || '').trim(), kind: 'attendee' }))
    .filter(p => p.address || p.name)
  const rec = {
    channel: 'notes',
    item_kind: itemKind || 'meeting_notes',
    provider: 'manual',
    account_id: MANUAL_ACCOUNT_ID,
    msg_id,
    thread_id,
    date: Number(date) || Date.now(),
    author_address: lc(authorAddress),
    author_name: authorName || '',
    participants,
    participants_kind: 'attendees',
    title: (title || '').trim() || deriveNoteTitle(body),
    body_text: (body || '').trim(),
    body_html: '',
    labels: [],
    attachments: [],
    html_truncated: false,
    authority: 'canonical',   // the ONLY copy in existence — never pruned, archived not deleted
    archived: false,
    status: 'pending',
    analysis_event_id: null,
    revision: 1,
    content_hash: null,
    edited_asof: null,
    prior_revisions: [],
    linked_project_id: linkedProjectId || null,
    captured_asof: Date.now(),
    sources: [NOTE_SOURCE_TAG]
  }
  rec.content_hash = noteContentHash(rec)
  return rec
}

// inputs record -> the normalized item the engine analyses.
export function normalizedFromInput (rec) {
  const m = normalizeMessage({
    channel: rec.channel || 'notes',
    item_kind: rec.item_kind || null,
    msg_id: rec.msg_id,
    thread_id: rec.thread_id,
    date: rec.date,
    from: { address: rec.author_address || '', name: rec.author_name || '' },
    to: (rec.participants || []).map(p => ({ address: p.address || '', name: p.name || '' })),
    cc: [],
    subject: rec.title || '',
    text: rec.body_text || '',
    source_ref: 'inputs'
  })
  m.revised = (Number(rec.revision) || 1) > 1 // the renderer adds the REVISED marker (§6.4)
  return m
}

// Analyse ONE pending input through an existing session and persist everything it touched —
// the note-side sibling of processor.persistOne. Never throws: the input's status records the
// outcome, so a failed note shows as 'error' and the drain retries it on a later run.
export async function processNoteInput (session, persist, inputRec, { emit } = {}) {
  const out = emit || (() => {})
  const newMsg = normalizedFromInput(inputRec)
  session.allById.set(newMsg.msg_id, newMsg)
  // The modal's project picker pre-links the synthetic thread, so the model edits that project's
  // full list in place instead of guessing from the catalog (§6.2.5).
  if (inputRec.linked_project_id && session.store.get(inputRec.linked_project_id)) {
    session.store.linkThread(newMsg.thread_id, inputRec.linked_project_id)
  }

  let stepEvent = null
  let errorEvent = null
  const wrapped = (ev) => {
    if (ev.type === 'step') stepEvent = ev
    if (ev.type === 'step_error') errorEvent = ev
    out(ev)
  }
  let res
  try {
    // hard-bounded like every processor step: a provider stall marks the note 'error' (retried by
    // a later drain) instead of hanging the caller — and, with it, the run lock
    const r = await withTimeout(
      processBatch(session, {
        entries: [{ newMsg, priorMsgs: [], threadId: newMsg.thread_id }], noDrafts: false, idx: 0, total: 1
      }, { emit: wrapped }),
      STEP_TIMEOUT_MS,
      'no response for ' + Math.round(STEP_TIMEOUT_MS / 60000) + ' min (connection or provider stall)'
    )
    res = (r.results && r.results[0]) || { ok: false }
  } catch (e) {
    res = { ok: false, error: (e && e.message) || String(e) }
  }

  const inputKey = { account_id: inputRec.account_id, msg_id: inputRec.msg_id }
  if (res.ok && stepEvent) {
    const eventRec = eventFromStep(stepEvent, 'manual', { account_id: inputRec.account_id })
    const addrs = new Set()
    if (newMsg.from && newMsg.from.address) addrs.add(lc(newMsg.from.address))
    for (const x of (newMsg.to || [])) if (x && x.address) addrs.add(lc(x.address))
    const errors = await persist.persistStep({
      store: session.store,
      profiles: session.profiles,
      touchedProjectIds: (res.applied && res.applied.touched_project_ids) || [],
      touchedAddresses: [...addrs],
      profileHistory: [],
      event: eventRec,
      sourceTag: NOTE_SOURCE_TAG
    })
    if (errors.length) out({ type: 'persist_error', errors })
    await persist.updateInputFields(inputKey, {
      status: 'analysed',
      last_error: null,
      analysis_event_id: persist.eventIdFor ? persist.eventIdFor(inputRec.account_id, inputRec.msg_id) : null
    })
    return { ok: true, applied: res.applied || null, cost: stepEvent.cost || 0 }
  }

  const reason = (errorEvent && errorEvent.message) || res.error || 'analysis failed'
  await persist.updateInputFields(inputKey, {
    status: 'error',
    // the retry cap (persist.pendingInputs) reads this; an environmental failure (busy connector,
    // rate limit, network) says nothing about the note and does not spend an attempt
    attempts: isEnvironmentalFailure(reason) ? (Number(inputRec.attempts) || 0) : (Number(inputRec.attempts) || 0) + 1,
    last_error: String(reason).slice(0, 300)
  })
  await persist.addEvent({
    msg_id: inputRec.msg_id, account_id: inputRec.account_id, thread_id: inputRec.thread_id,
    source_id: 'manual', asof: inputRec.date, kind: 'message', channel: 'notes',
    latest_delta: {}, changes: [], via_workflow: null, fetch_rounds: 0, cost: 0,
    subject: inputRec.title || '(untitled note)', from_address: inputRec.author_address || '',
    error: reason
  }).catch(() => {})
  out({ type: 'note_error', msg_id: inputRec.msg_id, message: reason })
  return { ok: false, error: reason }
}

// Build a source-less session from persisted state — for the on-save path, which runs outside
// any mail run. The style guide comes from settings (built by mail runs); no source calls happen.
export function noteSessionFrom ({ freezr, data }) {
  const settings = (data && data.settings) || {}
  const profiles = createProfileStore()
  profiles.hydrate((data && data.profiles) || [])
  const store = createProjectStore()
  store.hydrate((data && data.projects) || [])
  const instructions = createInstructionStore()
  instructions.hydrate((data && data.instructions) || [])
  const session = createSession({
    freezr,
    source: null,
    meSet: new Set((settings.your_addresses || []).map(lc)),
    model: settings.default_model || {},
    prefs: sessionPrefsFrom(settings),
    instructions,
    profiles,
    store
  })
  session.userStyle = settings.style_guide || '' // never build from a source here ('' = none)
  return { session, settings }
}

// The ON-SAVE path (§6.2): the caller has ALREADY persisted the input (pending-first). Takes the
// same run lock as a mail check; if a run holds it, the note stays pending and the run's own
// drain (below) picks it up — "immediately" degrades to "within the current run".
export async function runNoteIngestion ({ freezr, persist, inputRec, onEvent = null }) {
  const owner = newNoteOwnerId()
  // the stage rides on the lock so every page's status strip says WHAT is being analysed —
  // the strip painters already render progress.stage (processingNotice.js / mailTools.js)
  const lock = await persist.acquireRunLock({
    owner,
    kind: 'note',
    staleMs: LOCK_STALE_MS,
    progress: { stage: '📝 analysing your note — “' + String(inputRec.title || 'untitled').slice(0, 60) + '”' }
  })
    .catch(e => ({ ok: false, holder: null, error: (e && e.message) || String(e) }))
  if (!lock.ok) {
    return { ok: false, deferred: true, holder: lock.holder || null, skipped: 'a mail check is running — the note is saved and will be analysed when it finishes' }
  }
  try {
    const data = await persist.loadAll()
    const { session } = noteSessionFrom({ freezr, data })
    // HEARTBEAT: renew the lock on engine events (throttled) so a LIVE run never looks stale,
    // and a run whose tab dies goes stale ~LOCK_STALE_MS after its LAST beat — the status strip
    // then flips from "analysing…" to the stalled warning instead of sitting on it (2026-08-22:
    // a closed tab mid-analysis left "⏳ Note — starting…" up for the full stale window).
    const stage = { stage: '📝 analysing your note — “' + String(inputRec.title || 'untitled').slice(0, 60) + '”' }
    let lastBeat = Date.now()
    const emit = (ev) => {
      const now = Date.now()
      if (now - lastBeat > 15000) {
        lastBeat = now
        persist.renewRunLock({ owner, staleMs: LOCK_STALE_MS, progress: stage }).catch(() => {})
      }
      if (onEvent) onEvent(ev)
    }
    const r = await processNoteInput(session, persist, inputRec, { emit })
    return { ...r, deferred: false, cost: session.totalCost }
  } finally {
    await persist.releaseRunLock({ owner }).catch(() => {})
  }
}

// The DRAIN (mail-run tail, called by ingest.runIngestion before it releases the lock): analyse
// any pending inputs through the run's own session, respecting what is left of its budget.
export async function drainPendingInputs (session, persist, { deadline = Infinity, emit = null, renew = null } = {}) {
  if (typeof persist.pendingInputs !== 'function') return { pending: 0, processed: 0 } // older persist in a mixed-cache runtime
  // TIME-BOXED: this runs at the tail of every mail run, while the run lock is still held. A
  // hung query here (e.g. the `inputs` table not yet installed on the server, or a dead
  // connection) must skip the drain, never orphan the lock.
  let pending
  try {
    pending = await withTimeout(persist.pendingInputs(), 15000, 'pending-inputs query timed out')
  } catch (e) {
    console.warn('[superlazy] pending-input drain skipped:', (e && e.message) || e)
    return { pending: 0, processed: 0 }
  }
  // MESSAGING (Slack) chunks are NOT the drain's to analyse: they belong to the planned queue,
  // where they get their stream context (prior chunks, previous-chunk inlining) — the drain would
  // analyse them context-free and, worse, around the staged-rollout gate. Discovered live
  // 2026-08-29: a mail check's tail quietly analysed the pending chunks Inspect had formed.
  // The same holds for AGENT turns (channel 'work'): they belong to the planned queue, which
  // merges mail, Slack and both agents oldest-first and gives each turn its session context. The
  // drain analysing them as context-free notes is what retired nine turns on 2026-09-12: after
  // the main run stopped on a busy connector, the drain re-tried every pending turn instantly,
  // stamping an attempt each time. Only what this module ingests — notes — is the drain's.
  const isDrainable = (r) => r && r.channel !== 'messages' && r.channel !== 'work'
  const skippedChunks = pending.filter(r => r && r.channel === 'messages').length
  const skippedTurns = pending.filter(r => r && r.channel === 'work').length
  if (skippedChunks) console.info('[superlazy] drain: leaving ' + skippedChunks + ' pending Slack chunk(s) to the planned queue (Inspect / the check once the messages channel is live)')
  if (skippedTurns) console.info('[superlazy] drain: leaving ' + skippedTurns + ' pending agent turn(s) to the planned queue')
  pending = pending.filter(isDrainable)
  let processed = 0
  for (const rec of pending) {
    if (Date.now() >= deadline) break
    // surface WHICH note is being analysed on the run's status strip (and keep the lock fresh)
    if (renew) await Promise.resolve(renew({ stage: '📝 analysing your note — “' + String(rec.title || 'untitled').slice(0, 60) + '”' })).catch(() => {})
    await processNoteInput(session, persist, rec, { emit: emit || (() => {}) }) // per-note bound: STEP_TIMEOUT_MS inside
    processed++
  }
  return { pending: pending.length, processed }
}
