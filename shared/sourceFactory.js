// sourceFactory.js — the ONE place that decides which MailSource implementation a page gets.
// Launch default: LIVE mail (freezr.connections.mail). The Email Cabinet archive source is kept
// for dev/testing (the replay + chrono pages have explicit pickers) and for installs whose stored
// account records were trained from the archive — their source_id says so and keeps working.
//
// CHANNEL-AWARE since the Slack slice: stored accounts may include `channel:'messages'` records
// (Slack workspaces, created by the slacklab page). Those must NEVER select or feed the mail
// source — a messaging connection put through the mail API is exactly the
// "No use_mail permission covers connection: <name>" failure. Pages that need the Slack side use
// slackSource/slacklab directly; this factory answers the MAIL question only.

import { createArchiveSource } from './archiveSource.js'
import { createLiveMailSource } from '../jobs/analyze_thread/liveMailSource.js'

export const isMessagingAccount = (rec) => !!rec && (rec.channel === 'messages' ||
  String((rec && rec.source_id) || '').startsWith('live:connections.messaging'))

// Map a stored source_id (accounts.source_id) to a source instance. Anything that isn't
// explicitly the archive — including null/unknown on a fresh install — gets live mail.
export function sourceForId (sourceId) {
  return String(sourceId || '').startsWith('archive:') ? createArchiveSource() : createLiveMailSource()
}

// Pick the source the stored MAIL accounts were trained with (first record that names one).
// Messaging accounts are ignored here by design.
export function sourceFromAccounts (accounts) {
  const rec = (accounts || []).find(a => a && a.source_id && !isMessagingAccount(a))
  return sourceForId(rec && rec.source_id)
}

// For pages that haven't loaded the accounts collection themselves: one cheap query, then route.
// Falls back to live mail if the query fails (fresh install / nothing persisted yet).
export async function detectSource () {
  try {
    const rows = await freezr.query('accounts', {}, { count: 5 })
    return sourceFromAccounts(rows)
  } catch (e) {
    return sourceForId(null)
  }
}
