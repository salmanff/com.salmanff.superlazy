// sessionDigest.js — PURE digest formation for the WORK channel (Claude Code sessions first).
// specs/superlazy-sessions.md §2: the input item for an agent session is a DIGEST of its
// transcript, not the transcript. A Claude Code session is one append-only JSONL file whose bytes
// are >90% tool output (file dumps, command output) — none of which is the user's work. What IS
// the work: the user's prompts (the asks), the assistant's closing text per turn (the recaps —
// the tail of a turn says what was done and what is outstanding), the tools used and the files
// touched (effort, not content), the last checklist (TodoWrite) and any plan produced.
//
// This module is deliberately freezr-free and fs-free so `test/verifySessions.mjs` can exercise
// every rule offline, and can run over a real ~/.claude/projects tree with plain node fs.
// sessionsSource.js owns reading files through the freezr fs API; this file owns only:
// transcript text in → structured session + rendered digest out.
//
// Truncation direction (user, 2026-09-06): for emails we cut the BOTTOM (quoted history); for a
// session we cut the TOP of each assistant answer — the last lines are the recap. Prompts keep
// their HEAD (an ask leads with the ask). Tool results are dropped entirely, never truncated —
// they are where secrets hide (a `cat` of an env file, a printed token), so a positional cut
// would still leak. A regex scrub runs over what remains as a second line of defence.

import { isCodexRollout, codexRolloutToRecords } from './codexAdapter.js'

export const DIGEST_TUNING = {
  QUIET_MS: 30 * 60 * 1000,        // a session touched within this is ACTIVE — do not analyse yet
  STALE_DAYS: 14,                  // quiet for longer than this ⇒ stale (the forgotten-work candidates)
  PROMPT_CHARS: 1200,              // per user prompt (head kept)
  RECENT_TURNS: 3,                 // the last N turns keep their assistant text at RECENT_ASSISTANT_CHARS
  RECENT_ASSISTANT_CHARS: 2500,    // tail kept for recent turns
  OLDER_ASSISTANT_CHARS: 350,      // tail kept for older turns
  DIGEST_CAP_CHARS: 14000,         // whole digest budget — middle turns collapse to one-liners, then to a count
  MAX_FILES_LISTED: 12,
  OMITTED_LINE_CHARS: 90           // a collapsed turn's one-liner
}

// Tools whose use means the session CHANGED something (vs. only read/ran)
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'])

// ---- parsing -----------------------------------------------------------------------------------

export function parseSessionLines (text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    if (!line) continue
    try { out.push(JSON.parse(line)) } catch (e) { /* a torn last line while the session writes — skip */ }
  }
  return out
}

// Text blocks of a message content (string or block array); tool_result blocks excluded.
export function textOf (content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
}

const toolResultChars = (content) => {
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const b of content) {
    if (!b || b.type !== 'tool_result') continue
    if (typeof b.content === 'string') n += b.content.length
    else if (Array.isArray(b.content)) for (const c of b.content) n += (c && typeof c.text === 'string') ? c.text.length : 0
  }
  return n
}

// Harness-injected text rides in user messages too (system reminders, IDE selection, slash
// command expansions). Strip the tagged blocks; what remains is what the human typed.
const INJECTED = /<(system-reminder|ide_selection|ide_opened_file|command-name|command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g
export function humanTextOf (rec) {
  const raw = textOf(rec && rec.message && rec.message.content)
  const t = raw.replace(INJECTED, '').trim()
  if (!t) return ''
  if (rec.origin && rec.origin.kind && rec.origin.kind !== 'human') return ''
  // Anything still starting with a tag is machinery (cross-session messages, task notifications)
  if (/^<[a-z-]+[\s>]/i.test(t)) return ''
  return t
}

const isHumanPrompt = (rec) => rec && rec.type === 'user' && !rec.isMeta && !rec.isSidechain &&
  rec.message && rec.message.role === 'user' && humanTextOf(rec).length > 0

const baseName = (p) => String(p || '').split('/').filter(Boolean).pop() || ''

// ---- effort helpers ----------------------------------------------------------------------------

const lineCount = (t) => { t = String(t || ''); return t ? t.split('\n').length : 0 }
// lines touched by one write-tool call — a PROXY for the amount of code produced: an Edit counts
// its new text as added and its old text as removed (a 3-line rewrite is +3/−3), a Write counts
// its whole content as added, MultiEdit each edit, NotebookEdit the new source. Not a git diff —
// a cheap, consistent effort signal.
export function linesDelta (name, input = {}) {
  let added = 0; let removed = 0
  // a provider adapter that already counted the patch (Codex apply_patch) says so directly
  if (input && (input._lines_added != null || input._lines_removed != null)) return { added: Number(input._lines_added) || 0, removed: Number(input._lines_removed) || 0 }
  const edit = (o, n) => { added += lineCount(n); removed += lineCount(o) }
  if (name === 'Edit') edit(input.old_string, input.new_string)
  else if (name === 'MultiEdit') for (const e of (input.edits || [])) edit(e && e.old_string, e && e.new_string)
  else if (name === 'Write') added += lineCount(input.content)
  else if (name === 'NotebookEdit') added += lineCount(input.new_source)
  return { added, removed }
}

const CONTINUATION_RE = /^(?:(?:sorry|oops|ok|okay)[\s,.!-]*)?(?:pls|please|plz)?\s*(?:cont(?:inue)?|go on|carry on|resume|proceed|keep going|try again|retry|again)\b[\s.!?…]*$/i
export function isContinuation (prompt, prev) {
  const p = String(prompt || '').trim()
  if (!p || p.length > 80) return false
  if (CONTINUATION_RE.test(p)) return true
  // a SHORT prompt (≤ 4 words) right after a turn that did NOT end (stopped mid-tool, or never
  // answered — typically a dropped connection) continues it; a real new instruction has more words,
  // and a turn that ended cleanly never attracts a fold
  return p.length <= 40 && p.split(/\s+/).length <= 4 && !!prev && !prev.ended
}

function foldTurn (prev, t) {
  prev.continuations.push(t.prompt)
  if (t.assistantText) prev.assistantText = t.assistantText
  prev.assistantTextChars += t.assistantTextChars
  prev.assistantMsgs += t.assistantMsgs
  prev.stopReason = t.stopReason || prev.stopReason
  for (const [k, v] of Object.entries(t.tools || {})) prev.tools[k] = (prev.tools[k] || 0) + v
  for (const f of t.files) if (!prev.files.includes(f)) prev.files.push(f)
  prev.wrote = prev.wrote || t.wrote
  prev.plan = t.plan || prev.plan
  prev.planDocs = (prev.planDocs || []).concat(t.planDocs || [])
  prev.todos = t.todos || prev.todos
  prev.toolResultChars += t.toolResultChars
  prev.lastTs = t.lastTs || prev.lastTs
  for (const m of t.models) if (!prev.models.includes(m)) prev.models.push(m)
  for (const k of Object.keys(prev.usage)) prev.usage[k] += t.usage[k] || 0
  prev.thinkingChars += t.thinkingChars
  prev.apiErrors += t.apiErrors
  prev.linesAdded += t.linesAdded; prev.linesRemoved += t.linesRemoved
  prev.askedQuestion = t.askedQuestion
  prev.ended = t.ended
  prev.interrupt = t.interrupt
  prev.commits.push(...(t.commits || []))
  prev.pastedLines += t.pastedLines || 0
  prev.diffStat = t.diffStat || prev.diffStat
  if (prev.raw && t.raw) prev.raw = prev.raw.concat(t.raw)
}

// The EFFORT record stored on a turn item (inputs.work_stats) — what survives of the tool use,
// intermediate answers and usage that the item body deliberately drops.
export function turnStats (turn) {
  const toolCalls = Object.values(turn.tools || {}).reduce((n, v) => n + v, 0)
  return {
    duration_ms: turn.lastTs && turn.ts ? Math.max(0, turn.lastTs - turn.ts) : null,
    tokens: { ...turn.usage },
    tool_calls: toolCalls,
    tools: turn.tools || {},
    files_changed: (turn.files || []).length,
    lines_added: turn.linesAdded || 0,
    lines_removed: turn.linesRemoved || 0,
    tool_output_chars: turn.toolResultChars || 0,
    thinking_chars: turn.thinkingChars || 0,
    assistant_messages: turn.assistantMsgs || 0,
    models: turn.models || [],
    api_errors: turn.apiErrors || 0,
    continuations: (turn.continuations || []).length,
    asked_question: !!turn.askedQuestion,
    prompt_pasted_lines: turn.pastedLines || 0,
    diff_stat: turn.diffStat ? { files: turn.diffStat.files_count, insertions: turn.diffStat.insertions, deletions: turn.diffStat.deletions } : null,
    commits: (turn.commits || []).map(c => ({ hash: c.hash, branch: c.branch, message: c.message, files: c.files, insertions: c.insertions, deletions: c.deletions, ts: c.ts || null }))
  }
}

const fmtK = (n) => { n = Number(n) || 0; return n >= 10000 ? Math.round(n / 1000) + 'k' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n) }
// One line of effort for headers: "42m · 3 files (+120/−15 lines) · 18 tool calls · 21k tokens"
export function effortLine (st) {
  if (!st) return ''
  const parts = []
  if (st.duration_ms != null) parts.push(fmtDuration(st.duration_ms))
  if (st.files_changed) parts.push(st.files_changed + ' file' + (st.files_changed === 1 ? '' : 's') + ((st.lines_added || st.lines_removed) ? ' (+' + st.lines_added + '/−' + st.lines_removed + ' lines)' : ''))
  else if (st.diff_stat && st.diff_stat.files) parts.push(st.diff_stat.files + ' file' + (st.diff_stat.files === 1 ? '' : 's') + ' (+' + st.diff_stat.insertions + '/−' + st.diff_stat.deletions + ' lines, per git diff)')
  else parts.push('no files changed')
  if (st.tool_calls) parts.push(st.tool_calls + ' tool call' + (st.tool_calls === 1 ? '' : 's'))
  const tok = (st.tokens && (st.tokens.input + st.tokens.output + st.tokens.cache_read + st.tokens.cache_write)) || 0
  if (tok) parts.push(fmtK(tok) + ' tokens')
  if (st.commits && st.commits.length) parts.push(st.commits.length + ' commit' + (st.commits.length === 1 ? '' : 's') + ' (' + st.commits.map(c => c.hash.slice(0, 7)).join(', ') + ')')
  if (st.continuations) parts.push(st.continuations + ' continuation' + (st.continuations === 1 ? '' : 's'))
  if (st.api_errors) parts.push(st.api_errors + ' API error' + (st.api_errors === 1 ? '' : 's'))
  return parts.join(' · ')
}

// ---- prompt compaction ---------------------------------------------------------------------------
// The prompt is the ASK; what the user PASTES into it (stack traces, logs, JSON, a table, a code
// block) is context for the agent, not for a task manager (user, 2026-09-07). Collapse pasted
// material deterministically: fenced blocks, and runs of >= minRun machine-looking lines, each
// keep their FIRST line (usually the error message itself) plus a count of what was omitted.
const PASTE_LINE = /^(?:\s+at\s+\S|\s*Traceback \(most recent|\s*File "[^"]+", line \d+|\s*\w*(?:Error|Exception)\b[:\s]|\s*[{}\[\]]\s*,?\s*$|\s*"[^"]+"\s*:|\s*\d{4}-\d\d-\d\d[T ]\d\d:\d\d|\s*\[\d{2}:\d{2}:\d{2}|\s*[$>]\s|\s*\|.*\|\s*$|\s*(?:npm|node|error|warn|info|debug)\s*[:!]|\s*<\/?[a-zA-Z][^>]*>\s*$|\s{4,}\S)/i
const isPasteLine = (l) => PASTE_LINE.test(l) || l.length > 300
export function compactPrompt (text, { minRun = 3, keepFirst = 160 } = {}) {
  const lines = String(text || '').split('\n')
  const out = []
  let pasted = 0
  let i = 0
  while (i < lines.length) {
    if (/^\s*```/.test(lines[i])) {
      let j = i + 1
      while (j < lines.length && !/^\s*```/.test(lines[j])) j++
      const inner = lines.slice(i + 1, j)
      if (inner.length >= 2) {
        out.push('[pasted block, ' + inner.length + ' lines — starts: ' + clipHead(inner[0].trim() || inner[1].trim(), keepFirst) + ']')
        pasted += inner.length
      } else out.push(...inner)
      i = j + 1
      continue
    }
    if (isPasteLine(lines[i])) {
      let j = i
      while (j < lines.length && (isPasteLine(lines[j]) || (!lines[j].trim() && j + 1 < lines.length && isPasteLine(lines[j + 1])))) j++
      const n = j - i
      if (n >= minRun) {
        out.push(clipHead(lines[i].trim(), keepFirst))
        out.push('[… ' + (n - 1) + ' more pasted lines (logs / errors / data) omitted]')
        pasted += n - 1
        i = j
        continue
      }
    }
    out.push(lines[i])
    i++
  }
  return { text: out.join('\n'), pastedLines: pasted }
}

// A git commit the AGENT made inside the session shows up as a Bash tool call whose result reads
// "[branch hash] message" + "N files changed, X insertions(+), Y deletions(-)". Parsed into the
// turn's commits — the strongest "it landed" evidence a session gives.
const GIT_COMMIT_CMD = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/
export function parseCommitOutput (text) {
  const t = String(text || '')
  const out = []
  const re = /\[([^\s\]]+)\s+(?:\(root-commit\)\s+)?([0-9a-f]{7,40})\]\s+([^\n]*)/g
  let m
  while ((m = re.exec(t))) {
    const c = { branch: m[1], hash: m[2], message: m[3].trim().slice(0, 200), files: null, insertions: null, deletions: null }
    const rest = t.slice(m.index)
    const st = rest.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/)
    if (st) { c.files = Number(st[1]); c.insertions = st[2] != null ? Number(st[2]) : 0; c.deletions = st[3] != null ? Number(st[3]) : 0 }
    out.push(c)
  }
  return out
}

// `git diff --stat` output → { files: [path…], insertions, deletions } — the effort measure when the
// agent edited files through a shell command (a python heredoc, sed…) that the write-tool line
// counts cannot see. Codex does most of its edits that way.
export function parseDiffStat (text) {
  const t = String(text || '')
  const sum = t.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/)
  if (!sum) return null
  const files = []
  for (const line of t.split('\n')) { const m = line.match(/^\s*(\S[^|]*?)\s+\|\s+\d+/); if (m) files.push(m[1].trim()) }
  return { files: files.slice(0, 40), insertions: sum[2] != null ? Number(sum[2]) : 0, deletions: sum[3] != null ? Number(sum[3]) : 0, files_count: Number(sum[1]) }
}

// The git snapshot Claude Code puts in a session's FIRST message (a "# gitStatus" context block:
// current branch, working-tree status lines, the five most recent commits). Kept as METADATA on the
// session's first turn item (user, 2026-09-08: store branch + commit data per chat for later use —
// e.g. a Stage-2 "changed files still uncommitted" signal); never rendered to the model.
export function parseGitSnapshot (text) {
  const t = String(text || '')
  const i = t.indexOf('# gitStatus')
  if (i < 0) return null
  const block = t.slice(i, i + 6000)
  const branch = (block.match(/Current branch:\s*(\S+)/) || [])[1] || null
  const mainBranch = (block.match(/Main branch[^:]*:\s*(\S+)/) || [])[1] || null
  const uncommitted = []
  const recent = []
  const st = block.match(/\nStatus:\n([\s\S]*?)(?:\n\s*\n|\nRecent commits:)/)
  if (st) for (const line of st[1].split('\n')) { const m = line.match(/^\s*(\?\?|[ MADRCU!]{1,2})\s+(\S.*)$/); if (m) uncommitted.push({ code: m[1].trim(), path: m[2].trim() }) }
  const rc = block.match(/Recent commits:\n([\s\S]*?)(?:\n\s*\n|<\/|$)/)
  if (rc) for (const line of rc[1].split('\n')) { const m = line.match(/^\s*([0-9a-f]{7,40})\s+(.*)$/); if (m) recent.push({ hash: m[1], message: m[2].trim().slice(0, 200) }) }
  if (!branch && !uncommitted.length && !recent.length) return null
  return { branch, main_branch: mainBranch, uncommitted: uncommitted.slice(0, 60), recent_commits: recent }
}

// ---- session build -----------------------------------------------------------------------------

/**
 * Build the structured session from parsed records.
 * @param {Array} records   parsed JSONL records (parseSessionLines)
 * @param {Object} meta     { sessionId, repoSlug, path, size, mtimeMs } from the file listing
 */
// opts.keepRaw: keep every record of each turn on turn.raw (the lab's inspection modal — never in
// a job; a session's records are the whole transcript).
export function buildSession (records, meta = {}, { keepRaw = false, mergeContinuations = true } = {}) {
  const s = {
    sessionId: meta.sessionId || null,
    repoSlug: meta.repoSlug || null,
    path: meta.path || null,
    bytes: meta.size || 0,
    mtimeMs: meta.mtimeMs || null,
    title: null,
    lastPrompt: null,
    cwd: null,
    repoName: null,
    gitBranch: null,
    version: null,
    entrypoint: null,
    provider: null,          // 'claude_code' (default) | 'codex' — set by the provider adapter's records
    firstTs: null,
    lastTs: null,
    turns: [],
    compactions: [],
    todos: null,             // the LAST TodoWrite list in the session
    repoState: null,         // the git snapshot from the session's first message (parseGitSnapshot)
    filesTouched: [],        // union of write-tool file paths + file-history-delta paths
    rawPre: keepRaw ? [] : null,   // records before the first prompt (lab only)
    stats: { lines: records.length, userTurns: 0, assistantMsgs: 0, toolUses: 0, toolResultChars: 0, assistantTextChars: 0, promptChars: 0, thinkingBlocks: 0, apiErrors: 0 }
  }
  const touched = new Set()
  let turn = null
  let pendingToolUse = false   // an assistant tool_use awaiting its tool_result
  const gitPending = new Map() // tool_use id -> the `git commit` command awaiting its result
  const diffPending = new Set() // tool_use ids of `git diff` commands — their --stat output measures the work

  const tsOf = (r) => (r && r.timestamp) ? Date.parse(r.timestamp) : NaN
  const noteTs = (r) => {
    const t = tsOf(r)
    if (!Number.isFinite(t)) return
    if (!s.firstTs || t < s.firstTs) s.firstTs = t
    if (!s.lastTs || t > s.lastTs) s.lastTs = t
  }

  for (const r of records) {
    if (!r || typeof r !== 'object') continue
    if (r.isSidechain) continue
    if (!s.sessionId && r.sessionId) s.sessionId = r.sessionId
    if (!s.cwd && r.cwd) { s.cwd = r.cwd; s.repoName = baseName(r.cwd) }
    if (r.gitBranch) s.gitBranch = r.gitBranch
    if (r.version) s.version = r.version
    if (!s.entrypoint && r.entrypoint) s.entrypoint = r.entrypoint
    if (!s.provider && r.provider) s.provider = r.provider

    if (keepRaw && !(r.type === 'user' && isHumanPrompt(r))) {
      if (turn) turn.raw.push(r); else s.rawPre.push(r)
    }
    if (turn && r.timestamp && r.type !== 'ai-title' && r.type !== 'last-prompt') {
      const t = tsOf(r)
      if (Number.isFinite(t) && (!turn.lastTs || t > turn.lastTs) && !(r.type === 'user' && isHumanPrompt(r))) turn.lastTs = t
    }
    switch (r.type) {
      case 'ai-title': if (r.aiTitle) s.title = r.aiTitle; break
      case 'last-prompt': if (r.lastPrompt) s.lastPrompt = r.lastPrompt; break
      case 'summary': if (r.summary) s.compactions.push(String(r.summary)); break
      case 'file-history-delta': if (r.trackingPath) touched.add(r.trackingPath); break
      case 'system': if (r.subtype === 'api_error') { s.stats.apiErrors++; if (turn) turn.apiErrors++ } noteTs(r); break
      case 'user': {
        noteTs(r)
        const content = r.message && r.message.content
        const trChars = toolResultChars(content)
        if (trChars || (Array.isArray(content) && content.some(b => b && b.type === 'tool_result'))) {
          s.stats.toolResultChars += trChars
          if (turn) turn.toolResultChars += trChars
          pendingToolUse = false
          if ((gitPending.size || diffPending.size) && Array.isArray(content)) {
            for (const b of content) {
              if (!b || b.type !== 'tool_result') continue
              const txt = typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content.map(x => (x && x.text) || '').join('\n') : '')
              if (gitPending.has(b.tool_use_id)) {
                gitPending.delete(b.tool_use_id)
                const found = parseCommitOutput(txt).map(c => ({ ...c, ts: tsOf(r) || null }))
                if (turn && found.length) turn.commits.push(...found)
              }
              if (diffPending.has(b.tool_use_id)) {
                diffPending.delete(b.tool_use_id)
                const st = parseDiffStat(txt)
                if (turn && st) turn.diffStat = st
              }
            }
          }
        }
        if (!s.repoState && r.message && !r.isMeta) {
          const raw = textOf(r.message.content)
          if (raw.includes('# gitStatus')) s.repoState = parseGitSnapshot(raw)
        }
        if (isHumanPrompt(r)) {
          const prompt = humanTextOf(r)
          turn = {
            n: s.turns.length + 1,
            ts: tsOf(r) || null,
            prompt,
            promptChars: prompt.length,
            assistantText: '',      // the LAST assistant text of the turn (the recap)
            assistantTextChars: 0,  // all assistant text in the turn
            assistantMsgs: 0,
            stopReason: null,
            tools: {},              // name → count
            files: [],
            wrote: false,
            plan: null,             // first line of an ExitPlanMode plan (legacy title; agent_work.plans has the text)
            planDocs: [],           // FULL plan / design documents written this turn (planDoc): ExitPlanMode text, .md Writes, Codex add-file patches
            planRef: null,          // { title, turn_n, ts } — the newest plan known to the session AS OF this turn (post-pass)
            todos: null,            // last TodoWrite in this turn
            toolResultChars: 0,
            ended: false,
            interrupt: null,        // null | 'unanswered' | 'mid_tool'
            // turn FACTS (derived, cheap): the effort record (turnStats) is stored on the item
            lastTs: tsOf(r) || null,
            linesAdded: 0,
            linesRemoved: 0,
            askedQuestion: false,   // AskUserQuestion tool, or the closing text ends with a question
            continuations: [],      // prompts folded into this turn ("sorry, pls cont" after a drop)
            commits: [],            // git commits the agent made in this turn (parseCommitOutput)
            diffStat: null,         // last `git diff --stat` the agent ran: { files:[…], insertions, deletions }
            pastedLines: 0,         // lines of pasted logs/errors/data collapsed out of the prompt
            models: [],
            usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
            thinkingChars: 0,
            apiErrors: 0,
            raw: keepRaw ? [r] : null
          }
          s.turns.push(turn)
          s.stats.userTurns++
          s.stats.promptChars += prompt.length
          pendingToolUse = false
        }
        break
      }
      case 'assistant': {
        noteTs(r)
        s.stats.assistantMsgs++
        const content = r.message && r.message.content
        const blocks = Array.isArray(content) ? content : []
        const text = textOf(content)
        if (r.message && r.message.stop_reason && turn) turn.stopReason = r.message.stop_reason
        if (turn) {
          turn.assistantMsgs++
          const u = r.message && r.message.usage
          if (u) {
            turn.usage.input += Number(u.input_tokens) || 0
            turn.usage.output += Number(u.output_tokens) || 0
            turn.usage.cache_read += Number(u.cache_read_input_tokens) || 0
            turn.usage.cache_write += Number(u.cache_creation_input_tokens) || 0
          }
          const model = r.message && r.message.model
          if (model && !turn.models.includes(model)) turn.models.push(model)
        }
        if (text) {
          s.stats.assistantTextChars += text.length
          if (turn) { turn.assistantText = text; turn.assistantTextChars += text.length }
        }
        for (const b of blocks) {
          if (!b) continue
          if (b.type === 'thinking') { s.stats.thinkingBlocks++; if (turn) turn.thinkingChars += String(b.thinking || '').length }
          if (b.type !== 'tool_use') continue
          s.stats.toolUses++
          pendingToolUse = true
          const name = String(b.name || '?')
          const input = b.input || {}
          if (turn) {
            turn.tools[name] = (turn.tools[name] || 0) + 1
            if (FILE_TOOLS.has(name) && input.file_path) {
              if (WRITE_TOOLS.has(name)) { touched.add(input.file_path); turn.wrote = true; if (!turn.files.includes(input.file_path)) turn.files.push(input.file_path) }
            }
            if (WRITE_TOOLS.has(name)) {
              const d = linesDelta(name, input)
              turn.linesAdded += d.added; turn.linesRemoved += d.removed
            }
            if (name === 'AskUserQuestion') turn.askedQuestion = true
            if (name === 'Bash' && GIT_COMMIT_CMD.test(String(input.command || ''))) gitPending.set(b.id, input.command)
            if (name === 'Bash' && /\bgit\s+diff\b/.test(String(input.command || ''))) diffPending.add(b.id)
            if (name === 'TodoWrite' && Array.isArray(input.todos)) { turn.todos = input.todos; s.todos = input.todos }
            if (name === 'ExitPlanMode' && typeof input.plan === 'string') {
              turn.plan = docTitleOf(input.plan)
              turn.planDocs.push(planDoc('plan', 'ExitPlanMode', null, input.plan))
            }
            // A DOCUMENT the agent wrote is already in the transcript in full — a Claude `Write`
            // carries `content`, a Codex apply_patch add-file arrives here as a synthetic Write with
            // `content` rebuilt from the diff (codexAdapter). Markdown only: that is where plans and
            // specs live; code files are effort, not intent. (specs/superlazy-sessions.md §6.3)
            if (name === 'Write' && isMarkdownPath(input.file_path) && typeof input.content === 'string' && input.content.trim()) {
              turn.planDocs.push(planDoc('doc', input._patch_kind ? 'apply_patch' : 'Write', input.file_path, input.content))
            }
            // a Codex UPDATE of a markdown document: only the delta exists — keep it as a patch so a
            // revised plan is at least visible as "what changed"
            if (name === 'Edit' && isMarkdownPath(input.file_path) && typeof input._unified_diff === 'string' && input._unified_diff.trim()) {
              turn.planDocs.push(planDoc('patch', 'apply_patch', input.file_path, input._unified_diff))
            }
            // A Claude Code `Edit` / `MultiEdit` of a markdown document carries old_string / new_string,
            // not a diff — synthesise one so a revised plan is visible as "what changed" exactly as a
            // Codex patch is. Without this, a plan drafted in rounds via Edit was invisible after its
            // first Write: "PLAN document CHANGED" never fired for Claude (found 2026-09-21).
            if ((name === 'Edit' || name === 'MultiEdit') && isMarkdownPath(input.file_path) && typeof input._unified_diff !== 'string') {
              const edits = name === 'Edit' ? [input] : (Array.isArray(input.edits) ? input.edits : [])
              const diff = edits.map(e => editAsDiff(e && e.old_string, e && e.new_string)).filter(Boolean).join('\n')
              if (diff) turn.planDocs.push(planDoc('patch', 'Edit', input.file_path, diff))
            }
          }
        }
        break
      }
      default: break
    }
  }

  for (const t of s.turns) t.pastedLines = compactPrompt(t.prompt).pastedLines
  // Turn endings (computed BEFORE the continuation merge — a fold looks at how the previous turn
  // ended): the last assistant message of a turn with stop_reason end_turn (or any text
  // after the tools) closes it. A turn whose last event is a tool_use with no result, or a prompt
  // with no assistant message at all, was interrupted — the "left mid-turn" signal.
  for (const t of s.turns) {
    if (t.assistantMsgs === 0) { t.interrupt = 'unanswered'; continue }
    if (t.stopReason === 'end_turn' || t.stopReason === 'stop_sequence') { t.ended = true; continue }
    if (t.stopReason === 'max_tokens') { t.ended = true; continue }
    t.interrupt = 'mid_tool'
  }

  // A turn whose closing text ends with a question (and no tool after) asked the user something.
  for (const t of s.turns) {
    if (t.assistantText && /\?\s*$/.test(t.assistantText.trim())) t.askedQuestion = true
  }
  // CONTINUATIONS (user, 2026-09-07): "sorry, pls cont" after a dropped connection is not a new
  // ask — fold it into the turn it continues: the merged turn keeps the ORIGINAL prompt, takes the
  // continuation's answer/tools/usage, and remembers the folded prompt(s). Folded when the prompt
  // is a short continuation phrase, OR short and following a turn that errored / was left mid-tool.
  if (mergeContinuations) {
    const merged = []
    for (const t of s.turns) {
      const prev = merged[merged.length - 1]
      if (prev && isContinuation(t.prompt, prev)) { foldTurn(prev, t); continue }
      merged.push(t)
    }
    merged.forEach((t, i) => { t.n = i + 1 })
    s.turns = merged
  }
  // The newest plan the session knows AS OF each turn. A plan is HOT on the turn that writes or
  // changes it (sent in full) and a one-line reference everywhere after (specs/superlazy-sessions.md
  // §6.3 — a three-day-old plan must never be re-read as a statement of what remains).
  let latest = null
  for (const t of s.turns) {
    const fresh = (t.planDocs || []).filter(d => d.kind !== 'patch')
    const last = fresh[fresh.length - 1]
    if (last) latest = { title: last.title, turn_n: t.n, ts: t.ts || t.lastTs || null, source: last.source }
    t.planRef = latest
  }
  s.filesTouched = [...touched]
  if (!s.lastTs && s.mtimeMs) s.lastTs = s.mtimeMs
  return s
}

// ---- classification ----------------------------------------------------------------------------

/**
 * Deterministic state of a session — no LLM.
 * @returns {{ state: 'active'|'interrupted'|'quiet'|'stale'|'empty', ageMs, quietMs, planUnexecuted, openTodos, flags: string[] }}
 */
export function classifySession (s, { now = Date.now(), tuning = DIGEST_TUNING, registered = false } = {}) {
  const lastTs = Number(s.lastTs || s.mtimeMs || 0)
  const quietMs = lastTs ? Math.max(0, now - lastTs) : Infinity
  const ageMs = s.firstTs ? Math.max(0, now - s.firstTs) : quietMs
  const flags = []
  const last = s.turns[s.turns.length - 1]

  // a plan was produced and no write tool ran in that turn or any later one
  let planUnexecuted = false
  for (let i = 0; i < s.turns.length; i++) {
    if (!s.turns[i].plan) continue
    const wroteAfter = s.turns.slice(i).some(t => t.wrote)
    if (!wroteAfter) planUnexecuted = true
  }
  const openTodos = (s.todos || []).filter(t => t && t.status !== 'completed').length

  let state
  if (!s.turns.length) state = 'empty'
  else if (quietMs < tuning.QUIET_MS) state = 'active'
  else if (last && last.interrupt) state = 'interrupted'
  else if (quietMs > tuning.STALE_DAYS * 86400000) state = 'stale'
  else state = 'quiet'

  if (registered) flags.push('registered')            // a live-process registry entry names it (maybe open in VS Code)
  if (last && last.interrupt === 'unanswered') flags.push('last prompt unanswered')
  if (last && last.interrupt === 'mid_tool') flags.push('stopped mid-tool')
  if (planUnexecuted) flags.push('plan not executed')
  if (openTodos) flags.push(openTodos + ' checklist item' + (openTodos === 1 ? '' : 's') + ' open')
  if (s.compactions.length) flags.push('compacted ×' + s.compactions.length)
  if (s.firstTs && s.lastTs && (s.lastTs - s.firstTs) > 2 * 86400000) flags.push('spans ' + Math.round((s.lastTs - s.firstTs) / 86400000) + ' days')
  if (!s.filesTouched.length && s.turns.length) flags.push('no files changed')

  return { state, ageMs, quietMs, planUnexecuted, openTodos, flags }
}

// ---- secret scrub ------------------------------------------------------------------------------

const SECRET_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g, 'Bearer [redacted]'],
  [/\b(?:sk|ghp|gho|ghu|ghs|xox[abps]|xapp|AKIA|AIza|pk_live|sk_live|rk_live)[-_A-Za-z0-9]{12,}/g, '[redacted-token]'],
  [/("?(?:appToken|accessToken|access_token|refresh_token|api_key|apiKey|password|passwd|secret|client_secret|private_key|token)"?\s*[:=]\s*"?)[^"\s,}]{6,}/gi, '$1[redacted]'],
  [/\b[A-Fa-f0-9]{40,}\b/g, '[redacted-hex]'],
  [/\b[A-Za-z0-9_\-]{48,}\b/g, '[redacted-long]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-key]']
]
// ---- captured plan / design documents -------------------------------------------------------------
// Stored WHOLE. No plan in the measured corpus (largest 27,390 chars) comes near the cap; it exists
// only against a pathological file, and a cut is always marked — never presented as the whole text.
export const PLAN_DOC_CAP = 64 * 1024
export const isMarkdownPath = (p) => /\.(md|markdown)$/i.test(String(p || ''))
// the first non-empty line, without markdown heading marks — the document's own name
export function docTitleOf (text) {
  const first = String(text || '').split('\n').find(l => l.trim()) || 'plan'
  return first.replace(/^#+\s*/, '').trim().slice(0, 120)
}
// A Claude Code Edit as a readable delta: the removed text with "- " line prefixes, then the added
// text with "+ ". Not a real unified diff (no hunk headers — we have no line numbers), but the same
// shape the model already reads from Codex patches. Empty when neither side has text.
export function editAsDiff (oldS, newS) {
  const o = typeof oldS === 'string' ? oldS : ''
  const n = typeof newS === 'string' ? newS : ''
  if (!o.trim() && !n.trim()) return ''
  const pre = (s, mark) => s.split('\n').map(l => mark + l).join('\n')
  return (o.trim() ? '--- removed\n' + pre(o, '- ') + '\n' : '') + (n.trim() ? '+++ added\n' + pre(n, '+ ') : '')
}
export function planDoc (kind, source, path, text) {
  const raw = scrubSecrets(String(text || ''))
  const truncated = raw.length > PLAN_DOC_CAP
  return {
    kind,                                   // 'plan' (a plan-mode plan) | 'doc' (a markdown document written whole) | 'patch' (a markdown delta)
    source,                                 // 'ExitPlanMode' | 'Write' | 'apply_patch' (Codex) | 'Edit' (Claude Code, via editAsDiff)
    path: path || null,
    title: kind === 'patch' ? (String(path || '').split('/').pop() || 'patch') : docTitleOf(raw),
    text: truncated ? raw.slice(0, PLAN_DOC_CAP) : raw,
    chars: raw.length,
    truncated
  }
}

export function scrubSecrets (text) {
  let t = String(text || '')
  for (const [re, rep] of SECRET_PATTERNS) t = t.replace(re, rep)
  return t
}

// ---- rendering ---------------------------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0')
export const fmtTs = (ms) => {
  if (!ms) return '?'
  const d = new Date(ms)
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}
const fmtShort = (ms) => {
  if (!ms) return '?'
  const d = new Date(ms)
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
}
export const fmtDuration = (ms) => {
  if (!Number.isFinite(ms)) return '?'
  if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + 's'   // a Codex turn is often seconds
  const m = Math.round(ms / 60000)
  if (m < 60) return m + 'm'
  const h = Math.round(m / 60)
  if (h < 48) return h + 'h'
  return Math.round(h / 24) + 'd'
}

const clipHead = (t, n) => { t = String(t || '').trim(); return t.length <= n ? t : t.slice(0, n).trimEnd() + ' …' }
const clipTail = (t, n) => { t = String(t || '').trim(); return t.length <= n ? t : '… ' + t.slice(t.length - n).trimStart() }

const toolsLine = (t, max = DIGEST_TUNING.MAX_FILES_LISTED) => {
  const names = Object.entries(t.tools || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + (v > 1 ? '×' + v : ''))
  if (!names.length) return ''
  const files = (t.files || []).map(baseName)
  const shown = files.slice(0, max)
  return '  [tools: ' + names.join(' ') + (shown.length ? ' · changed: ' + shown.join(', ') + (files.length > max ? ' (+' + (files.length - max) + ')' : '') : '') + ']'
}

const renderTodos = (todos) => {
  if (!Array.isArray(todos) || !todos.length) return []
  const out = ['--- checklist (latest TodoWrite)']
  for (const t of todos) {
    const mark = t.status === 'completed' ? '[x]' : (t.status === 'in_progress' ? '[~]' : '[ ]')
    out.push(mark + ' ' + clipHead(t.content || '', 160))
  }
  return out
}

/**
 * Render the digest text the LLM reads. Header + compaction summary + turns + checklist.
 * `verdict` (classifySession output) is optional but makes the header self-describing.
 */
export function renderDigest (s, { tuning = DIGEST_TUNING, verdict = null, now = Date.now() } = {}) {
  const T = tuning
  const head = []
  head.push('[WORK SESSION — ' + (s.agentName || 'Claude Code') + ']')
  head.push('title: ' + (s.title || '(untitled)'))
  head.push('repo: ' + (s.repoName || s.repoSlug || '?') + (s.gitBranch ? ' (branch ' + s.gitBranch + ')' : '') + (s.cwd ? ' · cwd: ' + s.cwd : ''))
  const v = verdict || classifySession(s, { now, tuning })
  head.push('span: ' + fmtTs(s.firstTs) + ' → ' + fmtTs(s.lastTs) + ' · ' + s.turns.length + ' turn' + (s.turns.length === 1 ? '' : 's') +
    ' · state: ' + v.state + ' · quiet ' + fmtDuration(v.quietMs) + (v.flags.length ? ' · ' + v.flags.join(', ') : ''))
  if (s.filesTouched.length) {
    const names = [...new Set(s.filesTouched.map(baseName))]
    head.push('files changed: ' + names.slice(0, T.MAX_FILES_LISTED).join(', ') + (names.length > T.MAX_FILES_LISTED ? ' (+' + (names.length - T.MAX_FILES_LISTED) + ')' : ''))
  }
  if (s.compactions.length) {
    head.push('--- earlier context (the session was compacted; this is its own summary)')
    head.push(clipTail(s.compactions[s.compactions.length - 1], 2000))
  }

  const n = s.turns.length
  const recentFrom = Math.max(0, n - T.RECENT_TURNS)
  const full = s.turns.map((t, i) => {
    const lines = []
    lines.push('--- turn ' + t.n + ' · ' + fmtShort(t.ts) + (t.plan ? ' · PLAN: ' + t.plan : '') + (t.interrupt ? ' · ' + (t.interrupt === 'unanswered' ? 'NO ANSWER YET' : 'STOPPED MID-TOOL') : ''))
    lines.push('YOU: ' + clipHead(t.prompt, T.PROMPT_CHARS))
    if (t.assistantText) lines.push('CLAUDE: ' + clipTail(t.assistantText, i >= recentFrom ? T.RECENT_ASSISTANT_CHARS : T.OLDER_ASSISTANT_CHARS))
    const tl = toolsLine(t, T.MAX_FILES_LISTED)
    if (tl) lines.push(tl)
    return lines.join('\n')
  })
  const oneLiner = (t) => '· turn ' + t.n + ' ' + fmtShort(t.ts) + ': ' + clipHead(t.prompt.replace(/\s+/g, ' '), T.OMITTED_LINE_CHARS) + (t.wrote ? ' [changed ' + t.files.length + ' file' + (t.files.length === 1 ? '' : 's') + ']' : '')

  const tail = renderTodos(s.todos)
  const fixedChars = head.join('\n').length + tail.join('\n').length + 40
  const budget = Math.max(2000, T.DIGEST_CAP_CHARS - fixedChars)

  // Fit: keep turn 1 and the recent turns in full; collapse middle turns oldest-first to
  // one-liners; if still over, replace the one-liners with a count.
  let body = full.slice()
  let collapsedFrom = -1
  const total = () => body.join('\n').length
  for (let i = 1; i < recentFrom && total() > budget; i++) {
    body[i] = oneLiner(s.turns[i])
    collapsedFrom = collapsedFrom < 0 ? i : collapsedFrom
  }
  if (total() > budget && collapsedFrom >= 0) {
    const kept = [body[0]]
    kept.push('… ' + (recentFrom - 1) + ' turns omitted (' + s.turns.slice(1, recentFrom).filter(t => t.wrote).length + ' changed files)')
    body = kept.concat(body.slice(recentFrom))
  }
  // last resort: trim recent assistant tails proportionally
  if (total() > budget) {
    const over = total() - budget
    const perTurn = Math.max(200, T.RECENT_ASSISTANT_CHARS - Math.ceil(over / Math.max(1, n - recentFrom)))
    body = body.map((blk, i) => {
      if (i < recentFrom || typeof blk !== 'string') return blk
      const t = s.turns[i]
      if (!t || !t.assistantText) return blk
      return blk.replace(/CLAUDE: [\s\S]*?(\n  \[tools:|$)/, (m, g1) => 'CLAUDE: ' + clipTail(t.assistantText, perTurn) + (g1 || ''))
    })
  }

  const text = head.concat(body, tail).join('\n')
  return scrubSecrets(text)
}

// Everything the lab table and the item builder need, in one call.
// Text of ANY supported transcript → the session. Detects the provider from the records: a Codex
// rollout is translated first (codexAdapter.js); Claude Code records pass straight through.
export function sessionFromText (text, meta = {}, opts = {}) {
  let records = parseSessionLines(text)
  if (isCodexRollout(records)) records = codexRolloutToRecords(records)
  const session = buildSession(records, meta, opts)
  if (!session.provider) session.provider = 'claude_code'
  return session
}

export function digestSession (text, meta = {}, { tuning = DIGEST_TUNING, now = Date.now(), registered = false } = {}) {
  const session = sessionFromText(text, meta)
  const verdict = classifySession(session, { now, tuning, registered })
  const digest = renderDigest(session, { tuning, verdict, now })
  return {
    session,
    verdict,
    digest,
    measures: {
      rawChars: String(text || '').length,
      digestChars: digest.length,
      reduction: text ? 1 - digest.length / String(text).length : 0,
      approxTokens: Math.ceil(digest.length / 4)
    }
  }
}

// ---- per-TURN item body (the WORK channel's input item) --------------------------------------------
// Stage 1 (specs/superlazy-sessions.md §2): the input item is ONE TURN — the user's prompt and the
// agent's answer — exactly like one email in a thread; the session is the thread. This renders the
// dialogue text stored on the inputs record (what the viewer shows, in full) — the LLM-facing
// renderer in assemble.js re-cuts it (prompt head, answer TAIL). The answer is capped here only
// for storage sanity; tool output is never part of it.
export const TURN_BODY_TUNING = { ANSWER_STORE_CHARS: 24000, PROMPT_STORE_CHARS: 12000 }
// The agent line is provider-neutral: "AGENT (Claude Code):" today, "AGENT (Codex):" tomorrow — the
// name in brackets is whatever the source reports. isAgentMarker recognises any of them.
export const TURN_MARKERS = { you: 'YOU:', agent: 'AGENT', tools: '[tools:', note: '[turn note:', commits: '[commits:' }
export const agentMarker = (agentName) => 'AGENT (' + String(agentName || 'AI agent').replace(/[()]/g, '') + '):'
export const isAgentMarker = (line) => /^AGENT( \([^)]*\))?:$/.test(String(line || '').trim()) || String(line || '').trim() === 'CLAUDE CODE:'

export function renderTurnBody (turn, { tuning = TURN_BODY_TUNING, agentName = 'Claude Code' } = {}) {
  const lines = []
  lines.push(TURN_MARKERS.you)
  lines.push(clipHead(compactPrompt(turn.prompt).text, tuning.PROMPT_STORE_CHARS))
  lines.push('')
  lines.push(agentMarker(agentName))
  if (turn.assistantText) lines.push(clipTail(turn.assistantText, tuning.ANSWER_STORE_CHARS))
  else lines.push(turn.interrupt === 'unanswered' ? '(no answer — the prompt was never answered)' : '(no closing text — the run stopped while a tool was running)')
  const tl = toolsLine(turn)
  if (tl) { lines.push(''); lines.push(tl.trim()) }
  if (turn.commits && turn.commits.length) {
    lines.push(TURN_MARKERS.commits + ' ' + turn.commits.map(c => c.hash.slice(0, 7) + ' "' + clipHead(c.message, 90) + '"' +
      (c.files != null ? ' (' + c.files + ' file' + (c.files === 1 ? '' : 's') + ', +' + (c.insertions || 0) + '/−' + (c.deletions || 0) + ')' : '')).join('; ') + ']')
  }
  const notes = []
  if (turn.continuations && turn.continuations.length) notes.push('resumed after a break — ' + turn.continuations.length + ' continuation prompt(s) folded in: ' + turn.continuations.map(c => '"' + clipHead(c, 40) + '"').join(', '))
  if (turn.askedQuestion) notes.push('the agent ended this turn by asking you a question' + (turn.ended ? ' — the next turn is your answer, if any' : ''))
  if (turn.plan) notes.push('a plan was written: "' + turn.plan + '"')
  if (turn.interrupt === 'mid_tool') notes.push('this turn was left unfinished (stopped mid-tool)')
  if (turn.interrupt === 'unanswered') notes.push('this prompt got no answer')
  if (Array.isArray(turn.todos) && turn.todos.length) {
    const open = turn.todos.filter(t => t && t.status !== 'completed')
    notes.push('agent checklist at this point: ' + turn.todos.length + ' item(s), ' + open.length + ' open' +
      (open.length ? ' — ' + open.slice(0, 6).map(t => clipHead(t.content || '', 80)).join('; ') : ''))
  }
  for (const n of notes) lines.push(TURN_MARKERS.note + ' ' + n + ']')
  return scrubSecrets(lines.join('\n'))
}

// Split a stored turn body back into its parts (the LLM renderer cuts prompt and answer differently).
export function splitTurnBody (body) {
  const s = String(body || '')
  const m = s.match(/\n(AGENT( \([^)]*\))?:|CLAUDE CODE:)\n/)
  if (!m) return { prompt: s.replace(/^YOU:\n?/, ''), answer: '', footer: '', agent: null }
  const iAgent = m.index
  const prompt = s.slice(0, iAgent).replace(/^YOU:\n?/, '').trim()
  const agent = (m[1].match(/\(([^)]*)\)/) || [])[1] || (m[1] === 'CLAUDE CODE:' ? 'Claude Code' : null)
  let rest = s.slice(iAgent + m[0].length)
  // footer = the tools line + turn notes at the end (each on its own line, starting with '[')
  const parts = rest.split('\n')
  const footer = []
  while (parts.length && /^\[(tools:|turn note:|commits:)/.test(parts[parts.length - 1])) footer.unshift(parts.pop())
  while (parts.length && !parts[parts.length - 1].trim()) parts.pop()
  return { prompt, answer: parts.join('\n'), footer: footer.join('\n'), agent }
}

// The item id of turn n in a session (deterministic — re-forming upserts).
export const turnMsgIdFor = (sessionId, n) => sessionId + '|t' + n

// The stream/thread identity scheme (specs/superlazy-sessions.md §2): one session = one thread.
export const threadIdFor = (repoSlug, sessionId) => 'cc:' + (repoSlug || '?') + ':' + sessionId
