// onboarding.js — permission probing + the freezr links the onboarding screens point at.
// The setup page decides WHICH welcome screen to show from what this module reports:
// use_mail granted? any mail account connected? background-jobs permissions granted?

// Where the user grants this app's permissions (freezr app-settings page).
export const APP_SETTINGS_URL = '/account/app/settings/' +
  ((typeof freezrMeta !== 'undefined' && freezrMeta.appName) || 'com.salmanff.superlazy')

// Where the user connects a mail account to their freezr.
export const RESOURCES_URL = '/account/resources'

// One pass over the app's permission grants. Names must match manifest.json.
// ONE input channel (mail OR messaging) + llmGranted are required to advance past the welcome
// gate — `inputGranted` is that disjunction; a Slack-only install is a valid start.
// jobsGranted is true when EITHER background-jobs permission is granted — enough to offer
// "Train in background" (run now); scheduleGranted additionally allows the recurring schedule.
export async function getPermissionState () {
  let perms = []
  try {
    perms = (await freezr.perms.getAppPermissions()) || []
  } catch (e) {
    console.error('[superlazy] could not read permissions:', e && e.message)
    return { known: false, mailGranted: false, messagingGranted: false, fsGranted: false, inputGranted: false, llmGranted: false, jobsGranted: false, scheduleGranted: false }
  }
  const granted = (type) => perms.some(p => p && p.type === type && p.granted)
  const mailGranted = granted('use_mail')
  const messagingGranted = granted('use_messaging')
  const fsGranted = granted('use_file_sys')   // the WORK channel (agent sessions) — a valid start too
  return {
    known: true,
    mailGranted,
    messagingGranted,
    fsGranted,
    inputGranted: mailGranted || messagingGranted || fsGranted,
    llmGranted: granted('use_llm'),
    jobsGranted: granted('run_job') || granted('schedule_job'),
    scheduleGranted: granted('schedule_job')
  }
}

// Can processing run in the BACKGROUND (a freezr job) instead of in the browser tab? True when
// the run_job permission is granted AND there is somewhere to run it — the admin trusted the
// app to run in-process ('trusted') or the user has a serverless credential (has_compute).
// Used to pick the processing story: background job (survives page closes) vs in-browser run
// (the keep-this-page-open modal). Safe on servers without the jobs API.
//
// Delegates to backgroundMode.probeCapability so there is ONE capability probe in the app — the
// two used to be separate and could disagree about whether background processing was possible.
// `available` is kept as the field name the setup page already reads.
export async function getBackgroundCapability () {
  const { probeCapability } = await import('../shared/backgroundMode.js')
  const c = await probeCapability()
  return { ...c, available: !!c.capable }
}
