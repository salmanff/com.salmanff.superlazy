// addFlows.js — the two ways to make something BY HAND: a project, or a meeting note for the
// analyser to read. One definition each, so every entry point behaves identically.
//
// Entry point today: the project board's filter bar (filterBar's `add` slot, wired in index.js).
// Until 2026-09-16 there was also a "＋ Add…" chooser in the topbar tools slot on every page;
// the user removed it in favour of the board's own section, so creating a project or a note now
// starts on the Dashboard. (If another view ever needs them, import these — do not re-implement.)
//
// Both take the same opts object:
//   persist          — createPersistence (the note flow persists + analyses through it)
//   getProjects()    — the page's LIVE projects (note modal picker + project create repaint)
//   getPeople()      — [{ address, name }] for the attendees autocomplete (may be [])
//   getAuthor()      — the user's own address (note author)
//   onCreated()      — repaint/reload after either flow completes
//   onProjectCreated(p) — optional: called with the new live project (e.g. open its modal);
//                         defaults to onCreated
// Project creation goes through ui.js projectOps.create, which relies on the host having wired
// setProjectCreator + setProjectSaver (the shell does).

import { projectOps } from '../shared/ui.js'
import { openNewProjectModal } from './newProjectModal.js'
import { openNewNoteModal } from './newNoteModal.js'

// "＋ Project": name it, pick a priority, and land in its own card on the "+ Add" tab.
export function addProjectFlow (opts = {}) {
  openNewProjectModal({
    onCreate: (name, importance) => projectOps.create(name, importance),
    onCreated: (p) => {
      if (opts.onProjectCreated) opts.onProjectCreated(p)
      else if (opts.onCreated) opts.onCreated()
    }
  })
}

// "＋ Meeting note": free text the analyser reads and turns into tasks against a project.
export function addNoteFlow (opts = {}) {
  openNewNoteModal({
    persist: opts.persist,
    projects: (opts.getProjects ? opts.getProjects() : []).filter(p => p && p.status !== 'archived'),
    people: opts.getPeople ? opts.getPeople() : [],
    authorAddress: opts.getAuthor ? opts.getAuthor() : '',
    onDone: () => { if (opts.onCreated) opts.onCreated() }
  })
}
