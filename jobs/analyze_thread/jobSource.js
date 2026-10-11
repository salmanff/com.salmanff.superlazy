// jobSource.js — the InputSource resolver for code that may run OUTSIDE the browser.
//
// Deliberately NOT sourceFactory.js (the page-side resolver): that one can also return the Email
// Cabinet archive source, which pulls in postal-mime.js (~69KB of third-party MIME parsing). A
// background job is bundled from this folder alone, so importing it here would mean shipping
// postal-mime in every job deploy — for a source the job can never usefully use anyway (the
// archive is a dev/replay fixture, not a live mailbox to poll).
//
// Since the Slack slice this resolver is CHANNEL-AWARE: stored accounts are split by channel —
// mail rows drive the live mail source, `channel:'messages'` rows drive the Slack source — and
// when both kinds exist the two are wrapped in ONE composite source whose listEnvelopes merges
// the queues oldest-first. That single sorted queue is the cross-channel chronology mechanism
// (the plan's "one clock, one serialized replay"): an email, the Slack follow-up, and the reply
// are analysed in true time order within a run, whatever channel each came from.
//
// An install whose stored accounts were trained from the archive gets `null` and the caller
// reports "this account can't be checked in the background" rather than silently analysing the
// wrong mailbox.

import { createLiveMailSource } from './liveMailSource.js'
import { createSlackSource } from './slackSource.js'
import { createWorkSource, isWorkAccount } from './workSource.js'

export { isWorkAccount }

export const isArchiveAccount = (rec) => String((rec && rec.source_id) || '').startsWith('archive:')
export const isMessagingAccount = (rec) => !!rec && (rec.channel === 'messages' ||
  String(rec.source_id || '').startsWith('live:connections.messaging'))

// accounts: stored account records (the LIVE objects — the slack source advances tokens/stream
// cursors on them, and processor.plan() adopts the same objects, so one save path serves both).
// persist: needed by the slack source (the `inputs` chunk ledger); mail ignores it.
// eager: user-initiated run — the slack soft-debounce is off (chunk whatever is there now).
// Returns a source, or null when the MAIL accounts belong to the archive source (browser-only).
// pendingFloorMs: how far back the queue-backed sources page for pending items (ingest.js computes it
// from the scan watermark; null = legacy newest-300 read) — see pendingScan.js.
export function sourceFromAccounts (accounts, { freezr, persist = null, eager = false, workTuning = null, pendingFloorMs = null } = {}) {
  const recs = (accounts || []).filter(r => r && r.account_id)
  const messagingRecs = recs.filter(isMessagingAccount)
  const workRecs = recs.filter(r => !isMessagingAccount(r) && isWorkAccount(r))
  const mailRecs = recs.filter(r => !isMessagingAccount(r) && !isWorkAccount(r))
  if (mailRecs.some(isArchiveAccount)) return null
  const mail = mailRecs.length ? createLiveMailSource({ freezr }) : null
  const slack = messagingRecs.length ? createSlackSource({ freezr, persist, accounts: messagingRecs, eager, pendingFloorMs }) : null
  // workTuning: a MANUAL check passes { QUIET_MS: 0 } so the turn the agent is working on right now is
  // analysed too (user, 2026-09-11: someone pressing the button is at their desk and wants the current
  // state; the completed version is re-formed as revision 2 when the answer lands). Polls and the
  // background job keep the 30-minute quiet window.
  const work = workRecs.length ? createWorkSource({ freezr, persist, accounts: workRecs, pendingFloorMs, ...(workTuning ? { tuning: workTuning } : {}) }) : null
  const extras = []
  if (slack) extras.push({ source: slack, ids: new Set(messagingRecs.map(r => r.account_id)), threadPrefix: 'slack:', channel: 'messages' })
  if (work) extras.push({ source: work, ids: new Set(workRecs.map(r => r.account_id)), threadPrefix: 'cc:', channel: 'work' })
  if (!extras.length) return mail || createLiveMailSource({ freezr }) // no accounts yet: mail default
  if (!mail && extras.length === 1) return extras[0].source
  return createCompositeSource({ mail: mail || createLiveMailSource({ freezr }), extras })
}

// One source over several channels. Routing rules:
//  - by ACCOUNT for envelope listing (each child sees only its own accountIds),
//  - by THREAD-ID PREFIX for thread loads (slack stream ids are 'slack:…', work sessions 'cc:…'),
//  - by the normalized item's CHANNEL for body/attachment calls,
//  - everything else (recent threads, window, sent samples, attachments) is MAIL's.
// Back-compat: createCompositeSource({ mail, slack, messagingIds }) still works.
export function createCompositeSource ({ mail, slack = null, messagingIds = null, extras = null }) {
  const kids = extras || (slack ? [{ source: slack, ids: messagingIds || new Set(), threadPrefix: 'slack:', channel: 'messages' }] : [])
  const kidForThread = (threadId) => kids.find(k => String(threadId || '').startsWith(k.threadPrefix)) || null
  const kidForMsg = (msg) => msg ? (kids.find(k => msg.channel === k.channel) || kidForThread(msg.thread_id)) : null
  const kidForAccount = (id) => kids.find(k => k.ids.has(id)) || null
  // a CHILD whose whole listing failed this run (its accounts are skipped; the others carry on)
  let childErrors = []
  return {
    // legacy id kept for the mail+slack pair ('messaging'), so stored/diagnostic references still match
    id: 'composite:mail+' + kids.map(k => k.channel === 'messages' ? 'messaging' : k.channel).join('+'),

    async listAccounts () {
      const all = await Promise.all([mail.listAccounts(), ...kids.map(k => k.source.listAccounts())])
      return { accounts: all.flatMap(r => (r && r.accounts) || []) }
    },

    // THE MERGE: every child lists, then one queue sorted oldest-first across channels.
    // ISOLATION (2026-10-04): one child failing (a mail token expired, a Slack workspace gone) used
    // to reject the whole merge — plan() threw and NO account was processed until the user fixed
    // that one. Now a failed child is recorded (accountErrors) and skipped; its cursor stands
    // still and the other channels are processed. Only when EVERY child fails is the error thrown,
    // so a single-source install still gets the plain failure it always had.
    async listEnvelopes (opts = {}) {
      const ids = opts.accountIds && opts.accountIds.length ? opts.accountIds : null
      const mailIds = ids ? ids.filter(id => !kidForAccount(id)) : null
      const calls = []
      if (!ids || mailIds.length) calls.push({ p: mail.listEnvelopes({ ...opts, accountIds: ids ? mailIds : null }), ids: ids ? mailIds : [], label: 'mail' })
      for (const k of kids) {
        const mine = ids ? ids.filter(id => k.ids.has(id)) : null
        if (!ids || mine.length) calls.push({ p: k.source.listEnvelopes({ ...opts, accountIds: ids ? mine : null }), ids: ids ? mine : [...k.ids], label: k.channel })
      }
      const settled = await Promise.allSettled(calls.map(c => c.p))
      const results = []
      childErrors = []
      settled.forEach((r, i) => {
        if (r.status === 'fulfilled') { results.push(r.value); return }
        const c = calls[i]
        const err = r.reason
        const message = (err && err.message) || String(err)
        console.error('[superlazy] ' + c.label + ' listing failed — its account(s) are skipped this run:', message)
        const targets = c.ids.length ? c.ids : ['(' + c.label + ')']
        for (const id of targets) {
          childErrors.push({ account_id: id, channel: c.label, message, token_expired: !!(err && err.tokenExpired), reauth_url: (err && err.reauth_url) || null })
        }
      })
      if (!results.length && settled.length) throw settled[0].reason
      const envelopes = results.flatMap(r => (r && r.envelopes) || [])
        .sort((a, b) => (a.date - b.date) || (a.msg_id < b.msg_id ? -1 : 1))
      return { envelopes, hitCeiling: results.some(r => r && r.hitCeiling) }
    },

    // Accounts this run could not list — per connection from the mail source, per workspace/store
    // from the children, plus whole-child failures from the merge above. plan() excludes them from
    // the window arithmetic and the account seeding; ingest.js reports them.
    accountErrors () {
      // one entry per account: the mail source records a failed connection itself AND, when it was
      // the only mail connection, its whole listing rejects and lands in childErrors too
      const seen = new Set()
      return [
        ...(mail.accountErrors ? mail.accountErrors() : []),
        ...kids.flatMap(k => (k.source.accountErrors ? k.source.accountErrors() : [])),
        ...childErrors
      ].filter(e => e && !seen.has(e.account_id) && seen.add(e.account_id))
    },

    // every queue-backed child reached its pending-scan floor (ingest.js advances the watermark only then)
    pendingScanComplete () {
      return kids.every(k => typeof k.source.pendingScanComplete !== 'function' || k.source.pendingScanComplete())
    },

    loadThreadRaw (threadId, opts) {
      const k = kidForThread(threadId)
      return k ? k.source.loadThreadRaw(threadId, opts) : mail.loadThreadRaw(threadId, opts)
    },

    listRecentThreads (opts) { return mail.listRecentThreads(opts) },
    loadWindowRaw (opts) { return mail.loadWindowRaw(opts) },
    loadSentSamples (meSet, opts) { return mail.loadSentSamples(meSet, opts) }, // style guide is mail-only

    getFullBody (msg) { const k = kidForMsg(msg); return k ? k.source.getFullBody(msg) : mail.getFullBody(msg) },
    getBodyPayload (msg) { const k = kidForMsg(msg); return k ? k.source.getBodyPayload(msg) : mail.getBodyPayload(msg) },
    getAttachment (args) { return mail.getAttachment(args) },

    handleTokenExpired (resOrErr) {
      return mail.handleTokenExpired(resOrErr) || kids.some(k => k.source.handleTokenExpired && k.source.handleTokenExpired(resOrErr))
    },

    // formation failures from every child that forms items (today: the work source)
    formationErrors () {
      return kids.flatMap(k => (k.source.formationErrors ? k.source.formationErrors() : []))
    }
  }
}
