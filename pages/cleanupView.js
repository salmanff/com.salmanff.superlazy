// cleanupView.js — the clean-up REVIEW SURFACE, host-agnostic (specs/superlazy-weekly-cleanup.md
// §7): a left rail of sections with undecided counts, a right panel showing the selected section —
// the period summary, the focus list, attention cards, questions with options, suggestions (old →
// new per operation, Accept / Ignore / Accept all) — and a footer with the tally and Apply. Every
// to-do it mentions renders as THE standard task row (renderUtils.taskRowEl) with the host's live
// handlers, so a click opens the same task / project modals as every other page.
// Everything else renders through textContent — this text derives from mail via the model.

import { div, span, btn, el, taskRowEl } from '../shared/renderUtils.js'
import { renderMarkdown } from '../shared/markdownLite.js'
import { GROUPS } from '../jobs/analyze_thread/maintenance/cleanupPrompt.js'

const LABELS = {
  period: 'This period', focus: 'Focus', attention: 'Needs your attention', stale: 'Stale tasks', archive: 'Finished projects', merge: 'Similar projects', split: 'Overgrown / misfiled',
  people: 'People', rules: 'Standing rules', learn: 'Learn from my edits', questions: 'Questions', housekeeping: 'Housekeeping'
}
const BLURBS = {
  period: 'What happened over the input window, for someone who was away: what came in, what got done, what you did by hand, what started. Written by the model from the index and the period counts.',
  focus: 'What to give your attention to over the focus horizon — ranked from due dates, importance, who is waiting on you and the attention section. Rows are live: tick, re-price or open them here.',
  attention: 'Situations the input says need you this week. Read the summary and the recommendation, then act on the to-dos directly — the rows are the live ones. Cards come back on the next run while the situation persists (no snoozing yet, deliberately, until the experiment plays out).',
  stale: 'Old, low-priority open items the model has a view on: resolve, cancel, snooze or raise. Items it would keep are not listed. Each row shows the live to-do, then the proposed change.',
  archive: 'Finished or abandoned projects. Archiving moves the project to the archive collection and closes its open to-dos; it can be restored from the archived list.',
  merge: 'Two catalog entries that are the same effort. The source\'s to-dos move into the target; the source is retired.',
  split: 'Projects that grew wrong: an effort peeled out into a new project, a misfiled to-do moved, or several steps folded into one task with checklist lines.',
  people: 'Profiles out of step with what came in, senders to file automatically, standing ranks from your own corrections.',
  rules: 'Standing instructions that are dead, wrong, duplicated or too broad — from their measured usage.',
  learn: 'Patterns in your hand edits that could become a standing rule. A note with no operations describes a pattern that cannot be a rule.',
  questions: 'What the model could not settle. Where it offered options, choosing one queues that option\'s changes for Apply. Free-text answers are NOT recorded yet: if a fact matters, put it in your situation text (Setup → Prefs) and it will be known next run.',
  housekeeping: 'Mechanical maintenance from the deterministic passes: pruning old events, recomputing interaction stats, releasing thread links no to-do cites any more.'
}
const KIND_LABEL = { stalled: 'stalled', slipping: 'slipping', heating: 'heating up', blocker: 'you are the blocker', overload: 'out of control' }
const WHEN_LABEL = { today: 'Today', this_period: 'This period', later: 'Later — not yet' }
const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(3)
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t }

/**
 * @param {HTMLElement} host
 * @param {Object} o
 * @param {Object} o.core           createCleanupCore()
 * @param {Object} [o.taskHandlers] the standard task-row handlers (nameOf, self, onResolve, onCancel, onImportance, onEdit, openEmailModal, onOpenPerson)
 * @param {Function} [o.onOpenProject] (project) — opens the live project modal
 * @param {Function} [o.projectName]   (id) → name
 * @param {Function} [o.onApplied]     (results) — the host reloads its stores
 * @param {Function} [o.onStatus]      (text, cls)
 */
export function createCleanupView (host, { core, taskHandlers = {}, onOpenProject = null, projectName = null, onApplied = null, onStatus = () => {} } = {}) {
  host.textContent = ''
  host.classList.add('cl-view')
  const top = div('cl-runinfo')
  const body = div('cl-body')
  const rail = el('nav', 'cl-rail')
  const panel = div('cl-panel')
  body.appendChild(rail); body.appendChild(panel)
  const foot = div('cl-foot')
  const filterBar = div('cl-filterbar')
  host.appendChild(top); host.appendChild(filterBar); host.appendChild(body); host.appendChild(foot)
  let selected = 'period'
  let applying = false
  let results = null

  // ---- SOURCE filter (2026-09-27): which mailbox / channel an item comes from, read off the
  // `sources` tags of the projects it touches ('email:<address>', 'agents:<store>', 'slack:…',
  // 'note:…'). Options: all, each channel, each source present in this run. An item whose projects
  // carry no source (people, rules, learning) shows only under "All"; the period summary always shows.
  let sourceFilter = ''
  const CHANNEL_OF = (tag) => { const k = String(tag || '').split(':')[0]; return k === 'email' ? 'mail' : k === 'agents' || k === 'repo' ? 'work' : k === 'note' ? 'notes' : (k === 'slack' || k === 'messages' || k === 'chat') ? 'chat' : k }
  const CHANNEL_LABEL = { mail: 'All mail', chat: 'All chat (Slack)', work: 'All agent work', notes: 'Notes' }
  const sourceLabel = (tag) => { const [k, ...rest] = String(tag).split(':'); const v = rest.join(':'); return k === 'email' ? '✉ ' + v : k === 'agents' ? '🤖 ' + v : (k === 'slack' || k === 'messages') ? '💬 ' + v : k === 'note' ? '📝 notes' : tag }
  const projectsOfItem = (i) => {
    const ids = new Set()
    for (const r of (i.todoRefs || [])) if (r && r.project) ids.add(r.project.project_id)
    if (i.project_id) ids.add(i.project_id)
    if (i.data && i.data.project_id) ids.add(i.data.project_id)
    const opsIds = (ops) => { for (const o of (ops || [])) for (const k of ['project_id', 'source_project_id', 'target_project_id', 'from_project_id', 'to_project_id']) if (o && o[k]) ids.add(o[k]) }
    opsIds(i.ops); for (const o of (i.options || [])) opsIds(o.ops)
    for (const f of (i.focusItems || [])) if (f && f.project) ids.add(f.project.project_id)
    return [...ids].map(id => (core.projectOf && core.projectOf(id)) || null).filter(Boolean)
  }
  const sourcesOfProject = (p) => (p && Array.isArray(p.sources) ? p.sources.filter(t => !/^repo:/.test(t)) : [])
  const matchesSource = (p) => {
    if (!sourceFilter) return true
    const tags = sourcesOfProject(p)
    return sourceFilter.startsWith('channel:') ? tags.some(t => CHANNEL_OF(t) === sourceFilter.slice(8)) : tags.includes(sourceFilter)
  }
  const itemMatches = (i) => !sourceFilter || i.section === 'summary' || (i.section === 'focus') || projectsOfItem(i).some(matchesSource)
  function paintFilter () {
    filterBar.textContent = ''
    const tags = new Set()
    for (const i of core.items) for (const p of projectsOfItem(i)) for (const t of sourcesOfProject(p)) tags.add(t)
    if (tags.size < 2 && !sourceFilter) return // one source: nothing to filter
    const sel = document.createElement('select')
    sel.className = 'cl-filter-select'
    const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o) }
    opt('', 'All sources')
    const channels = [...new Set([...tags].map(CHANNEL_OF))].filter(c => CHANNEL_LABEL[c])
    for (const c of channels) opt('channel:' + c, CHANNEL_LABEL[c])
    for (const t of [...tags].sort()) opt(t, sourceLabel(t))
    sel.value = sourceFilter
    sel.addEventListener('change', () => { sourceFilter = sel.value; paint() })
    filterBar.appendChild(span('cl-filter-label', 'Source'))
    filterBar.appendChild(sel)
  }

  const order = GROUPS.concat(['housekeeping'])
  const groupsPresent = () => order.filter(g => ['period', 'focus', 'attention'].includes(g) || core.items.some(i => i.group === g && !i.suppressed && !i.derivedFrom && itemMatches(i)))
  const itemsOf = (g) => core.items.filter(i => i.group === g && !i.suppressed && !i.derivedFrom && itemMatches(i))
  const undecided = (g) => itemsOf(g).filter(i => i.status === 'proposed' && i.section !== 'summary' && i.section !== 'focus').length

  // the standard live task row, with the project name as its context
  function liveRow (ref, { why = null } = {}) {
    if (!ref || ref.missing || !ref.todo) return div('cl-todo-missing ml-muted', (ref && ref.todo_id) + ' — this to-do no longer exists')
    const wrap = div('cl-liverow')
    const pn = projectName ? projectName(ref.project.project_id) : (ref.project.name || '')
    wrap.appendChild(taskRowEl(ref.todo, ref.project, taskHandlers, { projectName: pn, onOpenProject, showDirection: true }))
    if (why) wrap.appendChild(div('cl-why', why))
    return wrap
  }

  function paintRail () {
    rail.textContent = ''
    for (const g of groupsPresent()) {
      const n = undecided(g)
      const has = itemsOf(g).length
      const b = btn('cl-rail-item' + (g === selected ? ' sel' : '') + (n ? '' : ' quiet'), '', () => { selected = g; paint() })
      b.appendChild(span('cl-rail-label', LABELS[g] || g))
      b.appendChild(span('cl-rail-count', n ? String(n) : (has ? '✓' : '·')))
      rail.appendChild(b)
    }
  }

  function decide (item, status) { core.setStatus(item, status); paint() }

  function diffRows (rows) {
    const out = document.createDocumentFragment()
    for (const r of rows) {
      const d = div('cl-oprow')
      d.appendChild(span('cl-oplabel', r.label))
      const cols = div('ml-diff')
      const b = div('ml-diff-col'); b.appendChild(div('ml-diff-lbl', 'current')); const bp = el('pre', 'ml-diff-pre'); bp.textContent = r.before == null ? '(none)' : String(r.before); b.appendChild(bp)
      const a = div('ml-diff-col ml-diff-new'); a.appendChild(div('ml-diff-lbl', 'proposed')); const ap = el('pre', 'ml-diff-pre'); ap.textContent = r.after == null ? '(none)' : String(r.after); a.appendChild(ap)
      cols.appendChild(b); cols.appendChild(a)
      d.appendChild(cols)
      out.appendChild(d)
    }
    return out
  }

  // ---- one suggestion (proposal with ops) ----------------------------------------------------------
  function proposalRow (item) {
    const row = div('cl-prop ml-prop' + (item.status === 'accepted' ? ' accepted' : item.status === 'ignored' ? ' ignored' : item.status === 'applied' ? ' applied' : item.status === 'failed' ? ' failed' : ''))
    const head = div('ml-prop-head')
    head.appendChild(span('ml-prop-title', item.title || '(untitled)'))
    for (const f of item.flags) head.appendChild(span('ml-flag', f))
    if (item.isNote) head.appendChild(span('ml-flag cl-flag-note', 'note — nothing to apply'))
    if (item.derivedFrom) head.appendChild(span('ml-flag cl-flag-note', 'from your answer'))
    if (item.fromRun && item.createdAsof) head.appendChild(span('cl-from-run', 'from ' + new Date(item.createdAsof).toLocaleDateString()))
    head.appendChild(span('ml-prop-status', item.status === 'applied' ? '✓ ' + (item.applyNote || 'applied') : item.status === 'failed' ? '✕ ' + (item.applyNote || 'failed') : item.status === 'accepted' ? 'accepted' : item.status === 'ignored' ? 'ignored' : ''))
    row.appendChild(head)
    if (item.description) row.appendChild(div('ml-prop-reason', item.description))
    if (item.evidenceLabels && item.evidenceLabels.length) row.appendChild(div('cl-evidence', 'evidence: ' + item.evidenceLabels.join(', ')))
    if (item.problems.length) row.appendChild(div('ml-prop-blocked', 'not appliable: ' + item.problems.join(' · ')))
    if (item.todoRefs && item.todoRefs.length) {
      const list = div('cl-todos')
      for (const ref of item.todoRefs.slice(0, 12)) list.appendChild(liveRow(ref))
      if (item.todoRefs.length > 12) list.appendChild(div('ml-muted', '… and ' + (item.todoRefs.length - 12) + ' more'))
      row.appendChild(list)
    }
    row.appendChild(diffRows(item.rows))
    if (['proposed', 'accepted', 'ignored'].includes(item.status)) {
      const actions = div('ml-prop-actions')
      if (item.appliable) {
        const acc = btn('ml-btn ml-btn-accept', item.status === 'accepted' ? '✓ Accepted' : 'Accept', () => decide(item, item.status === 'accepted' ? 'proposed' : 'accepted'))
        acc.title = 'Queue this change — nothing is written until you press Apply'
        actions.appendChild(acc)
      }
      const ign = btn('ml-btn ml-btn-ignore', item.status === 'ignored' ? 'Un-ignore' : (item.isNote ? 'Dismiss' : 'Ignore'), () => decide(item, item.status === 'ignored' ? 'proposed' : 'ignored'))
      ign.title = 'Ignoring is a permanent, valid answer — this suggestion is never shown again'
      actions.appendChild(ign)
      row.appendChild(actions)
    }
    return row
  }

  // ---- one attention card ---------------------------------------------------------------------------
  function attentionCard (item) {
    const card = div('cl-card' + (item.status === 'seen' ? ' seen' : ''))
    const head = div('cl-card-head')
    head.appendChild(span('cl-kind cl-kind-' + item.kind, KIND_LABEL[item.kind] || item.kind))
    head.appendChild(span('cl-headline', item.headline || item.title || ''))
    if (item.status === 'seen') head.appendChild(span('ml-prop-status', 'seen'))
    card.appendChild(head)
    if (item.situation) card.appendChild(div('cl-situation', item.situation))
    if (item.recommendation) { const r = div('cl-reco'); r.appendChild(span('cl-reco-lbl', 'Recommendation')); r.appendChild(span('', ' ' + item.recommendation)); card.appendChild(r) }
    const meta = []
    const pr = item.todoRefs.find(t => t.project)
    if (pr) meta.push('project “' + (pr.project.name || pr.project.project_id) + '”'); else if (item.project_id) meta.push('project ' + item.project_id)
    if (item.people.length) meta.push('people: ' + item.people.map(a => (taskHandlers.nameOf && taskHandlers.nameOf(a)) || a).join(', '))
    if (item.evidenceLabels.length) meta.push('evidence: ' + item.evidenceLabels.join(', '))
    if (meta.length) card.appendChild(div('cl-evidence', meta.join(' · ')))
    if (item.todoRefs.length) {
      const list = div('cl-todos')
      for (const ref of item.todoRefs) list.appendChild(liveRow(ref))
      card.appendChild(list)
    }
    const actions = div('ml-prop-actions')
    if (pr && onOpenProject) actions.appendChild(btn('ml-btn', 'Open project', () => onOpenProject(pr.project)))
    actions.appendChild(btn('ml-btn ml-btn-ignore', item.status === 'seen' ? 'Show again' : 'Seen', () => decide(item, item.status === 'seen' ? 'proposed' : 'seen')))
    card.appendChild(actions)
    return card
  }

  function questionRow (item) {
    const row = div('cl-question' + (item.status === 'dismissed' ? ' ignored' : '') + (item.status === 'answered' ? ' answered' : ''))
    row.appendChild(div('cl-q', '? ' + (item.question || item.title)))
    if (item.why) row.appendChild(div('ml-prop-reason', 'why it matters: ' + item.why))
    if (item.forGroup) row.appendChild(div('cl-evidence', 'about: ' + (LABELS[item.forGroup] || item.forGroup)))
    if (item.options && item.options.length) {
      const opts = div('cl-options')
      item.options.forEach((o, i) => {
        const chosen = item.chosen === i
        const b = btn('ml-btn cl-option' + (chosen ? ' chosen' : '') + (o.ok ? '' : ' cl-option-bad'), (chosen ? '✓ ' : '') + o.label + (o.ops.length ? ' (' + o.ops.length + ' change' + (o.ops.length === 1 ? '' : 's') + ')' : ''), () => {
          if (item.status === 'answered') return
          const it = core.questionOption(item, i)
          onStatus(it ? 'Queued ' + it.ops.length + ' change(s) from your answer — see ' + (LABELS[it.group] || it.group) + ' and Apply.' : 'Answer noted (no changes to queue).', 'ok')
          paint()
        })
        b.disabled = item.status === 'answered' || !o.ok
        b.title = o.ok ? (o.rows.map(r => r.label + ': ' + clip(r.after, 60)).join(' · ') || 'no changes') : 'not appliable: ' + o.problems.join(' · ')
        opts.appendChild(b)
      })
      row.appendChild(opts)
    }
    if (item.status === 'answered') row.appendChild(div('cl-queued', 'answered: ' + item.options[item.chosen].label + ((item.derived || []).length ? ' — changes queued in ' + (LABELS[item.derived[0].group] || item.derived[0].group) : '')))
    if (item.status !== 'dismissed' && item.status !== 'answered') {
      const a = div('ml-prop-actions')
      a.appendChild(btn('ml-btn ml-btn-ignore', 'Dismiss', () => decide(item, 'dismissed')))
      row.appendChild(a)
    }
    return row
  }

  function focusBlock (item) {
    const wrap = div('cl-focus')
    if (item.markdown) wrap.appendChild(renderMarkdown(item.markdown))
    for (const when of ['today', 'this_period', 'later']) {
      const rows = item.focusItems.filter(f => f.when === when && (!sourceFilter || !f.project || matchesSource(f.project)))
      if (!rows.length) continue
      wrap.appendChild(div('cl-when', WHEN_LABEL[when] + ' · ' + rows.length))
      const list = div('cl-todos')
      for (const f of rows) list.appendChild(liveRow(f, { why: f.why }))
      wrap.appendChild(list)
    }
    if (!item.focusItems.length) wrap.appendChild(div('cl-empty', 'The model named no items.'))
    return wrap
  }

  function paintPanel () {
    panel.textContent = ''
    const g = selected
    panel.appendChild(div('cl-panel-title', LABELS[g] || g))
    panel.appendChild(div('cl-blurb', BLURBS[g] || ''))
    const items = itemsOf(g)
    if (!items.length) { panel.appendChild(div('cl-empty', core.runInfo ? 'Nothing here — an empty section is a good outcome.' : 'Run the clean-up to fill this section.')); return }
    if (g === 'period') { for (const it of items) panel.appendChild(renderMarkdown(it.markdown || '')); return }
    if (g === 'focus') { for (const it of items) panel.appendChild(focusBlock(it)); return }
    if (g === 'attention') { for (const it of items) panel.appendChild(attentionCard(it)); return }
    if (g === 'questions') { for (const it of items) panel.appendChild(questionRow(it)); return }
    const open = items.filter(i => i.status === 'proposed' && i.appliable)
    if (open.length > 1) {
      const bar = div('cl-acceptall')
      bar.appendChild(span('', open.length + ' undecided'))
      bar.appendChild(btn('ml-btn ml-btn-accept', 'Accept all', () => { for (const i of open) core.setStatus(i, 'accepted'); paint() }))
      bar.appendChild(btn('ml-btn ml-btn-ignore', 'Ignore all', () => { for (const i of open) core.setStatus(i, 'ignored'); paint() }))
      panel.appendChild(bar)
    }
    for (const it of items) panel.appendChild(proposalRow(it))
  }

  function paintFoot () {
    foot.textContent = ''
    const t = core.tally()
    foot.appendChild(span('cl-tally', t.accepted + ' accepted · ' + t.ignored + ' ignored · ' + t.undecided + ' undecided' + (t.applied ? ' · ' + t.applied + ' applied' : '') + (core.suppressed ? ' · ' + core.suppressed + ' suppressed (ignored earlier)' : '')))
    const b = btn('ml-btn ml-btn-primary', applying ? 'Applying…' : 'Apply ' + t.accepted + ' accepted change' + (t.accepted === 1 ? '' : 's'), async () => {
      if (applying || !t.accepted) return
      applying = true; paintFoot()
      try {
        onStatus('Applying…', 'busy')
        const r = await core.apply({ onProgress: (done, total, label) => onStatus('Applying ' + done + ' of ' + total + ' — ' + label, 'busy') })
        results = r.results
        const ok = results.filter(x => x.ok).length
        onStatus('Applied ' + ok + ' / ' + results.length + ' — every change is on the events log; the cached analysis snapshot was cleared.', ok === results.length ? 'ok' : 'warn')
        if (onApplied) await onApplied(results)
      } catch (e) {
        onStatus('Apply failed: ' + ((e && e.message) || e), 'error')
      } finally { applying = false; paint() }
    })
    b.disabled = applying || !t.accepted
    b.title = 'Takes the ingestion lock, writes the accepted changes to the real stores, records an event per change, and clears the cached analysis snapshot'
    foot.appendChild(b)
    if (results && results.length) {
      const res = div('cl-results')
      for (const r of results) res.appendChild(div('ml-result ' + (r.ok ? 'ok' : 'err'), (r.ok ? '✓ ' : '✕ ') + (r.ok ? r.note : r.error)))
      foot.appendChild(res)
    }
  }

  function paintTop () {
    top.textContent = ''
    const ri = core.runInfo
    if (!ri) { top.appendChild(span('ml-muted', 'No run loaded.')); return }
    const st = ri.stats || {}
    const tk = ri.tokens || {}
    const parts = [
      (ri.pending ? 'Pending from the run of ' : 'Run of ') + new Date(ri.startedAt || Date.now()).toLocaleString(),
      st.mode ? (st.mode === 'full' ? 'full mail' : 'index') + (st.items != null ? ' · ' + st.items + ' items' : st.messages != null ? ' · ' + st.messages + ' messages' : '') + (st.byChannel ? ' (' + Object.entries(st.byChannel).map(([k, v]) => k + ' ' + v).join(', ') + ')' : '') : null,
      ri.model || null,
      'cost ' + fmtMoney(ri.cost || 0) + (ri.costIn != null || ri.costOut != null ? ' = in ' + fmtMoney(ri.costIn) + (ri.costOther ? ' + cache ' + fmtMoney(ri.costOther) : '') + ' + out ' + fmtMoney(ri.costOut) : ''),
      (tk.input || tk.cache_read || tk.output) ? 'tokens in ' + ((tk.input || 0) + (tk.cache_read || 0)).toLocaleString() + (tk.cache_read ? ' (' + tk.cache_read.toLocaleString() + ' via cache)' : '') + ' · out ' + (tk.output || 0).toLocaleString() : null,
      ri.needRounds ? ri.needRounds + ' follow-up round(s)' : null,
      ri.incomplete ? '⚠ reply cut off' : null
    ].filter(Boolean)
    top.appendChild(span('', parts.join(' · ')))
  }

  function paint () { paintTop(); paintFilter(); paintRail(); paintPanel(); paintFoot() }

  return {
    paint,
    select (g) { selected = g; paint() },
    itemArrived (item) { if (item.group === selected || !groupsPresent().includes(selected)) paint(); else paintRail() },
    reset () { results = null; selected = 'period'; paint() }
  }
}
