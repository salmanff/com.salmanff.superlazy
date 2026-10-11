// personEditor.js — the EDIT modal for one person, opened by clicking a person chip on an
// expanded project card, or the ✏️ on the People page detail. Two jobs:
//   1. edit the person's profile DESCRIPTION (profile.summary — the model refines it over time,
//      but your wording sticks until it genuinely changes its read),
//   2. manage RULES for this sender — free-text rules stored in the `instructions` collection
//      (scope=sender, or scope=domain via the "everyone at this domain" checkbox) and injected
//      VERBATIM into the analysis prompt for every matching message (rulesEngine.preAnalyze →
//      prompt "Custom instructions"). The list also SHOWS domain/all-mail rules that apply to
//      this sender; those are managed on Setup & Prefs → Rules (rulesTab.js).
// Persistence: persist.saveProfile / persist.saveInstruction + manual_edit events. textContent only.

import { openModalShell } from './modalStack.js'
import { div, span, btn, el, avatarEl } from './renderUtils.js'
import { createInstructionStore } from '../jobs/analyze_thread/instructionStore.js'
import { AUTOMATED_CATEGORIES } from '../jobs/analyze_thread/workflows.js'
import { FILE_TO_PROJECT, getAutoProcess, applyAutoProcess, autoProcessState, userAutoProcessPatch } from '../jobs/analyze_thread/autoProcess.js'
import { PROFILE_TUNING } from '../jobs/analyze_thread/profileTuning.js'
import { entriesOf, setUserResponsibility, removeResponsibility } from '../jobs/analyze_thread/responsibilities.js'
import { profileHistorySnapshot } from '../jobs/analyze_thread/persist.js'
import { linkedInstruction, makeResponsibilityInstruction, syncResponsibilityInstructions, isAutomatedInstruction } from '../jobs/analyze_thread/responsibilityInstructions.js'
import { analysisModel, cardLinesUnreliableOn } from './modelInfo.js'

const lc = (s) => String(s || '').toLowerCase()

// opts: {
//   profiles,       // the page's profile store (createProfileStore, hydrated)
//   persist,        // createPersistence — saveProfile / saveInstruction / addEvent
//   instructions,   // the page's loaded instruction records (loadAll().instructions) — mutated in place
//   nameOf,         // (address) => display name | null
//   projects,       // () => live projects (auto-process file targets beyond the standard buckets)
//   reprofile,      // optional async (address) => { ok, outcome, reason } — the on-demand AI re-profile (people.js)
//   settings,       // the settings record — default_model decides whether the small-model warning shows
//   onChange        // fired after every saved change (host repaints)
// }
export function openPersonEditor (address, { profiles, persist, instructions, nameOf, projects, reprofile, settings, onChange } = {}) {
  const addr = lc(address)
  const profile = profiles && profiles.get(addr)
  const name = (profile && profile.display_name) || (nameOf && nameOf(addr)) || addr
  const rank = profile ? (Number(profile.manual_rank) || (profile.profile && Number(profile.profile.llm_importance)) || 3) : null

  // a store hydrated from the page's records mints NON-COLLIDING instruction ids (i_xx)
  const iStore = createInstructionStore()
  iStore.hydrate(instructions || [])

  const { modal, close } = openModalShell({ className: 'epv-modal-wide prs-modal', onClose: onChange, guardOutsideClick: true })
  const body = div('prs-body')
  modal.appendChild(body)

  const changed = () => { if (onChange) onChange() }
  // which model analyses mail decides whether card lines get the small-model warning. Resolved
  // async (one ping per page); repaint when it lands unless the user has started typing.
  let model = null
  let typing = false
  body.addEventListener('input', () => { typing = true })
  analysisModel(settings).then(m => { model = m; if (!typing && body.isConnected) paint() })
  // automated instructions (made from a card line) live in the page's records AND the editor's
  // store copy; keep both in step and persist
  const saveInstr = (r) => {
    const copy = iStore.all().find(x => x.instruction_id === r.instruction_id)
    if (copy && copy !== r) Object.assign(copy, r)
    persist && persist.saveInstruction(r).catch(e => console.error('instruction save failed', e))
  }
  // archive the version a manual edit replaces — but only once the profile is real
  // (solidified or previously user-edited); provisional first-pass text is churn, not history
  const archiveIfWorthy = (reason) => {
    const pr = profile && profile.profile
    if (!persist || !pr || !(pr.solidified_asof || pr.user_edited)) return
    persist.saveProfileHistory(profileHistorySnapshot(addr, { ...pr }, {
      manualRank: profile.manual_rank, source: 'manual_edit', reason, asof: Date.now()
    })).catch(e => console.error('profile history save failed', e))
  }
  const logEdit = (field, before, after) => {
    if (!persist) return
    persist.addEvent({
      kind: 'manual_edit', source_id: 'user', asof: Date.now(),
      field, target: 'profile', address: addr, before, after
    }).catch(e => console.error('person edit event failed', e))
  }

  function paint () {
    body.textContent = ''

    // ---- header ---------------------------------------------------------------------------
    const head = div('prs-head')
    head.appendChild(avatarEl(name, { rank, size: 'lg' }))
    const hmid = div('prs-head-mid')
    hmid.appendChild(div('prs-name', name))
    hmid.appendChild(div('prs-addr', addr))
    head.appendChild(hmid)
    body.appendChild(head)

    // ---- description ------------------------------------------------------------------------
    body.appendChild(div('epv-modal-head', 'Description'))
    if (profile) {
      profile.profile = profile.profile || {}
      const prof0 = profile.profile

      // profile-lifecycle status (profileTuning.js). 2026-09-19: the fit score, drift notes and
      // out-of-sync badge are gone with fit_concerns, which the model never once emitted.
      body.appendChild(div('prs-hint', !prof0.solidified_asof
        ? 'PROVISIONAL — the model refines this freely until ' + PROFILE_TUNING.MESSAGES_BEFORE_SOLIDIFYING_PROFILE + ' messages have been received, then grounds it from full history.'
        : 'Grounded from full history' + (prof0.user_edited ? '. Edited by you — the model won’t overwrite it.' : '. Use “Update with AI” to re-ground it.')))

      const ta = el('textarea', 'prs-desc')
      ta.rows = 3
      ta.value = prof0.summary || ''
      ta.placeholder = 'Who is this person to you? (the model keeps this current over time)'
      body.appendChild(ta)
      const row = div('prs-actions')
      row.appendChild(btn('pe-tbtn pe-tbtn-save', 'Save description', () => {
        const before = prof0.summary || ''
        const after = ta.value.trim()
        if (after === before) return
        archiveIfWorthy('description edited by user')
        prof0.summary = after
        // a hand-edit asserts current truth: lock the text against auto-overwrite
        prof0.user_edited = true
        profile.stub = false
        persist && persist.saveProfile(profile).catch(e => console.error('profile save failed', e))
        logEdit('profile_summary', before, after)
        changed(); paint()
      }))
      if (reprofile) {
        const ai = btn('pe-tbtn', '✨ Update with AI', async () => {
          ai.disabled = true
          ai.textContent = 'Re-profiling…'
          let pending = false
          try {
            const r = await reprofile(addr)
            pending = !!(r && r.outcome === 'pending')
            ai.textContent = !r || !r.ok
              ? 'Failed'
              : (r.outcome === 'no_change' ? 'No change needed' : (pending ? 'Running in background…' : '✓ Updated'))
            if (r && !r.ok) console.error('reprofile failed', r.reason)
            if (pending && r.reason) console.log('[superlazy] reprofile', r.reason)
          } catch (e) {
            ai.textContent = 'Failed'
            console.error('reprofile failed', e)
          }
          // 'pending' keeps its note on screen — the job persists the result itself, and this
          // page's data refresh brings it in whenever it lands; repainting now would erase the note
          if (!pending) setTimeout(() => { changed(); paint() }, 900)
        })
        ai.title = 'Re-read this person’s recent mail, projects and drift notes and rewrite the profile (uses your AI key)'
        row.appendChild(ai)
      }
      body.appendChild(row)

      // ---- what they handle ----------------------------------------------------------------
      // responsibilities is a LIST (jobs/analyze_thread/responsibilities.js). Each line is owned
      // either by the model — which refreshes its own lines on every re-profile — or by the USER,
      // whose lines are never touched by the model. Editing a model line makes it yours: that is
      // the point, and the hint says so rather than making the user guess.
      body.appendChild(div('epv-modal-head', 'What they handle'))
      body.appendChild(div('prs-hint', 'One line per kind of work. Be specific: say whose to-do list it goes on — theirs, yours, or both, and when (e.g. “both me and them if there is a problem”). Lines you write or edit are marked “yours” and the AI will never change or drop them; the rest it keeps current itself.'))
      const respList = div('prs-resp-list')
      const saveResp = (what) => {
        // an edited line rewrites the instruction made from it; a removed line switches it off
        for (const r of syncResponsibilityInstructions(instructions, { name, address: addr, entries: entriesOf(prof0) })) saveInstr(r)
        profile.stub = false
        persist && persist.saveProfile(profile).catch(e => console.error('profile save failed', e))
        logEdit('responsibilities', '', what)
        changed(); paint()
      }
      const unreliable = cardLinesUnreliableOn(model)
      if (unreliable) {
        body.appendChild(div('prs-warn', '⚠ Mail is analysed with ' + [model.provider, model.family].filter(Boolean).join(' ') + '. On this model, lines here are often NOT followed when deciding whose list an item goes on — in our tests a colleague\u2019s invoice line was ignored 3 times out of 3. To make a line dependable, turn it into a standing instruction with the button beside it (your words are used unchanged).'))
      }
      for (const e of entriesOf(prof0)) {
        const row = div('prs-resp-row')
        const ta = el('textarea', 'prs-desc prs-resp-text')
        ta.rows = 2
        ta.value = e.text
        row.appendChild(ta)
        const meta = div('prs-resp-meta')
        meta.appendChild(span(e.source === 'user' ? 'prs-resp-tag prs-resp-tag-user' : 'prs-resp-tag', e.source === 'user' ? 'yours' : 'learned by the AI'))
        meta.appendChild(btn('pe-tbtn pe-tbtn-save', 'Save', () => {
          const after = ta.value.trim()
          if (!after || after === e.text) return
          setUserResponsibility(prof0, { id: e.id, text: after })
          saveResp(after.slice(0, 120))
        }))
        meta.appendChild(btn('pe-tbtn', 'Remove', () => {
          removeResponsibility(prof0, e.id)
          saveResp('removed: ' + e.text.slice(0, 80))
        }))
        if (e.source === 'user') {
          const linked = linkedInstruction(instructions, addr, e.id)
          if (linked) {
            meta.appendChild(span('prs-resp-tag prs-resp-tag-instr', '✓ standing instruction'))
            const off = btn('pe-tbtn', 'Stop instruction', () => {
              linked.status = 'disabled'
              saveInstr(linked)
              logEdit('instruction_removed', linked.text, null)
              changed(); paint()
            })
            off.title = 'Keep the line on the card, but stop sending it as a standing instruction'
            meta.appendChild(off)
          } else if (unreliable) {
            const mk = btn('pe-tbtn', 'Make it a standing instruction', () => {
              const rec = makeResponsibilityInstruction(iStore, { name, address: addr, entry: e })
              if (!rec) return
              if (Array.isArray(instructions)) instructions.push(rec)
              saveInstr(rec)
              logEdit('instruction_added', null, rec.text)
              changed(); paint()
            })
            mk.title = 'Sends this line to the AI as a standing instruction on every message — more reliable on small models'
            meta.appendChild(mk)
          }
        }
        row.appendChild(meta)
        respList.appendChild(row)
      }
      body.appendChild(respList)
      const addTa = el('textarea', 'prs-desc')
      addTa.rows = 2
      // the hint teaches the phrasing that works: say whose list it goes on (user, 2026-10-04)
      const first = String(name).split(/[\s@]/)[0] || 'them'
      addTa.placeholder = 'Be specific about whose list it goes on — e.g. "supplier invoices — put them on ' + first + '\u2019s list, not mine; if there is a problem or a delay, put it on both me and ' + first + '"'
      body.appendChild(addTa)
      const addRow = div('prs-actions')
      addRow.appendChild(btn('pe-tbtn pe-tbtn-save', 'Add', () => {
        const t = addTa.value.trim()
        if (!t) return
        setUserResponsibility(prof0, { text: t })
        saveResp(t.slice(0, 120))
      }))
      body.appendChild(addRow)

      // how the USER writes to this person — learned at re-profile time; drives suggested-reply voice
      if (prof0.user_tone || prof0.solidified_asof) {
        body.appendChild(div('epv-modal-head', 'Your tone with them'))
        body.appendChild(div('prs-hint', 'How you write to this person (learned from your sent mail; used to voice suggested replies).'))
        const tt = el('textarea', 'prs-desc')
        tt.rows = 2
        tt.value = prof0.user_tone || ''
        tt.placeholder = 'e.g. "First-name, casual, one-liners, signs off with just S." (learned on the next AI profile update)'
        body.appendChild(tt)
        const trow = div('prs-actions')
        trow.appendChild(btn('pe-tbtn pe-tbtn-save', 'Save tone', () => {
          const before = prof0.user_tone || ''
          const after = tt.value.trim()
          if (after === before) return
          archiveIfWorthy('tone edited by user')
          prof0.user_tone = after || null
          persist && persist.saveProfile(profile).catch(e => console.error('profile save failed', e))
          logEdit('profile_user_tone', before, after)
          changed()
        }))
        body.appendChild(trow)
      }
    } else {
      body.appendChild(div('epv-empty', 'No profile yet for this address — it is created when a message from them is analysed.'))
    }

    // ---- auto-process — standing automatic actions on this sender's mail (autoProcess.js).
    // The first action is FILE-TO-PROJECT: an explicit flag + target (a standard bucket or ANY
    // project). A user choice LOCKS it: the model may never override; its dissent shows as a warning.
    if (profile) {
      profile.profile = profile.profile || {}
      const prof = profile.profile
      body.appendChild(div('epv-modal-head', 'Auto-process'))
      body.appendChild(div('prs-hint', 'Automatic handling of this sender’s mail. Current action: FILE TO PROJECT — future mail files straight into the chosen project WITHOUT an AI call (needs the "automated autopilot" preference, on by default). Picking a bucket, or Off, locks your choice — the model can never change it. Reset unlocks it again.'))
      const row = div('prs-actions prs-autofile')
      const dsel = el('select', 'pe-movesel')
      // THREE states, all explicit (see autoProcess.js autoProcessState). The old single blank
      // option conflated "never learned" with "you turned it off" — they behave differently.
      const oReset = el('option', null, 'Reset — let the AI decide next time'); oReset.value = 'reset'
      dsel.appendChild(oReset)
      const oOff = el('option', null, 'Off — always analyse every message'); oOff.value = 'off'
      dsel.appendChild(oOff)
      const gCat = el('optgroup'); gCat.label = 'Standard buckets'
      for (const c of AUTOMATED_CATEGORIES) {
        const o = el('option', null, c.label + ' — files into “' + c.bucket + '”'); o.value = 'cat:' + c.key
        gCat.appendChild(o)
      }
      dsel.appendChild(gCat)
      const projList = (projects ? projects() : []).filter(p => p && p.status !== 'archived')
      if (projList.length) {
        const gProj = el('optgroup'); gProj.label = 'Your projects'
        for (const p of projList.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))) {
          const o = el('option', null, p.name || p.project_id); o.value = 'proj:' + p.project_id
          gProj.appendChild(o)
        }
        dsel.appendChild(gProj)
      }
      // current value: the sender's file_to_project entry decides (legacy auto_file* fields are
      // normalized to auto_processes[] by the getter)
      const entry = getAutoProcess(prof, FILE_TO_PROJECT)
      const state = autoProcessState(prof)
      const isOn = state === 'on'
      const disp = (entry && entry.details && entry.details.disposition) || null
      const projId = (entry && entry.details && entry.details.project_id) || null
      let current = state === 'off' ? 'off' : 'reset'
      if (isOn && AUTOMATED_CATEGORIES.some(c => c.key === disp)) current = 'cat:' + disp
      else if (isOn && projId) current = 'proj:' + projId
      dsel.value = current
      if (dsel.value !== current) dsel.value = 'reset' // stored target no longer exists
      dsel.addEventListener('change', () => {
        const v = dsel.value
        const before = current || null
        const asof = Date.now()
        if (v.startsWith('cat:')) {
          applyAutoProcess(prof, userAutoProcessPatch('on', { disposition: v.slice(4), asof }))
        } else if (v.startsWith('proj:')) {
          applyAutoProcess(prof, userAutoProcessPatch('on', { project_id: v.slice(5), asof }))
        } else {
          applyAutoProcess(prof, userAutoProcessPatch(v === 'off' ? 'off' : 'reset', { asof }))
        }
        persist && persist.saveProfile(profile).catch(e => console.error('auto-process save failed', e))
        logEdit('auto_process', before, v || 'reset')
        changed(); paint()
      })
      row.appendChild(dsel)
      body.appendChild(row)
      const bits = []
      if (state === 'off') bits.push('Off, set by you — every message from them is analysed. The model cannot re-learn this sender until you Reset.')
      else if (entry && entry.locked) bits.push('set by you (locked — the model cannot change it)')
      else if (isOn) bits.push('learned by the model')
      else bits.push('Not set — the next message is analysed normally, and the model may start auto-filing this sender.')
      body.appendChild(div('prs-hint', bits.join(' ')))
      // the model disagrees with a locked setting → warn, but the user's choice wins
      const suggestedDisp = (entry && entry.suggested && entry.suggested.disposition) || null
      if (entry && entry.locked && suggestedDisp && suggestedDisp !== disp) {
        body.appendChild(div('prs-warn', '⚠ The model would auto-process this sender as “' + suggestedDisp + '” — your setting wins.'))
      }
    }

    // ---- rules & special instructions -----------------------------------------------------------
    // EVERY rule that applies to this sender's mail (instructionStore.matching): their own
    // sender-scoped ones (editable here), plus domain- and all-mail ones (read-only here — the
    // Rules tab on Setup & Prefs is where those are managed). Account-wide rules don't show: a
    // person isn't tied to one mail account.
    body.appendChild(div('epv-modal-head', 'Standing instructions for this person'))
    body.appendChild(div('prs-hint', 'Applied VERBATIM whenever a message from ' + addr + ' is analysed — e.g. "always mark their requests priority 4+", "never draft replies to them", "file everything into the Acme project".'))

    const SCOPE_CHIP = { sender: 'Sender', domain: 'Domain', all: 'All mail', account: 'Account' }
    const applying = iStore.matching(addr)
    const list = div('prs-instr-list')
    if (!applying.length) list.appendChild(div('epv-empty', 'No standing instructions apply to this sender yet.'))
    for (const r of applying) {
      const row = div('prs-instr')
      row.appendChild(span('prs-instr-chip prs-instr-chip-' + r.scope, SCOPE_CHIP[r.scope] || r.scope))
      row.appendChild(span('prs-instr-txt', r.text + (r.scope === 'domain' ? '  (everyone at ' + r.match + ')' : '')))
      if (isAutomatedInstruction(r)) row.appendChild(span('prs-resp-tag prs-resp-tag-instr', r.label || 'from a card line'))
      if (r.scope === 'sender') {
        const del = btn('epv-cancel', '✕', () => {
          r.status = 'disabled'
          persist && persist.saveInstruction(r).catch(e => console.error('instruction save failed', e))
          logEdit('instruction_removed', r.text, null)
          changed(); paint()
        })
        del.title = 'Remove this instruction'
        row.appendChild(del)
      } else {
        row.title = isAutomatedInstruction(r)
          ? 'Made from a line on ' + (r.label ? r.label.replace(/^From /, '') : 'a person\u2019s card') + ' — edit or stop it there, under “What they handle”'
          : 'Managed on Setup & Prefs → Standing instructions'
      }
      list.appendChild(row)
    }
    body.appendChild(list)

    const ta = el('textarea', 'prs-instr-new')
    ta.rows = 2
    ta.placeholder = 'New instruction for messages from ' + name + '…'
    body.appendChild(ta)
    // a rule typed here can cover the sender's whole domain — the same record the Rules tab makes
    const domain = addr.includes('@') ? addr.slice(addr.indexOf('@')) : null
    let domainCb = null
    if (domain) {
      const opt = el('label', 'prs-instr-domainopt')
      domainCb = el('input')
      domainCb.type = 'checkbox'
      opt.appendChild(domainCb)
      opt.appendChild(span(null, 'Apply to everyone at ' + domain))
      body.appendChild(opt)
    }
    const acts = div('prs-actions')
    acts.appendChild(btn('pe-tbtn pe-tbtn-save', 'Add instruction', () => {
      const text = ta.value.trim()
      if (!text) return
      const wholeDomain = !!(domainCb && domainCb.checked && domain)
      const rec = iStore.add({
        scope: wholeDomain ? 'domain' : 'sender',
        match: wholeDomain ? domain : addr,
        text,
        asof: Date.now()
      })
      if (!rec) return
      if (Array.isArray(instructions)) instructions.push(rec) // future opens on this page see it
      persist && persist.saveInstruction(rec).catch(e => console.error('instruction save failed', e))
      logEdit('instruction_added', null, text + (wholeDomain ? ' (' + domain + ')' : ''))
      changed(); paint()
    }))
    acts.appendChild(btn('pe-tbtn', 'Done', () => close()))
    body.appendChild(acts)
    const manage = div('prs-hint')
    manage.appendChild(span(null, 'Account-wide and all-mail instructions live on '))
    const link = el('a', null, 'Setup & Prefs → Standing instructions')
    link.href = '/apps/com.salmanff.superlazy/setup'
    manage.appendChild(link)
    manage.appendChild(span(null, '.'))
    body.appendChild(manage)
  }

  paint()
  return { close }
}
