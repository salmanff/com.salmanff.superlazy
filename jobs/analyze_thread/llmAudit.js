// llmAudit.js — the REQUEST AUDIT sink (dev tool). When settings.llm_audit is on, every LLM
// exchange the per-message engine makes — the analysis call, each request_more detail round, each
// repair round — is persisted VERBATIM into the llm_audit table: the turns that went out, the reply
// and thinking that came back, the provider's usage and pricing. The Request Audit Lab page
// (requestauditlab) reads these and shows what each part of each request cost.
//
// Temporary storage by design: records older than settings.llm_audit_days (default 3) are pruned
// at the start of every audited run. Toggle from the Setup page console: superlazy.audit(true|false).
//
// The cached DURABLE turn (system prompt aside, the biggest thing sent) is byte-identical across
// many exchanges, so it is stored ONCE per distinct content as a 'blob' record keyed by hash and
// referenced from each exchange — otherwise every exchange would carry the same 58k chars.

export const AUDIT_DEFAULT_DAYS = 3
const BLOB_MIN_CHARS = 2000 // shorter cached turns are simply stored inline

// FNV-1a over the text (same recipe as persist.hash32 / ingest.durableSig).
export function hashText (str) {
  const s = String(str || '')
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(36) + '_' + s.length.toString(36)
}

// What an analyze.js capture entry becomes on disk. Pure, so the page (or a test) can rebuild one.
export function auditRecordFrom (entry, { runId, driver, turns }) {
  const meta = entry.meta || {}
  return {
    kind: 'exchange',
    run_id: runId || null,
    driver: driver || null,            // 'job' | 'tab' | 'inspect'
    chain_id: entry.chain_id || null,  // one chain = the analysis call + its follow-on rounds
    round: entry.round || 1,
    exchange_kind: entry.kind || 'analysis', // 'analysis' | 'detail' (a request_more round)
    phase: entry.phase || 'analysis',        // 'analysis' | 'repair' (an invalid-reply retry)
    at: entry.at,
    duration_ms: entry.duration_ms != null ? entry.duration_ms : null,
    msg_ids: entry.msg_ids || [],
    subject: entry.subject || '',
    batch: entry.batch || (entry.msg_ids ? entry.msg_ids.length : 1),
    prompt_version: entry.prompt_version || null,
    model: meta.model || null,
    provider: meta.provider || null,
    family: meta.modelFamily || null,
    opts: entry.opts || {},
    system_prompt_chars: (entry.opts && entry.opts.system_prompt_chars) || 0,
    turns,
    response: entry.response != null ? String(entry.response) : null,
    thinking: entry.thinking != null ? String(entry.thinking) : null,
    error: entry.error || null,
    meta: {
      tokensUsed: meta.tokensUsed || null,
      rawUsage: meta.rawUsage || null,
      pricing: meta.pricing || null,
      cost: meta.cost || null
    }
  }
}

// The sink: an async function analyze.js calls with every finished exchange (see onExchange), plus
// flush() for the driver to await before it ends the run — a job that returns with a write still in
// flight would lose the last exchange.
export function createAuditSink ({ persist, runId, driver }) {
  const seenBlobs = new Set()
  const pending = new Set()
  const track = (p) => { pending.add(p); p.then(() => pending.delete(p), () => pending.delete(p)); return p }

  const sink = (entry) => track((async () => {
    try {
      const turns = []
      for (const t of (entry.turns || [])) {
        const text = String((t && t.content) || '')
        if (t && t.cached && text.length >= BLOB_MIN_CHARS) {
          const h = hashText(text)
          if (!seenBlobs.has(h)) {
            seenBlobs.add(h) // mark BEFORE the await: two exchanges finishing together must not both write it
            await persist.saveAuditBlob({ hash: h, text, prompt_version: entry.prompt_version || null }).catch(e => { seenBlobs.delete(h); throw e })
          }
          turns.push({ role: t.role, cached: true, chars: text.length, blob: h })
        } else {
          turns.push({ role: t.role, cached: !!(t && t.cached), chars: text.length, text })
        }
      }
      await persist.saveAuditExchange(auditRecordFrom(entry, { runId, driver, turns }))
    } catch (e) {
      console.warn('[superlazy] request audit: could not persist an exchange —', (e && e.message) || e)
    }
  })())
  sink.flush = async () => { await Promise.all([...pending]) }
  return sink
}
