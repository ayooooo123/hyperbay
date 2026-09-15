// Hyperbay UI. Vanilla ES module: one observable store, a hash router, five
// screen renderers. Runs identically in the Pear renderer (direct api) and in
// a browser served by the gateway (http api). Every remote string reaches the
// DOM through textContent or esc(); artifact fields are hostile input.

import { icon } from './icons.mjs'
import { createHttpApi } from './http-api.mjs'
import { createPipeApi } from './pipe-api.mjs'

// ---------------------------------------------------------------------------
// Helpers

const MAX_ROWS = 400
const PAGE = 50
const SPARK_SAMPLES = 90
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// el('div.cls', { attrs }, ...children). Children: string → text node, node,
// array, null. `html` prop is for STATIC markup only (icons); never remote.
function el (spec, props, ...kids) {
  if (props && (props instanceof Node || typeof props !== 'object' || Array.isArray(props))) { kids.unshift(props); props = null }
  const [tag, ...classes] = spec.split('.')
  const node = document.createElement(tag || 'div')
  if (classes.length) node.className = classes.join(' ')
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') node.className += (node.className ? ' ' : '') + v
    else if (k === 'html') node.innerHTML = v
    else if (k === 'text') node.textContent = v
    else if (k === 'dataset') Object.assign(node.dataset, v)
    else if (k === 'style') node.style.cssText = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k in node && typeof v === 'boolean') node[k] = v
    else node.setAttribute(k, v === true ? '' : v)
  }
  append(node, kids)
  return node
}

function append (node, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue
    if (Array.isArray(k)) append(node, k)
    else node.append(k instanceof Node ? k : document.createTextNode(String(k)))
  }
  return node
}

const ico = (name, cls) => el('span.ico', { class: cls, html: icon(name) })
const clear = (node) => { while (node.firstChild) node.removeChild(node.firstChild); return node }

function fmtBytes (n) {
  n = Number(n) || 0
  if (n < 1024) return `${n} B`
  const u = ['KB', 'MB', 'GB', 'TB', 'PB']
  let i = -1
  do { n /= 1024; i++ } while (n >= 1024 && i < u.length - 1)
  return `${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)} ${u[i]}`
}
const fmtRate = (n) => `${fmtBytes(n)}/s`
const fmtInt = (n) => (Number(n) || 0).toLocaleString('en-US')

function fmtParams (n) {
  if (!n) return null
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`
  return `${Math.round(n / 1e3)}K`
}

function fmtRel (ts) {
  const t = Number(ts)
  if (!t) return '—'
  const d = Math.max(0, Date.now() - t)
  const s = Math.round(d / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  const days = Math.round(h / 24)
  if (days < 30) return `${days}d ago`
  const mo = Math.round(days / 30)
  if (mo < 18) return `${mo}mo ago`
  return `${Math.round(days / 365)}y ago`
}
const fmtAbs = (ts) => ts ? new Date(Number(ts)).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : ''

const trunc = (hex, n = 4) => { const s = String(hex || ''); return s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s }
const pct = (p) => `${Math.round(Math.max(0, Math.min(1, Number(p) || 0)) * 100)}%`
const safeUrl = (u) => /^https?:\/\//i.test(String(u || '')) ? String(u) : null

function debounce (fn, ms) {
  let t
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}

async function copyText (text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true }
  } catch {}
  const ta = el('textarea', { style: 'position:fixed;opacity:0;left:-9999px' }, text)
  document.body.append(ta)
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch {}
  ta.remove()
  return ok
}

// A click-to-copy chip for keys, hashes and commands.
function copyChip (text, { label = trunc(text), cls = '', title = 'Copy' } = {}) {
  const btn = el('button.chip.chip-copy.mono', { type: 'button', title: `${title}: ${text}`, class: cls },
    el('span', { text: label }), ico('copy', 'chip-ico'))
  btn.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation()
    const ok = await copyText(text)
    btn.classList.add('copied')
    setTimeout(() => btn.classList.remove('copied'), 1200)
    toast(ok ? 'Copied to clipboard' : 'Copy failed', ok ? 'ok' : 'error')
  })
  return btn
}

// One rAF per frame, however many events arrive.
const frame = { fns: new Set(), scheduled: false }
function onFrame (fn) {
  frame.fns.add(fn)
  if (frame.scheduled) return
  frame.scheduled = true
  requestAnimationFrame(() => {
    frame.scheduled = false
    const fns = [...frame.fns]
    frame.fns.clear()
    for (const f of fns) f()
  })
}

// ---------------------------------------------------------------------------
// Store: a flat object + key-filtered subscribers.

function createStore (init) {
  const state = { ...init }
  const subs = new Set()
  return {
    get: () => state,
    set (patch) {
      Object.assign(state, patch)
      const keys = Object.keys(patch)
      for (const s of [...subs]) if (!s.keys || keys.some(k => s.keys.has(k))) s.fn(state, patch)
    },
    on (keys, fn) {
      const s = { keys: keys ? new Set(keys) : null, fn }
      subs.add(s)
      return () => subs.delete(s)
    }
  }
}

const store = createStore({
  api: null,
  phase: 'boot', // boot | ready | error
  bootError: null,
  bootStep: 'Loading',
  node: null, // api.state()
  peers: 0,
  transport: true,
  seedingSet: new Set(),
  rates: { up: 0, down: 0 },
  samples: [], // [{ t, up, down }]
  catalogVersion: 0,
  jobs: new Map(), // id -> { id, type, status, message, log: [], slug, ... }
  jobsVersion: 0
})

// Live per-artifact progress, mutated in place and flushed once per frame.
const live = { drives: new Map(), files: new Map(), dirty: new Set(), tick: 0 }
function flushProgress () {
  live.tick++
  store.set({ progressTick: live.tick })
  live.dirty.clear()
}

// ---------------------------------------------------------------------------
// Toasts

const toastsRoot = document.getElementById('toasts')
function toast (message, kind = 'info', { ttl = 4200, action } = {}) {
  const node = el('div.toast', { class: `toast-${kind}`, role: kind === 'error' ? 'alert' : null },
    ico(kind === 'error' ? 'warn' : kind === 'ok' ? 'check' : 'info', 'toast-ico'),
    el('span.toast-msg', { text: message }),
    action ? el('a.toast-action', { href: action.href, text: action.label }) : null,
    el('button.toast-close', { type: 'button', 'aria-label': 'Dismiss', html: icon('close'), onclick: () => node.remove() }))
  toastsRoot.append(node)
  while (toastsRoot.children.length > 5) toastsRoot.firstChild.remove()
  setTimeout(() => { node.classList.add('leaving'); setTimeout(() => node.remove(), REDUCED_MOTION ? 0 : 200) }, ttl)
  return node
}

// ---------------------------------------------------------------------------
// Router

function parseHash () {
  const raw = location.hash.replace(/^#/, '') || '/'
  const [pathPart, search = ''] = raw.split('?')
  const query = new URLSearchParams(search)
  const seg = pathPart.split('/').filter(Boolean)
  if (seg.length === 0) return { screen: 'bay', query, path: '/' }
  if (seg[0] === 'a' && seg.length >= 3) return { screen: 'artifact', slug: `${decodeURIComponent(seg[1])}/${decodeURIComponent(seg[2])}`, query, path: pathPart }
  if (seg[0] === 'seeding') return { screen: 'seeding', query, path: pathPart }
  if (seg[0] === 'publish') return { screen: 'publish', tab: seg[1] === 'hf' ? 'hf' : 'folder', query, path: pathPart }
  if (seg[0] === 'network') return { screen: 'network', query, path: pathPart }
  return { screen: 'notfound', query, path: pathPart }
}

const artifactHref = (slug) => '#/a/' + String(slug).split('/').map(encodeURIComponent).join('/')

// ---------------------------------------------------------------------------
// Shared widgets

function progressBar (p, { cls = '' } = {}) {
  const v = Math.max(0, Math.min(1, Number(p) || 0))
  const bar = el('div.bar', { class: cls, role: 'progressbar', 'aria-valuenow': Math.round(v * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 },
    el('div.bar-fill', { style: `width:${(v * 100).toFixed(1)}%` }))
  if (v >= 1) bar.classList.add('done')
  return bar
}
function setBar (bar, p) {
  const v = Math.max(0, Math.min(1, Number(p) || 0))
  bar.firstChild.style.width = `${(v * 100).toFixed(1)}%`
  bar.setAttribute('aria-valuenow', Math.round(v * 100))
  bar.classList.toggle('done', v >= 1)
}

const chip = (text, cls = '') => el('span.chip', { class: cls, text })

function emptyState ({ icon: name = 'cube', title, body, actions = [] }) {
  return el('div.empty', ico(name, 'empty-ico'), el('h3', { text: title }), body ? el('p', { text: body }) : null,
    actions.length ? el('div.row.gap', actions) : null)
}

function errorState (err, retry) {
  return el('div.empty.empty-error', ico('warn', 'empty-ico'), el('h3', 'Request failed'),
    el('p.mono', { text: String(err && err.message || err) }),
    retry ? el('button.btn', { type: 'button', onclick: retry }, 'Retry') : null)
}

function skeletonRows (n, cols) {
  return Array.from({ length: n }, () => el('tr.skel', Array.from({ length: cols }, () => el('td', el('span.skel-bar')))))
}

// Seed/unseed toggle shared by the bay rows and the artifact hero.
function seedToggle (slug, { compact = false } = {}) {
  const btn = el('button.btn', { type: 'button', class: compact ? 'btn-sm btn-icon' : '' })
  const paint = () => {
    const on = store.get().seedingSet.has(slug)
    clear(btn)
    btn.classList.toggle('btn-on', on)
    btn.title = on ? 'Stop seeding' : 'Seed this artifact'
    append(btn, [ico(on ? 'stop' : 'seed'), compact ? null : (on ? 'Seeding' : 'Seed')])
  }
  paint()
  btn.addEventListener('click', async (e) => {
    e.preventDefault(); e.stopPropagation()
    const { api, seedingSet } = store.get()
    const on = seedingSet.has(slug)
    btn.disabled = true
    try {
      if (on) await api.unseed(slug); else await api.seed(slug)
      const next = new Set(seedingSet)
      if (on) next.delete(slug); else next.add(slug)
      store.set({ seedingSet: next })
      toast(on ? `Stopped seeding ${slug}` : `Seeding ${slug}`, 'ok')
    } catch (err) { toast(`Seed toggle failed: ${err.message}`, 'error') }
    btn.disabled = false
    paint()
  })
  const off = store.on(['seedingSet'], paint)
  return { node: btn, dispose: off }
}

async function startDownload (slug, paths) {
  const { api } = store.get()
  try {
    const r = await api.download({ slug, paths })
    toast(paths ? `Downloading ${paths.length} file${paths.length === 1 ? '' : 's'} of ${slug}` : `Downloading ${slug}`, 'ok', { action: { href: '#/seeding', label: 'Seedbox' } })
    return r
  } catch (err) { toast(`Download failed: ${err.message}`, 'error') }
}

// Minimal XSS-safe markdown-ish renderer. Escape first, then apply headings,
// fenced/inline code, bold/italic, links (http/https only) and lists.
function renderMarkdown (src) {
  const text = esc(String(src || '').replace(/\r\n?/g, '\n'))
  const out = []
  const lines = text.split('\n')
  let i = 0
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
      const u = safeUrl(url.replace(/&amp;/g, '&'))
      return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>` : `${label} <span class="muted">(${esc(url)})</span>`
    })
  while (i < lines.length) {
    const line = lines[i]
    if (/^```/.test(line)) {
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++])
      i++
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`)
      continue
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) { out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`); i++; continue }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*[-*]\s+/, ''))}</li>`)
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*\d+\.\s+/, ''))}</li>`)
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    if (/^\s*\|/.test(line)) {
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const cells = lines[i++].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
        if (cells.every(c => /^:?-+:?$/.test(c))) continue
        rows.push(`<tr>${cells.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`)
      }
      out.push(`<table class="md-table">${rows.join('')}</table>`)
      continue
    }
    if (!line.trim()) { i++; continue }
    const buf = []
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|\s*\|)/.test(lines[i])) buf.push(lines[i++])
    out.push(`<p>${inline(buf.join(' '))}</p>`)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Screen: Bay (#/). Search + facet rail + dense results table. Filters live
// in the hash so any filtered view is a link.

const FACET_GROUPS = [['task', 'tasks', 'Task'], ['license', 'licenses', 'License'], ['format', 'formats', 'Format'], ['owner', 'owners', 'Owner'], ['tag', 'tags', 'Tag']]
const SORTS = [['recent', 'Recent'], ['size', 'Largest'], ['mirrors', 'Most mirrored']]

function bayFilters (query) {
  const f = { q: query.get('q') || '', sort: SORTS.some(s => s[0] === query.get('sort')) ? query.get('sort') : 'recent' }
  for (const [k] of FACET_GROUPS) f[k] = (query.get(k) || '').split(',').filter(Boolean)
  return f
}
function bayHash (f) {
  const sp = new URLSearchParams()
  if (f.q) sp.set('q', f.q)
  if (f.sort !== 'recent') sp.set('sort', f.sort)
  for (const [k] of FACET_GROUPS) if (f[k].length) sp.set(k, f[k].join(','))
  const s = sp.toString()
  return '#/' + (s ? '?' + s : '')
}

function bayScreen (root, route) {
  let filters = bayFilters(route.query)
  let rows = []
  let cursor = null
  let reqId = 0
  let facets = null
  let disposers = []

  // -- chrome
  const search = el('input.search-input', { type: 'search', placeholder: 'Search the bay — name, owner, tag, task…', value: filters.q, autocomplete: 'off', spellcheck: false, 'aria-label': 'Search' })
  const searchWrap = el('label.search', ico('search', 'search-ico'), search, el('kbd.search-kbd', '/'))
  const sortBar = el('div.seg', { role: 'group', 'aria-label': 'Sort' })
  const count = el('span.result-count.mono')
  const drawerBtn = el('button.btn.btn-sm.drawer-btn', { type: 'button', onclick: () => root.classList.toggle('drawer-open') }, ico('filter'), 'Filters', el('span.badge.mono', { hidden: true }))
  const head = el('div.bay-head', searchWrap, el('div.bay-tools', drawerBtn, sortBar, count))

  const rail = el('aside.facets', { 'aria-label': 'Filters' })
  const tbody = el('tbody')
  const table = el('table.grid.results', el('thead', el('tr',
    th('Name', null, 'col-name'), th('Size', 'size', 'num'), th('Files', null, 'num'), th('Mirrors', 'mirrors', 'num', 'Peers currently seeding this artifact'),
    th('Votes', null, 'num'), th('Updated', 'recent', 'num'), el('th.col-actions', { 'aria-label': 'Actions' }))), tbody)
  const foot = el('div.results-foot')
  const main = el('section.bay-main', head, el('div.table-wrap', table), foot)
  const scrim = el('div.drawer-scrim', { onclick: () => root.classList.remove('drawer-open') })
  root.append(el('div.bay', rail, main, scrim))

  function th (label, sortKey, cls, title) {
    const cell = el('th', { class: cls, title })
    if (!sortKey) { cell.textContent = label; return cell }
    const btn = el('button.th-sort', { type: 'button', dataset: { sort: sortKey } }, label, ico('arrowRight', 'th-ico'))
    btn.addEventListener('click', () => setFilters({ sort: sortKey }))
    cell.append(btn)
    return cell
  }

  function paintSort () {
    clear(sortBar)
    for (const [k, label] of SORTS) sortBar.append(el('button.seg-btn', { type: 'button', class: filters.sort === k ? 'on' : '', 'aria-pressed': filters.sort === k, onclick: () => setFilters({ sort: k }) }, label))
    for (const b of table.querySelectorAll('.th-sort')) b.classList.toggle('on', b.dataset.sort === filters.sort)
  }

  // Filters only change through the hash so every view is a link and the
  // hashchange handler (→ update) is the single place that reloads.
  function setFilters (patch) {
    location.hash = bayHash({ ...filters, ...patch })
  }

  // -- facet rail
  function paintFacets () {
    clear(rail)
    const active = FACET_GROUPS.reduce((n, [k]) => n + filters[k].length, 0)
    const badge = drawerBtn.querySelector('.badge')
    badge.hidden = !active
    badge.textContent = active
    rail.append(el('div.facets-head', el('span', 'Filters'),
      active ? el('button.link', { type: 'button', onclick: () => setFilters(Object.fromEntries(FACET_GROUPS.map(([k]) => [k, []]))) }, 'Clear all') : null,
      el('button.btn.btn-sm.btn-icon.drawer-close', { type: 'button', 'aria-label': 'Close filters', html: icon('close'), onclick: () => root.classList.remove('drawer-open') })))
    if (!facets) { rail.append(el('p.muted.pad', 'Loading facets…')); return }
    if (facets.error) { rail.append(el('p.muted.pad', { text: `Facets unavailable: ${facets.error}` })); return }
    let any = false
    for (const [k, key, label] of FACET_GROUPS) {
      const items = Array.isArray(facets[key]) ? facets[key] : []
      if (!items.length && !filters[k].length) continue
      any = true
      const group = el('div.facet-group', el('h4', label))
      const values = new Set(items.map(x => String(x.value)))
      for (const v of filters[k]) if (!values.has(v)) items.push({ value: v, count: 0 })
      for (const it of items.slice(0, 24)) {
        const v = String(it.value)
        const on = filters[k].includes(v)
        group.append(el('button.facet', { type: 'button', class: on ? 'on' : '', 'aria-pressed': on, onclick: () => setFilters({ [k]: on ? filters[k].filter(x => x !== v) : [...filters[k], v] }) },
          el('span.facet-check', { html: icon('check') }), el('span.facet-label', { text: v }), el('span.facet-count.mono', { text: fmtInt(it.count) })))
      }
      rail.append(group)
    }
    if (!any) rail.append(el('p.muted.pad', 'No facets yet — the catalog is empty.'))
  }

  async function loadFacets () {
    try { facets = (await store.get().api.facets()) || {} } catch (err) { facets = { error: err.message } }
    paintFacets()
  }

  // -- results
  // `took` only exists on search responses; a plain list has none.
  function paintCount (took, total) {
    clear(count)
    if (rows.length === 0) return
    const n = total ?? rows.length
    append(count, [el('b', { text: fmtInt(n) }), n === 1 ? ' result' : ' results',
      total != null && total !== rows.length ? `, ${fmtInt(rows.length)} shown` : null,
      Number.isFinite(took) ? el('span.muted', { text: ` in ${Math.max(0, Math.round(took))} ms` }) : null])
  }

  function rowFor (a) {
    const stat = a.stat || {}
    const slug = String(a.slug || `${a.owner}/${a.name}`)
    const chips = [a.license ? chip(a.license, 'chip-license') : null, a.quant ? chip(a.quant, 'chip-quant') : null]
    for (const f of Array.isArray(a.formats) ? a.formats.slice(0, 3) : []) chips.push(chip(f, 'chip-format'))
    if (a.kind && a.kind !== 'model') chips.push(chip(a.kind, 'chip-kind'))
    const votes = (Number(stat.up) || 0) - (Number(stat.down) || 0)
    const seed = seedToggle(slug, { compact: true })
    disposers.push(seed.dispose)
    const tr = el('tr', { dataset: { slug } },
      el('td.col-name',
        el('a.name-link', { href: artifactHref(slug) }, el('span.name-owner', { text: `${a.owner}/` }), el('span.name-name', { text: a.name })),
        el('div.name-sub', chips, a.summary ? el('span.name-summary', { text: a.summary }) : null)),
      el('td.num.mono', { text: fmtBytes(a.sizeBytes) }),
      el('td.num.mono', { text: fmtInt(Array.isArray(a.files) ? a.files.length : (a.files ?? stat.files ?? 0)) }),
      el('td.num.mono.col-mirrors', el('span', { class: stat.mirrors > 0 ? 'ok' : 'muted', text: fmtInt(stat.mirrors) })),
      el('td.num.mono', el('span', { class: votes > 0 ? 'ok' : votes < 0 ? 'bad' : 'muted', text: votes > 0 ? `+${votes}` : String(votes) }),
        stat.flags > 0 ? el('span.flagged', { title: `${stat.flags} flag${stat.flags === 1 ? '' : 's'}`, html: icon('flag') }) : null),
      el('td.num.mono.muted', { text: fmtRel(a.updatedAt), title: fmtAbs(a.updatedAt) }),
      el('td.col-actions', el('div.row-actions',
        el('button.btn.btn-sm.btn-icon', { type: 'button', title: 'Download all files', html: icon('download'), onclick: () => startDownload(slug) }),
        seed.node,
        el('button.btn.btn-sm.btn-icon', { type: 'button', title: `Copy: hyperbay get ${slug}`, html: icon('copy'), onclick: async () => { await copyText(`hyperbay get ${slug}`); toast('Copied CLI command', 'ok') } }))))
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return
      location.hash = artifactHref(slug)
    })
    return tr
  }

  function appendRows (list) {
    const frag = document.createDocumentFragment()
    for (const a of list) frag.append(rowFor(a))
    tbody.append(frag)
  }

  function paintFoot () {
    clear(foot)
    if (rows.length >= MAX_ROWS) foot.append(el('p.muted', `Showing the first ${MAX_ROWS} rows — narrow the search to see more.`))
    else if (cursor) foot.append(el('button.btn', { type: 'button', onclick: loadMore }, 'Load more'))
  }

  async function load () {
    const id = ++reqId
    for (const d of disposers) d()
    disposers = []
    clear(tbody).append(...skeletonRows(6, 7))
    clear(foot)
    clear(count)
    const params = { q: filters.q || undefined, sort: filters.sort, limit: PAGE }
    for (const [k] of FACET_GROUPS) if (filters[k].length) params[k] = filters[k]
    try {
      const res = (await store.get().api.artifacts(params)) || {}
      if (id !== reqId) return
      rows = Array.isArray(res.rows) ? res.rows : []
      cursor = res.cursor || null
      clear(tbody)
      if (!rows.length) {
        const filtered = filters.q || FACET_GROUPS.some(([k]) => filters[k].length)
        tbody.append(el('tr.empty-row', el('td', { colspan: 7 }, filtered
          ? emptyState({ icon: 'search', title: 'No matches', body: 'Nothing in the catalog matches this search and filter set.', actions: [el('button.btn', { type: 'button', onclick: () => setFilters({ q: '', ...Object.fromEntries(FACET_GROUPS.map(([k]) => [k, []])) }) }, 'Clear search and filters')] })
          : emptyState({ icon: 'cube', title: 'The bay is empty', body: 'This catalog has no artifacts yet. Publish a folder, mirror a Hugging Face repo, or join a peer\u2019s catalog key.', actions: [el('a.btn.btn-accent', { href: '#/publish' }, 'Publish'), el('a.btn', { href: '#/network' }, 'Network')] }))))
      } else appendRows(rows)
      paintCount(res.took, res.total)
      paintFoot()
    } catch (err) {
      if (id !== reqId) return
      clear(tbody).append(el('tr.empty-row', el('td', { colspan: 7 }, errorState(err, load))))
    }
  }

  async function loadMore () {
    const btn = foot.querySelector('button')
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…' }
    const params = { q: filters.q || undefined, sort: filters.sort, limit: Math.min(PAGE, MAX_ROWS - rows.length), cursor }
    for (const [k] of FACET_GROUPS) if (filters[k].length) params[k] = filters[k]
    try {
      const res = (await store.get().api.artifacts(params)) || {}
      const more = Array.isArray(res.rows) ? res.rows : []
      rows = rows.concat(more)
      cursor = rows.length >= MAX_ROWS ? null : (res.cursor || null)
      appendRows(more)
      paintCount(res.took, res.total)
    } catch (err) { toast(`Load more failed: ${err.message}`, 'error') }
    paintFoot()
  }

  // -- wiring
  const onType = debounce(() => { if (search.value !== filters.q) setFilters({ q: search.value.trim() }) }, 250)
  search.addEventListener('input', onType)
  search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; setFilters({ q: '' }); search.blur() } })
  const offUpdate = store.on(['catalogVersion'], debounce(() => { load(); loadFacets() }, 600))

  paintSort()
  paintFacets()
  load()
  loadFacets()

  return {
    focusSearch: () => { search.focus(); search.select() },
    update (nextRoute) {
      const next = bayFilters(nextRoute.query)
      const changed = JSON.stringify(next) !== JSON.stringify(filters)
      filters = next
      if (document.activeElement !== search) search.value = filters.q
      paintSort(); paintFacets()
      if (changed) load()
    },
    unmount () { offUpdate(); for (const d of disposers) d() }
  }
}

// ---------------------------------------------------------------------------
// Screen: Artifact (#/a/<owner>/<name>). Hero + provenance, "Get it" panel,
// description, and the file table with per-file progress.

function artifactScreen (root, route) {
  const slug = route.slug
  const wrap = el('section.artifact')
  root.append(wrap)
  let disposers = []
  const fileBars = new Map() // path -> { bar, pctNode }
  let driveBar = null
  let localLabel = null

  async function load () {
    for (const d of disposers) d()
    disposers = []
    fileBars.clear()
    clear(wrap).append(el('div.hero.hero-skel', el('span.skel-bar', { style: 'width:40%' }), el('span.skel-bar', { style: 'width:70%' })))
    const { api } = store.get()
    let a, files, mirrors
    try {
      [a, files, mirrors] = await Promise.all([
        api.artifact(slug),
        api.files(slug).catch(() => null),
        typeof api.mirrors === 'function' ? api.mirrors(slug).catch(() => null) : null
      ])
    } catch (err) { clear(wrap).append(errorState(err, load)); return }
    if (!a) {
      clear(wrap).append(emptyState({ icon: 'search', title: 'Not in this catalog', body: `${slug} is not published in the catalog this node follows. It may exist under another catalog key, or the name may be off.`, actions: [el('a.btn', { href: '#/' }, 'Back to the bay')] }))
      return
    }
    if (!Array.isArray(files)) files = Array.isArray(a.files) ? a.files : []
    if (!Array.isArray(mirrors)) mirrors = Array.isArray(a.mirrors) ? a.mirrors : []
    paint(a, files, mirrors)
  }

  function paint (a, files, mirrors) {
    const stat = a.stat || {} // what the bay says
    const local = a.local || null // what this node holds
    const source = a.source || {}

    // The detail response is authoritative for local state until the first
    // progress event for this drive arrives; a published artifact is 100%.
    if (local && !live.drives.has(slug)) {
      const total = Number(local.sizeBytes) || Number(a.sizeBytes) || 0
      const p = local.progress != null ? Number(local.progress) : (total ? (Number(local.downloadedBytes) || 0) / total : 0)
      live.drives.set(slug, { progress: p, peers: local.peers, bytes: total, downloadedBytes: local.downloadedBytes })
    }
    // A complete drive means every file is complete, whether we learned that
    // from `local` or from an earlier progress event.
    if (liveProgress(slug) >= 1) {
      if (!live.files.has(slug)) live.files.set(slug, new Map())
      const fp = live.files.get(slug)
      for (const f of files) if (!fp.has(String(f.path))) fp.set(String(f.path), { progress: 1, bytes: f.sizeBytes, downloadedBytes: f.sizeBytes })
    }
    for (const f of files) {
      const fpv = f.progress != null ? Number(f.progress) : (f.downloadedBytes != null && f.sizeBytes ? Number(f.downloadedBytes) / Number(f.sizeBytes) : null)
      if (fpv == null) continue
      if (!live.files.has(slug)) live.files.set(slug, new Map())
      if (!live.files.get(slug).has(String(f.path))) live.files.get(slug).set(String(f.path), { progress: fpv, bytes: f.sizeBytes, downloadedBytes: f.downloadedBytes })
    }
    if (local && typeof local.seeding === 'boolean' && store.get().seedingSet.has(slug) !== local.seeding) {
      const next = new Set(store.get().seedingSet)
      if (local.seeding) next.add(slug); else next.delete(slug)
      store.set({ seedingSet: next })
    }

    const seed = seedToggle(slug)
    disposers.push(seed.dispose)
    const votes = { up: Number(stat.up) || 0, down: Number(stat.down) || 0 }
    const voteNode = el('span.mono.vote-net')
    const paintVotes = () => { const n = votes.up - votes.down; voteNode.textContent = n > 0 ? `+${n}` : String(n); voteNode.className = `mono vote-net ${n > 0 ? 'ok' : n < 0 ? 'bad' : 'muted'}` }
    paintVotes()
    const vote = async (v) => {
      try { await store.get().api.vote(slug, v); if (v > 0) votes.up++; else votes.down++; paintVotes(); toast('Vote recorded', 'ok') } catch (err) { toast(`Vote failed: ${err.message}`, 'error') }
    }
    const flagBtn = el('button.btn.btn-sm', { type: 'button', title: 'Flag this artifact', onclick: () => openFlag() }, ico('flag'), stat.flags > 0 ? el('span.mono', { text: fmtInt(stat.flags) }) : 'Flag')

    const facts = [
      a.license ? ['License', chip(a.license, 'chip-license')] : null,
      a.task ? ['Task', el('a.link', { href: `#/?task=${encodeURIComponent(a.task)}`, text: a.task })] : null,
      fmtParams(a.params) ? ['Params', el('span.mono', { text: fmtParams(a.params) })] : null,
      a.quant ? ['Quant', chip(a.quant, 'chip-quant')] : null,
      ['Size', el('span.mono', { text: fmtBytes(stat.sizeBytes ?? a.sizeBytes), title: 'Catalog-reported size' })],
      ['Files', el('span.mono', { text: fmtInt(stat.files ?? files.length), title: 'Catalog-reported file count' })],
      ['Mirrors', el('span.mono', { class: stat.mirrors > 0 ? 'ok' : 'muted', text: fmtInt(stat.mirrors) })],
      ['Updated', el('span.mono', { text: fmtRel(a.updatedAt), title: fmtAbs(a.updatedAt) })]
    ].filter(Boolean)

    driveBar = progressBar(liveProgress(slug))
    localLabel = el('span.mono.small.pct', { text: localText(slug) })
    const hero = el('header.hero',
      el('div.hero-top',
        el('div.crumbs', el('a', { href: '#/' }, 'Bay'), el('span.muted', ' / '), el('a', { href: `#/?owner=${encodeURIComponent(a.owner)}`, text: a.owner })),
        el('div.hero-kind', chip(a.kind || 'model', 'chip-kind'), Array.isArray(a.formats) ? a.formats.map(f => chip(f, 'chip-format')) : null)),
      el('h1.hero-title', el('span.name-owner', { text: `${a.owner}/` }), el('span', { text: a.name })),
      a.summary ? el('p.hero-summary', { text: a.summary }) : null,
      el('dl.facts', facts.map(([k, v]) => el('div.fact', el('dt', k), el('dd', v)))),
      el('div.hero-actions',
        el('button.btn.btn-accent', { type: 'button', onclick: () => startDownload(slug) }, ico('download'), 'Download all'),
        seed.node,
        el('div.votes', { role: 'group', 'aria-label': 'Vote' },
          el('button.btn.btn-sm.btn-icon', { type: 'button', title: 'Upvote', html: icon('voteUp'), onclick: () => vote(1) }),
          voteNode,
          el('button.btn.btn-sm.btn-icon', { type: 'button', title: 'Downvote', html: icon('voteDown'), onclick: () => vote(-1) })),
        flagBtn,
        el('div.hero-progress', { title: 'What this node holds of the drive, as opposed to what the catalog reports' }, el('span.muted.small', 'Local copy'), driveBar, localLabel)),
      Array.isArray(a.tags) && a.tags.length ? el('div.tags', a.tags.slice(0, 20).map(t => el('a.chip.chip-tag', { href: `#/?tag=${encodeURIComponent(t)}`, text: t }))) : null)

    // Provenance
    const srcUrl = safeUrl(source.url)
    const prov = el('section.panel',
      el('h3', 'Provenance'),
      el('dl.kv',
        kv('Source', srcUrl ? el('a.link.mono.ellipsis', { href: srcUrl, target: '_blank', rel: 'noopener noreferrer nofollow', text: srcUrl.replace(/^https?:\/\//, ''), title: srcUrl }) : el('span.muted', source.mirroredFrom ? String(source.mirroredFrom) : 'local publish')),
        kv('Revision', source.revision ? copyChip(String(source.revision), { label: trunc(String(source.revision), 7), title: 'Copy revision' }) : el('span.muted', '—')),
        kv('Publisher', a.publisher ? copyChip(String(a.publisher), { title: 'Copy publisher key' }) : el('span.muted', '—')),
        kv('Drive', a.driveKey ? copyChip(String(a.driveKey), { title: 'Copy drive key' }) : el('span.muted', '—')),
        kv('Published', el('span.mono', { text: fmtRel(a.publishedAt), title: fmtAbs(a.publishedAt) })),
        a.framework ? kv('Framework', el('span', { text: a.framework })) : null,
        a.modality ? kv('Modality', el('span', { text: a.modality })) : null))

    // Mirrors: one row per announcing peer, grouped by the drive it serves.
    // stat.mirrors is the distinct-peer count and is the headline number.
    const byDrive = new Map()
    for (const m of mirrors) {
      const dk = String(m.driveKey || a.driveKey || '')
      if (!byDrive.has(dk)) byDrive.set(dk, [])
      byDrive.get(dk).push(m)
    }
    const mirrorsPanel = el('section.panel.mirrors',
      el('div.panel-head', el('h3', 'Mirrors'), el('span.muted.small.mono', { text: `${fmtInt(stat.mirrors)} peer${stat.mirrors === 1 ? '' : 's'} · ${fmtInt(byDrive.size)} drive${byDrive.size === 1 ? '' : 's'}` })),
      byDrive.size
        ? el('div.mirrors-list', [...byDrive].map(([dk, peers]) => el('div.mirror',
          el('span.small.muted', dk === String(a.driveKey) ? 'origin drive' : 'alternate drive'),
          dk ? copyChip(dk, { title: 'Copy drive key' }) : el('span.muted', '—'),
          el('div.mirror-peers', peers.slice(0, 40).map(p => el('span.chip', { class: String(p.publisher) === String(a.publisher) ? 'chip-quant' : '', title: p.at ? `announced ${fmtRel(p.at)}` : null }, ico('peers', 'chip-ico'), trunc(String(p.publisher || ''), 5)))))))
        : el('p.muted', 'No mirror announcements yet. The publisher counts as the first mirror once its op lands in the view.'))

    // Get it
    const firstFile = files[0] ? String(files[0].path) : '<file>'
    const gw = gatewayOrigin()
    const cmds = [
      ['hyperbay CLI', `hyperbay get ${slug}`],
      ['curl via gateway', `curl -O ${gw.origin}/f/${slug}/${firstFile}`],
      ['huggingface-cli', `HF_ENDPOINT=${gw.origin} huggingface-cli download ${slug}`]
    ]
    const getit = el('section.panel.getit', el('h3', 'Get it'), cmds.map(([label, cmd]) => el('div.cmd',
      el('span.cmd-label', label),
      el('div.cmd-row', el('code.mono', { text: cmd }), el('button.btn.btn-sm.btn-icon', { type: 'button', title: 'Copy command', html: icon('copy'), onclick: async () => { await copyText(cmd); toast('Copied command', 'ok') } })))),
      gw.assumed ? el('p.muted.small', `Assumes the gateway on its default port (hyperbay serve → ${gw.origin}).`) : null)

    // Files
    const tbody = el('tbody')
    for (const f of files.slice(0, MAX_ROWS)) {
      const p = String(f.path || '')
      const bar = progressBar(fileProgress(slug, p))
      const pctNode = el('span.mono.small.pct', { text: fileProgress(slug, p) != null ? pct(fileProgress(slug, p)) : '' })
      fileBars.set(p, { bar, pctNode, row: null })
      const tr = el('tr',
        el('td.col-path', el('div.path-cell', ico('file', 'file-ico'), el('a.mono.ellipsis', { href: store.get().api.fileUrl(slug, p), target: '_blank', rel: 'noopener', text: p, title: p })),
          el('div.file-progress', { class: fileProgress(slug, p) != null ? 'show' : '' }, bar, pctNode)),
        el('td.num.mono', { text: fmtBytes(f.sizeBytes) }),
        el('td.col-hash', f.sha256 ? copyChip(String(f.sha256), { title: 'Copy sha256' }) : el('span.muted', '—')),
        el('td.col-actions', el('button.btn.btn-sm.btn-icon', { type: 'button', title: `Download ${p}`, html: icon('download'), onclick: () => startDownload(slug, [p]) })))
      fileBars.get(p).row = tr
      tbody.append(tr)
    }
    const filesPanel = el('section.panel.files',
      el('div.panel-head', el('h3', 'Files'), el('span.muted.mono.small', `${fmtInt(files.length)} · ${fmtBytes(a.sizeBytes)}`)),
      files.length
        ? el('div.table-wrap', el('table.grid', el('thead', el('tr', el('th', 'Path'), el('th.num', 'Size'), el('th', 'sha256'), el('th.col-actions'))), tbody))
        : el('p.muted.pad', 'No file manifest for this artifact.'),
      files.length > MAX_ROWS ? el('p.muted', `Showing the first ${MAX_ROWS} of ${fmtInt(files.length)} files.`) : null)

    const desc = el('section.panel.desc', el('h3', 'Description'),
      a.description ? el('div.md', { html: renderMarkdown(a.description) }) : el('p.muted', 'No description.'))

    clear(wrap).append(hero, el('div.artifact-body', el('div.artifact-main', filesPanel, desc), el('div.artifact-side', getit, prov, mirrorsPanel)))

    function openFlag () {
      const input = el('input', { type: 'text', placeholder: 'Reason (malware, wrong license, spam…)', maxlength: 200 })
      const dlg = overlay(el('div.sheet',
        el('h3', 'Flag this artifact'),
        el('p.muted', 'Flags are signed ops in the open catalog. Every peer sees the count; nobody can delete the record.'),
        input,
        el('div.row.gap.end',
          el('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
          el('button.btn.btn-danger', { type: 'button', onclick: async () => { const reason = input.value.trim(); if (!reason) return input.focus(); try { await store.get().api.flag(slug, reason); toast('Flag recorded', 'ok'); dlg.close() } catch (err) { toast(`Flag failed: ${err.message}`, 'error') } } }, 'Flag'))))
      input.focus()
    }
  }

  const kv = (k, v) => el('div.kv-row', el('dt', k), el('dd', v))

  function onProgress () {
    if (driveBar && localLabel) { setBar(driveBar, liveProgress(slug)); localLabel.textContent = localText(slug) }
    const fp = live.files.get(slug)
    if (!fp) return
    for (const [path, v] of fp) {
      const ref = fileBars.get(path)
      if (!ref) continue
      setBar(ref.bar, v.progress)
      ref.pctNode.textContent = pct(v.progress)
      ref.bar.parentNode.classList.add('show')
    }
  }

  const offProgress = store.on(['progressTick'], onProgress)
  const offUpdate = store.on(['catalogVersion'], debounce(load, 800))
  load()
  return { unmount () { offProgress(); offUpdate(); for (const d of disposers) d() } }
}

const liveProgress = (slug) => { const d = live.drives.get(slug); return d ? d.progress : 0 }
const fileProgress = (slug, path) => { const m = live.files.get(slug); const v = m && m.get(path); return v ? v.progress : null }
// "6.00 MB / 6.00 MB · 100%" when byte counts are known, else just the percent.
function localText (slug) {
  const d = live.drives.get(slug)
  if (d && d.bytes && d.downloadedBytes != null) return `${fmtBytes(d.downloadedBytes)} / ${fmtBytes(d.bytes)} · ${pct(d.progress)}`
  return pct(liveProgress(slug))
}
// Origin of the HTTP gateway for copy-ready commands. Served by the gateway
// → the page's own origin. Under Pear the worker reports the loopback gateway
// it started, so the snippets are exact there too.
function gatewayOrigin () {
  if (gatewayBase) return { origin: gatewayBase, assumed: false }
  if (!globalThis.Pear && /^https?:$/.test(location.protocol)) return { origin: location.origin, assumed: false }
  return { origin: 'http://127.0.0.1:8433', assumed: true }
}

// ---------------------------------------------------------------------------
// Screen: Seedbox (#/seeding). Aggregate header with a canvas sparkline plus
// one row per mirrored artifact, patched in place on progress frames.

function seedingScreen (root) {
  const wrap = el('section.seedbox')
  root.append(wrap)
  const rowsBySlug = new Map()
  let list = []

  const stat = (label, value, cls = '') => { const v = el('span.stat-value.mono', { class: cls, text: value }); return { node: el('div.stat', el('span.stat-label', label), v), v } }
  const sTotal = stat('Mirrored', '0 B')
  const sArts = stat('Artifacts', '0')
  const sPeers = stat('Active peers', '0')
  const sUp = stat('Up', '0 B/s', 'rate-up')
  const sDown = stat('Down', '0 B/s', 'rate-down')
  const canvas = el('canvas.spark', { width: 600, height: 72, 'aria-label': 'Throughput, last 36 seconds' })
  const header = el('div.seed-head', el('div.stats', sTotal.node, sArts.node, sPeers.node, sUp.node, sDown.node),
    el('div.spark-wrap', canvas, el('div.spark-legend.mono.small', el('span.rate-up', '↑ up'), el('span.rate-down', '↓ down'))))

  const tbody = el('tbody')
  const table = el('table.grid.seeds', el('thead', el('tr', el('th', 'Artifact'), el('th.num', 'Size'), el('th.col-progress', 'Progress'), el('th.num', 'Peers'), el('th.num', 'Up'), el('th.num', 'Down'), el('th.col-actions'))), tbody)
  const body = el('div.table-wrap', table)
  wrap.append(header, body)

  function rowFor (s) {
    const slug = String(s.slug)
    const bar = progressBar(s.progress)
    const refs = {
      bar,
      pctNode: el('span.mono.small.pct', { text: pct(s.progress) }),
      peers: el('td.num.mono', { text: fmtInt(s.peers) }),
      up: el('td.num.mono.rate-up', { text: fmtRate(s.up) }),
      down: el('td.num.mono.rate-down', { text: fmtRate(s.down) }),
      size: el('td.num.mono', { text: fmtBytes(s.sizeBytes) })
    }
    const stopBtn = el('button.btn.btn-sm', { type: 'button', onclick: async () => {
      stopBtn.disabled = true
      try {
        await store.get().api.unseed(slug)
        const next = new Set(store.get().seedingSet); next.delete(slug); store.set({ seedingSet: next })
        toast(`Stopped seeding ${slug}`, 'ok')
        refs.tr.remove(); rowsBySlug.delete(slug); list = list.filter(x => x.slug !== slug); paintAggregate(); if (!list.length) paintEmpty()
      } catch (err) { toast(`Stop failed: ${err.message}`, 'error'); stopBtn.disabled = false }
    } }, ico('stop'), 'Stop')
    refs.tr = el('tr', { dataset: { slug } },
      el('td.col-name', el('a.name-link', { href: artifactHref(slug) }, el('span.name-owner', { text: s.owner ? `${s.owner}/` : '' }), el('span.name-name', { text: s.name || slug })),
        s.owner ? el('div.name-sub.mono.muted.small', { text: slug }) : null),
      refs.size,
      el('td.col-progress', el('div.file-progress.show', bar, refs.pctNode)),
      refs.peers, refs.up, refs.down,
      el('td.col-actions', stopBtn))
    rowsBySlug.set(slug, refs)
    return refs.tr
  }

  function paintEmpty () {
    clear(tbody).append(el('tr.empty-row', el('td', { colspan: 7 }, emptyState({ icon: 'seed', title: 'Nothing seeded yet', body: 'Seed an artifact from the bay to mirror it. Every seeded drive is announced on the swarm and served to any peer that asks.', actions: [el('a.btn.btn-accent', { href: '#/' }, 'Browse the bay')] }))))
  }

  function paintAggregate () {
    let total = 0; let peers = 0; let up = 0; let down = 0
    for (const s of list) {
      const d = live.drives.get(s.slug) || s
      total += Number(s.sizeBytes) || 0
      peers += Number(d.peers) || 0
      up += Number(d.up) || 0
      down += Number(d.down) || 0
    }
    const r = store.get().rates
    sTotal.v.textContent = fmtBytes(total)
    sArts.v.textContent = fmtInt(list.length)
    sPeers.v.textContent = fmtInt(peers)
    sUp.v.textContent = fmtRate(r.up || up)
    sDown.v.textContent = fmtRate(r.down || down)
  }

  async function load () {
    clear(tbody).append(...skeletonRows(3, 7))
    try {
      list = (await store.get().api.seeding()) || []
      if (!Array.isArray(list)) list = []
      rowsBySlug.clear()
      clear(tbody)
      if (!list.length) paintEmpty()
      else { const frag = document.createDocumentFragment(); for (const s of list.slice(0, MAX_ROWS)) frag.append(rowFor(s)); tbody.append(frag) }
      paintAggregate()
      store.set({ seedingSet: new Set(list.filter(s => s.seeding !== false).map(s => String(s.slug))) })
    } catch (err) { clear(tbody).append(el('tr.empty-row', el('td', { colspan: 7 }, errorState(err, load)))) }
  }

  function onProgress () {
    for (const slug of live.dirty.size ? live.dirty : live.drives.keys()) {
      const d = live.drives.get(slug)
      const refs = rowsBySlug.get(slug)
      if (!d || !refs) continue
      setBar(refs.bar, d.progress)
      refs.pctNode.textContent = pct(d.progress)
      if (d.peers != null) refs.peers.textContent = fmtInt(d.peers)
      if (d.up != null) refs.up.textContent = fmtRate(d.up)
      if (d.down != null) refs.down.textContent = fmtRate(d.down)
    }
    paintAggregate()
  }

  // Sparkline: two filled lines (up, down) over the last SPARK_SAMPLES.
  function drawSpark () {
    const dpr = devicePixelRatio || 1
    const w = canvas.clientWidth || 600
    const h = canvas.clientHeight || 72
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr) }
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const samples = store.get().samples
    const max = Math.max(1, ...samples.map(s => Math.max(s.up, s.down)))
    // Grow across the full width until the window is full, then scroll.
    const step = w / (Math.max(samples.length, 16) - 1)
    const x0 = w - (samples.length - 1) * step
    ctx.strokeStyle = 'rgba(255,255,255,.07)'
    ctx.lineWidth = 1
    for (const y of [0.25, 0.5, 0.75]) { ctx.beginPath(); ctx.moveTo(0, h * y + 0.5); ctx.lineTo(w, h * y + 0.5); ctx.stroke() }
    const series = [['down', '#39d3bb'], ['up', '#f2b134']]
    for (const [key, color] of series) {
      if (samples.length < 2) continue
      ctx.beginPath()
      samples.forEach((s, i) => { const x = x0 + i * step; const y = h - 2 - (s[key] / max) * (h - 6); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.lineTo(x0 + (samples.length - 1) * step, h)
      ctx.lineTo(x0, h)
      ctx.closePath()
      ctx.fillStyle = color + '22'
      ctx.fill()
    }
    ctx.font = '10px ui-monospace, Menlo, monospace'
    ctx.textAlign = 'right'
    const label = fmtRate(max)
    const tw = ctx.measureText(label).width
    ctx.fillStyle = 'rgba(17,24,32,.85)'
    ctx.fillRect(w - tw - 8, 2, tw + 6, 13)
    ctx.fillStyle = 'rgba(215,222,230,.6)'
    ctx.fillText(label, w - 5, 12)
  }

  const offProgress = store.on(['progressTick'], onProgress)
  const offSamples = store.on(['samples', 'rates'], () => onFrame(drawSpark))
  const offUpdate = store.on(['catalogVersion'], debounce(load, 800))
  const ro = new ResizeObserver(() => onFrame(drawSpark))
  ro.observe(canvas)
  load()
  drawSpark()
  return { unmount () { offProgress(); offSamples(); offUpdate(); ro.disconnect() } }
}

// ---------------------------------------------------------------------------
// Screen: Publish (#/publish, #/publish/hf). Two tabs (local folder, Hugging
// Face mirror) and the live job log fed by 'job' events.

function publishScreen (root, route) {
  const wrap = el('section.publish')
  root.append(wrap)
  let tab = route.tab

  const tabs = el('div.tabs', { role: 'tablist' },
    el('a.tab', { href: '#/publish', role: 'tab', dataset: { tab: 'folder' } }, ico('folder'), 'From folder'),
    el('a.tab', { href: '#/publish/hf', role: 'tab', dataset: { tab: 'hf' } }, ico('cloud'), 'Mirror from Hugging Face'))
  const pane = el('div.pane')
  const jobs = el('section.panel.jobs', el('div.panel-head', el('h3', 'Jobs'), el('span.muted.small', 'live from this node')), el('div.job-list'))
  wrap.append(el('div.publish-grid', el('div', tabs, pane), jobs))

  const field = (label, input, hint) => el('label.field', el('span.field-label', label), input, hint ? el('span.field-hint', hint) : null)
  const input = (props) => el('input', { type: 'text', autocomplete: 'off', spellcheck: false, ...props })

  function paintTab () {
    for (const t of tabs.children) { const on = t.dataset.tab === tab; t.classList.toggle('on', on); t.setAttribute('aria-selected', on) }
    clear(pane).append(tab === 'hf' ? hfForm() : folderForm())
  }

  function folderForm () {
    const dir = input({ placeholder: '/path/to/model-folder', class: 'mono' })
    const drop = el('div.drop', { tabindex: 0 }, ico('folder', 'drop-ico'), el('span', 'Drop a folder here'), el('span.muted.small', 'or type its absolute path above'))
    const onDrop = (e) => {
      e.preventDefault(); drop.classList.remove('over')
      const item = e.dataTransfer && e.dataTransfer.items && e.dataTransfer.items[0]
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]
      // Chromium only exposes an absolute path in Electron/Pear (file.path); a
      // plain browser gives the directory name via the entry API.
      const full = file && file.path
      const entry = item && item.webkitGetAsEntry && item.webkitGetAsEntry()
      if (full) dir.value = full
      else if (entry) { dir.value = entry.fullPath || entry.name; toast('Browsers hide absolute paths — check the folder path before publishing', 'info') }
      dir.focus()
    }
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over') })
    drop.addEventListener('dragleave', () => drop.classList.remove('over'))
    drop.addEventListener('drop', onDrop)
    const meta = { name: input({ placeholder: 'llama-3.1-8b-instruct' }), owner: input({ placeholder: 'defaults to your identity' }), license: input({ placeholder: 'apache-2.0', list: 'licenses' }), task: input({ placeholder: 'text-generation', list: 'tasks' }), tags: input({ placeholder: 'llama, instruct, chat' }), quant: input({ placeholder: 'Q4_K_M / fp16 / —' }) }
    const submit = el('button.btn.btn-accent', { type: 'submit' }, ico('seed'), 'Publish to the bay')
    const form = el('form.form', { onsubmit: async (e) => {
      e.preventDefault()
      const d = dir.value.trim()
      if (!d) { dir.focus(); toast('A folder path is required', 'error'); return }
      const m = {}
      for (const [k, i] of Object.entries(meta)) { const v = i.value.trim(); if (v) m[k] = k === 'tags' ? v.split(',').map(s => s.trim()).filter(Boolean) : v }
      submit.disabled = true
      try {
        const r = await store.get().api.publish({ dir: d, meta: m })
        toast(r && r.job ? `Publishing started (job ${r.job})` : 'Publishing started', 'ok')
        if (r && r.job) trackJob(r.job, { type: 'publish', message: `Publishing ${d}` })
      } catch (err) { toast(`Publish failed: ${err.message}`, 'error') }
      submit.disabled = false
    } },
      field('Folder', dir, 'Every file under it becomes an entry in a new Hyperdrive, hashed with sha256, then signed into the catalog.'),
      drop,
      el('div.form-grid', field('Name', meta.name), field('Owner', meta.owner), field('License', meta.license), field('Task', meta.task), field('Tags', meta.tags), field('Quant', meta.quant)),
      el('datalist', { id: 'licenses' }, ['apache-2.0', 'mit', 'cc-by-4.0', 'llama3.1', 'gemma', 'openrail'].map(v => el('option', { value: v }))),
      el('datalist', { id: 'tasks' }, ['text-generation', 'text-to-image', 'automatic-speech-recognition', 'feature-extraction', 'image-classification', 'translation'].map(v => el('option', { value: v }))),
      el('div.row.gap', submit))
    return form
  }

  function hfForm () {
    const repo = input({ placeholder: 'owner/repo', class: 'mono' })
    const rev = input({ placeholder: 'main', class: 'mono', value: 'main' })
    const submit = el('button.btn.btn-accent', { type: 'submit' }, ico('cloud'), 'Mirror into the bay')
    return el('form.form', { onsubmit: async (e) => {
      e.preventDefault()
      const r = repo.value.trim()
      if (!/^[^/\s]+\/[^/\s]+$/.test(r)) { repo.focus(); toast('Repo must look like owner/name', 'error'); return }
      submit.disabled = true
      try {
        const res = await store.get().api.import({ repo: r, revision: rev.value.trim() || 'main' })
        toast(res && res.job ? `Import started (job ${res.job})` : 'Import started', 'ok')
        if (res && res.job) trackJob(res.job, { type: 'import', message: `Importing ${r}` })
      } catch (err) { toast(`Import failed: ${err.message}`, 'error') }
      submit.disabled = false
    } },
      el('p.muted', 'Fetches the public repo over the Hugging Face API, writes every file into a Hyperdrive, verifies sha256 against the upstream manifest, then publishes the artifact under your key. Gated and private repos are refused.'),
      el('div.form-grid', field('Repository', repo), field('Revision', rev, 'branch, tag or commit')),
      el('div.row.gap', submit))
  }

  // -- job log
  const jobList = jobs.querySelector('.job-list')
  function trackJob (id, seed) {
    const j = store.get().jobs
    if (!j.has(id)) j.set(id, { id, status: 'running', log: [], ...seed })
    store.set({ jobs: j, jobsVersion: store.get().jobsVersion + 1 })
  }
  function paintJobs () {
    const all = [...store.get().jobs.values()].reverse().slice(0, 12)
    clear(jobList)
    if (!all.length) { jobList.append(el('p.muted.pad', 'No jobs yet. Publish or import to see progress here.')); return }
    for (const j of all) {
      const done = j.status === 'done'
      const err = j.status === 'error'
      const bytesP = j.totalBytes ? (j.bytes || 0) / j.totalBytes : (done ? 1 : 0)
      jobList.append(el('article.job', { class: done ? 'job-done' : err ? 'job-error' : 'job-running' },
        el('div.job-head', el('span.chip', { class: done ? 'chip-ok' : err ? 'chip-bad' : 'chip-live', text: j.status || 'running' }), el('span.mono.small.muted', { text: `${j.type || 'job'} · ${j.id}` })),
        el('div.job-msg', { text: j.message || '' }),
        j.totalBytes || j.totalFiles ? el('div.job-progress', progressBar(bytesP), el('span.mono.small.muted', { text: [j.totalBytes ? `${fmtBytes(j.bytes || 0)} / ${fmtBytes(j.totalBytes)}` : null, j.totalFiles ? `${fmtInt(j.files || 0)}/${fmtInt(j.totalFiles)} files` : null].filter(Boolean).join(' · ') })) : null,
        j.log.length ? el('pre.job-log.mono', { text: j.log.slice(-40).join('\n') }) : null,
        done && j.slug ? el('a.btn.btn-sm', { href: artifactHref(j.slug) }, ico('arrowRight'), `Open ${j.slug}`) : null))
    }
  }

  const offJobs = store.on(['jobsVersion'], () => onFrame(paintJobs))
  paintTab()
  paintJobs()
  return {
    update (nextRoute) { if (nextRoute.tab !== tab) { tab = nextRoute.tab; paintTab() } },
    unmount () { offJobs() }
  }
}

// ---------------------------------------------------------------------------
// Screen: Network (#/network). Keys, peers, and what is decentralized.

function networkScreen (root) {
  const wrap = el('section.network')
  root.append(wrap)

  function paint () {
    const s = store.get().node || {}
    const catalogKey = s.catalogKey ? String(s.catalogKey) : ''
    const identity = typeof s.identity === 'string' ? s.identity : (s.identity && (s.identity.hex || s.identity.publicKey)) || ''
    const peersN = store.get().peers
    clear(wrap).append(
      el('div.net-grid',
        el('section.panel.keypanel',
          el('h3', 'Catalog key'),
          el('p.muted', 'Share this to let another node join this bay. They run ', el('code.mono', 'hyperbay serve --catalog <key>'), ' and replicate the same index, read-only, from any peer that has it.'),
          catalogKey ? el('div.bigkey', el('code.mono.bigkey-text', { text: catalogKey }), el('button.btn.btn-accent', { type: 'button', onclick: async () => { await copyText(catalogKey); toast('Catalog key copied', 'ok') } }, ico('copy'), 'Copy')) : el('p.muted', 'No catalog yet — the node has not opened its Autobase.')),
        el('section.panel',
          el('h3', 'Join a bay'),
          el('p.muted', 'Paste another peer\u2019s catalog key to replicate their index instead. This node keeps its identity, its drives and everything it seeds \u2014 only the index changes.'),
          joinForm()),
        el('section.panel',
          el('h3', 'This node'),
          el('dl.kv',
            kv('Identity', identity ? copyChip(identity, { label: trunc(identity, 8), title: 'Copy identity key' }) : el('span.muted', '—')),
            kv('Peers', el('span.mono', { class: peersN > 0 ? 'ok' : 'warn', text: fmtInt(peersN) })),
            kv('Catalog entries', el('span.mono', { text: fmtInt(s.artifacts) })),
            kv('Catalog length', el('span.mono', { text: s.length != null ? fmtInt(s.length) : '—' })),
            kv('Seeding', el('span.mono', { text: fmtInt(s.seeding) })),
            kv('Throughput', el('span.mono', el('span.rate-up', { text: `↑ ${fmtRate(store.get().rates.up)}` }), ' ', el('span.rate-down', { text: `↓ ${fmtRate(store.get().rates.down)}` }))),
            s.storage ? kv('Storage', el('code.mono.ellipsis', { text: String(s.storage), title: String(s.storage) })) : null)),
        el('section.panel.explain',
          el('h3', 'What is decentralized here'),
          el('p', 'The catalog is an Autobase: an append-only log any peer can replicate by key and any peer can write to, with every op signed by its author and verified on apply. The weights are one Hyperdrive per artifact, addressed by hash and served by whoever seeds them over the Hyperswarm DHT. This node holds a local copy of the index and of the drives it seeds; it needs no server to search, to download from a peer, or to publish. Nobody owns the index, nobody can take it down, and a missing peer only affects freshness and bandwidth.'))),
      el('section.panel.peers',
        el('div.panel-head', el('h3', 'Connected peers'), el('span.muted.small.mono', { text: `${fmtInt(peersN)} connected` })),
        el('div.table-wrap.peers-table')))
    loadPeers()
  }
  const kv = (k, v) => el('div.kv-row', el('dt', k), el('dd', v))

  // Switching bays is a real network action, so it reports what happened
  // rather than silently succeeding.
  function joinForm () {
    const input = el('input.mono', {
      type: 'text',
      placeholder: 'catalog key',
      autocomplete: 'off',
      spellcheck: false,
      'aria-label': 'Catalog key to join'
    })
    const button = el('button.btn.btn-accent', { type: 'button' }, ico('key'), 'Join')
    const status = el('p.muted.small')

    const submit = async () => {
      const key = input.value.trim()
      if (!key) {
        status.textContent = 'Paste a catalog key first.'
        return
      }
      button.disabled = true
      input.disabled = true
      status.textContent = 'Joining…'
      try {
        const result = await store.get().api.joinCatalog(key)
        input.value = ''
        if (result && result.changed === false) {
          status.textContent = 'Already on that bay.'
        } else {
          status.textContent = 'Joined. Reading the index from peers…'
          toast('Joined a new bay', 'ok')
          const s = await store.get().api.state()
          store.set({ node: s || {} })
        }
      } catch (err) {
        status.textContent = err && err.message ? err.message : 'Could not join that bay.'
        toast('Join failed', 'error')
      } finally {
        button.disabled = false
        input.disabled = false
      }
    }

    button.addEventListener('click', submit)
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      }
    })

    return el('div.joinbay', el('div.joinbay-row', input, button), status)
  }

  async function loadPeers () {
    const host = wrap.querySelector('.peers-table')
    if (!host) return
    clear(host).append(el('table.grid', el('thead', el('tr', el('th', 'Public key'), el('th', 'Address'), el('th.num', 'RTT'), el('th.num', 'Up'), el('th.num', 'Down'))), el('tbody', skeletonRows(2, 5))))
    let peers
    try { peers = (await store.get().api.peers()) || [] } catch (err) { clear(host).append(errorState(err, loadPeers)); return }
    if (!Array.isArray(peers)) peers = []
    const tbody = host.querySelector('tbody')
    clear(tbody)
    if (!peers.length) { tbody.append(el('tr.empty-row', el('td', { colspan: 5 }, emptyState({ icon: 'peers', title: 'No peers connected', body: 'The node is announced on the DHT and will connect as peers appear. Searches still work from the local copy of the catalog.' })))); return }
    for (const p of peers.slice(0, MAX_ROWS)) {
      const key = String(p.publicKey || '')
      tbody.append(el('tr', el('td', key ? copyChip(key, { label: trunc(key, 8), title: 'Copy peer key' }) : el('span.muted', '—')),
        el('td.mono', { text: p.host ? `${p.host}:${p.port ?? ''}` : '—' }),
        el('td.num.mono', { text: p.rtt != null ? `${Math.round(p.rtt)} ms` : '—' }),
        el('td.num.mono', { text: fmtBytes(p.up) }), el('td.num.mono', { text: fmtBytes(p.down) })))
    }
  }

  const off = store.on(['node', 'peers'], debounce(paint, 300))
  paint()
  return { unmount: off }
}

// ---------------------------------------------------------------------------
// Overlays: shortcut sheet, flag dialog.

const overlayRoot = document.getElementById('overlay-root')
function overlay (content) {
  const node = el('div.overlay', { role: 'dialog', 'aria-modal': 'true' }, content)
  const close = () => { node.remove() }
  node.addEventListener('click', (e) => { if (e.target === node) close() })
  clear(overlayRoot).append(node)
  return { close, node }
}
const closeOverlays = () => { clear(overlayRoot); document.querySelector('.bay')?.parentElement.classList.remove('drawer-open') }

function shortcutSheet () {
  const rows = [['/', 'Focus search'], ['g b', 'Bay'], ['g s', 'Seedbox'], ['g p', 'Publish'], ['g n', 'Network'], ['?', 'This sheet'], ['Esc', 'Close overlays / clear search']]
  overlay(el('div.sheet', el('h3', 'Keyboard'), el('dl.shortcuts', rows.map(([k, v]) => el('div', el('dt', el('kbd', k)), el('dd', v)))),
    el('div.row.end', el('button.btn', { type: 'button', onclick: closeOverlays }, 'Close'))))
}

// ---------------------------------------------------------------------------
// Chrome: nav state, peer pill, rates, boot / error screens.

const view = document.getElementById('view')
// Tells the inline boot watchdog in index.html that the module is alive, so it
// stops waiting to report a stalled start.
view.dataset.booted = '1'
const peerPill = document.getElementById('peer-pill')
const rateUp = document.getElementById('rate-up')
const rateDown = document.getElementById('rate-down')

function paintPill () {
  const { peers, transport, phase } = store.get()
  peerPill.className = `pill mono ${phase !== 'ready' ? 'pill-muted' : !transport ? 'pill-rose' : peers > 0 ? 'pill-green' : 'pill-amber'}`
  peerPill.textContent = phase !== 'ready' ? 'offline' : !transport ? 'link lost' : `${fmtInt(peers)} peer${peers === 1 ? '' : 's'}`
  peerPill.title = !transport ? 'Event stream disconnected — reconnecting' : `${peers} connected peer${peers === 1 ? '' : 's'}`
}
function paintRates () {
  const { rates } = store.get()
  rateUp.textContent = `↑ ${fmtRate(rates.up)}`
  rateDown.textContent = `↓ ${fmtRate(rates.down)}`
}
store.on(['peers', 'transport', 'phase'], paintPill)
store.on(['rates'], () => onFrame(paintRates))

function paintBoot (step) {
  clear(view).append(el('div.boot', el('div.boot-mark'), el('p.boot-line', { text: step }), el('p.muted.small', globalThis.Pear ? 'Opening the corestore and bootstrapping the DHT. A few seconds on first launch.' : 'Talking to the local gateway.')))
}
function paintBootError (err) {
  clear(view).append(el('div.boot.boot-error', ico('warn', 'empty-ico'), el('h2', 'The node failed to start'),
    el('pre.mono', { text: String(err && (err.stack || err.message) || err) }),
    el('p.muted', globalThis.Pear ? 'Check that no other hyperbay instance holds the storage lock, then relaunch.' : 'Is the gateway running? Start it with `hyperbay serve` and reload.'),
    el('div.row.gap', el('button.btn.btn-accent', { type: 'button', onclick: () => location.reload() }, 'Retry'))))
}

// ---------------------------------------------------------------------------
// Live events → store. One subscription for the app's lifetime.

function handleEvent (ev) {
  if (!ev || typeof ev !== 'object') return
  switch (ev.event) {
    case 'progress': {
      const slug = ev.slug ? String(ev.slug) : null
      if (!slug) return
      const p = ev.progress != null ? Number(ev.progress) : (ev.bytes ? (Number(ev.downloadedBytes) || 0) / Number(ev.bytes) : 0)
      if (ev.path) {
        if (!live.files.has(slug)) live.files.set(slug, new Map())
        live.files.get(slug).set(String(ev.path), { progress: p, bytes: ev.bytes, downloadedBytes: ev.downloadedBytes })
      } else {
        live.drives.set(slug, { progress: p, peers: ev.peers, up: ev.up, down: ev.down, bytes: ev.bytes, downloadedBytes: ev.downloadedBytes })
      }
      live.dirty.add(slug)
      onFrame(flushProgress)
      return
    }
    case 'traffic': {
      const up = Number(ev.up) || 0
      const down = Number(ev.down) || 0
      const samples = store.get().samples.concat({ t: Date.now(), up, down }).slice(-SPARK_SAMPLES)
      store.set({ rates: { up, down }, samples })
      return
    }
    case 'peers': {
      const n = Array.isArray(ev.peers) ? ev.peers.length : Number(ev.peers ?? ev.count)
      if (Number.isFinite(n)) store.set({ peers: n })
      return
    }
    case 'update':
      store.set({ catalogVersion: store.get().catalogVersion + 1 })
      return
    case 'job': {
      const id = String(ev.job || ev.id || 'job')
      const jobs = store.get().jobs
      const j = jobs.get(id) || { id, log: [] }
      Object.assign(j, { type: ev.type || j.type, status: ev.status || j.status || 'running', message: ev.message ?? j.message, slug: ev.slug || j.slug, bytes: ev.bytes ?? j.bytes, totalBytes: ev.totalBytes ?? j.totalBytes, files: ev.files ?? j.files, totalFiles: ev.totalFiles ?? j.totalFiles })
      if (ev.message && j.log[j.log.length - 1] !== ev.message) j.log.push(String(ev.message))
      if (j.log.length > 200) j.log.splice(0, j.log.length - 200)
      jobs.set(id, j)
      store.set({ jobs, jobsVersion: store.get().jobsVersion + 1 })
      if (ev.status === 'done') toast(ev.message ? String(ev.message) : `Job ${id} finished`, 'ok', { action: ev.slug ? { href: artifactHref(ev.slug), label: 'Open' } : null, ttl: 8000 })
      else if (ev.status === 'error') toast(`Job ${id} failed: ${ev.message || 'unknown error'}`, 'error', { ttl: 8000 })
      if (ev.status === 'done') store.set({ catalogVersion: store.get().catalogVersion + 1 })
      return
    }
    case 'transport':
      store.set({ transport: !!ev.connected })
  }
}

async function refreshState () {
  const { api } = store.get()
  try {
    const s = (await api.state()) || {}
    const patch = { node: s }
    if (s.peers != null) patch.peers = Array.isArray(s.peers) ? s.peers.length : Number(s.peers) || 0
    if (s.up != null || s.down != null) patch.rates = { up: Number(s.up) || 0, down: Number(s.down) || 0 }
    store.set(patch)
  } catch (err) { console.warn('state refresh failed', err) }
}

async function refreshSeeding () {
  try {
    const list = (await store.get().api.seeding()) || []
    store.set({ seedingSet: new Set((Array.isArray(list) ? list : []).filter(s => s.seeding !== false).map(s => String(s.slug))) })
  } catch {}
}

// ---------------------------------------------------------------------------
// Router glue

const SCREENS = { bay: bayScreen, artifact: artifactScreen, seeding: seedingScreen, publish: publishScreen, network: networkScreen }
let current = { screen: null, inst: null, key: null }

function route () {
  if (store.get().phase !== 'ready') return
  const r = parseHash()
  const key = r.screen === 'artifact' ? `artifact:${r.slug}` : r.screen
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.dataset.nav === (r.screen === 'artifact' ? 'bay' : r.screen))
  if (current.key === key && current.inst && current.inst.update) { current.inst.update(r); return }
  if (current.inst && current.inst.unmount) current.inst.unmount()
  closeOverlays()
  clear(view)
  view.scrollTop = 0
  window.scrollTo(0, 0)
  const factory = SCREENS[r.screen]
  if (!factory) {
    view.append(emptyState({ icon: 'search', title: 'No such screen', body: r.path, actions: [el('a.btn', { href: '#/' }, 'Back to the bay')] }))
    current = { screen: 'notfound', inst: null, key }
    return
  }
  document.title = r.screen === 'artifact' ? `${r.slug} · hyperbay` : r.screen === 'bay' ? 'hyperbay' : `${r.screen} · hyperbay`
  current = { screen: r.screen, inst: factory(view, r), key }
  if (focusSearchOnMount && r.screen === 'bay') { focusSearchOnMount = false; current.inst.focusSearch() }
}

// Keyboard: `/` search, `g <k>` jumps, `?` sheet, Escape closes.
let pendingG = 0
let focusSearchOnMount = false
function onKey (e) {
  const t = e.target
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
  if (e.key === 'Escape') { closeOverlays(); if (typing) t.blur(); return }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === '/') {
    e.preventDefault()
    if (current.screen === 'bay') current.inst.focusSearch()
    else { focusSearchOnMount = true; location.hash = '#/' }
    return
  }
  if (e.key === '?') { e.preventDefault(); overlayRoot.firstChild ? closeOverlays() : shortcutSheet(); return }
  if (e.key === 'g') { pendingG = Date.now(); return }
  if (pendingG && Date.now() - pendingG < 900) {
    const map = { b: '#/', s: '#/seeding', p: '#/publish', n: '#/network' }
    if (map[e.key]) { e.preventDefault(); location.hash = map[e.key] }
  }
  pendingG = 0
}

// ---------------------------------------------------------------------------
// Boot

// Under Pear the peer runs in a Bare worker (worker.js): the renderer has no
// Bare runtime, and it cannot fetch the worker's loopback gateway either
// (cross-origin fetch from the app window is blocked whatever CORS says). So
// the desktop drives the worker over its pipe and only *quotes* the gateway URL
// in the copy-ready terminal snippets.
let gatewayBase = ''

// Resolves once the worker reports the gateway it started. The handshake
// listener detaches itself so it never competes with the pipe transport.
function startPearWorker () {
  return new Promise((resolve, reject) => {
    let pipe
    try {
      pipe = globalThis.Pear.worker.run('./worker.js')
    } catch (err) {
      reject(err)
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let settled = false

    const settle = (fn, value) => {
      if (settled) return
      settled = true
      pipe.off('data', onData)
      fn(value)
    }

    function onData (chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (!line) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.type === 'ready') return settle(resolve, { pipe, ready: message })
        if (message.type === 'error') return settle(reject, new Error(message.error || 'the hyperbay worker failed to start'))
      }
    }

    pipe.on('data', onData)
    pipe.on('error', err => settle(reject, err))
    pipe.on('close', () => settle(reject, new Error('the hyperbay worker exited before it was ready')))
  })
}

async function resolveApi () {
  if (globalThis.Pear) {
    const { pipe, ready } = await startPearWorker()
    gatewayBase = String(ready.url || '').replace(/\/$/, '')
    store.set({ worker: ready })
    return createPipeApi(pipe, { fileBase: gatewayBase })
  }
  return createHttpApi()
}

async function main () {
  paintPill()
  paintBoot(globalThis.Pear ? 'Starting node / joining swarm…' : 'Connecting to gateway…')
  let api
  try {
    api = await resolveApi()
    store.set({ api })
    paintBoot(globalThis.Pear ? 'Node up — reading catalog…' : 'Reading catalog…')
    // The first state() call is the readiness probe: in a browser a dead
    // gateway surfaces here instead of as a hollow shell.
    const s = await api.state()
    store.set({ node: s || {}, peers: s && s.peers != null ? (Array.isArray(s.peers) ? s.peers.length : Number(s.peers) || 0) : 0, rates: { up: Number(s && s.up) || 0, down: Number(s && s.down) || 0 } })
  } catch (err) {
    store.set({ phase: 'error', bootError: err })
    paintBootError(err)
    return
  }
  store.set({ phase: 'ready' })
  const unsubscribe = api.subscribe(handleEvent)
  const poll = setInterval(refreshState, 10000)
  addEventListener('beforeunload', () => { unsubscribe(); clearInterval(poll) }, { once: true })
  addEventListener('hashchange', route)
  addEventListener('keydown', onKey)
  refreshSeeding()
  route()
}

main()
