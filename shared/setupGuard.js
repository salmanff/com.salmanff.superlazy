// setupGuard.js — shared page guard: every page except Setup & Prefs calls redirectUnlessTrained()
// first thing. Until at least one account exists AND the initial history build has finished
// (settings.training_wip false), the user is sent back to the setup page — that page owns the
// whole onboarding + training story. Fails OPEN: if the check itself errors, the page proceeds
// and surfaces its own errors.

const SETUP_URL = '/apps/com.salmanff.superlazy/setup'

// Returns { ready, hasAccounts, trainingWip, settings } without redirecting.
export async function getSetupState () {
  const [accountRows, settingsRows] = await Promise.all([
    freezr.query('accounts', {}, { count: 1 }),
    freezr.query('settings', {}, { count: 1 })
  ])
  const settings = (settingsRows && settingsRows[0]) || null
  const hasAccounts = !!(accountRows && accountRows.length)
  const trainingWip = !!(settings && settings.training_wip)
  return { ready: hasAccounts && !trainingWip, hasAccounts, trainingWip, settings }
}

// Redirect to the setup page unless setup is complete. Returns true when the caller may
// proceed, false when a redirect was issued (caller should stop initialising).
export async function redirectUnlessTrained () {
  let state = null
  try {
    state = await getSetupState()
  } catch (e) {
    console.error('[superlazy] setup check failed — proceeding anyway:', e && e.message)
    return true
  }
  if (state.ready) return true
  window.location.href = SETUP_URL
  return false
}
