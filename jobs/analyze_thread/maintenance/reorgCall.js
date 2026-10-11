// jobs/analyze_thread/maintenance/reorgCall.js — renderProjectDetail: ONE project as the clean-up model sees it
// when it asks for project_detail (cleanupCore.resolveNeed) and in the replay tooling. The R1
// re-organization prompt and call that used to live here were retired on 2026-09-26: the project
// editor's button now runs the weekly clean-up restricted to one project (reorgReview.js →
// cleanupCore.prepare({ projectId })) — same prompt, same operations, same apply path.

const day = (ms) => { try { return new Date(Number(ms)).toISOString().slice(0, 10) } catch (e) { return '' } }
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }

// The project as the model sees it — real todo_ids, USER-SET markers, dates from the evidence.
export function renderProjectDetail (project, { nameOf } = {}) {
  const nice = (a) => a ? (((nameOf && nameOf(a)) || '') + ' <' + a + '>').trim() : ''
  const parts = []
  parts.push('# PROJECT UNDER REVIEW')
  parts.push('Name: ' + (project.name || '(unnamed)'))
  parts.push('Summary: ' + (project.summary || '(none)'))
  parts.push('Importance: ' + (project.importance || 3) + (project.importance_locked ? ' [USER-SET]' : ''))
  const ppl = project.participant_emails || Object.keys(project.participants || {})
  if (ppl.length) parts.push('Participants: ' + ppl.map(nice).join(', '))
  parts.push('Created: ' + day(project.created_asof) + ' · last active: ' + day(project.last_active_asof))
  parts.push('')
  parts.push('## TASKS (' + (project.todos || []).length + ')')
  for (const t of (project.todos || [])) {
    const lastTouch = Math.max(Number(t.created_asof) || 0, ...(t.evidence || []).map(e => Number(e && e.asof) || 0))
    parts.push('--- ' + t.todo_id + ' [' + (t.status || 'open') + ' · ' + (t.direction || '') + ' · imp ' + (t.importance || 3) +
      (t.importance_locked ? ' · USER-SET' : '') + ']')
    parts.push('short: ' + (t.short_description || '(none)'))
    if (t.description) parts.push('description: ' + clip(t.description, 500))
    if (t.owner) parts.push('owner: ' + nice(t.owner))
    if (t.counterparty) parts.push('counterparty: ' + nice(t.counterparty))
    if (t.due_hint) parts.push('due: ' + t.due_hint)
    parts.push('raised ' + day(t.created_asof) + ' · last touched ' + day(lastTouch))
    // the analyst's notes on the messages that moved this item — the same trail the per-item
    // analysis reads (three deep); without it "is this step finished?" is judged blind
    for (const e of (t.evidence || []).filter(e => e && e.summary).slice(-3)) parts.push('  ↳ ' + day(e.asof) + ' · ' + clip(e.summary, 200))
  }
  return parts.join('\n')
}
