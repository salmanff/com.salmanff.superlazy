// rulesTab.js — the RULES tab of the Setup & Prefs page: the ONE overview of the `instructions`
// collection (user-authored free-text rules the LLM applies verbatim — see instructionStore.js).
// Every scope is manageable here — all mail / one account / a domain / a single sender — whereas
// the person modal (personEditor.js) only adds sender- and domain-scoped ones. Rows are removed by
// setting status='disabled' (same soft-delete the person modal uses), so nothing is ever lost.

import { isAutomatedInstruction } from '../jobs/analyze_thread/responsibilityInstructions.js'
import { div, span, btn, el } from '../shared/renderUtils.js'
import { createInstructionStore } from '../jobs/analyze_thread/instructionStore.js'

const SCOPES = [
  { key: 'all', label: 'All mail', hint: 'Added to EVERY analysis as guidance. Does not stop auto-filed senders from auto-filing.' },
  { key: 'account', label: 'One account', hint: 'Added to the analysis of every message arriving on that mail account. Does not stop auto-filing.' },
  { key: 'domain', label: 'A domain', hint: 'Applied to every sender at that domain. Their messages ALWAYS go through the AI (never auto-filed silently).' },
  { key: 'sender', label: 'One sender', hint: 'Applied to one email address. Their messages ALWAYS go through the AI (never auto-filed silently).' }
]
const SCOPE_ORDER = { all: 0, account: 1, domain: 2, sender: 3 }
const scopeDef = (key) => SCOPES.find(s => s.key === key) || SCOPES[3]

// opts: {
//   instructions,   // the page's loaded instruction records (loadAll().instructions) — mutated in place
//   accounts,       // stored account records [{ account_id, account_email }] (for the account scope)
//   persist,        // createPersistence — saveInstruction / addEvent
//   onChange        // fired after every saved change
// }
export function renderRulesTab (host, { instructions, accounts, persist, onChange } = {}) {
  if (!host) return
  const accs = (accounts || []).filter(a => a && a.account_id)
  const accEmail = (id) => {
    const a = accs.find(x => x.account_id === id)
    return (a && a.account_email) || id
  }

  // a store hydrated from the page's records mints NON-COLLIDING instruction ids (i_xx)
  const iStore = createInstructionStore()
  iStore.hydrate(instructions || [])

  const changed = () => { if (onChange) onChange() }
  const logEdit = (field, rec, before, after) => {
    if (!persist) return
    persist.addEvent({
      kind: 'manual_edit', source_id: 'user', asof: Date.now(),
      field, target: 'instruction', address: rec.match || rec.scope, before, after
    }).catch(e => console.error('rule edit event failed', e))
  }

  function matchLabel (r) {
    if (r.scope === 'all') return 'every message'
    if (r.scope === 'account') return accEmail(r.match)
    return r.match || '—'
  }

  function paint () {
    host.textContent = ''
    host.appendChild(el('h2', null, 'Standing instructions'))
    host.appendChild(div('su-muted', 'Standing instructions are your own words, given to the AI with every matching message — e.g. “if an email mentions the Alpha launch, file it into the Alpha project”, “never draft replies to anyone at this domain”, “treat anything about invoices as priority 4+”. Sender- and domain-scoped instructions force those messages through the AI (they are never auto-filed unread); all-mail and account ones are general guidance and leave auto-filing alone. All-mail instructions ride in the weekly cached block, so they cost almost nothing to keep.'))

    // ---- existing rules, broadest scope first ------------------------------------------------
    const rows = iStore.all().filter(r => r.status === 'active')
      .sort((a, b) => (SCOPE_ORDER[a.scope] ?? 9) - (SCOPE_ORDER[b.scope] ?? 9) || String(a.match || '').localeCompare(String(b.match || '')))
    const list = div('su-rules-list')
    if (!rows.length) list.appendChild(div('epv-empty', 'No standing instructions yet — add one below, or from a person’s edit modal.'))
    for (const r of rows) {
      const row = div('su-rule')
      row.appendChild(span('su-rule-chip su-rule-chip-' + r.scope, scopeDef(r.scope).label))
      row.appendChild(span('su-rule-match', matchLabel(r)))
      row.appendChild(span('su-rule-txt', r.text))
      // made from a line on a person's card (the person editor's button) — edited there, not here
      if (isAutomatedInstruction(r)) {
        const o = span('prs-resp-tag prs-resp-tag-instr', r.label || 'from a card line')
        o.title = 'Made from a line under “What they handle” on this person\u2019s card — edit the line there and this follows. ✕ stops the instruction; the line stays on the card.'
        row.appendChild(o)
      }
      const del = btn('epv-cancel', '✕', () => {
        r.status = 'disabled'
        persist && persist.saveInstruction(r).catch(e => console.error('rule save failed', e))
        logEdit('instruction_removed', r, r.text, null)
        changed(); paint()
      })
      del.title = 'Remove this instruction'
      row.appendChild(del)
      list.appendChild(row)
    }
    host.appendChild(list)

    // ---- add a rule ---------------------------------------------------------------------------
    host.appendChild(div('epv-modal-head', 'Add an instruction'))
    const form = div('su-rule-form')

    const scopeSel = el('select', 'pe-movesel')
    for (const s of SCOPES) {
      const o = el('option', null, s.label)
      o.value = s.key
      scopeSel.appendChild(o)
    }
    form.appendChild(scopeSel)

    // the match control changes shape with the scope: none (all) / account picker / text input
    const matchWrap = span('su-rule-matchwrap')
    form.appendChild(matchWrap)
    const scopeHint = div('su-muted small')
    let matchInput = null // the live control, read at add time

    function paintMatch () {
      matchWrap.textContent = ''
      matchInput = null
      const sc = scopeSel.value
      scopeHint.textContent = scopeDef(sc).hint
      if (sc === 'account') {
        const sel = el('select', 'pe-movesel')
        if (!accs.length) {
          const o = el('option', null, 'no accounts set up yet')
          o.value = ''
          sel.appendChild(o)
        }
        for (const a of accs) {
          const o = el('option', null, a.account_email || a.account_id)
          o.value = a.account_id
          sel.appendChild(o)
        }
        matchWrap.appendChild(sel)
        matchInput = sel
      } else if (sc === 'domain' || sc === 'sender') {
        const inp = el('input', 'su-rule-input')
        inp.type = 'text'
        inp.placeholder = sc === 'domain' ? '@company.com' : 'person@company.com'
        matchWrap.appendChild(inp)
        matchInput = inp
      }
    }
    scopeSel.addEventListener('change', paintMatch)

    const ta = el('textarea', 'prs-instr-new')
    ta.rows = 2
    ta.placeholder = 'The instruction, in your own words — it is given to the AI verbatim…'

    const acts = div('prs-actions')
    const err = span('su-rule-err')
    acts.appendChild(btn('pe-tbtn pe-tbtn-save', 'Add instruction', () => {
      err.textContent = ''
      const scope = scopeSel.value
      const match = matchInput ? matchInput.value.trim() : null
      const text = ta.value.trim()
      if (!text) { err.textContent = 'Write the instruction first.'; return }
      if (scope !== 'all' && !match) { err.textContent = scope === 'account' ? 'No account to pick — set one up first.' : 'Say which ' + (scope === 'domain' ? 'domain' : 'sender') + ' it applies to.'; return }
      if (scope === 'sender' && !/^[^@\s]+@[^@\s]+$/.test(match)) { err.textContent = 'That does not look like an email address.'; return }
      if (scope === 'domain' && /\s/.test(match)) { err.textContent = 'That does not look like a domain.'; return }
      const rec = iStore.add({ scope, match, text, asof: Date.now() })
      if (!rec) return
      if (Array.isArray(instructions)) instructions.push(rec) // future renders on this page see it
      persist && persist.saveInstruction(rec).catch(e => console.error('rule save failed', e))
      logEdit('instruction_added', rec, null, text)
      changed(); paint()
    }))
    acts.appendChild(err)

    paintMatch()
    host.appendChild(form)
    host.appendChild(scopeHint)
    host.appendChild(ta)
    host.appendChild(acts)
  }

  paint()
}
