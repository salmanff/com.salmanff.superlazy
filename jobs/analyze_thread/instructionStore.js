// instructionStore.js — PERMANENT core (Part 1: in-memory; Part 2: durable `instructions`
// collection). Holds the user's free-text CUSTOM INSTRUCTIONS (Concept A), each scoped to a
// sender, a whole domain, one mail account, or all mail. Matching is exact string comparison —
// the LLM does all the interpreting; there is NO structured action here.
// See specs/pipeline-walkthrough.md §5a.

const lc = (s) => String(s || '').toLowerCase()
const domainOf = (email) => { const s = lc(email); const i = s.indexOf('@'); return i >= 0 ? s.slice(i) : '' }

export function createInstructionStore () {
  const map = new Map() // instruction_id -> record
  let seq = 0
  const mintId = () => 'i_' + (++seq).toString(36).padStart(2, '0')

  // scope: 'sender' | 'domain' | 'account' | 'all'. For 'sender' match is the email; for 'domain'
  // the domain (with or without a leading '@' — normalized here); for 'account' the stored
  // account_id of a connected mailbox (case-sensitive, kept as-is); for 'all' match is ignored.
  function add ({ scope, match, text, label, asof } = {}) {
    const t = String(text || '').trim()
    if (!t) return null
    const sc = ['sender', 'domain', 'account', 'all'].includes(scope) ? scope : 'sender'
    let m = null
    if (sc === 'sender') m = lc(match)
    else if (sc === 'domain') { m = lc(match); if (m && m[0] !== '@') m = '@' + m.replace(/^.*@/, '') }
    else if (sc === 'account') m = String(match || '').trim() || null
    const rec = {
      instruction_id: mintId(),
      scope: sc,
      match: m,
      text: t,
      label: (label && String(label).trim()) || (t.length > 42 ? t.slice(0, 42) + '…' : t),
      status: 'active',
      created_asof: asof || null,
      author: 'user'
    }
    map.set(rec.instruction_id, rec)
    return rec
  }

  function disable (id) { const r = map.get(id); if (r) r.status = 'disabled'; return r || null }
  function enable (id) { const r = map.get(id); if (r) r.status = 'active'; return r || null }
  function remove (id) { return map.delete(id) }
  function all () { return [...map.values()] }

  // Every active instruction that applies to a message from `senderEmail`: scope=all always,
  // scope=sender when the address matches, scope=domain when the sender's domain matches, and
  // scope=account when the message arrived on that connected account (accountId — optional; when
  // the caller has no account context, account-scoped rules simply don't match).
  function matching (senderEmail, accountId) {
    const s = lc(senderEmail)
    const dom = domainOf(s)
    const acc = accountId == null ? null : String(accountId)
    return all().filter(r => r.status === 'active' && (
      r.scope === 'all' ||
      (r.scope === 'sender' && r.match === s) ||
      (r.scope === 'domain' && r.match === dom) ||
      (r.scope === 'account' && acc != null && r.match === acc)
    ))
  }

  // Just the text lines, for injection into the prompt.
  function textsFor (senderEmail, accountId) { return matching(senderEmail, accountId).map(r => r.text) }

  // Load persisted instruction records and bump the id counter past used ids.
  function hydrate (records) {
    for (const r of (records || [])) {
      if (!r || !r.instruction_id || !r.text) continue
      map.set(r.instruction_id, { ...r })
      const n = parseInt(String(r.instruction_id).slice(2), 36)
      if (Number.isFinite(n)) seq = Math.max(seq, n)
    }
  }

  return { add, disable, enable, remove, all, matching, textsFor, hydrate }
}
