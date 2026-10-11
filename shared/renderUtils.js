// renderUtils.js — SHARED rendering primitives for every page: element helpers, date formatters,
// the importance colour scale, the importance badge, the four entity chips (project / task /
// event / person), the initials avatar (PERSON identity) and the event kind disc (EVENT
// identity). One concern: the cross-page visual identity of the four entities — see the
// styleguide page. Text-only (textContent) — all content passed in is untrusted.

import { subTaskStats, renderDescriptionEl, toggleSubTask } from './subTasks.js'
import { effImportance } from '../jobs/analyze_thread/dueDates.js'
import { openComposer } from './replyComposer.js'
import { sanitize } from './mailHtml.js'

// ---- importance scale -----------------------------------------------------------------
// Salience rises with importance (1 recedes, 5 pops). MIRRORED in tokens.css (--imp-1..5):
// change BOTH together. Prefer the class helpers (CSS owns the colour); impColor() is for
// genuinely dynamic paints only (dots widget fill, rank buttons, avatar rings).
export const IMP_COLORS = { 1: '#9aa6b5', 2: '#6b7686', 3: '#2f6df0', 4: '#7a5cc0', 5: '#d9534f' }
const impN = (n) => Math.max(1, Math.min(5, Math.round(Number(n) || 3)))
export const impColor = (n) => IMP_COLORS[impN(n)]
export const impClassFg = (n) => 'imp-fg-' + impN(n) // colour + border-colour (entities.css)
export const impClassBl = (n) => 'imp-bl-' + impN(n) // border-left-colour (entities.css)

// ---- element helpers --------------------------------------------------------------------
export const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
export const div = (cls, text) => el('div', cls, text)
export const span = (cls, text) => el('span', cls, text)
export function btn (cls, text, onClick) {
  const b = el('button', cls, text)
  b.type = 'button'
  if (onClick) b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e) })
  return b
}

// ---- date formatting ----------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (x) => String(x).padStart(2, '0')

export const fmtDate = (ms) => {
  const n = Number(ms); if (!n) return '—'
  try { return new Date(n).toISOString().slice(0, 10) } catch (e) { return String(ms) }
}

// an ISO day ('2026-08-24') → '24 Aug', with the year appended only when it isn't this year
export const fmtShortDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))
  if (!m) return String(iso || '')
  const label = Number(m[3]) + ' ' + MONTHS[Number(m[2]) - 1]
  return Number(m[1]) === new Date().getFullYear() ? label : label + ' ' + m[1]
}

export const fmtDateTime = (ms) => {
  const n = Number(ms); if (!n) return '—'
  try {
    const d = new Date(n)
    return p2(d.getUTCDate()) + '-' + MONTHS[d.getUTCMonth()] + '-' + d.getUTCFullYear() + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes())
  } catch (e) { return String(ms) }
}

// friendly relative time ("just now", "12m ago", then dd-Mon hh:mm)
export function fmtAgo (ms) {
  const n = Number(ms); if (!n) return '—'
  const diff = Date.now() - n
  if (diff < 90e3) return 'just now'
  if (diff < 3600e3) return Math.round(diff / 60e3) + 'm ago'
  if (diff < 24 * 3600e3) return Math.round(diff / 3600e3) + 'h ago'
  const d = new Date(n)
  return p2(d.getDate()) + '-' + MONTHS[d.getMonth()] + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes())
}

// "Name <addr>, Name2" line from a [{ name, address }] list (or plain strings)
export function addrLine (list) {
  return (list || []).map(x => (x && (x.name || x.address)) || x).filter(Boolean).join(', ')
}

// ---- importance badge (the ONE badge — replaces epv-rowimp / rc-imp variants) -------------
export function impBadge (n) {
  const b = span('imp-badge ' + impClassFg(n), String(impN(n)))
  b.title = 'importance ' + impN(n) + '/5'
  return b
}

// the badge with ▾/▴ priority arrows — the standard right-side control on task rows everywhere
// (same classes as the project-card rows, so it looks identical). onDelta(+1|-1); omit for a
// read-only badge.
//
// The "set by you" dot rides on the badge's own top-right corner, ABSOLUTELY positioned so it
// occupies no layout space. It used to be a sibling span, which widened the control whenever a
// priority was user-set — so a column of task rows had its arrows stepping in and out of line
// depending on which ones the user had touched (user, 2026-08-21).
// Pass `todo` to make the badge due-hold aware: the NUMBER shown is the task's EFFECTIVE
// priority (dueDates.effImportance — what every sort and filter uses), a small ⏲ on the badge's
// top-right marks an active hold, and the "set by you" dot sits on the BOTTOM edge — right when
// the user raised it above the model's reading, left when they lowered it. All the explanatory
// notes live in the NUMBER's own tooltip: the corner marks are far too small to hover, and the
// old lock-dot title never fired at all (the dot is pointer-events:none). (user, 2026-08-27)
export function impCtl (value, onDelta, { locked = false, todo = null } = {}) {
  const wrap = span('epv-impctl')
  const mk = (glyph, delta, title) => { const b = btn('epv-imp-arrow', glyph, () => onDelta(delta)); b.title = title; return b }
  if (onDelta) wrap.appendChild(mk('▾', -1, 'Lower priority'))
  const actual = impN(value)
  const eff = todo ? Math.min(actual, effImportance(todo)) : actual
  const held = eff < actual
  const badge = impBadge(eff)
  // the badge is the positioning ANCHOR for its corner marks (.epv-imp-lock dot, .epv-imp-timer):
  // entities.css gives .imp-badge-locked position:relative. The project control always set it;
  // this task-row control appended the absolutely-positioned dot WITHOUT it, so the dot anchored
  // to some outer ancestor and landed off the badge (long-failing test, fixed 2026-09-11).
  if (locked || (todo && Math.min(actual, effImportance(todo)) < actual)) badge.classList.add('imp-badge-locked')
  const notes = ['priority ' + eff + '/5']
  if (held) {
    const back = (todo.due_earliest || todo.due_latest) || null
    notes.push('held down from ' + actual + ' until due' + (back ? ' (' + fmtShortDay(back) + ')' : ''))
    badge.appendChild(span('epv-imp-timer', '⏲'))
  }
  if (locked) {
    const machine = todo ? Number(todo.llm_importance) || null : null
    notes.push('set manually' + (machine && machine !== actual ? ' (SuperLazy read ' + machine + ')' : '') + ' — the model may not override it')
    const raised = !machine || actual >= machine // unknown machine reading defaults right
    badge.appendChild(span('epv-imp-lock ' + (raised ? 'imp-lock-br' : 'imp-lock-bl')))
  } else {
    notes.push('set automatically')
  }
  badge.title = notes.join(' · ')
  wrap.appendChild(badge)
  if (onDelta) wrap.appendChild(mk('▴', +1, 'Raise priority'))
  return wrap
}

// ---- PERSON: initials + avatar -------------------------------------------------------------
// Initials from a display name ("Bob Smith" → BS) or an email ("bob.smith@x.com" → BS).
export function initialsOf (nameOrEmail) {
  const s = String(nameOrEmail || '').trim()
  if (!s) return '?'
  const base = s.includes('@') ? s.split('@')[0].replace(/[._-]+/g, ' ') : s
  const words = base.split(/\s+/).filter(Boolean)
  if (!words.length) return s[0].toUpperCase()
  const first = words[0][0]
  const second = words.length > 1 ? words[words.length - 1][0] : (words[0][1] || '')
  return (first + second).toUpperCase()
}

// The person disc: NEUTRAL initials (people add no colour of their own); the thin circular
// border is tinted by importance rank when known — rings always mean importance.
// size: 'xs' (in rows/chips) | 'sm' (list rows) | 'lg' (detail header)
export function avatarEl (nameOrEmail, { rank = null, size = 'sm', title } = {}) {
  const a = span('avatar avatar-' + size, initialsOf(nameOrEmail))
  if (rank != null) { a.style.borderColor = impColor(rank); a.style.borderWidth = '2px' }
  a.title = title != null ? title : String(nameOrEmail || '')
  return a
}

// ---- EVENT: kind disc -----------------------------------------------------------------------
// The event identity mark: a small tinted circle whose colour+glyph encode the kind.
// kind: 'message' | 'auto' | 'manual' | 'cleanup' | 'error'  (use eventKindOf(ev) to normalize a record)
const EV_KINDS = {
  message: { glyph: '✉', label: 'email analysed' },
  auto: { glyph: '⚙', label: 'handled automatically' },
  manual: { glyph: '✍️', label: 'your action' }, // the writing hand — ✋ read as a stop sign (user, 2026-08-19)
  cleanup: { glyph: '🧹', label: 'clean-up change (accepted by you)' }, // the weekly clean-up's accepted proposals
  error: { glyph: '✗', label: 'failed' }
}
// Display title for a chat (Slack) item. New formations write good titles ("Slack DM: A, B" /
// "#channel"), but records captured before member-name resolution carry machine strings —
// Rewrites both to the one presentation the feed/viewer use; good titles pass through untouched.
export function chatTitle (title) {
  let t = String(title || '').trim()
  const thread = / › thread$/.test(t)
  if (thread) t = t.replace(/ › thread$/, '')
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s
  const m = t.match(/^Group DM: mpdm-(.+?)-\d+$/) || t.match(/^mpdm-(.+?)-\d+$/)
  if (m) t = 'Slack DM: ' + m[1].split('--').map(cap).join(', ')
  else if (/^Group DM: /.test(t)) t = 'Slack DM: ' + t.slice('Group DM: '.length)
  else if (/^DM with /i.test(t)) t = 'Slack DM: ' + cap(t.slice('DM with '.length))
  else if (/^dm:/i.test(t)) t = 'Slack DM: ' + t.slice(3)
  return t + (thread ? ' › thread' : '')
}

export function kindDisc (kind) {
  const k = EV_KINDS[kind] ? kind : 'message'
  const d = span('ev-disc ev-disc-' + k, EV_KINDS[k].glyph)
  d.title = EV_KINDS[k].label
  return d
}
export function eventKindOf (ev) {
  if (!ev) return 'message'
  if (ev.error) return 'error'
  if (ev.kind === 'manual_edit') return 'manual'
  if (ev.kind === 'message' || !ev.kind) return 'message'
  return 'auto' // workflow_short_circuit | mail_action | skipped
}

// ---- TASK direction marks -------------------------------------------------------------------
// Direction uses a list mark for my to-dos and emoji for the other buckets.
// The circular ring still carries importance; the larger disc emphasizes my list.
// Text-only contexts (such as native select options) use a plain list fallback.
export const DIR_GLYPHS = { i_owe_them: '≋', they_owe_me: '📥', team_owes: '👥', read_only: '📖' }

// Reusable CSS icon. Omit label beside visible text; supply it for standalone use.
// Size with font-size; colour with currentColor. No checkbox semantics or interaction.
export function myTodosIcon (label = '') {
  const icon = span('my-todos-icon')
  if (label) {
    icon.setAttribute('role', 'img')
    icon.setAttribute('aria-label', label)
  } else icon.setAttribute('aria-hidden', 'true')
  for (let i = 0; i < 3; i++) icon.appendChild(span('my-todos-icon-row'))
  return icon
}
export const DIR_LABEL = { i_owe_them: 'I owe', they_owe_me: 'Owed me', team_owes: 'Team', read_only: 'Read' }
export function dirDisc (direction, imp) {
  const d = span('dir-disc' + (direction === 'i_owe_them' ? ' dir-disc-major' : '') +
    (imp != null ? ' ' + impClassFg(imp) : ''), direction === 'i_owe_them' ? null : DIR_GLYPHS[direction] || '•')
  if (direction === 'i_owe_them') d.appendChild(myTodosIcon())
  d.title = (DIR_LABEL[direction] || direction) + (imp != null ? ' · top priority ' + impN(imp) + '/5' : '')
  d.setAttribute('role', 'img')
  d.setAttribute('aria-label', d.title)
  return d
}

// the DONE mark: a GREEN check in a white box with a green border — the resolved counterpart
// of the open ☑️ (white box, dark check). Use wherever a resolved item is indicated.
export function doneMark (title) {
  const m = span('done-mark', '✓')
  m.title = title || 'resolved'
  return m
}

// ---- the entity chips (cross-link connective tissue) ----------------------------------------
// Every reference from one entity to another renders as one of these four chips, identically on
// every page. Clickable when onClick is given (a <button>), otherwise a passive <span>.
function chipEl (variant, onClick) {
  return onClick ? btn('chip ' + variant, null, onClick) : span('chip ' + variant)
}

// project reference — squared slate chip carrying the logo's inverted pentagon (CSS clip-path).
// Clickable chips get the HOLLOW pentagon: no fill = a button that opens the project.
export function projectChip (name, onClick, { title } = {}) {
  const c = chipEl('chip-project', onClick)
  const mark = span('proj-mark' + (onClick ? ' proj-mark-hollow' : ''))
  if (onClick) mark.appendChild(span('proj-mark-core'))
  c.appendChild(mark)
  c.appendChild(span('chip-txt', name || '(untitled project)'))
  c.title = title || ('Project: ' + (name || '(untitled)') + (onClick ? ' — open' : ''))
  return c
}

// ✉ source email / event reference — round, kind-tinted. label optional (compact ✉-only chip).
export function eventChip (label, onClick, { kind = 'message', title } = {}) {
  const c = chipEl('chip-event chip-event-' + (EV_KINDS[kind] ? kind : 'message'), onClick)
  c.appendChild(span('chip-glyph', EV_KINDS[kind] ? EV_KINDS[kind].glyph : '✉'))
  if (label) c.appendChild(span('chip-txt', label))
  c.title = title || 'Open the email behind this'
  return c
}

// person reference — round pill with a mini initials disc
// ---- REPOS: the PLACE agent work happened -------------------------------------------------------
// A repo is a place, never a project (specs/superlazy-sessions.md decision 1), so it shows as a
// quiet chip wherever agent work appears. Three sources, all already in the data:
//   · a project carries 'repo:<slug>' tags in `sources` (persist.addRepoSources)
//   · a work event/input carries repo_name directly (persisted since 2026-09-10)
//   · anything older still has the slug inside its thread id, 'cc:<repoSlug>:<sessionId>'
// so nothing needs backfilling for a repo to be shown.
const CC_THREAD_RE = /^cc:(.+):[^:]+$/
// the slug is a slugified cwd; its LAST segment is the repo folder — the tooltip keeps the whole thing
export const repoNameFromSlug = (slug) => String(slug || '').split('-').filter(Boolean).pop() || String(slug || '')
export const repoSlugFromThreadId = (threadId) => {
  const m = CC_THREAD_RE.exec(String(threadId || ''))
  return m && m[1] ? m[1] : null
}
// every repo feeding a project, newest tag order, as { slug, name }
export function reposOfProject (p) {
  return (Array.isArray(p && p.sources) ? p.sources : [])
    .filter(t => String(t || '').startsWith('repo:'))
    .map(t => String(t).slice(5))
    .map(slug => ({ slug, name: repoNameFromSlug(slug) }))
}
// the repo of one work event / input / body view — stored field first, thread id as the fallback
export function repoOfWorkItem (ev) {
  if (!ev) return null
  const slug = ev.repo_slug || repoSlugFromThreadId(ev.thread_id)
  const name = ev.repo_name || (slug ? repoNameFromSlug(slug) : null)
  return name ? { slug: slug || name, name, branch: ev.branch || null } : null
}
// The repo(s) behind ONE task: its own agent evidence first (most precise — this is where the
// work actually happened), falling back to the project's repo tags.
export function reposOfTask (todo, project) {
  const seen = new Map()
  for (const e of (Array.isArray(todo && todo.evidence) ? todo.evidence : [])) {
    const slug = repoSlugFromThreadId(e && e.thread_id)
    if (slug && !seen.has(slug)) seen.set(slug, { slug, name: repoNameFromSlug(slug) })
  }
  if (seen.size) return [...seen.values()]
  return reposOfProject(project)
}

// The project pillbox with its repo(s) UNDERNEATH — one unit, so a task or event row says both
// which effort and which place without widening the row (user, 2026-09-10: "next to the project
// name pillbox, potentially right below it to take advantage of the space").
export function projectWithRepo (name, onClick, repos, { title } = {}) {
  const chip = projectChip(name, onClick, { title })
  const list = (repos || []).filter(Boolean)
  if (!list.length) return chip
  const box = document.createElement('span')
  box.className = 'projbox'
  box.appendChild(chip)
  const rw = document.createElement('span'); rw.className = 'projbox-repos'
  for (const r of list.slice(0, 2)) rw.appendChild(repoChip(r))
  if (list.length > 2) {
    const more = document.createElement('span'); more.className = 'projbox-more'
    more.textContent = '+' + (list.length - 2)
    more.title = list.slice(2).map(r => r.slug).join('\n')
    rw.appendChild(more)
  }
  box.appendChild(rw)
  return box
}

// Which captured document (agent_work.plans) does a changed-file NAME refer to? The Files row lists
// basenames; a plan doc carries its full path. Exact basename match first, else null.
export function docIndexForFile (plans, fileName) {
  const want = String(fileName || '').split('/').pop()
  if (!want) return -1
  return (Array.isArray(plans) ? plans : []).findIndex(p => p && p.path && String(p.path).split('/').pop() === want)
}

// ---- SEARCH: "repo:name" searches REPOS ONLY -------------------------------------------------------
// A query beginning with "repo:" is a repo filter and nothing else (user, 2026-09-11): "repo:freezr"
// shows what lives in a repo whose NAME starts with "freezr" (freezrPrivate), and does NOT match
// notes or projects that merely mention freezr. Prefix match on the repo's display name,
// case-insensitive. A bare "repo:" means "anything that has a repo". Everything else is the
// ordinary text search. ('#' was the first operator and was dropped the same day: it collides with
// words that legitimately start with '#', such as Slack channel names.)
export const REPO_QUERY_PREFIX = 'repo:'
export function parseSearch (q) {
  const raw = String(q || '').trim()
  if (raw.toLowerCase().startsWith(REPO_QUERY_PREFIX)) return { repo: raw.slice(REPO_QUERY_PREFIX.length).trim().toLowerCase(), needle: '' }
  return { repo: null, needle: raw.toLowerCase() }
}
// repos: [{ slug, name }] (reposOfProject / reposOfTask / repoOfWorkItem-as-list)
export function repoQueryMatches (repos, repoPrefix) {
  const list = Array.isArray(repos) ? repos : []
  if (repoPrefix === '') return list.length > 0
  const p = String(repoPrefix || '').toLowerCase()
  return list.some(r => r && (String(r.name || '').toLowerCase().startsWith(p) || String(r.slug || '').toLowerCase().split('-').filter(Boolean).pop() === p))
}

// ---- the REPO filter (the filter bar's "#" button) ------------------------------------------
// One value covers the whole cut: 'all' (no restriction), 'only' (anything that touches SOME
// repo), 'none' (anything that touches none) or a specific repo slug. The button only appears
// when the data actually has repos, so a mail-only user never meets it (filterBar.js).
export const REPO_FILTER_ALL = 'all'
export function repoFilterMatches (repos, value) {
  if (!value || value === REPO_FILTER_ALL) return true
  const list = (Array.isArray(repos) ? repos : []).filter(Boolean)
  if (value === 'only') return list.length > 0
  if (value === 'none') return list.length === 0
  return list.some(r => r && r.slug === value)
}
// every repo the projects touch, de-duplicated by slug and named alphabetically — what the
// chooser lists (a repo reaches a project through persist.addRepoSources' 'repo:<slug>' tags)
export function allReposOfProjects (projects) {
  const seen = new Map()
  for (const p of (projects || [])) {
    for (const r of reposOfProject(p)) if (r && r.slug && !seen.has(r.slug)) seen.set(r.slug, r)
  }
  return [...seen.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)))
}

// ---- EDITOR LINKS: open a changed file in the user's editor --------------------------------------
// A URL-scheme template with {path}; default VS Code. User-defined in Preferences (Cursor, Zed,
// Sublime, JetBrains…). Only meaningful when the server runs on the same machine as the files.
export const EDITOR_URL_DEFAULT = 'vscode://file/{path}'
export const EDITOR_PRESETS = [
  ['VS Code', 'vscode://file/{path}'], ['Cursor', 'cursor://file/{path}'], ['Zed', 'zed://file/{path}'],
  ['Sublime', 'subl://open?url=file://{path}'], ['JetBrains', 'idea://open?file={path}']
]
export function editorUrlFor (template, absPath) {
  const t = String(template || EDITOR_URL_DEFAULT)
  const p = String(absPath || '')
  if (!p.startsWith('/') || !t.includes('{path}')) return null
  // encode each segment (spaces → %20) but keep the slashes — schemes take a path, not a query
  let enc = p.split('/').map(seg => encodeURIComponent(seg)).join('/')
  // canonical forms differ by scheme: vscode://file/Users/x (the editor schemes elide the path's
  // leading slash after "file/"), but subl's file:///Users/x and idea's ?file=/Users/x keep it
  if (/file\/\{path\}/.test(t) && !/file:\/\/\{path\}/.test(t)) enc = enc.replace(/^\/+/, '')
  return t.replace('{path}', enc)
}
// the server is on THIS machine — the only case in which a local path means anything to the browser
export function serverIsLocal () {
  try {
    const addr = (typeof freezrMeta !== 'undefined' && freezrMeta && freezrMeta.serverAddress) ? String(freezrMeta.serverAddress) : (typeof location !== 'undefined' ? location.host : '')
    return /(^|\/\/)(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(addr)
  } catch (e) { return false }
}

// A path as the agent recorded it, made absolute. Claude Code's Write/Edit paths are already
// absolute; Codex's apply_patch paths are relative to the session's cwd.
export function absPathFor (p, cwd) {
  const path = String(p || '')
  if (!path) return null
  if (path.startsWith('/')) return path
  const base = String(cwd || '').replace(/\/+$/, '')
  return base.startsWith('/') ? base + '/' + path.replace(/^\.\//, '') : null
}
export function repoChip ({ slug, name, branch } = {}) {
  const c = document.createElement('span')
  c.className = 'chip chip-repo'
  c.title = 'repo: ' + (slug || name) + (branch ? ' (branch ' + branch + ')' : '')
  const g = document.createElement('span'); g.className = 'chip-glyph'; g.textContent = '#'
  const t = document.createElement('span'); t.className = 'chip-txt'; t.textContent = name || slug
  c.appendChild(g); c.appendChild(t)
  return c
}

export function personChip (nameOrEmail, onClick, { prefix, title } = {}) {
  const c = chipEl('chip-person', onClick)
  c.appendChild(avatarEl(nameOrEmail, { size: 'xs', title: '' }))
  c.appendChild(span('chip-txt', (prefix ? prefix + ' ' : '') + String(nameOrEmail || '?')))
  c.title = title || String(nameOrEmail || '')
  return c
}

// ☑ task REFERENCE (narratives, event change lines) — visibly not an actionable task row
export function taskChip (short, imp, onClick, { title } = {}) {
  const c = chipEl('chip-task ' + impClassBl(imp), onClick)
  c.appendChild(span('chip-glyph', '☑'))
  c.appendChild(span('chip-txt', short || '(untitled to-do)'))
  c.title = title || (short || '')
  return c
}

// ---- a suggested-reply DRAFT block: kind + recipient + full body + Send/Edit/Dismiss --------
// Shared by the events feed, the email viewer and the project cards. evLike carries the mail
// context the send needs: { account_id, thread_id, msg_id, subject, from_address }. ctx = { nameOf }.
// drafts (host handlers) = { sendState(evLike) → { ok } | { ok:false, reason },
// onSend(evLike, ent, payload?), onEdit(evLike, ent) — PERSIST the draft after an edit,
// onDismiss(ent) }; ent = { response, project }.
// "Edit" swaps the block for THE reply composer (replyComposer.js) — the same card a reply written
// from the email viewer uses: To / Cc / Subject, a formatting bar, and the thread quoted under the
// text (user, 2026-09-27: suggested replies must show the history when edited). Edits save as you
// type (body + body_html + recipients); Send sends exactly what the composer shows.
const DRAFT_LABEL = { answer: '↩ Suggested reply', delegate: '➜ Delegation draft' }
const reSubject = (s) => (/^\s*re\s*:/i.test(String(s || '')) ? String(s) : 'Re: ' + String(s || ''))
export function renderDraft (evLike, ent, ctx, drafts, { compact = false, onFullView = null } = {}) {
  const r = ent.response
  const wrap = div('ev-draft' + (compact ? ' ev-draft-compact' : ''))
  const nice = (a) => (ctx && ctx.nameOf && ctx.nameOf(a)) || a
  const toListOf = () => ((r.to && r.to.length) ? r.to : [evLike.from_address]).filter(Boolean)
  const st = (drafts.sendState && drafts.sendState(evLike)) || { ok: false, reason: 'sending not available here' }

  function readView () {
    wrap.textContent = ''
    wrap.classList.remove('ev-draft-editing')
    const head = div('ev-draft-head')
    const lbl = span('ev-draft-kind', DRAFT_LABEL[r.kind] || DRAFT_LABEL.answer)
    lbl.title = r.kind === 'delegate'
      ? 'A draft email handing this to-do to someone else to handle'
      : 'A reply the model drafted for you'
    head.appendChild(lbl)
    const toList = toListOf()
    const to = span('ev-draft-to', 'to ' + toList.map(nice).join(', ') + ((r.cc && r.cc.length) ? '  ·  cc ' + r.cc.map(nice).join(', ') : ''))
    to.title = toList.join(', ')
    head.appendChild(to)
    if (r.status === 'edited') head.appendChild(span('ev-draft-flag', 'edited'))
    wrap.appendChild(head)

    // the user's formatted edit when there is one (allowlisted by the editor, sanitised again
    // here), else the model's plain text
    const bodyView = div('ev-draft-body')
    if (r.body_html) { bodyView.classList.add('ev-draft-body-html'); bodyView.innerHTML = sanitize(r.body_html) } else bodyView.textContent = r.body || '(empty draft)'
    wrap.appendChild(bodyView)

    const actions = div('ev-draft-actions')
    const send = btn('ev-draft-send', 'Send ↗')
    if (st.ok && drafts.onSend) {
      send.title = 'Send this reply now, with the thread quoted under it'
      send.addEventListener('click', async () => {
        send.disabled = true; send.textContent = 'Sending…'
        try { await drafts.onSend(evLike, ent) } catch (e) {
          send.disabled = false; send.textContent = 'Send ↗'
          send.title = 'Send failed: ' + ((e && e.message) || e)
        }
      })
    } else {
      send.disabled = true
      send.title = st.reason || 'sending not available here'
    }
    actions.appendChild(send)
    if (!st.ok && st.reauth) {
      // a fixable account problem (expired session / read-only connection): say it, link the fix
      const note = span('ev-draft-off', st.reason.replace(/ at \/account\/resources.*$/, ''))
      const a = el('a', 'ev-draft-fix', 'Fix ↗'); a.href = st.reauth; a.target = '_blank'; a.rel = 'noopener'
      note.appendChild(document.createTextNode(' ')); note.appendChild(a)
      wrap.appendChild(note)
    }
    const eb = btn('ev-draft-btn', 'Edit', editView)
    eb.title = 'Edit it — recipients, formatting, with the thread shown below'
    actions.appendChild(eb)
    if (drafts.onDismiss) {
      const b = btn('ev-draft-btn', 'Dismiss', () => drafts.onDismiss(ent))
      b.title = 'Not relevant — remove this draft'
      actions.appendChild(b)
    }
    if (onFullView) {
      const b = btn('ev-draft-btn ev-draft-full', 'Open thread ↗', onFullView)
      b.title = 'Open the email and its whole thread'
      actions.appendChild(b)
    }
    wrap.appendChild(actions)
  }

  function editView () {
    wrap.textContent = ''
    wrap.classList.add('ev-draft-editing')
    const save = (p) => {
      const changed = p.userText !== (r.body || '') || p.userHtml !== (r.body_html || '') ||
        p.to.join(',') !== toListOf().join(',') || p.cc.join(',') !== (r.cc || []).join(',') || (p.subject || '') !== (r.subject || '')
      if (!changed) return
      r.body = p.userText
      r.body_html = p.userHtml
      r.to = p.to
      r.cc = p.cc
      r.subject = p.subject || r.subject || null
      r.status = 'edited'
      if (drafts.onEdit) drafts.onEdit(evLike, ent)
    }
    const comp = openComposer({
      mode: 'draft',
      fromLabel: (drafts.accountLabel && evLike.account_id) ? drafts.accountLabel(evLike.account_id) : '',
      title: DRAFT_LABEL[r.kind] || DRAFT_LABEL.answer,
      to: toListOf(),
      cc: r.cc || [],
      subject: r.subject || reSubject(evLike.subject),
      bodyHtml: r.body_html || '',
      bodyText: r.body || '',
      quoteFrom: evLike.thread_id ? { thread_id: evLike.thread_id, msg_id: evLike.msg_id || null, account_id: evLike.account_id } : null,
      sendState: st,
      compact,
      onChange: save,
      onSend: async (p) => { save(p); await drafts.onSend(evLike, ent, p) },
      extraActions: drafts.onDismiss ? [{ label: 'Dismiss', title: 'Not relevant — remove this draft', fn: () => drafts.onDismiss(ent) }] : [],
      cancelLabel: 'Done',
      onCancel: () => readView()
    })
    wrap.appendChild(comp.el)
    comp.focus()
    comp.el.scrollIntoView({ block: 'nearest' }) // a tall card: bring the whole composer into view
  }

  readView()
  return wrap
}

// ---- TASK: the row -----------------------------------------------------------------------
// THE task row — EXACTLY the project-card row, everywhere (project card, person view, recent
// list). Same classes (epv-row family), so the hover-reveal / styling are identical. Outside a
// project view, pass opts.projectName (+ onOpenProject) and the project pill renders right
// after the task text; the project card simply doesn't pass it.
// Anatomy: [direction mark] · checkbox · name (opens the task modal) + history strip · [project pill] · due · priority ▾▴ · ✕
// The leading who-initials disc and ✉ chip are GONE (user, 2026-08-17): the history strip below
// the name opens the email + its whole thread, which is where every person involved is listed.
// The △ edit button and the far-right "modified" date went the same way (user, 2026-08-21) — the
// NAME opens the editor, and every date the row needs is already in the strip. Priority sits at
// the far right with only the ✕ beyond it, so it forms a straight right-hand column.
// handlers (same shape as the project card's): { onResolve(todo, project),
//   onCancel(todo, project), onImportance(todo, delta, project), openEmailModal(todo, project),
//   onEdit(todo, project) — the △ task editor, nameOf }
// opts: { now, projectName, onOpenProject(project),
//         showDirection — lead the row with the ☑️/📥/👥/📖 direction mark. OFF by default: in a
//           direction-scoped list (the I owe / Owed / Team / Read tabs) the tab already says it
//           and a per-row glyph is just noise. Pass it wherever the list MIXES directions —
//           an "All to-dos" archive, or the tasks behind one email (user, 2026-08-21).

//         showOnly: ['check','email','project','due','edit','imp','cancel'] — when given,
//         ONLY the listed fields render (the text column always shows); hosts like the email
//         viewer use it to drop fields their context already carries (the email, the project).
//         'email' now gates only the meta line's link to the source email. }
const dayKeyOf = (ms) => { const n = Number(ms); if (!n) return ''; try { return new Date(n).toISOString().slice(0, 10) } catch (e) { return '' } }
// ---- evidence: the task's own history ------------------------------------------------------
// Every writer (the analyzer and every manual edit) appends to todo.evidence, so the trail below
// is the task's whole story and needs NO query — it travels on the project record. These helpers
// are the single reading of an entry, shared by the task row's two-item summary and the task
// modal's full HISTORY section, so both say the same thing about the same entry.

// Ordered oldest-first, junk dropped. Entries predating a field are tolerated (no `changed`, no
// `who`, no `type`) — the summary degrades to "created" / "updated" rather than throwing.
export function evidenceTrailOf (todo) {
  return ((todo && todo.evidence) || [])
    .filter(e => e && (Number(e.asof) || e.msg_id))
    .slice()
    .sort((a, b) => (Number(a.asof) || 0) - (Number(b.asof) || 0))
}

export const isManualEvidence = (e) => !!e && (e.source === 'manual' || e.type === 'manual')

// One evidence entry read as { verb, actor, when, msg }. `first` marks the oldest entry — its
// email is what CREATED the task, whatever prose reason the model attached to it.
export function evidenceSummary (e, { first = false, nameOf = null, self = [], todo = null } = {}) {
  const manual = isManualEvidence(e)
  const changed = Array.isArray(e.changed) ? e.changed : []
  const statusTo = (changed.find(c => c.field === 'status') || {}).to
  // a chat (Slack) evidence entry: typed since Phase B; legacy entries betray it by thread id
  const chat = !manual && (e.type === 'messages' || String(e.thread_id || '').startsWith('slack:'))
  // an agent-session (Claude Code) evidence entry: the actor is the user, the session is the venue
  const agent = !manual && (e.type === 'work' || String(e.thread_id || '').startsWith('cc:'))

  let verb
  if (manual && (e.action === 'project_merge' || /^merged from /i.test(e.reason || ''))) verb = 'merged'
  else if (statusTo === 'resolved') verb = 'resolved'
  else if (statusTo === 'cancelled') verb = 'cancelled'
  else if (statusTo === 'open') verb = 'reopened'
  else if (first) verb = manual ? 'added by you' : 'created'
  else if (manual) verb = 'set manually'
  else if (changed.length) verb = 'changed'
  else verb = 'updated'

  const selfSet = new Set((self || []).map(a => String(a).toLowerCase()))
  const raw = e.who || null
  const isSelf = !raw || raw === 'you' || selfSet.has(String(raw).toLowerCase())
  let actor = manual ? null : (isSelf ? 'you' : ((nameOf && nameOf(raw)) || raw))
  // A chunk's `who` is its FIRST author — very often the user, which read as "created by you"
  // for a task someone ELSE took on in the DM (user, 2026-08-30). Prefer the one person the
  // task actually concerns (its owner / counterparty); the conversation itself rides on `via`.
  if (chat && isSelf && todo) {
    const better = [todo.owner, todo.counterparty]
      .find(a => a && !selfSet.has(String(a).toLowerCase()))
    actor = better ? ((nameOf && nameOf(better)) || better) : null
  }

  return {
    verb,
    // null for manual edits — "set manually" already says who
    actor,
    when: Number(e.asof) || 0,
    manual,
    chat,
    agent,
    // the conversation behind a chat entry — "Slack DM: A, B" (legacy entries have no via);
    // the session behind an agent entry
    via: chat ? chatTitle(e.via || '') || 'Slack' : (agent ? 'AI agent' : null),
    changed,
    // the model's prose reason / the coalesced manual reason — the tooltip's detail
    detail: e.reason || null,
    // the model's one-sentence read of the message
    summary: e.summary || null,
    msg: e.msg_id ? { msg_id: e.msg_id, thread_id: e.thread_id || null } : null
  }
}

// The compact label a history line shows: "created 12-Aug 09:14 — Bob Smith". A chat entry
// names the conversation when no single person could be attributed: "created 2h — Slack DM: A, B".
export function evidenceLabel (sum) {
  const who = sum.actor
    ? sum.actor + (sum.chat ? ' · Slack' : (sum.agent ? ' · AI agent' : ''))
    : ((sum.chat || sum.agent) ? sum.via : null)
  return sum.verb + ' ' + fmtAgo(sum.when) + (who ? ' — ' + who : '')
}

// The task row's history strip: the FIRST and LAST evidence entries, with a "…" between them
// when there are more (the middle of the story lives in the task modal). Entries backed by an
// email open that exact message in the thread viewer; manual ones are plain text.
// opts: { nameOf, self, onOpenMessage(msg), onOpenHistory(), title }
function evidenceStrip (todo, { nameOf, self, onOpenMessage, onOpenHistory, title } = {}) {
  const trail = evidenceTrailOf(todo)
  if (!trail.length) return null
  const wrap = span('task-meta task-hist')
  if (title) wrap.title = title

  const item = (e, first) => {
    const sum = evidenceSummary(e, { first, nameOf, self, todo })
    const openable = !!(sum.msg && onOpenMessage)
    const node = openable
      ? btn('task-hist-item clickable', evidenceLabel(sum), () => onOpenMessage(sum.msg))
      : span('task-hist-item' + (sum.manual ? ' manual' : ''), evidenceLabel(sum))
    node.title = [sum.chat && sum.via, sum.detail, fmtDateTime(sum.when),
      openable ? (sum.chat ? 'open the conversation behind this' : 'open the email behind this') : null]
      .filter(Boolean).join(' · ')
    return node
  }

  // reads as one left-aligned sentence: "created …, + 2 more, resolved …"
  wrap.appendChild(item(trail[0], true))
  if (trail.length > 2) {
    wrap.appendChild(span('task-hist-sep', ', '))
    const gapText = '+ ' + (trail.length - 2) + ' more'
    const gap = onOpenHistory
      ? btn('task-hist-gap clickable', gapText, () => onOpenHistory())
      : span('task-hist-gap', gapText)
    gap.title = (trail.length - 2) + ' further change(s) — open the to-do to see the full history'
    wrap.appendChild(gap)
  }
  if (trail.length > 1) {
    wrap.appendChild(span('task-hist-sep', ', '))
    wrap.appendChild(item(trail[trail.length - 1], false))
  }
  return wrap
}

export function taskRowEl (todo, project, handlers = {}, { now = 0, projectName = null, onOpenProject = null, showOnly = null, showDirection = false } = {}) {
  const want = (k) => !showOnly || showOnly.includes(k)
  const open = todo.status === 'open' || todo.status === 'in_progress'
  const today = now && (dayKeyOf(todo.created_asof) === dayKeyOf(now) || dayKeyOf(todo.resolved_asof) === dayKeyOf(now))
  const row = div('epv-row task-row' + (open ? '' : ' epv-row-done done') + (today ? ' epv-row-today' : ''))

  // A state change that REMOVES this row from the list (resolve / reopen / cancel) wipes it shut
  // BEFORE committing: the commit repaints the list, and an instant repaint slid the next task
  // under the cursor so a quick second click hit the wrong row (user, 2026-08-27). The
  // .task-row-wiping class (entities.css) kills pointer-events, so mid-wipe clicks land on
  // nothing rather than on a moving target.
  // PRIORITY changes are deliberately NOT wiped: the row now KEEPS ITS PLACE when you re-price it
  // (taskSort.js holds the order), so the slide-out-and-back was pure noise on a row that never
  // went anywhere (user, 2026-09-01). The wipe is for rows that actually disappear.
  const wipeThen = (fn) => (...args) => {
    row.style.height = row.offsetHeight + 'px'
    void row.offsetHeight // commit the start height so the transition has a from-value
    row.classList.add('task-row-wiping')
    row.style.height = '0px'
    setTimeout(() => fn(...args), 240)
  }

  // direction mark FIRST — left of the checkbox, so a mixed list reads "what kind of thing, then
  // is it done" (user, 2026-08-21). Only where the surrounding list doesn't imply it.
  if (showDirection && todo.direction) row.appendChild(dirDisc(todo.direction))

  // leading state control: checkbox (open / resolved-green) — but a CANCELLED task shows a red ✕
  // mark instead of the green check (clicking it reopens, like unticking)
  if (!want('check')) {
    // no state control — nothing to render in the slot
  } else if (todo.status === 'cancelled') {
    const cm = handlers.onResolve ? btn('cancel-mark', '✕', wipeThen(() => handlers.onResolve(todo, project))) : span('cancel-mark', '✕')
    cm.title = 'Cancelled' + (handlers.onResolve ? ' — click to reopen' : '')
    row.appendChild(cm)
  } else {
    const cb = el('input', 'epv-check')
    cb.type = 'checkbox'
    cb.checked = !open
    cb.title = open ? 'Mark done' : 'Reopen'
    if (handlers.onResolve) cb.addEventListener('click', (e) => { e.stopPropagation(); wipeThen(() => handlers.onResolve(todo, project))() })
    else cb.disabled = true
    row.appendChild(cb)
  }

  const nice = (a) => (handlers.nameOf && handlers.nameOf(a)) || a
  const selfSet = new Set((handlers.self || []).map(a => String(a).toLowerCase()))
  const isSelf = (a) => { const s = String(a || '').toLowerCase(); return !s || s === 'you' || selfSet.has(s) }

  // the text + its meta line ("from Bob · 2h ago") stacked, left-aligned with each other
  const mid = div('task-mid')
  const label = todo.short_description || todo.description || '(untitled)'

  // Does this task have anything to REVEAL in place? (computed up here because the title's click
  // behaviour depends on it.) The description panel is built lazily further down.
  const subCount = subTaskStats(todo.description).total
  const hasDesc = !!(todo.description && String(todo.description).trim() &&
    todo.description !== todo.short_description)
  const canReveal = hasDesc || !!subCount

  // THE TITLE IS A DISCLOSURE, NOT AN EDITOR (user, 2026-09-12). Clicking the name opens the
  // description panel under it — the same panel a hover opens, and on a touch screen the only way
  // to reach it at all. The ✏️ beside it is what opens the task modal. A task with NOTHING to
  // reveal keeps the old behaviour (the click opens the modal) rather than being a dead tap.
  const openEditor = (want('edit') && handlers.onEdit) ? () => handlers.onEdit(todo, project) : null
  let onTitleActivate = openEditor // swapped for the disclosure toggle once the panel exists
  const titleActs = !!(openEditor || canReveal)
  const short = titleActs
    ? btn('epv-short clickable ' + impClassBl(effImportance(todo)), label, () => { if (onTitleActivate) onTitleActivate() })
    : span('epv-short ' + impClassBl(effImportance(todo)), label)
  if (titleActs) short.title = canReveal ? 'show what this to-do says' : 'open this to-do'
  // the caret is INSIDE the title button, so it is part of the same tap target. It is also the
  // only standing sign that a row HAS more to say — on touch there is no hover to discover it.
  if (canReveal) {
    short.appendChild(span('task-disc', '⌄'))
    short.setAttribute('aria-expanded', 'false')
  }

  // the ✏️ right after the name opens the task modal — an explicit, universally-readable edit
  // affordance (user, 2026-08-25: the △ read as nerd notation)
  // …and beside it, the conversation: ✉️ (💬 for a chat, 📝 note, 🤖 agent session) opens the
  // email viewer on the LATEST message of the thread the task came from — the same place the
  // history strip's links go, one tap and always the newest (user, 2026-09-27)
  const latestMsg = (todo.evidence || []).filter(e => e.msg_id)
    .reduce((best, e) => (!best || (Number(e.asof) || 0) >= (Number(best.asof) || 0)) ? e : best, null)
  const openThread = (latestMsg && want('email') && handlers.openEmailModal) ? () => handlers.openEmailModal(todo, project) : null
  let nameLine = short
  if (openEditor || openThread) {
    nameLine = div('task-shortline')
    nameLine.appendChild(short)
    if (openEditor) {
      const eb = btn('task-editbtn', '✏️', openEditor)
      eb.title = 'Edit this to-do'
      nameLine.appendChild(eb)
    }
    if (openThread) {
      const ch = latestMsg.type || (String(latestMsg.thread_id || '').startsWith('slack:') ? 'messages' : 'mail')
      const glyph = ch === 'messages' ? '💬' : ch === 'notes' ? '📝' : ch === 'work' ? '🤖' : '✉️'
      const mb = btn('task-editbtn task-threadbtn', glyph, openThread)
      mb.title = ch === 'mail' ? 'Open the email thread — latest message' : 'Open the conversation — latest message'
      mb.setAttribute('aria-label', mb.title)
      nameLine.appendChild(mb)
    }
    mid.appendChild(nameLine)
  } else {
    mid.appendChild(short)
  }

  // ---- description + sub-tasks: the old title-tooltip is gone — hovering the task NAME (not
  // the whole row: that opened on every pass of the cursor — user, 2026-08-25) SLIDES the
  // description open under it, after a 1s intent delay (450ms read as accidental — user,
  // 2026-08-27). Once open, the panel keeps itself
  // open while hovered (so the checkboxes are reachable) and closes on a short grace timer that
  // survives the hop across the meta strip. Checklist lines ("- [ ]") tick live through
  // handlers.onDescChange — the ticked row restyles ITSELF in place, nothing here repaints.
  let descPanel = null
  let hoverTimer = null
  const canTick = !!handlers.onDescChange
  let descWanted = false
  let pinned = false // opened by a CLICK — a hover leaving must not take it away again
  const showDesc = (on) => {
    descWanted = on
    if (canReveal) short.setAttribute('aria-expanded', String(on))
    // the rAF lets the slide transition play from 0fr on a freshly inserted panel; the
    // descWanted check stops a leave-during-that-frame from leaving the panel stuck open
    if (on) { buildDesc(); requestAnimationFrame(() => { if (descWanted) descPanel.classList.add('open') }) }
    else if (descPanel) descPanel.classList.remove('open')
  }
  const scheduleOpen = () => { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => showDesc(true), 1000) }
  const scheduleClose = () => {
    if (pinned) return
    clearTimeout(hoverTimer); hoverTimer = setTimeout(() => showDesc(false), 250)
  }
  // Click semantics: closed → open and PIN. Open by hover → just pin it (a click must never take
  // away what the user has only just revealed). Open and pinned → close.
  const toggleDesc = () => {
    clearTimeout(hoverTimer)
    if (descWanted && !pinned) { pinned = true; return }
    pinned = !descWanted
    showDesc(!descWanted)
  }
  const holdOpen = () => clearTimeout(hoverTimer)
  const buildDesc = () => {
    if (descPanel) return
    descPanel = div('task-desc')
    const descIn = div('task-desc-in')
    descPanel.appendChild(descIn)
    // directly UNDER THE TITLE, not at the end of .task-mid: the panel is built lazily, so a
    // plain append dropped it below the "created by … " history strip — title, then what the
    // task says, then where it came from is the order that reads (user, 2026-09-12)
    mid.insertBefore(descPanel, nameLine.nextSibling)
    descPanel.addEventListener('mouseenter', holdOpen)
    descPanel.addEventListener('mouseleave', scheduleClose)
    descIn.appendChild(renderDescriptionEl(todo.description, {
      // persist only — rebuilding the list here removed the hovered checkbox and Chrome's
      // ancestor-mouseleave then closed the panel (user, 2026-08-24)
      onToggle: canTick ? (idx) => handlers.onDescChange(todo, project, toggleSubTask(todo.description, idx)) : null
    }))
  }
  if (canReveal) {
    nameLine.addEventListener('mouseenter', scheduleOpen)
    nameLine.addEventListener('mouseleave', scheduleClose)
    onTitleActivate = toggleDesc
  }

  // who it came FROM + WHEN — anchored to the EMAIL's own date (the evidence/created asof is the
  // message date, not the parse time). Clicking it opens the email and its whole thread: this line
  // IS the row's person + email affordance now that the initials disc and ✉ chip are gone.
  const lastMail = (todo.evidence || []).filter(e => e.msg_id).map(e => Number(e.asof) || 0).reduce((m, n) => Math.max(m, n), 0)
  const metaWhen = lastMail || Number(todo.created_asof) || 0

  // the counterparty (who owes it / who it is owed to) has no glyph of its own since the disc
  // went — it lives on the history strip's tooltip
  let other = null
  if (todo.direction === 'they_owe_me' || todo.direction === 'team_owes') {
    if (todo.owner && !isSelf(todo.owner)) other = 'owes: ' + nice(todo.owner)
  } else if (todo.direction === 'i_owe_them') {
    if (todo.counterparty && !isSelf(todo.counterparty)) other = 'for: ' + nice(todo.counterparty)
  }

  // HISTORY, not just provenance: the first and the last thing that happened to this task, each
  // opening the exact email behind it. The middle of the story is one tap away in the task modal.
  const strip = evidenceStrip(todo, {
    nameOf: nice,
    self: handlers.self || [],
    onOpenMessage: (want('email') && handlers.openEmailModal)
      ? (msg) => handlers.openEmailModal(todo, project, msg.msg_id)
      : null,
    onOpenHistory: openEditor,
    title: other
  })
  if (strip) mid.appendChild(strip)
  else if (metaWhen) mid.appendChild(span('task-meta', 'added ' + fmtAgo(metaWhen)))
  row.appendChild(mid)

  // the trailing controls live in one .task-tail group — display:contents on wide screens
  // (layout unchanged), its own wrapped line on narrow ones (entities.css media rules)
  const tail = span('task-tail')

  // TAIL ORDER (user, 2026-08-25): due · project · priority · ✕, with priority hard right —
  // the brown due date sits LEFT of the project chip. The △ and the far-right "modified" date
  // are gone — the task NAME opens the editor now, and every date the row needs is in the
  // history strip under the text.
  if (want('due') && (todo.due_hint || todo.due_latest || todo.due_earliest)) {
    // The hint TEXT ("next week", "by Friday") is only true on the day its email was written —
    // read a week later it actively misleads. Same-day: show the text. Any later day: show the
    // interpreted date(s) instead (dueDates.js window); no machine window = the text stays,
    // it is all we have. (user, 2026-08-19)
    const writtenDay = dayKeyOf(metaWhen)
    const sameDayAsWritten = writtenDay && writtenDay === dayKeyOf(Date.now())
    let text = todo.due_hint || ''
    // "asap" is the one relative phrase that never goes stale — it stays literal (and the due
    // sort pins it to the top) instead of decaying into the day it was written (user, 2026-08-27)
    const isAsap = /\basap\b/i.test(text)
    if (!isAsap && !sameDayAsWritten && (todo.due_latest || todo.due_earliest)) {
      const e = todo.due_earliest
      const l = todo.due_latest
      text = 'due ' + (e && l && e !== l ? fmtShortDay(e) + '–' + fmtShortDay(l) : fmtShortDay(l || e))
    }
    const due = span('task-due', text)
    // tooltip: the machine window + the original wording; past-due goes red
    const bits = []
    if (todo.due_latest) {
      bits.push('due ' + (todo.due_earliest && todo.due_earliest !== todo.due_latest
        ? 'between ' + todo.due_earliest + ' and ' + todo.due_latest : 'on ' + todo.due_latest))
    }
    if (todo.due_hint && text !== todo.due_hint) bits.push('“' + todo.due_hint + '” (as of ' + fmtDate(metaWhen) + ')')
    if (todo.due_latest && todo.due_latest < new Date().toISOString().slice(0, 10)) {
      due.classList.add('task-due-overdue')
      bits.push('OVERDUE')
    }
    if (bits.length) due.title = bits.join(' — ')
    tail.appendChild(due)
  }

  if (want('project') && projectName) {
    // shown only OFF the project page — so it carries the place too: the pillbox with the repo
    // stacked under it, which uses the row's vertical space instead of widening it
    tail.appendChild(projectWithRepo(projectName, onOpenProject ? () => onOpenProject(project) : null, reposOfTask(todo, project)))
  }

  if (want('imp')) {
    // no wipeThen here — see the note above: the row stays put, so it must not slide
    tail.appendChild(impCtl(todo.importance,
      handlers.onImportance ? (delta) => handlers.onImportance(todo, delta, project) : null,
      { locked: !!todo.importance_locked, todo }))
  }

  if (want('cancel') && handlers.onCancel) {
    const cancel = btn('epv-cancel', '✕', wipeThen(() => handlers.onCancel(todo, project)))
    cancel.title = 'Cancel this to-do'
    tail.appendChild(cancel)
  }

  row.appendChild(tail)
  return row
}
