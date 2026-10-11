// topbar.js — shared top bar for every page: superlazy logo + page title on the left, the page
// menu right-aligned on the right. Each page's entry script calls renderTopBar(pageKey) once its
// #topbar div is in the DOM. Pages not in MENU_PAGES (replay, styleguide, cleanup, …) still
// get a title but are left out of the menu itself.
//
// SHELL SUPPORT: the shell page (shell.js) hosts several views under one document. It passes
// { onNavigate } — a click on a menu item calls onNavigate(key) first, and when that returns true
// (the shell switched views in place) the anchor's normal navigation is suppressed. Plain pages
// call renderTopBar(pageKey) exactly as before and get plain links. setActiveTopBarPage(key)
// re-paints ONLY the title + menu marker, leaving #topbarTools (the mail tools) untouched.

import { openModalShell } from './modalStack.js'

const BASE = '/apps/com.salmanff.superlazy/'

const MENU_PAGES = [
  { key: 'index', href: 'index', menu: 'Projects', title: 'Project Dashboard' },
  { key: 'recent', href: 'recent', menu: 'To-dos', title: 'To-dos' },
  { key: 'threads', href: 'threads', menu: 'Threads', title: 'Threads' },
  { key: 'people', href: 'people', menu: 'People', title: 'View People' },
  { key: 'events', href: 'events', menu: 'Events', title: 'Events (Chronological)' },
  { key: 'setup', href: 'setup', menu: 'Setup & Prefs', title: 'Setup & Prefs' }
]

const OTHER_TITLES = {
  replay: 'Replay (demo)',
  styleguide: 'Style Guide',
  cleanup: 'Clean-up',
  requestauditlab: 'Request Audit Lab'
}

function logoSrc () {
  if (typeof freezr !== 'undefined' && freezr.utils && freezr.utils.appFilePathFrom) {
    return 'static/logo.png'
  }
  return BASE + 'static/logo.png'
}

let barState = null // { pageKey, onNavigate } — lets setActiveTopBarPage repaint without a rebuild
let pagesDrawer = null

function navMarkup () {
  return MENU_PAGES.map((p) => p.key === barState.pageKey
    ? '<span class="sl-topbar-here" aria-current="page">' + p.menu + '</span>'
    : '<a href="' + BASE + p.href + '" data-navkey="' + p.key + '">' + p.menu + '</a>'
  ).join('')
}

function navigate (e) {
  const a = e.target.closest?.('a[data-navkey]')
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
  pagesDrawer?.close()
  if (barState?.onNavigate?.(a.dataset.navkey)) e.preventDefault()
}

function openPages (trigger) {
  if (pagesDrawer) return
  const mobile = window.matchMedia('(max-width: 900px)')
  const app = document.getElementById('app')
  const wasInert = app?.inert
  const overflow = document.body.style.overflow
  const onResize = () => { if (!mobile.matches) pagesDrawer?.close() }
  const drawer = openModalShell({
    className: 'sl-pages-drawer',
    onClose: () => {
      pagesDrawer = null
      trigger.setAttribute('aria-expanded', 'false')
      if (app) app.inert = wasInert
      document.body.style.overflow = overflow
      mobile.removeEventListener('change', onResize)
      if (trigger.isConnected && mobile.matches) trigger.focus({ preventScroll: true })
    }
  })
  pagesDrawer = drawer
  drawer.overlay.classList.add('sl-pages-overlay')
  drawer.modal.id = 'sl-pages-drawer'
  drawer.modal.setAttribute('role', 'dialog')
  drawer.modal.setAttribute('aria-modal', 'true')
  drawer.modal.setAttribute('aria-labelledby', 'sl-pages-heading')
  drawer.modal.querySelector('button').setAttribute('aria-label', 'Close pages menu')
  const content = document.createElement('div')
  content.innerHTML = '<h2 id="sl-pages-heading">Pages</h2><nav class="sl-pages-nav" aria-label="Pages">' + navMarkup() + '</nav>'
  drawer.modal.appendChild(content)
  content.addEventListener('click', navigate)
  drawer.modal.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return
    const items = [...drawer.modal.querySelectorAll('button, a[href]')]
    const first = items[0]; const last = items[items.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === drawer.modal)) {
      e.preventDefault(); last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus()
    }
  })
  if (app) app.inert = true
  document.body.style.overflow = 'hidden'
  trigger.setAttribute('aria-expanded', 'true')
  mobile.addEventListener('change', onResize)
  drawer.modal.querySelector('button').focus({ preventScroll: true })
}

function paintTitleAndNav () {
  if (!barState) return
  const current = MENU_PAGES.find(p => p.key === barState.pageKey)
  const title = current ? current.title : (OTHER_TITLES[barState.pageKey] || '')
  const h1 = document.querySelector('#topbar .sl-topbar-title')
  if (h1) h1.textContent = title
  const nav = document.querySelector('#topbar .sl-topbar-nav')
  if (nav) {
    nav.innerHTML = navMarkup()
  }
}

export function renderTopBar (pageKey, { onNavigate = null } = {}) {
  const host = document.getElementById('topbar')
  if (!host) return

  pagesDrawer?.close()
  barState = { pageKey, onNavigate }

  // #topbarTools (Check Mail + account picker — mailTools.js mounts into it) sits next to the
  // title; #topbarNote is the small grey status line under it.
  host.innerHTML =
    '<div class="sl-topbar">' +
      '<div class="sl-topbar-left">' +
        '<img class="sl-topbar-logo" src="' + logoSrc() + '" alt="superlazy">' +
        '<div class="sl-topbar-titlewrap">' +
          '<div class="sl-topbar-titlerow">' +
            '<h1 class="sl-topbar-title"></h1>' +
            '<span id="topbarTools" class="sl-topbar-tools"></span>' +
          '</div>' +
          '<div id="topbarNote" class="sl-topbar-note"></div>' +
        '</div>' +
      '</div>' +
      '<nav class="sl-topbar-nav" aria-label="Pages"></nav>' +
      '<button type="button" class="sl-pages-button" aria-haspopup="dialog" aria-expanded="false" aria-controls="sl-pages-drawer"><span aria-hidden="true">☰</span> Pages</button>' +
    '</div>'

  // in-shell view switching: let modified clicks (new tab / window) follow the real href
  const nav = host.querySelector('.sl-topbar-nav')
  nav.addEventListener('click', navigate)
  const pagesButton = host.querySelector('.sl-pages-button')
  pagesButton.addEventListener('click', () => openPages(pagesButton))

  paintTitleAndNav()
}

// Shell view switches: update the title + the menu's "you are here" marker in place.
export function setActiveTopBarPage (pageKey) {
  if (!barState) return
  pagesDrawer?.close()
  barState.pageKey = pageKey
  paintTitleAndNav()
}
