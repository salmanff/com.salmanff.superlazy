// profiles.js — PERMANENT core (Part 1: in-memory; Part 2: durable).
// A living profile per address. Every participant always has one — an 'unknown-person'
// stub at minimum — and it is always sent to the model.
//
// Profile lifecycle (constants in profileTuning.js):
//  PROVISIONAL (profile.solidified_asof == null): the inline analysis refines the profile
//  freely on every message. SOLID (after the count-triggered "graduation" re-profile): inline
//  profile_updates stop and the profile is only rewritten by an on-demand re-profile
//  (reprofiler.js). User-edited profiles (profile.user_edited) are never auto-overwritten.
//  2026-09-19: the fit accumulator (fit.score / fit.drift_log / fit.needs_review) and the
//  fit_concerns the model fed it are GONE — none were emitted in 983 analyses. The stored `fit`
//  object is left on old records; nothing reads or writes it any more.

import { normalizeAutoProcesses, applyAutoProcess, FILE_TO_PROJECT } from './autoProcess.js'
import { normalizeResponsibilities, applyModelResponsibilities, setUserResponsibility, removeResponsibility } from './responsibilities.js'
import { PROFILE_TUNING } from './profileTuning.js'

const STUB_SUMMARY = 'Unknown person — no prior context yet.'

export function createProfileStore () {
  const map = new Map()

  function ensure (address, name) {
    const a = String(address || '').toLowerCase()
    if (!a) return null
    if (!map.has(a)) {
      map.set(a, {
        address: a,
        display_name: name || a,
        profile: {
          summary: STUB_SUMMARY,
          relationship: 'unknown',
          llm_importance: 3,
          responsibilities: [],       // LIST of { id, text, source:'user'|'model', locked, asof } — what this
                                      // person handles / what the user delegates to them. A source:'user'
                                      // entry is the user's own and the model may never change or drop it
                                      // (see responsibilities.js — the only module that reads this shape)
          responsiveness_note: null,
          auto_processes: [],         // standing per-sender actions (see autoProcess.js) — the first type, file_to_project, files this sender's mail WITHOUT the LLM
          user_tone: null,            // how the USER writes to this person (register/greeting/brevity) — learned by the re-profiler, drives suggested-reply voice
          last_profiled_asof: null,
          solidified_asof: null,      // set by the graduation re-profile; null = still PROVISIONAL
          user_edited: false          // the user hand-edited the profile text — the model may never auto-overwrite it
        },
        manual_rank: null,
        // Observed interaction stats, updated incrementally per message (regenerable from the
        // events log / archive — see specs/pipeline-backlog.md, People & interaction stats). Averages are derived:
        // reply_ms_by_them / replies_by_them = how fast THEY typically answer the user, etc.
        interaction_data: {
          messages_from: 0,     // messages received from this person
          messages_to: 0,       // messages the user sent to / cc'ing this person
          replies_by_user: 0,   // times the user replied to one of their messages…
          reply_ms_by_user: 0,  // …total user response time (ms) across those replies
          replies_by_them: 0,   // times they replied to one of the user's messages…
          reply_ms_by_them: 0,  // …total response time (ms) across those replies
          // reply_median_ms_by_user / reply_median_ms_by_them / reply_medians_asof are written by
          // the MAINTENANCE REBUILD only (the clean-up page’s housekeeping D2, jobs/maintenance/deterministic.js) — true
          // medians over the actual latencies; the live counters here keep no samples and cannot
          // maintain them. Consumers (assemble, peopleData, reprofiler) prefer them when present.
          first_seen_asof: null,
          last_seen_asof: null
        },
        // WHICH source(s) this profile was learned from — 'email:<address of the mail account>'
        // (see addSource in persist.js). Union, because the same person can appear on more than one
        // account. It is what makes a per-account "forget this account" possible: a record whose
        // sources reduce to nothing when one account is removed can be deleted; a shared one stays.
        sources: [],
        stub: true
      })
    } else if (name) {
      const p = map.get(a)
      if (p.display_name === a) p.display_name = name
    }
    return map.get(a)
  }

  // Record ONE message's interaction facts: ensures a profile for every participant, counts
  // volume in each direction, and — when the replied-to parent is known — accumulates response
  // times (user→them when the user replies, them→user when they reply). Called once per
  // processed message by the engine.
  // Writing to someone settles the question: they are a correspondent, so their mail must not be
  // auto-filed unread. Switching it OFF here (rather than only ignoring it at read time) keeps the
  // stored profile honest. Left UNLOCKED — that flag means "the user chose this", and they didn't;
  // re-learning is blocked anyway by workflows.autopilotVeto, which sees the same interaction stats.
  // Collected in `unlearned` so the caller can tell the user it happened.
  const unlearned = []
  function unlearnAutoFiling (address) {
    const p = map.get(address)
    if (!p) return
    const list = normalizeAutoProcesses(p.profile)
    const entry = list.find(a => a && a.type === FILE_TO_PROJECT)
    if (!entry || !entry.active || entry.locked) return
    applyAutoProcess(p.profile, { type: FILE_TO_PROJECT, active: false, source: 'auto', asof: Date.now() })
    unlearned.push(address)
  }
  // Drain: what stopped being auto-filed since the last call (the engine turns these into events).
  function takeUnlearned () { return unlearned.splice(0, unlearned.length) }

  // channel: the item's channel (default 'mail'). Non-mail channels keep their own counters
  // (interaction_data.counts.<channel>) and NEVER touch messages_from/_to or the reply-latency
  // stats — graduation (PROVISIONAL -> SOLID) counts CORRESPONDENCE only, so being named in
  // meeting minutes can never solidify a profile. See specs/superlazy-inputs.md §8.
  function recordMessage (newMsg, { parent, meSet, channel } = {}) {
    const me = meSet || new Set()
    const from = String((newMsg.from && newMsg.from.address) || '').toLowerCase()
    const fromMe = me.has(from)
    const recipients = [...(newMsg.to || []), ...(newMsg.cc || [])]

    if (channel && channel !== 'mail') {
      // work (agent session) items: the author is ME and the only participant is the agent (a
      // name-only team member) — nobody's stats move, nothing is minted
      if (channel === 'work') return
      if (channel === 'notes') {
        // attendees WITH an address get/keep a profile (they appear in the People block and can
        // receive delegate drafts); name-only attendees mint nothing (§9 — a name stub would rot).
        if (from) ensure(from, newMsg.from && newMsg.from.name)
        for (const r of recipients) {
          const a = String((r && r.address) || '').toLowerCase()
          if (!a || me.has(a)) continue
          const p = ensure(a, r.name)
          const d = p.interaction_data
          d.counts = d.counts || {}
          d.counts.notes = d.counts.notes || { mentions: 0 }
          d.counts.notes.mentions++
          if (!d.first_seen_asof) d.first_seen_asof = newMsg.date
          d.last_seen_asof = Math.max(Number(d.last_seen_asof) || 0, newMsg.date)
        }
      }
      if (channel === 'messages') {
        // a chunk has MANY authors — count by the transcript's authors (channel_data.authors,
        // built by the source from messages_raw), not by the item's nominal sender. `from` = they
        // authored lines; `to` = ME spoke in a chunk they took part in. Attested-email authors
        // land on their existing profile; the rest mint nothing yet (identity plan §9 — the
        // channel-scoped `slack:<id>` profile is a later slice). Deliberately NOT correspondence:
        // graduation and latency stay mail-only for now (DM-weighting is a Stage-2+ decision).
        const authors = (newMsg.channel_data && newMsg.channel_data.authors) || []
        const meSpoke = authors.some(a => a.address && me.has(String(a.address).toLowerCase()))
        for (const a of authors) {
          const addr = String(a.address || '').toLowerCase()
          if (!addr || me.has(addr)) continue
          const p = ensure(addr, a.name)
          const d = p.interaction_data
          d.counts = d.counts || {}
          d.counts.messages = d.counts.messages || { from: 0, to: 0 }
          d.counts.messages.from += Number(a.count) || 1
          if (meSpoke) d.counts.messages.to++
          if (!d.first_seen_asof) d.first_seen_asof = newMsg.date
          d.last_seen_asof = Math.max(Number(d.last_seen_asof) || 0, newMsg.date)
        }
      }
      return // never correspondence counters, latency stats, or auto-file unlearning
    }

    // everyone on the message gets a profile (the People block renders from these)
    if (from) ensure(from, newMsg.from && newMsg.from.name)
    for (const r of recipients) ensure(r.address, r.name)

    if (from && !fromMe) {
      const d = ensure(from).interaction_data
      d.messages_from++
      if (!d.first_seen_asof) d.first_seen_asof = newMsg.date
      d.last_seen_asof = newMsg.date
    }
    if (fromMe) {
      for (const r of recipients) {
        const a = String(r.address || '').toLowerCase()
        if (!a || me.has(a)) continue
        ensure(a).interaction_data.messages_to++
        unlearnAutoFiling(a) // the user writes to them ⇒ they are not a mailing list
      }
    }

    // reply timing — only when the parent is known and ordering is sane
    if (parent && parent.from && Number(newMsg.date) > Number(parent.date)) {
      const parentFrom = String(parent.from.address || '').toLowerCase()
      const deltaMs = Number(newMsg.date) - Number(parent.date)
      if (fromMe && parentFrom && !me.has(parentFrom)) {
        const d = ensure(parentFrom).interaction_data
        d.replies_by_user++
        d.reply_ms_by_user += deltaMs
        unlearnAutoFiling(parentFrom) // replying settles it too, even if they are not in to/cc
      } else if (!fromMe && from && me.has(parentFrom)) {
        const d = ensure(from).interaction_data
        d.replies_by_them++
        d.reply_ms_by_them += deltaMs
      }
    }
  }

  function get (address) { return map.get(String(address || '').toLowerCase()) || null }

  function forAddresses (addresses) {
    const seen = new Set()
    const out = []
    for (const a of addresses) {
      const la = String(a || '').toLowerCase()
      if (!la || seen.has(la)) continue
      seen.add(la)
      const p = get(la)
      if (p) out.push(p)
    }
    return out
  }

  // PROVISIONAL = the graduation re-profile hasn't happened yet: the inline analysis may still
  // refine the profile freely. (Records from before this lifecycle existed have no
  // solidified_asof and so re-enter the provisional flow — their first graduation grounds them.)
  function isProvisional (address) {
    const p = get(address)
    return !!p && !p.profile.solidified_asof
  }

  // Apply model-proposed profile updates (PROVISIONAL profiles only — solidified ones are
  // guarded here, not just in the prompt). manual_rank (if ever set) governs importance;
  // user-edited text is never overwritten by the inline analysis.
  function applyUpdates (updates, asof) {
    const applied = []
    for (const u of (updates || [])) {
      const p = ensure(u.address)
      if (!p) continue
      if (p.profile.solidified_asof || p.profile.user_edited) continue // solid / hand-edited: only a re-profile rewrites it
      const before = { ...p.profile }
      if (u.summary) p.profile.summary = u.summary
      if (u.relationship) p.profile.relationship = u.relationship
      // a model proposal refreshes the model's OWN entries; the user's survive untouched
      if (u.responsibilities !== undefined && u.responsibilities !== null) applyModelResponsibilities(p.profile, u.responsibilities, { asof })
      if (typeof u.llm_importance === 'number' && p.manual_rank == null) {
        p.profile.llm_importance = u.llm_importance
      }
      p.profile.last_profiled_asof = asof
      p.stub = false
      applied.push({ address: p.address, before, after: { ...p.profile }, reason: u.reason || null })
    }
    return applied
  }

  // Apply a re-profiler result: the full replacement profile. Solidifies the profile (ends the
  // provisional window on graduation) and — unless the run was user-requested — refuses to
  // touch user-edited text (belt to the engine's braces).
  function applyReprofile (address, result, { asof, userRequested } = {}) {
    const p = get(address)
    if (!p || !result) return null
    if (p.profile.user_edited && !userRequested) return null
    const before = { ...p.profile }
    if (result.summary) p.profile.summary = result.summary
    if (result.relationship) p.profile.relationship = result.relationship
    if (result.responsibilities !== undefined) applyModelResponsibilities(p.profile, result.responsibilities, { asof })
    if (result.user_tone !== undefined) p.profile.user_tone = result.user_tone
    if (typeof result.llm_importance === 'number' && p.manual_rank == null) {
      p.profile.llm_importance = result.llm_importance
    }
    if (userRequested) p.profile.user_edited = false // the user asked the model to take over the text
    p.profile.last_profiled_asof = asof
    p.profile.solidified_asof = p.profile.solidified_asof || asof
    p.stub = false
    return { address: p.address, before, after: { ...p.profile }, reason: result.change_note || null }
  }

  // Set ONE standing auto-process action on a sender's profile (see autoProcess.js for the
  // contract). The LLM emits the intent (a trigger); the APP owns this state. Merge semantics:
  // only the fields given change; `details` keys merge onto the existing ones. UNAMBIGUOUS RULES:
  //   active — THE flag: true = the action runs on this sender's future mail. Never implicit.
  //   locked — the user set this action (on, off, or its target); the model may NOT change
  //            anything while locked — its dissent lands in `suggested` so the UI can warn.
  function setAutoProcess (address, { type, active, details, locked, suggested, source, asof } = {}) {
    const p = ensure(address)
    if (!p) return null
    const change = applyAutoProcess(p.profile, { type, active, details, locked, suggested, source, asof })
    if (!change) return null
    p.profile.last_profiled_asof = asof || p.profile.last_profiled_asof
    return { address: p.address, ...change }
  }

  // The USER's own responsibility entries. Anything set here is locked to them: the inline
  // analysis, the re-profiler and the clean-up all leave it alone (responsibilities.js).
  function setResponsibility (address, { id, text, asof } = {}) {
    const p = ensure(address)
    if (!p) return null
    const e = setUserResponsibility(p.profile, { id, text, asof })
    return e ? { address: p.address, entry: e } : null
  }
  function dropResponsibility (address, id) {
    const p = get(address)
    return p ? removeResponsibility(p.profile, id) : false
  }

  function all () { return [...map.values()] }

  // Load persisted profile records into a fresh store (missing sub-objects get defaults so old
  // records survive schema growth). Call once, before processing.
  function hydrate (records) {
    for (const r of (records || [])) {
      if (!r || !r.address) continue
      const p = ensure(r.address, r.display_name)
      if (r.profile) p.profile = { ...p.profile, ...r.profile }
      normalizeAutoProcesses(p.profile)      // upgrade legacy auto_file* fields to auto_processes[]
      normalizeResponsibilities(p.profile)   // upgrade a legacy responsibilities STRING to the entry list
      if (r.manual_rank != null) p.manual_rank = r.manual_rank
      if (r.interaction_data) p.interaction_data = { ...p.interaction_data, ...r.interaction_data }
      if (Array.isArray(r.sources)) p.sources = [...r.sources]
      p.stub = r.stub !== false
    }
  }

  return {
    ensure,
    recordMessage,
    get,
    forAddresses,
    isProvisional,
    applyUpdates,
    applyReprofile,
    setAutoProcess,
    setResponsibility,
    dropResponsibility,
    takeUnlearned,
    all,
    hydrate
  }
}
