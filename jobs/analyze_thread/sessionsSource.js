// sessionsSource.js — the WORK-channel reader over the freezr file-system API (use_file_sys).
// Claude Code first. Reads the agent's own on-disk state through a granted fs connection — a
// local file store the admin pointed at ~/.claude (or at ~/.claude/projects) — and hands each
// session file to sessionDigest.js. Nothing here talks to an LLM and nothing is persisted: this
// is the provider-facing half (like slackSource's fetch), the digest is the pure half.
//
// LAYOUTS the store root may be mounted at (detectLayout):
//   claude_home  root = ~/.claude          → projects/ (transcripts) + sessions/ (live-process registry)
//   projects     root = ~/.claude/projects → transcripts only, no registry
// The registry (sessions/<pid>.json) names the sessionId of each RUNNING Claude process — the
// only "is this tab open" signal there is. Its files linger after exit and a browser cannot test
// pid liveness, so it is reported as `registered` (maybe live), never as `live`. The `.key` files
// beside them are never read.
//
// freezr fs API (features/connections/fs/fsRoutes.mjs):
//   GET /feps/connections/fs/:conn/list?path=&depth=1 → { entries: [{ name, type: 'file'|'dir', size, mtimeMs }] }
//   GET /feps/connections/fs/:conn/read?path=         → raw bytes (textResponse)
// Whole-file reads for now: a stage-0 lab over a few days of sessions. The tail-read ask for
// incremental checks is logged in specs/superlazy-sessions.md §6.

import { digestSession, DIGEST_TUNING } from './sessionDigest.js'

// Claude Code names a repo folder by slugifying the cwd (every non-alphanumeric → '-'); Codex keeps the
// cwd itself. The SAME slug for the same repo is what lets one repo's sessions from both agents share
// a roster row and a provenance shape.
export const slugOfCwd = (cwd) => String(cwd || '').replace(/[^A-Za-z0-9]/g, '-')
const YEAR_DIR = /^\d{4}$/
const ROLLOUT_FILE = /^rollout-.*\.jsonl$/

const q = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&')

// The fs-capable connections this app may use (the shared /accounts listing, filtered).
export async function listFsConnections (fz) {
  const F = fz || (typeof freezr !== 'undefined' ? freezr : null)
  if (!F) throw new Error('freezr is not available')
  const res = await F.apiRequest('GET', '/feps/connections/accounts')
  const rows = (res && res.accounts) || []
  return rows.filter(a => Array.isArray(a.services) && a.services.includes('fs'))
}

// Turn an fs API failure into a sentence the lab can show.
export function explainFsError (err) {
  const status = err && err.status
  const msg = (err && err.message) || String(err)
  if (status === 403 && /use_file_sys|permission/i.test(msg)) {
    return 'superlazy has no file-system permission yet — grant "read_work_sessions" in the app\'s Settings (after re-installing with the new manifest), and make sure a local file store exists at /account/resources.'
  }
  if (status === 403 && /localhost|admin|local_fs/i.test(msg)) return 'Local file stores are only readable by an admin on localhost with the admin pref "local_fs_access_enabled" on — ' + msg
  if (status === 404) return 'Path not found in the file store — is the store rooted at ~/.claude, ~/.claude/projects or ~/.codex/sessions? (' + msg + ')'
  return msg
}

export function createSessionsSource ({ freezr: fz, connectionName } = {}) {
  const F = fz || (typeof freezr !== 'undefined' ? freezr : null)
  if (!F) throw new Error('freezr is not available')
  if (!connectionName) throw new Error('connectionName is required')
  const base = '/feps/connections/fs/' + encodeURIComponent(connectionName)
  let layout = null

  async function list (path) {
    const res = await F.apiRequest('GET', base + '/list?' + q({ path, depth: 1 }))
    return (res && res.entries) || []
  }
  const readText = (path) => F.apiRequest('GET', base + '/read?' + q({ path }), null, { textResponse: true })
  const join = (a, b) => a ? a + '/' + b : b

  async function detectLayout () {
    const entries = await list('')
    const dirs = new Set(entries.filter(e => e.type === 'dir').map(e => e.name))
    const files = new Set(entries.filter(e => e.type === 'file').map(e => e.name))
    if (dirs.has('projects')) {
      layout = { kind: 'claude_home', provider: 'claude_code', projectsPath: 'projects', sessionsPath: dirs.has('sessions') ? 'sessions' : null, plansPath: dirs.has('plans') ? 'plans' : null }
    } else if ([...dirs].some(n => n.startsWith('-'))) {
      layout = { kind: 'projects', provider: 'claude_code', projectsPath: '', sessionsPath: null, plansPath: null }
    } else if ([...dirs].some(n => YEAR_DIR.test(n))) {
      // ~/.codex/sessions — the recommended Codex mount (never ~/.codex itself: auth.json lives there)
      layout = { kind: 'codex_sessions', provider: 'codex', rolloutsPath: '', projectsPath: null, sessionsPath: null, plansPath: null }
    } else if (dirs.has('sessions') && (files.has('session_index.jsonl') || files.has('config.toml'))) {
      // ~/.codex mounted whole — works, but only sessions/ is ever read
      layout = { kind: 'codex_home', provider: 'codex', rolloutsPath: 'sessions', projectsPath: null, sessionsPath: null, plansPath: null }
    } else {
      throw new Error('This file store does not look like a Claude Code or Codex folder (expected ~/.claude, ~/.claude/projects or ~/.codex/sessions).')
    }
    return layout
  }
  const isCodex = () => !!(layout && layout.provider === 'codex')

  // ---- Codex: rollouts live under YYYY/MM/DD; the repo (cwd) is inside each file's first line ----
  const textCache = new Map()   // path -> { mtimeMs, text }  (a rollout read for its cwd is not read twice)
  const metaCache = new Map()   // path -> { mtimeMs, cwd, sessionId }
  async function readCached (path, mtimeMs) {
    const c = textCache.get(path)
    if (c && c.mtimeMs === mtimeMs) return c.text
    const text = await readText(path)
    if (textCache.size > 60) textCache.delete(textCache.keys().next().value)
    textCache.set(path, { mtimeMs, text })
    return text
  }
  async function listRolloutFiles ({ sinceMs = 0 } = {}) {
    const root = layout.rolloutsPath
    const out = []
    const years = (await list(root)).filter(e => e.type === 'dir' && YEAR_DIR.test(e.name)).sort((a, b) => b.name.localeCompare(a.name))
    for (const y of years) {
      const months = (await list(join(root, y.name))).filter(e => e.type === 'dir').sort((a, b) => b.name.localeCompare(a.name))
      for (const m of months) {
        const days = (await list(join(join(root, y.name), m.name))).filter(e => e.type === 'dir').sort((a, b) => b.name.localeCompare(a.name))
        for (const d of days) {
          // a whole day older than the window cannot hold a file touched inside it — skip the listing
          const dayMs = Date.parse(y.name + '-' + m.name + '-' + d.name + 'T23:59:59Z')
          if (sinceMs && Number.isFinite(dayMs) && dayMs + 2 * 86400000 < sinceMs) continue
          const dir = join(join(join(root, y.name), m.name), d.name)
          for (const e of await list(dir)) {
            if (e.type !== 'file' || !ROLLOUT_FILE.test(e.name)) continue
            if (sinceMs && (e.mtimeMs || 0) < sinceMs) continue
            const idm = e.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)
            out.push({ path: dir + '/' + e.name, size: e.size || 0, mtimeMs: e.mtimeMs || 0, sessionId: idm ? idm[1] : e.name.replace(/\.jsonl$/, '') })
          }
        }
      }
    }
    return out
  }
  // the cwd (→ repo slug) of a rollout, from its session_meta line — cached per path+mtime
  async function rolloutMeta (f) {
    const c = metaCache.get(f.path)
    if (c && c.mtimeMs === f.mtimeMs) return c
    const text = await readCached(f.path, f.mtimeMs)
    let cwd = null; let sessionId = f.sessionId
    const nl = text.indexOf('\n')
    try {
      const first = JSON.parse(nl > 0 ? text.slice(0, nl) : text)
      if (first && first.type === 'session_meta' && first.payload) { cwd = first.payload.cwd || null; sessionId = first.payload.id || sessionId }
    } catch (e) { /* torn first line — leave cwd null */ }
    const meta = { mtimeMs: f.mtimeMs, cwd, sessionId }
    metaCache.set(f.path, meta)
    return meta
  }
  const ensureLayout = async () => layout || detectLayout()

  // One folder per repo Claude was run in (folder name = the cwd, slugified). For Codex the repos are
  // the distinct cwds of the rollouts touched within `sinceMs` (default: the last 30 days).
  async function listRepos ({ sinceMs = null } = {}) {
    const L = await ensureLayout()
    if (isCodex()) {
      const since = sinceMs == null ? Date.now() - 30 * 86400000 : sinceMs
      const byRepo = new Map()
      for (const f of await listRolloutFiles({ sinceMs: since })) {
        const m = await rolloutMeta(f)
        if (!m.cwd) continue
        const slug = slugOfCwd(m.cwd)
        const r = byRepo.get(slug) || { slug, path: null, cwd: m.cwd, mtimeMs: 0, count: 0 }
        r.mtimeMs = Math.max(r.mtimeMs, f.mtimeMs); r.count++
        byRepo.set(slug, r)
      }
      return [...byRepo.values()].sort((a, b) => b.mtimeMs - a.mtimeMs)
    }
    const entries = await list(L.projectsPath)
    return entries.filter(e => e.type === 'dir' && e.name.startsWith('-'))
      .map(e => ({ slug: e.name, path: join(L.projectsPath, e.name), mtimeMs: e.mtimeMs || 0 }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  // Session transcript files, newest first. sinceMs filters on the file's mtime (last activity).
  async function listSessionFiles ({ repoSlugs = null, sinceMs = 0 } = {}) {
    await ensureLayout()
    if (isCodex()) {
      const out = []
      for (const f of await listRolloutFiles({ sinceMs: sinceMs || (Date.now() - 30 * 86400000) })) {
        const m = await rolloutMeta(f)
        const slug = m.cwd ? slugOfCwd(m.cwd) : 'unknown'
        if (repoSlugs && !repoSlugs.includes(slug)) continue
        out.push({ repoSlug: slug, sessionId: m.sessionId, path: f.path, size: f.size, mtimeMs: f.mtimeMs, cwd: m.cwd })
      }
      return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
    }
    const repos = await listRepos()
    const chosen = repoSlugs ? repos.filter(r => repoSlugs.includes(r.slug)) : repos
    const out = []
    for (const r of chosen) {
      const entries = await list(r.path)
      for (const e of entries) {
        if (e.type !== 'file' || !e.name.endsWith('.jsonl')) continue
        if (sinceMs && (e.mtimeMs || 0) < sinceMs) continue
        out.push({ repoSlug: r.slug, sessionId: e.name.replace(/\.jsonl$/, ''), path: r.path + '/' + e.name, size: e.size || 0, mtimeMs: e.mtimeMs || 0 })
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  }

  // Live-process registry: { pid, sessionId, cwd, startedAt, updatedAt, entrypoint } per file.
  async function readRegistry () {
    const L = await ensureLayout()
    if (!L.sessionsPath || isCodex()) return []
    let entries
    try { entries = await list(L.sessionsPath) } catch (e) { return [] }
    const out = []
    for (const e of entries) {
      if (e.type !== 'file' || !e.name.endsWith('.json')) continue   // never the .key files
      try {
        const rec = JSON.parse(await readText(L.sessionsPath + '/' + e.name))
        if (rec && rec.sessionId) out.push({ pid: rec.pid, sessionId: rec.sessionId, cwd: rec.cwd, startedAt: rec.startedAt, updatedAt: rec.updatedAt || e.mtimeMs, entrypoint: rec.entrypoint, name: rec.name })
      } catch (err) { /* torn or foreign file — skip */ }
    }
    return out
  }

  // Read + digest one session file. registeredIds: Set of sessionIds from readRegistry.
  async function loadSession (file, { registeredIds = null, tuning = DIGEST_TUNING, now = Date.now() } = {}) {
    const text = await readSessionText(file)
    const r = digestSession(text, file, { tuning, now, registered: !!(registeredIds && registeredIds.has(file.sessionId)) })
    return { file, ...r }
  }

  // read a session file's text — the cache serves it when the file was already read for its cwd
  const readSessionText = (f) => (f && typeof f === 'object') ? readCached(f.path, f.mtimeMs) : readText(f)

  return { connectionName, detectLayout, get layout () { return layout }, listRepos, listSessionFiles, readRegistry, readText, readSessionText, loadSession, slugOfCwd }
}
