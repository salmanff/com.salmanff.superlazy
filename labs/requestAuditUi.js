// requestAuditUi.js — DOM rendering for the Request Audit Lab: page totals, one card per request
// chain (the analysis call + its follow-on rounds), and per exchange the cost lines by part, the
// turns that were sent (the cached durable turn loads on demand from its blob), the reply, the
// thinking and the raw usage. Pure rendering — data shapes come from requestAuditData.js.

const el = (tag, cls, text) => {
  const d = document.createElement(tag)
  if (cls) d.className = cls
  if (text != null) d.textContent = text
  return d
}
const money = (n) => '$' + (Number(n) || 0).toFixed(4)
const kchars = (n) => (Number(n) || 0).toLocaleString() + ' chars'
const when = (ms) => { try { return new Date(Number(ms)).toLocaleString() } catch (e) { return String(ms) } }
const secs = (ms) => ms != null ? (Number(ms) / 1000).toFixed(1) + 's' : '—'

export function setStatus (text, cls) {
  const s = document.getElementById('raStatus')
  s.textContent = text
  s.className = 'ra-status' + (cls ? ' ' + cls : '')
}

function detailsBlock (title, body, { cls = '', open = false } = {}) {
  const d = el('details', 'ra-block' + (cls ? ' ' + cls : ''))
  if (open) d.open = true
  d.appendChild(el('summary', null, title))
  const pre = el('pre', null, typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  d.appendChild(pre)
  return d
}

// a details block whose text arrives only when opened (the durable-turn blob)
function lazyBlock (title, loader, { cls = '' } = {}) {
  const d = el('details', 'ra-block' + (cls ? ' ' + cls : ''))
  d.appendChild(el('summary', null, title))
  const pre = el('pre', null, '(open to load)')
  d.appendChild(pre)
  let loaded = false
  d.addEventListener('toggle', async () => {
    if (!d.open || loaded) return
    loaded = true
    pre.textContent = 'loading…'
    try { const t = await loader(); pre.textContent = t != null ? t : '(blob not found — pruned or never stored)' } catch (e) { pre.textContent = 'load failed: ' + ((e && e.message) || e) }
  })
  return d
}

function eqMark (isEq) {
  if (!isEq) return null
  const s = el('span', 'ra-eq', 'eq')
  s.title = 'equivalent price: this call ran on a $0 local connector and is priced as the same model via the API'
  return s
}

export function renderTotals (host, runs) {
  host.textContent = ''
  let calls = 0, chains = 0, billed = 0, eq = 0, rd = 0, wr = 0, inp = 0, out = 0
  for (const r of runs) {
    billed += r.total; eq += r.eqTotal
    for (const c of r.chains) {
      chains++
      for (const x of c.exchanges) { calls++; const t = x.breakdown.tokens; rd += t.cache_read; wr += t.cache_write; inp += t.input; out += t.output }
    }
  }
  const cell = (label, value, extra) => { const s = el('span'); s.appendChild(el('span', null, label + ' ')); const b = el('b', null, value); s.appendChild(b); if (extra) s.appendChild(extra); host.appendChild(s) }
  cell('runs', String(runs.length))
  cell('requests', String(chains))
  cell('LLM calls', String(calls))
  cell('billed', money(billed))
  if (eq) cell('equivalent', money(eq), eqMark(true))
  cell('cache read', rd.toLocaleString() + ' tok')
  cell('cache write', wr.toLocaleString() + ' tok')
  cell('new input', inp.toLocaleString() + ' tok')
  cell('output', out.toLocaleString() + ' tok')
  if (wr > rd && calls > 3) {
    const w = el('span', 'ra-eq', '⚠ more written to cache than read — the cache is not paying off')
    host.appendChild(w)
  }
}

export function renderSystemPrompt (host, { text, version, versionsSeen }) {
  host.textContent = ''
  const other = versionsSeen.filter(v => v && v !== version)
  const title = 'system prompt v' + version + ' · ' + kchars(text.length) + ' · identical on every call (cached)' +
    (other.length ? ' — NOTE: some recorded exchanges used v' + other.join(', v') + '; their system prompt text is not stored' : '')
  host.appendChild(detailsBlock(title, text, { cls: 'cached' }))
}

function costTable (bd) {
  const t = el('table', 'ra-cost')
  for (const l of bd.lines) {
    const tr = el('tr', l.tokens ? '' : 'zero')
    tr.appendChild(el('td', null, l.label))
    tr.appendChild(el('td', 'n', l.tokens.toLocaleString() + ' tok'))
    const rate = el('td', 'n ra-rate', l.rate != null ? '@ $' + Number(l.rate).toFixed(2) + '/M' : '')
    tr.appendChild(rate)
    tr.appendChild(el('td', 'n', money(l.cost)))
    t.appendChild(tr)
  }
  const tot = el('tr', 'total')
  tot.appendChild(el('td', null, bd.eq ? 'total (equivalent, priced as ' + bd.priced_as + ')' : bd.unpriced ? 'total — NO PRICE ON FILE for this model' : 'total'))
  tot.appendChild(el('td', 'n', ''))
  tot.appendChild(el('td', 'n ra-rate', bd.server != null && Math.abs(bd.server - bd.computed) > 0.00005 ? 'server says ' + money(bd.server) : ''))
  const td = el('td', 'n', money(bd.total)); const m = eqMark(bd.eq); if (m) td.appendChild(m); tot.appendChild(td)
  t.appendChild(tot)
  return t
}

function exchangeCard (x, { loadBlob }) {
  const card = el('div', 'ra-ex')
  const head = el('div', 'ra-ex-head')
  const kind = x.phase === 'repair' ? 'repair' : (x.exchange_kind === 'detail' ? 'detail' : 'analysis')
  head.appendChild(el('span', 'ra-ex-round ' + kind, 'round ' + (x.round || 1) + ' · ' + kind))
  head.appendChild(el('span', null, (x.model || '?') + (x.provider ? ' · ' + x.provider : '')))
  head.appendChild(el('span', 'ra-muted', when(x.at) + ' · ' + secs(x.duration_ms)))
  const o = x.opts || {}
  head.appendChild(el('span', 'ra-muted', 'max_tokens ' + (o.max_tokens || '?') + ' · thinking ' + JSON.stringify(o.thinking) + (o.effort ? ' · effort ' + o.effort : '') + ' · cache ' + (o.cache ? JSON.stringify(o.cache) : 'off')))
  const cost = el('span', 'ra-ex-cost', money(x.breakdown.total)); const m = eqMark(x.breakdown.eq); if (m) cost.appendChild(m)
  head.appendChild(cost)
  card.appendChild(head)
  if (x.error) card.appendChild(el('div', 'ra-ex-err', '✗ ' + x.error))
  card.appendChild(costTable(x.breakdown))

  const turns = x.turns || []
  turns.forEach((t, i) => {
    const label = 'sent turn ' + (i + 1) + '/' + turns.length + ' — ' + t.role + ' · ' + kchars(t.chars) +
      (t.cached ? ' — CACHED (durable turn: situation + catalog + auto-process rules; cache breakpoint here)' : (i === turns.length - 1 ? ' — VOLATILE (this request: people, linked projects, thread, message)' : ''))
    if (t.blob) card.appendChild(lazyBlock(label, () => loadBlob(t.blob), { cls: 'cached' }))
    else card.appendChild(detailsBlock(label, t.text || '', { cls: t.cached ? 'cached' : (i === turns.length - 1 ? 'volatile' : '') }))
  })
  if (x.thinking) card.appendChild(detailsBlock('received THINKING · ' + kchars(x.thinking.length) + ' (billed as output)', x.thinking))
  card.appendChild(detailsBlock('received reply · ' + kchars((x.response || '').length), x.response || '(empty)'))
  card.appendChild(detailsBlock('raw usage + pricing (as the server reported them)', { tokensUsed: x.meta && x.meta.tokensUsed, rawUsage: x.meta && x.meta.rawUsage, pricing: x.meta && x.meta.pricing, cost: x.meta && x.meta.cost }))
  return card
}

function chainCard (c, opts) {
  const card = el('div', 'ra-chain' + (c.error ? ' error' : (c.exchanges.length > 1 ? ' multi' : '')))
  const head = el('div', 'ra-chain-head')
  head.appendChild(el('span', 'ra-chain-title', (c.subject || '(no subject)') + (c.batch > 1 ? ' (+' + (c.batch - 1) + ' more in one request)' : '')))
  const rounds = c.exchanges.length
  head.appendChild(el('span', 'ra-chain-meta', when(c.first) + ' · ' + rounds + ' call' + (rounds === 1 ? '' : 's') +
    (rounds > 1 ? ' (' + c.exchanges.slice(1).map(x => x.phase === 'repair' ? 'repair' : 'detail').join(', ') + ')' : '') +
    (c.msg_ids.length ? ' · ' + c.msg_ids.length + ' msg' : '')))
  const cost = el('span', 'ra-chain-cost', money(c.total)); const m = eqMark(c.eq); if (m) cost.appendChild(m)
  head.appendChild(cost)
  card.appendChild(head)
  const body = el('div', 'ra-chain-body')
  body.hidden = true
  head.addEventListener('click', () => { body.hidden = !body.hidden; if (!body.hidden && !body.childNodes.length) for (const x of c.exchanges) body.appendChild(exchangeCard(x, opts)) })
  card.appendChild(body)
  return card
}

export function renderRuns (host, runs, opts) {
  host.textContent = ''
  if (!runs.length) { host.appendChild(el('div', 'ra-empty', 'Nothing recorded in this window. Turn recording on, let a check run, then Refresh.')); return }
  for (const r of runs) {
    const h = el('div', 'ra-run')
    h.appendChild(el('span', null, (r.driver === 'job' ? 'background run' : r.driver === 'tab' ? 'foreground check' : r.driver === 'inspect' ? 'inspect page' : 'run') + ' · ' + when(r.first)))
    h.appendChild(el('span', 'ra-run-id', r.run_id))
    h.appendChild(el('span', 'ra-muted', r.chains.length + ' request' + (r.chains.length === 1 ? '' : 's')))
    const tot = el('span', 'ra-run-total', money(r.total) + (r.eqTotal ? ' + ' + money(r.eqTotal) : ''))
    const m = eqMark(!!r.eqTotal); if (m) tot.appendChild(m)
    if (r.unpriced) tot.appendChild(el('span', 'ra-eq', r.unpriced + ' unpriced'))
    h.appendChild(tot)
    host.appendChild(h)
    for (const c of r.chains) host.appendChild(chainCard(c, opts))
  }
}
