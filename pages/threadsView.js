// threadsView.js — the THREADS view of the shell page (shell.js): a mail client over everything
// superlazy has read. Column 1 lists every CONVERSATION (an email thread or a Slack stream/thread)
// as one summary row, newest activity first; choosing one fills columns 2 + 3 with THE email
// viewer (emailViewer.js, embedded via its `host` option) — the same message list and reading
// pane the modal shows, with Reply / Reply all / Forward (user, 2026-09-27, Mac Mail inspired).
//
// The row (Mail's message-list row, one per thread): who is on it (newest sender first, "You"
// for your own) · message count · date of the latest message | subject | the latest message's
// summary ("You: …" when you wrote last) | what superlazy knows: open to-dos (a dot when YOU owe
// something), an unsent suggested reply, auto-filed, the projects it belongs to.
//
// The chosen thread is unmistakable: its row is filled with the selection blue, and the pane
// opens with a banner naming the same thread (subject, count, people) above the viewer.
// The selection rides on the URL hash (#t=<thread id>) so a reload comes back to it.

import { buildThreads } from './threadsData.js'
import { openEmailViewer } from '../shared/emailViewer.js'
import { isLiveResponse } from '../shared/expandableProjectView.js'
import { createFilterBar, passesOnly, sharedSearch } from '../shared/filterBar.js'
import { getAccountFilter } from '../shared/mailTools.js'
import { setStatus } from '../shared/ui.js'
import { chatTitle, DIR_GLYPHS } from '../shared/renderUtils.js'
import { effImportance } from '../jobs/analyze_thread/dueDates.js'
import { loadInbox, inboxCached } from './threadsInbox.js'

const el = (id) => document.getElementById(id)
const mk = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
const PAGE = 150
// the conversations this view lists: mail threads and chat streams (agent sessions and notes are
// not conversations with anyone — they have their own pages)
const CHANNELS = new Set(['mail', 'messages'])

// Mail's list dates: a time today, the weekday this week, the day this year, else the full date
function listDate (ms) {
  const n = Number(ms); if (!n) return ''
  const d = new Date(n)
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  try {
    if (n >= startToday) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    if (n >= startToday - 86400000) return 'Yesterday'
    if (n >= startToday - 6 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'long' })
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' })
  } catch (e) { return '' }
}

export function createThreadsView ({ app, nameOf, getProject, projectName, mailCtx }) {
  const onlyKeys = new Set()
  let minImp = 0                // the priority filter (0 = all)
  let inboxBusy = false         // the live inbox listing is being fetched
  let hideAuto = true           // auto-filed-only threads (newsletters, receipts) start hidden
  let acctFilter = getAccountFilter()
  let limit = PAGE
  let fb = null
  let threads = []              // the filtered list as last painted
  let selectedId = null
  let viewer = null             // the embedded viewer handle { destroy, holdsTyping }
  let shown = false

  const selfSet = () => new Set((app.settings && app.settings.your_addresses || []).map(a => String(a).toLowerCase()))
  const who = (addr, self) => self.has(addr) ? 'You' : ((nameOf && nameOf(addr)) || String(addr || '').split('@')[0] || '?')

  // ---- the data ----------------------------------------------------------------------------------
  function allThreads () {
    const isLiveDraft = (r, p) => {
      if (!isLiveResponse(r, p)) return false
      return !(mailCtx && mailCtx.draftHandlers && mailCtx.draftHandlers.isStale && mailCtx.draftHandlers.isStale(null, r))
    }
    return buildThreads(app.events || [], app.store ? app.store.all() : [], { selfSet: selfSet(), isLiveDraft })
      .filter(t => CHANNELS.has(t.channel))
  }
  function matches (t, q, self) {
    if (!q) return true
    const hay = [t.subject, t.channel === 'messages' ? chatTitle(t.latest.subject) : '',
      ...t.senders, ...t.senders.map(a => who(a, self)),
      ...t.messages.slice(0, 5).map(m => m.summary),
      ...t.projectIds.map(projectName)].join(' \n').toLowerCase()
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(w => hay.includes(w))
  }
  // THE ITEM TEST (user, 2026-09-27): open to-dos, a direction and the priority floor are all
  // questions about the thread's TO-DOS, and they compose on the SAME to-do — "priority 4+ AND open
  // AND I owe" keeps a thread only when one to-do is all three at once (not one 4+ resolved item
  // plus some other open one). With none of them active, to-dos don't restrict anything.
  const DIRS = ['i_owe_them', 'they_owe_me', 'team_owes']
  function passesItems (t) {
    const wantOpen = onlyKeys.has('todos')
    const dir = DIRS.find(d => onlyKeys.has(d)) || null
    if (!wantOpen && !dir && !minImp) return true
    return (t.todos || []).some(({ todo }) =>
      (!wantOpen || todo.status === 'open' || todo.status === 'in_progress') &&
      (!dir || todo.direction === dir) &&
      (!minImp || effImportance(todo) >= minImp))
  }
  // 📬 — in an inbox right now (threadsInbox asks each mail server live)
  function inInbox (t, box) {
    if (!box) return true // still loading: don't blank the list meanwhile
    return box.threads.has(t.thread_id) || t.messages.some(m => box.msgs.has(m.msg_id))
  }
  function filtered () {
    const q = sharedSearch()
    const self = selfSet()
    const box = onlyKeys.has('inbox') ? inboxCached() : null
    return allThreads().filter(t =>
      (!acctFilter || t.account_id === acctFilter) &&
      (!hideAuto || !t.autoOnly) &&
      passesOnly(onlyKeys, (k) => k === 'mail' ? t.channel === 'mail'
        : k === 'inbox' ? t.channel === 'mail' && inInbox(t, box)
          : k === 'chat' ? t.channel === 'messages'
            : k === 'drafts' ? t.drafts > 0
              : true) && // the to-do questions are answered together, below
      passesItems(t) &&
      matches(t, q, self))
  }
  async function refreshInbox (force = false) {
    inboxBusy = true
    paintList()
    try {
      const box = await loadInbox({ force })
      if (box.problems.length) setStatus('Inbox check — ' + box.problems.join(' · '), 'error')
    } finally { inboxBusy = false }
    paintList()
  }

  // ---- column 1: the thread list -----------------------------------------------------------------
  function rowEl (t, self) {
    const row = mk('button', 'th-row' + (t.thread_id === selectedId ? ' active' : '') + (t.autoOnly ? ' th-auto' : ''))
    row.type = 'button'
    row.dataset.tid = t.thread_id
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(t.thread_id === selectedId))
    row.tabIndex = t.thread_id === selectedId ? 0 : -1
    // Mail's unread dot, re-purposed: YOU owe something on this thread
    if (t.mineOpen) { const d = mk('span', 'th-dot'); d.title = t.mineOpen + ' open to-do' + (t.mineOpen === 1 ? '' : 's') + ' you owe'; row.appendChild(d) }

    const top = mk('div', 'th-row-top')
    const isChat = t.channel === 'messages'
    const people = isChat ? '💬 ' + (chatTitle(t.latest.subject) || 'Chat') : t.senders.slice(0, 3).map(a => who(a, self)).join(', ') + (t.senders.length > 3 ? ' +' + (t.senders.length - 3) : '')
    top.appendChild(mk('span', 'th-who', people || '?'))
    if (t.count > 1) top.appendChild(mk('span', 'th-count', String(t.count)))
    const dt = mk('span', 'th-date', listDate(t.lastDate))
    try { dt.title = new Date(t.lastDate).toLocaleString() } catch (e) { /* no title */ }
    top.appendChild(dt)
    row.appendChild(top)

    if (!isChat) row.appendChild(mk('div', 'th-subj', t.subject || '(no subject)'))
    const sum = mk('div', 'th-sum')
    if (t.lastFromSelf) sum.appendChild(mk('span', 'th-you', 'You: '))
    else if (isChat && t.latest.from) sum.appendChild(mk('span', 'th-you', who(t.latest.from, self) + ': '))
    sum.appendChild(document.createTextNode(t.latest.summary || ''))
    row.appendChild(sum)

    const meta = mk('div', 'th-meta')
    if (t.openTodos) {
      const b = mk('span', 'th-badge th-badge-todo', '☐ ' + t.openTodos + ' open')
      b.title = t.openTodos + ' open to-do' + (t.openTodos === 1 ? '' : 's') + ' from this thread' + (t.mineOpen ? ' (' + t.mineOpen + ' yours)' : '')
      meta.appendChild(b)
    }
    if (t.drafts) {
      const b = mk('span', 'th-badge th-badge-draft', '↩ draft')
      b.title = 'An unsent suggested reply is waiting'
      meta.appendChild(b)
    }
    if (t.autoOnly) meta.appendChild(mk('span', 'th-badge th-badge-auto', '⚙ auto-filed'))
    const names = t.projectIds.map(projectName).filter(Boolean)
    if (names.length) {
      const pj = mk('span', 'th-projs', names.slice(0, 2).join(' · ') + (names.length > 2 ? ' +' + (names.length - 2) : ''))
      pj.title = names.join('\n')
      meta.appendChild(pj)
    }
    if (meta.childNodes.length) row.appendChild(meta)

    row.addEventListener('click', () => select(t.thread_id))
    return row
  }

  function paintList () {
    const list = el('thList')
    if (!list) return
    const scroll = list.scrollTop
    list.textContent = ''
    const all = filtered()
    threads = all.slice(0, limit)
    const self = selfSet()
    const head = mk('div', 'th-list-head')
    head.appendChild(mk('span', 'th-list-title', 'Threads'))
    head.appendChild(mk('span', 'th-list-n', all.length + (app.hasMoreEvents && app.hasMoreEvents() ? '+' : '')))
    if (onlyKeys.has('inbox')) {
      // the inbox is a live listing: say when it was read, and let it be read again
      const box = inboxCached()
      const r = mk('button', 'th-inbox-refresh', inboxBusy ? 'checking inboxes…' : (box ? '📬 as of ' + new Date(box.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) + ' ↻' : '📬'))
      r.type = 'button'; r.disabled = inboxBusy
      r.title = 'The inbox is read live from your mail accounts — click to check again'
      r.addEventListener('click', () => refreshInbox(true))
      head.appendChild(r)
    }
    list.appendChild(head)
    if (!threads.length) {
      list.appendChild(mk('div', 'th-empty', app.isLoading && app.isLoading() ? 'Loading…' : 'No threads match.'))
    }
    for (const t of threads) list.appendChild(rowEl(t, self))
    if (all.length > limit || (app.hasMoreEvents && app.hasMoreEvents())) {
      const more = mk('button', 'th-more', 'Show older threads')
      more.type = 'button'
      more.addEventListener('click', loadMore)
      list.appendChild(more)
    }
    list.scrollTop = scroll
    const cnt = el('thListCount'); if (cnt) cnt.textContent = String(all.length)
  }

  async function loadMore () {
    limit += PAGE
    let fetches = 0
    while (app.hasMoreEvents && app.hasMoreEvents() && filtered().length < limit && fetches < 4) {
      fetches++
      try { await app.loadOlderEvents() } catch (e) { setStatus('Could not load older mail: ' + ((e && e.message) || e), 'error'); break }
    }
    paintList()
  }

  // ---- columns 2 + 3: the chosen thread, in the embedded viewer ----------------------------------
  function paintEmptyPane () {
    const pane = el('thPane')
    if (!pane) return
    pane.textContent = ''
    const e = mk('div', 'th-pane-empty')
    e.appendChild(mk('div', 'th-pane-empty-ico', '✉️'))
    e.appendChild(mk('div', 'th-pane-empty-txt', 'Choose a thread'))
    e.appendChild(mk('div', 'th-pane-empty-sub', 'Its messages, to-dos and replies open here.'))
    pane.appendChild(e)
  }

  function select (tid, { fromHash = false } = {}) {
    if (tid === selectedId && viewer) { el('thCols').classList.add('th-has-sel'); return }
    if (viewer && viewer.holdsTyping() && !window.confirm('Discard the reply you are writing?')) return
    const t = allThreads().find(x => x.thread_id === tid)
    if (!t) return
    if (viewer) { viewer.destroy(); viewer = null }
    selectedId = tid
    // mark the row in place (no full repaint — keeps the list's scroll and focus)
    const list = el('thList')
    for (const r of list.querySelectorAll('.th-row')) {
      const on = r.dataset.tid === tid
      r.classList.toggle('active', on)
      r.setAttribute('aria-selected', String(on))
      r.tabIndex = on ? 0 : -1
      if (on) r.scrollIntoView({ block: 'nearest' })
    }
    el('thCols').classList.add('th-has-sel')
    if (!fromHash) {
      try { window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + '#t=' + encodeURIComponent(tid)) } catch (e) { /* hash is a convenience */ }
    }

    const pane = el('thPane')
    pane.textContent = ''
    // the banner: names the chosen thread in the same words as its row, so row ↔ pane can't be
    // mistaken — plus the back arrow a narrow screen needs
    const self = selfSet()
    const banner = mk('div', 'th-banner')
    const back = mk('button', 'th-back', '‹ Threads')
    back.type = 'button'
    back.addEventListener('click', () => { el('thCols').classList.remove('th-has-sel'); const r = list.querySelector('.th-row.active'); if (r) r.focus() })
    banner.appendChild(back)
    const txt = mk('div', 'th-banner-txt')
    txt.appendChild(mk('div', 'th-banner-subj', t.channel === 'messages' ? '💬 ' + (chatTitle(t.latest.subject) || 'Chat') : (t.subject || '(no subject)')))
    txt.appendChild(mk('div', 'th-banner-sub', t.count + ' message' + (t.count === 1 ? '' : 's') + ' · ' + t.senders.slice(0, 5).map(a => who(a, self)).join(', ')))
    banner.appendChild(txt)
    pane.appendChild(banner)
    const host = mk('div', 'th-viewer')
    pane.appendChild(host)
    viewer = openEmailViewer({ host, msg_id: t.latest.msg_id, thread_id: t.thread_id, account_id: t.account_id, subject: t.subject, snippet: t.latest.summary, prefer_latest: true })
  }

  function selectFromHash () {
    const m = /(?:^|[#&])t=([^&]+)/.exec(window.location.hash || '')
    if (!m) return false
    let tid = null
    try { tid = decodeURIComponent(m[1]) } catch (e) { return false }
    if (!tid) return false
    select(tid, { fromHash: true })
    return true
  }

  // ↑ / ↓ walk the list and open as they go (Mail's behaviour); Home / End jump
  function onListKey (e) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
    const rows = [...el('thList').querySelectorAll('.th-row')]
    if (!rows.length) return
    e.preventDefault()
    let i = rows.findIndex(r => r.dataset.tid === selectedId)
    if (e.key === 'ArrowDown') i = Math.min(rows.length - 1, i + 1)
    else if (e.key === 'ArrowUp') i = Math.max(0, i - 1)
    else if (e.key === 'Home') i = 0
    else i = rows.length - 1
    select(rows[i].dataset.tid)
    rows[i].focus({ preventScroll: true })
  }

  // the columns fill the window below the bars: the list and the pane scroll inside, like Mail
  function fitHeight () {
    const cols = el('thCols')
    if (!cols || !shown) return
    const top = cols.getBoundingClientRect().top
    cols.style.height = Math.max(360, window.innerHeight - top - 10) + 'px'
  }

  function paint () {
    if (fb && fb.refresh) fb.refresh()
    paintList()
    if (!selectedId && !selectFromHash()) paintEmptyPane()
    fitHeight()
  }

  function mount () {
    fb = createFilterBar(el('filterbar-threads'), {
      // the priority floor — a question about the thread's to-dos, answered together with the
      // open / direction buttons (passesItems)
      priority: { active: minImp, onChange: (v) => { minImp = v; limit = PAGE; paintList() } },
      only: {
        items: [
          // WHERE: Slack · all mail · just what is in an inbox now (one question, so one group)
          { key: 'chat', group: 'channel', icon: '💬', label: 'Slack', title: 'only Slack conversations' },
          { key: 'mail', group: 'channel', icon: '✉️', label: 'All mail', title: 'only email threads — every folder' },
          { key: 'inbox', group: 'channel', icon: '📬', label: 'Inbox', title: 'only email threads in an inbox right now (read live from your mail accounts)' },
          // the to-do questions — the dashboard's own buttons
          { key: 'todos', group: 'status', icon: '☐', label: 'Open to-dos', title: 'only threads with a to-do still open (combines with priority and the direction buttons: the SAME to-do must match all)' },
          { key: 'i_owe_them', group: 'dir', icon: DIR_GLYPHS.i_owe_them, label: 'I owe', title: 'only threads with a to-do on YOUR plate' },
          { key: 'they_owe_me', group: 'dir', icon: DIR_GLYPHS.they_owe_me, label: 'Owed to you', title: 'only threads with a to-do others owe you' },
          { key: 'team_owes', group: 'dir', icon: DIR_GLYPHS.team_owes, label: 'Team owes', title: 'only threads with a to-do the team owes' },
          { key: 'drafts', group: 'draft', icon: '↩', label: 'Drafts', title: 'only threads with an unsent suggested reply' }
        ],
        onChange: (key, on) => {
          // (pressing a button releases its group-mates — filterBar fires their onChange(false))
          if (on) onlyKeys.add(key); else onlyKeys.delete(key)
          limit = PAGE
          if (key === 'inbox' && on) refreshInbox(false); else paintList()
        }
      },
      hide: {
        items: [{ key: 'auto', icon: '⚙', label: 'Auto-filed threads', title: 'threads made only of mail the automation filed without a read (newsletters, receipts…)', active: true }],
        onChange: (key, hidden) => { if (key === 'auto') { hideAuto = hidden; limit = PAGE; paintList() } }
      },
      search: {
        placeholder: 'Search threads — people, subject, summary, project…',
        onChange: () => { limit = PAGE; paintList() }
      }
    })
    el('thList').addEventListener('keydown', onListKey)
    const btn = el('thListBtn')
    if (btn) btn.addEventListener('click', () => el('thCols').classList.remove('th-has-sel'))
    window.addEventListener('resize', fitHeight)
  }

  function show () {
    shown = true
    const host = el('view-threads'); if (host) host.style.display = ''
    // full width, like Events: three columns need the room (the shell caps #app at 1180px)
    const appEl = el('app'); if (appEl) appEl.classList.remove('su')
    paint()
  }
  function hide () {
    shown = false
    const host = el('view-threads'); if (host) host.style.display = 'none'
    const appEl = el('app'); if (appEl) appEl.classList.add('su')
  }
  async function onReload () {
    paintList()
    // new data: rebuild the open thread too — unless a reply is being written in it
    if (selectedId && viewer && !viewer.holdsTyping()) { const id = selectedId; selectedId = null; select(id, { fromHash: true }) }
  }
  function onAccountChange (v) { acctFilter = v; limit = PAGE }
  function onVisible () {
    if (Date.now() - (app.lastLoadedAt || 0) > 60000) app.reload().catch(e => console.error('refresh failed', e))
    else paintList()
  }
  function onHashChange () { selectFromHash() }

  return { key: 'threads', mount, show, hide, paint, onReload, onAccountChange, onVisible, onHashChange }
}
