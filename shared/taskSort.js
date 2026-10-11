// taskSort.js — the sort keys every task list shares, plus THE HOLD that keeps a list still
// while you re-price it.
//
// THE PROBLEM (user, 2026-08-31): every task list is sorted by priority (or by date last
// touched, which a priority edit also bumps). So nudging a row's ▴/▾ re-sorted the list under
// the cursor and the task you were working on vanished up or down the page — the one moment a
// stable list matters most.
//
// THE RULE: an edit never re-sorts. The FIRST priority change to a task freezes the sort keys
// it had at that moment (its priority AND its last-touch time), so it keeps its place however
// many times you nudge it afterwards. The list is now knowingly out of order, so the sort
// control says so (isSortHeld) and clicking it — the user asking for an order — releases every
// hold and re-sorts (releaseSortHold). Tab switches and full reloads release it too.
//
// Holds are keyed by todo_id and live in memory only: they are a UI courtesy for the current
// glance at the list, never data.

import { effImportance } from '../jobs/analyze_thread/dueDates.js'

const heldImp = new Map() // todo_id -> the priority to KEEP SORTING BY
const heldTouch = new Map() // todo_id -> the last-touch ms to KEEP SORTING BY

// when a task was last touched — EXACTLY the date its row displays (created / resolved / latest
// evidence). The canonical copy: recent.js and expandableProjectView.js both read it from here.
export function lastTouchOf (t) {
  let m = Math.max(Number(t && t.created_asof) || 0, Number(t && t.resolved_asof) || 0)
  for (const e of ((t && t.evidence) || [])) m = Math.max(m, Number(e.asof) || 0)
  return m
}

// Called from ui.js the instant BEFORE a priority edit lands, with the values the row is
// currently sorted on. First call per task wins — a second nudge must not re-freeze on the
// already-changed value, or the row would creep after all.
export function holdSortKeys (todo) {
  const id = todo && todo.todo_id
  if (!id || heldImp.has(id)) return
  heldImp.set(id, effImportance(todo))
  heldTouch.set(id, lastTouchOf(todo))
}

// the sort keys — identical to the live ones unless this task is being held
export function sortImportanceOf (t) {
  const id = t && t.todo_id
  return (id && heldImp.has(id)) ? heldImp.get(id) : effImportance(t)
}
export function sortTouchOf (t) {
  const id = t && t.todo_id
  return (id && heldTouch.has(id)) ? heldTouch.get(id) : lastTouchOf(t)
}

// is ANY list currently held out of order? (drives the sort control's "out of whack" highlight)
export function isSortHeld () { return heldImp.size > 0 }

// the user asked for an order (clicked a sort control), switched tab, or reloaded — let go
export function releaseSortHold () { heldImp.clear(); heldTouch.clear() }
