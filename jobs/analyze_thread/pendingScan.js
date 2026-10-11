// pendingScan.js — how a QUEUE-BACKED source (agent turns in workSource.js, Slack chunks in
// slackSource.js) reads its pending items from the `inputs` collection.
//
// Why this exists (2026-10-04): both sources used persist.pendingInputs — the newest 300 input
// records, filtered for status 'pending' — on the assumption that pending items are recent. A
// four-day mail backlog wrote 339 body records in one night and pushed 21 pending agent turns past
// rank 300; invisible to the planner, they were then overtaken by a newer turn that moved the
// account cursor, and nothing could ever queue them again ("great. thanks. done" never analysed).
// The deep scan (persist.scanPendingInputs) pages the same indexed sort until it passes the caller's
// floor — the watermark of the last run that scanned to its floor and drained its queue — so a
// burst only costs extra pages, never visibility. The legacy newest-300 read remains for callers
// that pass no floor (labs, Inspect) and for a persist without the deep scan; it makes no
// completeness claim, so a watermark is never advanced on its say-so.
export function createPendingReader ({ persist = null, floorMs = null } = {}) {
  let last = { complete: false, pages: 0, deep: false, rows: 0 }

  async function read () {
    if (!persist) { last = { complete: false, pages: 0, deep: false, rows: 0 }; return [] }
    if (floorMs != null && typeof persist.scanPendingInputs === 'function') {
      const r = await persist.scanPendingInputs({ floorMs: Number(floorMs) || 0 })
      const rows = (r && r.rows) || []
      last = { complete: !!(r && r.complete), pages: (r && r.pages) || 0, deep: true, rows: rows.length }
      return rows
    }
    const rows = await persist.pendingInputs({ scan: 300 })
    last = { complete: false, pages: 1, deep: false, rows: (rows || []).length }
    return rows || []
  }

  return { read, lastScan: () => last }
}
