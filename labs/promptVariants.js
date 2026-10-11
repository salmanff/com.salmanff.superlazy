// promptVariants.js — LAB ONLY. Prompt arms for the agents-lab A/B (agentslabRun's promptOverride).
//
// An arm is expressed as EXACT search/replace pairs against the shipped SYSTEM_PROMPT, never as a
// copy of it: the control and the variant then differ by precisely the edits listed here, and the
// variant cannot silently rot when prompt.js moves on. Every `find` must match EXACTLY ONCE or
// buildVariant throws — a silently-unapplied edit would make an arm look like a null result.
//
// Nothing here ships to production. analyze.js uses its own SYSTEM_PROMPT unless a lab run passes
// an override, so no production path can reach this file.

import { SYSTEM_PROMPT, PROMPT_VERSION } from '../jobs/analyze_thread/prompt.js'

// ---- arm B: "goals & granularity" ---------------------------------------------------------------
// The thesis: the guide tells the model to track "one to-do per meaningful outcome at a scale the
// user would recognise" but gives it no way to DECIDE that scale, so in practice the line lands
// wherever the TURN happened to land — which is how one channel-named project reached 130 rows of
// steps. These edits make the project's GOAL the ruler, so granularity is judged relative to it
// (context-dependent) rather than in the abstract.
//
// ALL THREE EDITS SIT INSIDE "## Channel guide: work" (user, 2026-09-20: "the prompt changes should
// be more explicit and put into the ## Channel guide: work area — as what becomes a project").
// Nothing in the all-channel block is touched, so a null result here cannot be blamed on mail.
const GOALS_AND_GRANULARITY = [
  {
    id: 'what-becomes-a-project',
    why: 'names the project as a GOAL stated in done-terms; treats the session/repo boundary as carrying NO information either way (a session may well be exactly one goal), while still forbidding the place-naming that produced "Superlazy — work-sessions channel (Claude Code)"',
    find: '- PROJECTS FROM A SESSION: one per OUTCOME the user would name if asked what they are working on — usually one to three per session, rarely more, rarely fewer when the session did several distinct things. The test is the user\'s own framing: what they asked for, the plan they approved, the thing they would report as done.',
    replace: '- WHAT BECOMES A PROJECT: a project is a GOAL — ONE thing the user is trying to achieve, stated so that anyone could tell whether it has been reached. Write the summary\'s opening in exactly those terms: "obligations get assigned to the person actually responsible", never "work on the assignment logic". One project per goal the user would name if asked what they are working on — usually one to three per session, rarely more, rarely fewer when the session did several distinct things. The test is the user\'s own framing: what they asked for, the plan they approved, the thing they would report as done. THE SESSION AND REPO BOUNDARIES TELL YOU NOTHING about where a goal starts or ends: sometimes one session IS exactly one goal, often several sessions serve one goal, and one long session often serves two or three. Judge by the goal, never by the container. What is always wrong is NAMING a project after the channel, the repo, the agent or the session ("the sessions channel", "the X repo work") — those name a PLACE, and a place has no finish; if a place name is the only one that fits, the goal has not been identified yet.'
  },
  {
    id: 'goal-is-the-ruler',
    why: 'the missing test, made explicit: project = goal, to-do = sub-goal, "- " line = step, each judged against THIS project\'s goal rather than in the abstract',
    find: '- ONE TO-DO PER OUTCOME, its components INSIDE it. A session makes many small moves; they are components of one deliverable, not siblings.',
    replace: '- THE GOAL IS THE RULER. The project is the GOAL; a TO-DO is a SUB-GOAL — something that, once finished, visibly moves that goal forward and that the user would name if asked "what is left?"; a "- " CHECKLIST LINE is a STEP — it matters to whoever is doing the to-do, and the user would mention it only if asked HOW the work was done. Judge every candidate against THIS project\'s goal, never in the abstract: the same piece of work is a whole project in one place and one to-do inside a bigger goal in another. Two tests, in order. (1) THE PROGRESS-REPORT TEST: if the user had to report progress on this goal to whoever is waiting on it, would this line appear? A sub-goal is what goes in that report ("the connector is ported and under test"); a step is what they would only say if asked how it was done ("re-ran the probe", "fixed the lint"). If it would not appear in the report it is a STEP — put it on a "- " line inside the to-do it serves, do not give it a row. (2) THE NO-NEARER TEST: could it be finished and leave the goal no nearer? If so it is not a sub-goal: it is a step, or it belongs to a different project. ONE TO-DO PER OUTCOME, its components INSIDE it. A session makes many small moves; they are components of one deliverable, not siblings.'
  },
  {
    id: 'goal-defined-elsewhere',
    why: 'the guide links across channels at TO-DO level only (":362 … an open to-do that came from a PERSON"). For a real dev the GOAL usually arrives as a spec, plan or brief in another channel, so the session must match that project rather than restate it — and must not narrow its goal to the slice this session touched',
    find: 'Inherit importance from the ask served.',
    replace: 'Inherit importance from the ask served. THE SAME APPLIES TO THE GOAL ITSELF: a project\'s goal is often defined OUTSIDE the session — a spec or project plan pasted in as a note, a brief agreed by mail or chat, a request from a colleague. Before starting a project, look through the CATALOG for one whose goal this work serves, whatever channel it was born in, and file the work there. When the goal is already written, KEEP it: do NOT rewrite a project\'s goal to the slice this session happened to touch, because a session usually advances PART of a goal rather than all of it. Widen or restate a goal only when the user\'s own words in this session actually change the scope.'
  },
  {
    id: 'step-examples-and-valve',
    why: 'the guide has one positive example and no negative ones; adds the three shapes that actually leak through, plus the pressure valve against a runaway list',
    find: '"Port the OpenAI connector to the Responses API" is the to-do; "run the probe", "fix the lint" are at most "- " lines under it.',
    replace: '"Port the OpenAI connector to the Responses API" is the to-do; "run the probe", "fix the lint" are at most "- " lines under it. Three shapes that are STEPS, never rows of their own — each belongs on a "- " line of the outcome it serves: (a) a row naming an internal mechanism instead of a result ("chain the reads for the unread stores", "scope the verdict block to the thread"); (b) a row bundling two fixes ("fix the search operator and the event leak" — two steps, and usually two different goals); (c) a row that just restates the turn ("answer the question about X", "review the draft"). When the project ALREADY carries many open to-dos, treat that as evidence its lines were drawn too low rather than as room for one more row: find the open to-do this is a step of and say so in change_reason. A project whose open list has grown past what a person would read in one go is a project whose to-dos are steps.'
  }
]

// SHIPPED 2026-09-20 as prompt 0.57 — the four GOALS_AND_GRANULARITY edits above are now IN
// prompt.js, so the arm is retired and kept only as the record of what was tested. Its anchors no
// longer match (the shipped prompt IS the variant), so re-registering it here would throw by
// design. The next experiment adds its own entry to VARIANTS; the machinery below is the point.
const VARIANTS = {
  control: {
    id: 'control',
    label: 'shipped prompt (control)',
    edits: []
  }
}

export const VARIANT_LIST = Object.values(VARIANTS).map(v => ({ id: v.id, label: v.label, edits: v.edits.length }))

/**
 * Build an arm's system prompt. Returns { id, label, version, text, applied[] } — or null for the
 * control, which is the caller's signal to pass no override at all (so the control is literally the
 * shipped path, not a rebuilt copy of it).
 * @throws if any edit's `find` does not occur exactly once in the base prompt.
 */
export function buildVariant (id, base = SYSTEM_PROMPT, baseVersion = PROMPT_VERSION) {
  const v = VARIANTS[id]
  if (!v) throw new Error('promptVariants: unknown arm "' + id + '"')
  if (!v.edits.length) return null

  let text = base
  const applied = []
  for (const e of v.edits) {
    const n = text.split(e.find).length - 1
    if (n !== 1) {
      throw new Error('promptVariants: arm "' + id + '" edit "' + e.id + '" matched ' + n +
        ' times (need exactly 1) — prompt.js has moved; update the find string before running an arm.')
    }
    text = text.replace(e.find, e.replace)
    applied.push({ id: e.id, why: e.why, removed: e.find.length, added: e.replace.length })
  }
  return {
    id: v.id,
    label: v.label,
    version: baseVersion + '+' + v.id,
    text,
    applied,
    baseChars: base.length,
    chars: text.length
  }
}
