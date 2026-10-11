// inspectRunner.js — engine glue for the INSPECT page (inspect.js). One message at a time,
// full wire visibility, NOTHING persisted until the user presses Save.
//
// It builds the exact production pipeline (same prefs mapping via sessionPrefsFrom, same
// processor/engine path, same pinned snapshot) but with the processor's deferPersist mode on:
// the analysis runs, every LLM exchange is captured (session.exchangeCapture), and the
// would-be writes wait on processor.pendingPersist for commitPending() (Save) or
// discardPending() (Ignore). After an Ignore the in-memory stores have still been mutated
// by the analysis, so the page must call rebuild() before running again — the same message
// is re-analysed from a clean snapshot (the cursor never moved).
//
// NO LOCKING. This is a temporary debug page: it never touches the mail run lock, so it can
// never block (or be blocked by) the dashboard's Check Mail or the background job. The user
// coordinates manually — don't run both at once over the same messages.

import { createPersistence } from '../jobs/analyze_thread/persist.js'
import { sessionPrefsFrom, newTabOwnerId, adoptSnapshotPin, stampSnapshotPin, meSetFromSettingsAndAccounts } from '../jobs/analyze_thread/ingest.js'
import { createProcessor } from '../jobs/analyze_thread/processor.js'
import { createProfileStore } from '../jobs/analyze_thread/profiles.js'
import { createProjectStore } from '../jobs/analyze_thread/projectStore.js'
import { createInstructionStore } from '../jobs/analyze_thread/instructionStore.js'
import { sourceFromAccounts } from '../jobs/analyze_thread/jobSource.js'
import { PROMPT_VERSION, SYSTEM_PROMPT } from '../jobs/analyze_thread/prompt.js'
import { DEFAULT_HISTORY_DAYS, DEFAULT_THREAD_CONTEXT_DAYS } from '../jobs/analyze_thread/config.js'
import { loadActiveSubscriptions } from '../jobs/analyze_thread/subscriptionsCore.js'

export { SYSTEM_PROMPT }

export async function createInspector ({ freezr, onScan = null } = {}) {
  const persist = createPersistence(freezr)
  const owner = 'inspect:' + newTabOwnerId()

  const data = await persist.loadAll()
  const settings = data.settings || {}
  const allStored = (data.accounts || []).filter(r => r && r.account_id)
  const stored = allStored.filter(r => !r.sync_paused) // a paused account is not read anywhere, this page included
  if (!stored.length) {
    return {
      error: allStored.length
        ? 'Every account is paused — resume one on the Setup page to inspect it.'
        : 'No account is set up yet — finish setup first (mail on the Setup page, Slack in the Slack lab).'
    }
  }
  // persist is passed so the composite's Slack side can run REAL chunk formation (the `inputs`
  // chunk ledger): with a messaging account stored, plan() forms + queues pending chunks and this
  // page steps them exactly like mail — Inspect IS the Slack rollout's Stage-1/2 harness.
  const source = sourceFromAccounts(stored, { freezr, persist })
  if (!source) return { error: 'These accounts were set up from a local archive — live inspection is unavailable.' }


  const profiles = createProfileStore()
  profiles.hydrate(data.profiles)
  const store = createProjectStore()
  store.hydrate(data.projects)
  const instructions = createInstructionStore()
  instructions.hydrate(data.instructions)

  const processor = createProcessor({
    freezr,
    source,
    persist,
    meSet: meSetFromSettingsAndAccounts(settings, stored),
    model: settings.default_model || {},
    prefs: sessionPrefsFrom(settings),
    instructions,
    profiles,
    store,
    deferPersist: true
  })

  // mirror ingest.js: reuse the stored style guide when fresh (no sent-mail fetch, no LLM call)
  const refreshDays = Number(settings.style_guide_refresh_days) || 30
  const styleFresh = settings.style_guide != null &&
    (Date.now() - (Number(settings.style_guide_asof) || 0)) < refreshDays * 24 * 3600e3
  if (styleFresh) processor.session.userStyle = settings.style_guide

  // subscriptions must be loaded BEFORE pin adoption — their detector lines are hashed into the
  // durable sig; without this, inspect would compute a different sig and discard the pin every run
  await loadActiveSubscriptions(freezr)

  // the SAME adoption path ingest uses (it reports why, when a pin is rejected)
  adoptSnapshotPin(processor.session, settings)

  processor.session.exchangeCapture = []

  const plan = await processor.plan({
    accountInfos: stored.map(r => ({ account_id: r.account_id, account_email: r.account_email, provider: r.provider })),
    historyDays: settings.history_days || DEFAULT_HISTORY_DAYS,
    threadContextDays: settings.thread_context_days != null ? settings.thread_context_days : DEFAULT_THREAD_CONTEXT_DAYS,
    processDays: null,
    existingAccounts: stored,
    onScan
  })

  // PIN THE DURABLE TURN after a run — the Inspect page is a driver like any other. Without
  // this, every inspect session re-rendered the durable turn and paid a fresh cache WRITE (the
  // provider cached bytes nobody ever pinned), which is why "it caches every turn". Called on
  // BOTH Save and Ignore: the write has already been paid, so pinning the bytes is what lets the
  // next run READ them at ~10%.
  const pinSnapshot = () => stampSnapshotPin(persist, processor.session, settings)

  // What was actually planned — shown in the knobs so "why is there no Slack here" answers itself
  // (a missing messaging account record is invisible otherwise: the lab's builds are dry runs).
  const nMsg = stored.filter(r => r.channel === 'messages').length
  const nWork = stored.filter(r => r.channel === 'work').length
  const accountMix = stored.length + ' account(s): ' + (stored.length - nMsg - nWork) + ' mail, ' + nMsg + ' slack, ' + nWork + ' work' +
    (nMsg === 0 ? ' — no Slack account is SAVED (the lab\'s "Build chunks" is a dry run; press "Save selection" there)' : '')

  return { persist, settings, source, processor, plan, owner, pinSnapshot, accountMix }
}

// The prefs the current run will use — shown on the page so a cross-tab comparison always
// states its variables. Reads the same mapped prefs object the engine reads.
export function runKnobs (inspector) {
  const s = inspector.processor.session
  const p = s.prefs || {}
  return {
    accounts: inspector.accountMix || '(unknown)',
    model: (s.model && (s.model.provider || s.model.family))
      ? [(s.model.provider || ''), (s.model.family || '')].filter(Boolean).join(' / ')
      : 'app default',
    thinking: s.thinkingOpt ? 'on' : 'off',
    effort: s.effortOpt,
    max_tokens: s.maxTokensOpt || 40000,
    fetch_rounds: s.fetchRoundsMax,
    context_chars: p.analysis_context_chars || 70000,
    cache: s.cacheOpt ? (s.cacheOpt.ttl ? '1h ttl' : '5m ttl') : 'off',
    suggest_replies: p.suggest_replies === false ? 'off' : 'on',
    pinned_snapshot: s.snapshot
      ? ('hot ' + s.snapshot.count + ' projects / ' + Math.round(s.snapshot.chars / 1000) + 'k chars, cold ' +
        (s.snapshot.cold ? s.snapshot.cold.count + ' / ' + Math.round(s.snapshot.cold.chars / 1000) + 'k chars' : 'none'))
      : 'none (renders fresh)',
    prompt_version: PROMPT_VERSION
  }
}
