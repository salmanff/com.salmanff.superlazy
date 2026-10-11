// failureHint.js — turns a stopped-run error into something the user can ACT on.
//
// Any analysis failure now stops the run (jobs/analyze_thread/processor.js) and the message it stopped
// on is recorded as errored, so it is retried first on the next run. That design only pays off if
// the user understands WHY it stopped and what to do — 'llm.ask failed: Your credit balance is too
// low to access the Anthropic API' is the provider's sentence, not an instruction. One module so the
// dashboard's mail check and the training page say the same thing.

const RULES = [
  {
    // provider is out of money — the case that motivated all of this
    test: /credit|balance|quota|insufficient_quota|billing|payment|funds/i,
    hint: 'Your AI provider reports no credit left. Top up your account, then press Continue — ' +
      'nothing was lost, and the email it stopped on is processed first.'
  },
  {
    // the freezr SIGN-IN itself died (e.g. an identity layer in front of the server timed out) —
    // must match BEFORE the mail-reconnect rule below, or the user gets sent to reconnect a
    // mailbox that is fine. 'Unknown error' is what freezrApiV2 says for a bare 401 (empty body).
    test: /sign-?in (has )?expired|session expired|signed out|need to obtain an app token|^unknown error$/i,
    hint: 'Your sign-in has expired — reload the page to sign in again, then press Continue.'
  },
  {
    test: /token_expired|reauthor|re-author|reconnect|401|unauthor|invalid_grant/i,
    hint: 'Your mail connection needs re-authorising — reconnect the account at /account/resources, ' +
      'then press Continue.'
  },
  {
    test: /rate.?limit|429|overloaded|529|too many requests|capacity/i,
    hint: 'Your AI provider is rate-limiting or overloaded. Wait a minute, then press Continue.'
  },
  {
    test: /fetch|network|offline|timed? ?out|timeout|econn|stall|load failed|socket/i,
    hint: 'The connection dropped mid-analysis. Check you are online, then press Continue.'
  },
  {
    // nothing came back at all — in practice the request was rejected or dropped, and the commonest
    // cause is an oversized one, so the actionable move is to lower the context setting
    test: /empty reply|returned nothing|no response/i,
    hint: 'The AI returned nothing at all — usually an oversized request. Try “Context sent per email: Lean” ' +
      'on the Preferences tab, then press Continue; if it keeps happening, Skip past this one message.'
  },
  {
    test: /invalid|unparse|not an object|json/i,
    hint: 'The model returned something unusable twice in a row (the full exchange is in the browser ' +
      'console). Press Continue to retry it, or Skip to move past this one message.'
  },
  {
    test: /no api key|no key|not configured|use_llm|permission/i,
    hint: 'SuperLazy could not reach your AI provider — check your LLM keys and the app’s permissions ' +
      'in your freezr settings, then press Continue.'
  }
]

// A short actionable sentence for a failure reason, or '' when we have nothing useful to add.
export function failureHint (reason) {
  const s = String(reason || '')
  const rule = RULES.find(r => r.test.test(s))
  return rule ? rule.hint : ''
}

// The full user-facing line for a stopped run. failure: { subject, from_address, reason } — the
// shape processor.js attaches to its stop error and ingest.js returns as `failure`.
export function failureLine (failure, { fallback = 'Processing stopped.' } = {}) {
  if (!failure) return fallback
  const reason = failure.reason || failure.message || 'unknown error'
  const where = failure.subject
    ? ' while analysing “' + failure.subject + '”' + (failure.from_address ? ' from ' + failure.from_address : '')
    : ''
  const hint = failureHint(reason)
  return '⚠ Stopped' + where + ': ' + reason + (hint ? ' — ' + hint : ' — press Continue to retry.')
}
