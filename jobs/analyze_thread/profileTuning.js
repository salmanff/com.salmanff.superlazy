// profileTuning.js — PERMANENT core. Every tunable constant of the person-profile lifecycle
// (provisional window → graduation → re-profiling) lives HERE, in one exported block. Both the
// per-message engine (window / triggers) and the re-profiler (context sizes) import from this
// file — never scatter these numbers.
//
// Lifecycle recap (see specs/pipeline-walkthrough.md §10, Reprofile):
//  - A new sender's profile is PROVISIONAL: the inline analysis refines it freely on each message.
//  - At MESSAGES_BEFORE_SOLIDIFYING_PROFILE messages from them, the app fires ONE dedicated
//    re-profile ("graduation") that grounds the profile properly and learns user_tone, then the
//    profile is SOLID: inline profile_updates stop and only an on-demand re-profile rewrites it.
//  - User-edited profile text is never auto-overwritten.
//
// 2026-09-19: the fit-score maintenance stage is GONE. The model was asked for fit_concerns on
// every message and emitted none in 983 analyses, so the accumulator never moved and the drift
// re-profile trigger never fired. Its constants (FIT_SCORE_MAX, REPROFILE_AT_SCORE,
// SKIP_AUTO_REPROFILE_BELOW_IMPORTANCE, DRIFT_LOG_MAX_ENTRIES, DRIFT_BODIES_MAX,
// DRIFT_BODY_MAX_CHARS) went with it.

export const PROFILE_TUNING = {
  // ---- lifecycle -------------------------------------------------------------------------
  MESSAGES_BEFORE_SOLIDIFYING_PROFILE: 5, // messages received before the profile solidifies (graduation)

  // ---- re-profiler context sizes ----------------------------------------------------------
  PROJECTS_IN_FULL_MAX: 8,                // projects rendered in full; the rest as one-liners
  TODOS_PER_PROJECT_EACH_WAY: 3,          // their open + recently-resolved to-dos shown per project
  INDEX_ROWS_MAX: 30,                     // message-index rows (browsing menu)
  INDEX_LOOKBACK_DAYS: 183,               // …within this window (extended when too few rows — see reprofiler)
  INDEX_MIN_ROWS: 10,                     // sparse senders: extend the lookback until this many rows (or history ends)
  BASELINE_BODIES_FROM_THEM: 5,           // recent full bodies from them (tone/current-baseline)
  BASELINE_BODIES_FROM_USER: 5,           // recent full bodies the USER sent them (user_tone source)
  BASELINE_BODY_MAX_CHARS: 1000,
  MIN_USER_SAMPLES_FOR_TONE: 3,           // fewer user-sent samples than this: skip user_tone, don't guess
  REPROFILE_FETCH_ROUNDS_MAX: 2,          // bounded request_more loop, same discipline as the engine
  REPROFILE_MAX_TOKENS: 2000              // output cap — a profile is small; runaway prose is a bug
}


// Merge user preferences over the defaults. Only the keys present in PROFILE_TUNING are
// honored (a stray pref can't inject unknown knobs), and only finite numbers are accepted.
// prefs shape: settings/prefs.profile_tuning = { MESSAGES_BEFORE_SOLIDIFYING_PROFILE: 8, ... }
export function tuningFrom (prefs) {
  const out = { ...PROFILE_TUNING }
  const over = (prefs && prefs.profile_tuning) || {}
  for (const k of Object.keys(PROFILE_TUNING)) {
    const v = Number(over[k])
    if (Number.isFinite(v) && v >= 0) out[k] = v
  }
  return out
}
