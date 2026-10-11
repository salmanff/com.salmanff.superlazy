// threadsInbox.js — which threads are in the INBOX right now, for the Threads view's 📬 filter.
//
// Asked LIVE of each mail connection (freezr.connections.mail.listMessages on the inbox folder),
// not read from stored labels: the labels superlazy keeps are a snapshot taken when a message was
// analysed (and are absent on most rows), so they cannot say what you have since archived or
// moved. Gmail / IMAP name the folder 'INBOX'; Microsoft Graph takes the well-known name 'inbox'.
//
// loadInbox({ force }) → { threads: Set(thread_id), msgs: Set(msg_id), problems: [text], at }
// Cached for INBOX_TTL_MS; one load in flight at a time. The newest INBOX_MAX_PER_ACCOUNT
// messages per account are read — enough for any inbox a person actually works from.

const INBOX_TTL_MS = 2 * 60 * 1000
const INBOX_MAX_PER_ACCOUNT = 300
const PAGE = 100

let cache = null
let inflight = null

const folderFor = (provider) => (String(provider || '').toLowerCase() === 'microsoft' ? 'inbox' : 'INBOX')

export const inboxCached = () => cache

export async function loadInbox ({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < INBOX_TTL_MS) return cache
  if (inflight) return inflight
  inflight = (async () => {
    const out = { threads: new Set(), msgs: new Set(), problems: [], at: Date.now() }
    const M = typeof freezr !== 'undefined' && freezr.connections && freezr.connections.mail
    if (!M) { out.problems.push('mail is not available on this page'); return out }
    let accounts = []
    try { accounts = ((await M.listAccounts()) || {}).accounts || [] } catch (e) { out.problems.push('could not list the mail accounts'); return out }
    await Promise.all(accounts.filter(a => (a.services || []).includes('mail')).map(async (a) => {
      const label = a.account_email || a.connectionName
      if (a.status && a.status !== 'ok') { out.problems.push(label + ': ' + (a.status === 'token_expired' ? 'session expired' : a.status)); return }
      let pageToken
      let read = 0
      try {
        do {
          const res = await M.listMessages({ connectionName: a.connectionName, labelIds: [folderFor(a.provider)], limit: PAGE, pageToken })
          for (const m of ((res && res.messages) || [])) {
            if (m.threadId) out.threads.add(m.threadId)
            if (m.id) out.msgs.add(m.id)
          }
          read += ((res && res.messages) || []).length
          pageToken = res && res.nextPageToken
        } while (pageToken && read < INBOX_MAX_PER_ACCOUNT)
      } catch (e) {
        const d = (e && e.data) || {}
        out.problems.push(label + ': ' + (d.error === 'token_expired' ? 'session expired' : ((e && e.message) || 'could not read the inbox')))
      }
    }))
    cache = out
    return out
  })()
  try { return await inflight } finally { inflight = null }
}
