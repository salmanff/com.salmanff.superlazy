// rulesEngine.js — PERMANENT core. The coordinator that sits AROUND the per-message LLM analysis.
// It has NO state of its own — the runner passes in the profile store, project store, prefs, and
// the instruction store. Two entry points:
//   preAnalyze()      — BEFORE the LLM: gather user instructions (Concept A) + workflow-trigger
//                       lines (Concept B), and decide whether a workflow can SHORT-CIRCUIT the LLM.
//   dispatchTriggers()— AFTER reconcile: run the onTrigger algorithm of each workflow the model fired.
// (Named rulesEngine to avoid colliding with the per-thread roles.js.) See specs/pipeline-walkthrough.md §5a.

import { WORKFLOWS, workflowInstructions } from './workflows.js'
import { subscriptionPrefilterHit } from './subscriptionsCore.js'

// { newMsg, profiles, prefs, store, instructions, account } ->
//   { shortCircuit | null, userInstructions:[record], allMailInstructions:[record], workflowInstructions:[text] }
// userInstructions carries the RECORDS, not just their text: the prompt shows each rule's
// instruction_id so the model can name the ones it used (rules_applied), and the ALL-mail ones are
// split out because they ride in the weekly cached block instead of this message's turn.
// `account` is the account_id the message arrived on (optional — enables account-scoped rules).
export function preAnalyze ({ newMsg, profiles, prefs, store, instructions, account } = {}) {
  const sender = (newMsg && newMsg.from && newMsg.from.address) || ''
  const matches = instructions && instructions.matching ? instructions.matching(sender, account) : []
  // scope 'all' rides in the cached cold block (it applies to every message, so re-sending it per
  // message pays full price for identical bytes); everything else is per-message and rides volatile.
  const allMailInstructions = matches.filter(r => r.scope === 'all')
  const userInstructions = matches.filter(r => r.scope !== 'all')
  const wfInstructions = workflowInstructions()

  // §C pecking order: a short-circuit (skip-the-LLM) is the LAST resort. It fires ONLY IF nothing
  // higher-priority has a claim — a custom instruction FOR THIS SENDER/DOMAIN means the message
  // must go through the LLM with it injected. ALL-mail and ACCOUNT-wide instructions do NOT block
  // (they are generic guidance; forcing every auto-processed newsletter through the LLM because
  // of one would silently defeat auto-processing).
  const blocking = matches.filter(r => r.scope === 'sender' || r.scope === 'domain')
  // Inter-app subscriptions: a prefilter hit means "this message might match an approved
  // subscription" — it must reach the LLM even when the sender is on autopilot (invoices come
  // from exactly the machine senders that short-circuit). A hit blocks the short-circuit the
  // same way a sender-scoped instruction does; the LLM still decides the real match.
  const subscriptionCandidates = subscriptionPrefilterHit(newMsg)
  let shortCircuit = null
  if (!blocking.length && !subscriptionCandidates.length) {
    const candidates = Object.values(WORKFLOWS)
      .filter(w => typeof w.shortCircuit === 'function')
      .sort((a, b) => (b.priority || 0) - (a.priority || 0))
    for (const w of candidates) {
      const sc = w.shortCircuit({ newMsg, profiles, prefs, store })
      if (sc) { shortCircuit = { workflow: w.keyword, ...sc }; break }
    }
  }

  return { shortCircuit, userInstructions, allMailInstructions, workflowInstructions: wfInstructions, subscriptionCandidates }
}

// Run each returned auto-process trigger through its registry entry's onTrigger. Triggers carry
// { type, details } (the legacy flat { workflow, ... } shape is still accepted). Best-effort:
// one failing action never breaks the message.
// ctx: { freezr, newMsg, output, applied, profiles, store, asof }.
export async function dispatchTriggers (triggers, ctx = {}) {
  const fired = []
  for (const t of (Array.isArray(triggers) ? triggers : [])) {
    const key = t && (t.type || t.workflow)
    const w = key && WORKFLOWS[key]
    if (!w || typeof w.onTrigger !== 'function') continue // unknown action name — ignore (forward-compatible)
    try {
      const result = await w.onTrigger({ ...ctx, trigger: t })
      fired.push({ workflow: key, result })
    } catch (e) {
      fired.push({ workflow: key, error: (e && e.message) || String(e) })
    }
  }
  return fired
}
