// codexAdapter.js — Codex (OpenAI's coding agent) rollouts → the record shape sessionDigest.buildSession
// consumes. PURE: rollout records in, Claude-shaped records out; everything downstream (turns, the
// effort record, prompt compaction, commit capture, items, events, the viewer) then runs unchanged
// with provider 'codex' and agent name "Codex". Built against a real rollout (Codex 0.153.0, VS Code,
// 2026-09-08) — specs/superlazy-sessions.md §7.
//
// A rollout is `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, one line per record:
//   { timestamp, type, payload }  with types
//   session_meta        — id, timestamp, cwd, originator ('codex_vscode'), cli_version, source
//   world_state         — state.collaboration_mode.model (the model in use)
//   turn_context        — turn_id, cwd (per turn)
//   event_msg           — payload.type: task_started | user_message (the TYPED prompt) | agent_message
//                         (phase commentary|final_answer) | token_count | task_complete | turn_aborted | error
//                         | patch_apply_end (THE edit record: changes {path: {type, unified_diff}}, success)
//                         | thread_settings_applied (model…)
//   response_item       — payload.type: message (role developer|user|assistant; developer/user carry
//                         injected context <environment_context>… ; assistant carries output_text with
//                         phase) | custom_tool_call (name 'exec', input = a JS wrapper around
//                         tools.exec_command({cmd:"…"})) | custom_tool_call_output (output: [{text}] whose
//                         text wraps {"chunk_id","exit_code","output":"…"}) | function_call (older/other
//                         tools: name shell|apply_patch, arguments JSON) | function_call_output | reasoning
//   token_usage_record  — usage per model response: input_tokens, cached_input_tokens,
//                         cache_write_input_tokens, output_tokens, reasoning_output_tokens
// What has NO Codex equivalent: an ai-title (synthesised from the first prompt), the git branch in the
// transcript (Codex keeps it in its sqlite, unreadable through the fs API), Claude's file-history
// records (files changed via `exec` heredocs are invisible; `apply_patch` and `git diff --stat` output
// are what we have).

export const CODEX_PROVIDER = 'codex'

// Does this parsed transcript look like a Codex rollout? (first meaningful record is session_meta)
export function isCodexRollout (records) {
  for (const r of (records || [])) {
    if (!r || typeof r !== 'object') continue
    if (r.type === 'session_meta' && r.payload && (r.payload.cli_version || r.payload.originator || r.payload.id)) return true
    return false
  }
  return false
}

const textOfBlocks = (blocks) => (Array.isArray(blocks) ? blocks : []).map(b => (b && typeof b.text === 'string') ? b.text : '').join('\n')

// exec calls arrive as a JS wrapper: text(await tools.exec_command({cmd:"…", …})) — pull the cmd string
export function commandOfExecInput (input) {
  const s = String(input || '')
  const m = s.match(/exec_command\(\{\s*cmd\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (m) { try { return JSON.parse('"' + m[1] + '"') } catch (e) { return m[1] } }
  const m2 = s.match(/exec_command\(\{\s*cmd\s*:\s*'((?:[^'\\]|\\.)*)'/)
  if (m2) return m2[1]
  return s.slice(0, 500)
}

// The 0.15x exec wrapper for a patch: text(await tools.apply_patch("*** Begin Patch\n*** Add File: …"))
// — the patch is a JS STRING LITERAL (\n-escaped), so it is unescaped the same way as an exec cmd.
// This is the ONLY place the full text of an ADDED file exists: patch_apply_end carries an EMPTY
// diff for adds (verified on the real rollout 2026-09-10), a real diff only for updates.
export function patchTextOfExecInput (input) {
  const s = String(input || '')
  const m = s.match(/apply_patch\(\s*"((?:[^"\\]|\\.)*)"/)
  if (m) { try { return JSON.parse('"' + m[1] + '"') } catch (e) { return m[1].replace(/\\n/g, '\n') } }
  const m2 = s.match(/apply_patch\(\s*'((?:[^'\\]|\\.)*)'/)
  if (m2) return m2[1].replace(/\\n/g, '\n')
  return null
}
const isMd = (path) => /\.(md|markdown)$/i.test(String(path || ''))
// "*** Add File: <path>" sections → { path: fileText } for markdown files (plans and specs)
export function addFileBodiesFromPatch (patchText) {
  const out = {}
  let cur = null
  for (const line of String(patchText || '').split('\n')) {
    const m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (m) { cur = (m[1] === 'Add' && isMd(m[2].trim())) ? m[2].trim() : null; if (cur) out[cur] = []; continue }
    if (line.startsWith('*** End Patch')) { cur = null; continue }
    if (cur && line.startsWith('+') && !line.startsWith('+++')) out[cur].push(line.slice(1))
  }
  for (const k of Object.keys(out)) out[k] = out[k].join('\n')
  return out
}

// tool outputs wrap the real text in {"chunk_id":…,"exit_code":…,"output":"…"} after a header
export function unwrapExecOutput (text) {
  const t = String(text || '')
  const i = t.indexOf('{"chunk_id"')
  if (i < 0) return t
  try {
    const o = JSON.parse(t.slice(i, t.lastIndexOf('}') + 1))
    if (o && typeof o.output === 'string') return o.output + (o.exit_code ? '\n[exit code ' + o.exit_code + ']' : '')
  } catch (e) { /* fall through */ }
  return t
}

// apply_patch text → one Edit/Write tool_use per file with line counts (the "*** Update File:" format)
export function toolUsesFromPatch (patch, callId) {
  const out = []
  let cur = null
  const flush = () => { if (cur) out.push(cur); cur = null }
  for (const line of String(patch || '').split('\n')) {
    let m
    if ((m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/))) {
      flush()
      const kind = m[1]
      cur = { type: 'tool_use', id: callId + ':' + (out.length + 1), name: kind === 'Add' ? 'Write' : 'Edit', input: { file_path: m[2].trim(), _lines_added: 0, _lines_removed: 0, _patch_kind: kind } }
      continue
    }
    if (!cur) continue
    if (line.startsWith('+') && !line.startsWith('+++')) {
      cur.input._lines_added++
      if (cur.name === 'Write' && isMd(cur.input.file_path)) cur.input.content = (cur.input.content == null ? '' : cur.input.content + '\n') + line.slice(1)
    } else if (line.startsWith('-') && !line.startsWith('---')) cur.input._lines_removed++
  }
  flush()
  return out
}

// patch_apply_end.changes: { <path>: { type: 'update'|'add'|'delete', unified_diff } } → tool_use blocks
export function toolUsesFromChanges (changes, callId, success = true, addBodies = {}) {
  const out = []
  let i = 0
  for (const [file, ch] of Object.entries(changes || {})) {
    i++
    const diff = String((ch && ch.unified_diff) || '')
    let added = 0; let removed = 0
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++
      else if (line.startsWith('-') && !line.startsWith('---')) removed++
    }
    const kind = (ch && ch.type) || 'update'
    const input = { file_path: file, _lines_added: added, _lines_removed: removed, _patch_kind: kind, _applied: !!success }
    // MARKDOWN documents keep their text (specs/superlazy-sessions.md §6.3): Codex has no
    // planning tool, so a plan or spec it writes reaches us ONLY this way. An add-file patch IS the
    // whole file (every body line is a '+'); an update is a delta, kept as the diff. Code files stay
    // effort-only — the session builder reads `content` / `_unified_diff` exactly as it reads a
    // Claude Write, so one capture path serves both agents.
    if (/\.(md|markdown)$/i.test(file)) {
      if (kind === 'add') {
        const fromDiff = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)).join('\n')
        // 0.15x writes an EMPTY diff for an add — the text came in the exec call, keyed by path
        input.content = fromDiff.trim() ? fromDiff : (addBodies && typeof addBodies[file] === 'string' ? addBodies[file] : fromDiff)
      } else if (kind === 'update') {
        input._unified_diff = diff
      }
    }
    out.push({ type: 'tool_use', id: callId + ':' + i, name: kind === 'add' ? 'Write' : (kind === 'delete' ? 'Edit' : 'Edit'), input })
  }
  return out
}

/**
 * Translate a Codex rollout (parsed JSONL records) into buildSession's record shape.
 * @returns {Array} records — user / assistant / system / ai-title records with cwd, version, provider…
 */
export function codexRolloutToRecords (records) {
  const out = []
  const ctx = { sessionId: null, cwd: null, version: null, entrypoint: null, model: null }
  const base = (ts) => ({ timestamp: ts || null, sessionId: ctx.sessionId, cwd: ctx.cwd, version: ctx.version, entrypoint: ctx.entrypoint, provider: CODEX_PROVIDER })
  const hasUserEvents = (records || []).some(r => r && r.type === 'event_msg' && r.payload && r.payload.type === 'user_message')
  let lastAssistant = null
  const pendingAddBodies = {}   // path → text of a markdown file ADDED by an apply_patch exec, until its patch_apply_end
  let titled = false
  let currentTurnOpen = false

  const pushAssistant = (ts, blocks, stopReason) => {
    const rec = { ...base(ts), type: 'assistant', message: { role: 'assistant', model: ctx.model || null, stop_reason: stopReason || null, content: blocks, usage: null } }
    out.push(rec); lastAssistant = rec
    return rec
  }
  const pushUserPrompt = (ts, text) => {
    out.push({ ...base(ts), type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text }] } })
    if (!titled) {
      const first = String(text || '').split('\n').map(l => l.trim()).find(Boolean) || 'Codex session'
      out.push({ ...base(ts), type: 'ai-title', aiTitle: first.length > 70 ? first.slice(0, 67).trimEnd() + '…' : first })
      titled = true
    }
    lastAssistant = null
    currentTurnOpen = true
  }

  for (const r of (records || [])) {
    if (!r || typeof r !== 'object') continue
    const p = r.payload || {}
    const ts = r.timestamp || null
    switch (r.type) {
      case 'session_meta':
        ctx.sessionId = p.id || p.session_id || ctx.sessionId
        ctx.cwd = p.cwd || ctx.cwd
        ctx.version = p.cli_version || ctx.version
        ctx.entrypoint = p.originator || p.source || 'codex'
        break
      case 'world_state':
        if (p.state && p.state.collaboration_mode && p.state.collaboration_mode.model) ctx.model = p.state.collaboration_mode.model
        break
      case 'turn_context':
        if (p.cwd && !ctx.cwd) ctx.cwd = p.cwd
        if (p.model) ctx.model = p.model
        break
      case 'token_usage_record': {
        const u = p.usage || p.turn_token_usage
        if (u && lastAssistant) {
          lastAssistant.message.usage = {
            input_tokens: Number(u.input_tokens) || 0,
            output_tokens: Number(u.output_tokens) || 0,
            cache_read_input_tokens: Number(u.cached_input_tokens) || 0,
            cache_creation_input_tokens: Number(u.cache_write_input_tokens) || 0
          }
        }
        break
      }
      case 'event_msg':
        if (p.type === 'user_message' && typeof p.message === 'string') pushUserPrompt(ts, p.message)
        else if (p.type === 'patch_apply_end') {
          // THE edit record of Codex 0.15x: one event per applied patch, with a per-file unified diff
          // (the exec call that ran apply_patch shows nothing of the files) → one Edit/Write/Delete
          // tool_use per file with line counts from the diff
          const blocks = toolUsesFromChanges(p.changes, p.call_id || ('patch_' + out.length), p.success !== false, pendingAddBodies)
          for (const path of Object.keys(p.changes || {})) delete pendingAddBodies[path]
          if (blocks.length) pushAssistant(ts, blocks, 'tool_use')
        }
        else if (p.type === 'thread_settings_applied' && p.thread_settings && p.thread_settings.model) ctx.model = p.thread_settings.model
        else if (p.type === 'task_complete') { if (lastAssistant && currentTurnOpen) lastAssistant.message.stop_reason = 'end_turn'; currentTurnOpen = false }
        else if (p.type === 'turn_aborted') { currentTurnOpen = false }
        else if (p.type === 'error' || p.type === 'stream_error') out.push({ ...base(ts), type: 'system', subtype: 'api_error', level: 'error', error: { message: String(p.message || p.error || 'error') } })
        // agent_message duplicates the response_item assistant message — skipped
        break
      case 'response_item': {
        if (p.type === 'message') {
          if (p.role === 'assistant') {
            const text = textOfBlocks(p.content)
            if (text) pushAssistant(ts, [{ type: 'text', text }], p.phase === 'final_answer' ? 'end_turn' : null)
          } else if (p.role === 'user' && !hasUserEvents) {
            // older rollouts without user_message events: the typed prompt is a user message whose
            // text is not injected context (which always starts with a <tag>)
            const text = textOfBlocks(p.content).trim()
            if (text && !text.startsWith('<')) pushUserPrompt(ts, text)
          }
          // developer messages and injected user context are never prompts
        } else if (p.type === 'custom_tool_call' || p.type === 'function_call') {
          const name = String(p.name || '?')
          const callId = p.call_id || p.id || ('call_' + out.length)
          let blocks
          if (name === 'exec' || name === 'shell' || name === 'exec_command' || name === 'container.exec') {
            let command
            if (p.type === 'function_call') {
              try { const a = JSON.parse(p.arguments || '{}'); command = Array.isArray(a.command) ? a.command.join(' ') : String(a.command || a.cmd || '') } catch (e) { command = String(p.arguments || '') }
            } else {
              command = commandOfExecInput(p.input)
              // an apply_patch run through exec: keep the ADDED markdown bodies for the patch_apply_end
              // that follows (its add diff is empty); linked by PATH — the two records' call_ids differ
              const patchText = String(p.input || '').includes('apply_patch(') ? patchTextOfExecInput(p.input) : null
              if (patchText) Object.assign(pendingAddBodies, addFileBodiesFromPatch(patchText))
            }
            blocks = [{ type: 'tool_use', id: callId, name: 'Bash', input: { command } }]
          } else if (name === 'apply_patch') {
            let patch = p.input
            if (p.type === 'function_call') { try { const a = JSON.parse(p.arguments || '{}'); patch = a.input || a.patch || p.arguments } catch (e) { patch = p.arguments } }
            blocks = toolUsesFromPatch(patch, callId)
            if (!blocks.length) blocks = [{ type: 'tool_use', id: callId, name: 'apply_patch', input: {} }]
          } else {
            let input = {}
            try { input = p.type === 'function_call' ? JSON.parse(p.arguments || '{}') : { input: String(p.input || '').slice(0, 2000) } } catch (e) { input = { input: String(p.arguments || p.input || '').slice(0, 2000) } }
            blocks = [{ type: 'tool_use', id: callId, name, input }]
          }
          pushAssistant(ts, blocks, 'tool_use')
        } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
          const raw = typeof p.output === 'string' ? p.output : textOfBlocks(p.output)
          out.push({ ...base(ts), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: p.call_id || null, content: unwrapExecOutput(raw) }] } })
        } else if (p.type === 'reasoning') {
          // summaries are usually EMPTY and the content encrypted (0.15x) — keep a thinking block so the
          // reasoning shows up in the turn facts, with whatever text there is (often none)
          const summary = Array.isArray(p.summary) ? p.summary.map(x => (x && (x.text || x.summary_text)) || '').join('\n') : String(p.summary || '')
          pushAssistant(ts, [{ type: 'thinking', thinking: summary, encrypted: !!p.encrypted_content && !summary }], null)
        }
        break
      }
      default: break
    }
  }
  return out
}
