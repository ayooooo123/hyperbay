// The catalog: an Autobase whose view is a Hyperbee holding the artifact
// index. apply() is the only writer of the view and must be byte-identical on
// every peer, so it reads nothing but the view (plus linearized host state)
// and never touches the clock.

const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const ReadyResource = require('ready-resource')
const ProtomuxWakeup = require('protomux-wakeup')
const b4a = require('b4a')
const {
  KEYS,
  QUOTA_ARTIFACTS_PER_PUBLISHER,
  normaliseArtifact,
  normaliseSlug,
  artifactTokens,
  tokenize,
  cleanSegment,
  slugFromIndexKey,
  isHexKey,
  ValidationError
} = require('./schema.js')
const { signOp, verifyOp } = require('./trust.js')

const MAX_LIMIT = 500
const MAX_SCAN = 10000
const MAX_REASON = 400

// Per-publisher idempotence records; not part of KEYS in schema.js.
const voteKey = (slug, by) => 'vote/' + slug + '/' + by
const flagKey = (slug, by) => 'flag/' + slug + '/' + by

const FACETS = [
  ['owners', 'by-owner/'],
  ['tags', 'by-tag/'],
  ['tasks', 'by-task/'],
  ['licenses', 'by-license/'],
  ['formats', 'by-format/']
]

// Filter dimensions in selectivity order: with several filters the first one
// present drives the index scan and the rest post-filter loaded rows.
const FILTERS = [
  ['owner', v => cleanSegment(v), KEYS.byOwnerRange, (a, v) => a.owner === v],
  ['tag', v => lower(v), KEYS.byTagRange, (a, v) => a.tags.includes(v)],
  ['task', v => cleanSegment(v), KEYS.byTaskRange, (a, v) => a.task === v],
  ['format', v => lower(v), KEYS.byFormatRange, (a, v) => a.formats.includes(v)],
  ['license', v => lower(v), KEYS.byLicenseRange, (a, v) => a.license === v]
]

class Catalog extends ReadyResource {
  constructor (store, key = null, { identity = null, ackInterval = 1000, wakeup = null } = {}) {
    super()
    this.store = store
    this.identity = identity
    // The wakeup protocol is what tells a peer which writers are active. It is
    // owned here (not left implicit inside Autobase) so a caller can attach it
    // to a connection it already replicates the whole Corestore over — without
    // it, an optimistic append from a non-writer peer never reaches an indexer.
    this.wakeup = wakeup || new ProtomuxWakeup()
    this.base = new Autobase(store, key, {
      open,
      apply,
      valueEncoding: 'json',
      ackInterval,
      optimistic: true,
      wakeup: this.wakeup
    })
    this._onupdate = () => this.emit('update')
    this.base.on('update', this._onupdate)
  }

  get view () { return this.base.view }
  get key () { return this.base.key }
  get discoveryKey () { return this.base.discoveryKey }
  get writable () { return this.base.writable }
  get length () { return this.base.length }
  get local () { return this.base.local ? b4a.toString(this.base.local.key, 'hex') : null }

  async _open () {
    await this.base.ready()
  }

  async _close () {
    this.base.off('update', this._onupdate)
    await this.base.close()
  }

  update () {
    return this.base.update()
  }

  // Replicate the base and its wakeup channel on a stream of its own.
  replicate (...args) {
    return this.base.replicate(...args)
  }

  // Attach only the wakeup channel, for callers that already replicate the
  // Corestore holding both the catalog views and every artifact drive.
  addStream (stream) {
    this.wakeup.addStream(stream)
    return stream
  }

  // --- mutators ---------------------------------------------------------

  async _append (op) {
    const signed = signOp(op, this.identity)
    await this.base.append(signed, { optimistic: true })
    return signed
  }

  async publish (artifact) {
    if (!this.identity) throw new ValidationError('publishing requires an identity')
    const record = normaliseArtifact(artifact)
    record.publisher = this.identity.hex
    await this._append({ t: 'artifact', artifact: record })
    return record
  }

  async announceMirror (slug, driveKey) {
    if (!isHexKey(driveKey)) throw new ValidationError('driveKey must be a 32-byte hex key')
    await this._append({ t: 'mirror', slug: normaliseSlug(slug), driveKey: String(driveKey).toLowerCase() })
  }

  async vote (slug, value) {
    const v = Number(value) >= 0 ? 1 : -1
    await this._append({ t: 'vote', slug: normaliseSlug(slug), value: v })
  }

  async flag (slug, reason) {
    await this._append({ t: 'flag', slug: normaliseSlug(slug), reason: cleanReason(reason) })
  }

  async addWriter (keyHex, { indexer = true } = {}) {
    if (!isHexKey(keyHex)) throw new ValidationError('writer key must be a 32-byte hex key')
    await this._append({ t: 'addWriter', key: String(keyHex).toLowerCase(), indexer: indexer !== false })
  }

  async removeWriter (keyHex) {
    if (!isHexKey(keyHex)) throw new ValidationError('writer key must be a 32-byte hex key')
    await this._append({ t: 'removeWriter', key: String(keyHex).toLowerCase() })
  }

  // --- reads ------------------------------------------------------------

  async get (slug) {
    const s = safeSlug(slug)
    if (!s) return null
    return this._row(s)
  }

  async stats (slug) {
    const s = safeSlug(slug)
    const stat = s ? await getValue(this.view, KEYS.stat(s)) : null
    return stat || zeroStat()
  }

  async mirrors (slug) {
    const s = safeSlug(slug)
    if (!s) return []
    const range = KEYS.mirrorRange(s)
    const out = []
    for await (const { key, value } of this.view.createReadStream(range)) {
      out.push({ publisher: key.slice(range.gte.length), driveKey: value.driveKey, at: value.at })
    }
    return out
  }

  async writers () {
    const range = KEYS.writerRange()
    const out = []
    for await (const { key, value } of this.view.createReadStream(range)) {
      out.push({ key: key.slice(range.gte.length), indexer: !!value.indexer, at: value.at })
    }
    return out
  }

  async list (opts = {}) {
    const sort = SORTS.has(opts.sort) ? opts.sort : 'recent'
    const max = clampLimit(opts.limit)
    const filters = parseFilters(opts)
    const primary = filters[0] || null
    const rest = filters.slice(1)

    // Without filters the by-time / by-size indexes already yield the right
    // order. With a filter the scan is in slug order, so the page is sorted in
    // memory afterwards (page-local order, same as sort=mirrors).
    let range = primary ? primary.range : sort === 'size' ? KEYS.bySizeRange() : KEYS.byTimeRange()
    const reverse = !primary && sort === 'size'
    if (opts.cursor) range = reverse ? { ...range, lt: opts.cursor } : { ...range, gt: opts.cursor }

    const rows = []
    let last = null
    let scanned = 0
    let exhausted = true
    for await (const { key } of this.view.createReadStream(range, { reverse })) {
      last = key
      if (++scanned > MAX_SCAN) { exhausted = false; break }
      const row = await this._row(slugFromIndexKey(key))
      if (!row || !matches(row, rest)) continue
      rows.push(row)
      if (rows.length >= max) { exhausted = false; break }
    }
    if (primary || sort === 'mirrors') rows.sort(COMPARE[sort])
    return { rows, cursor: exhausted ? null : last }
  }

  async search (q, opts = {}) {
    const started = Date.now()
    const tokens = tokenize(q)
    const max = clampLimit(opts.limit)
    const filters = parseFilters(opts)
    const hits = new Map()

    for (let i = 0; i < tokens.length; i++) {
      const last = i === tokens.length - 1
      const range = last ? KEYS.tokPrefixRange(tokens[i]) : KEYS.tokRange(tokens[i])
      // A prefix can hit the same slug under several tokens; count once per query token.
      const seen = new Set()
      let scanned = 0
      for await (const { key } of this.view.createReadStream(range)) {
        if (++scanned > MAX_SCAN) break
        const slug = last ? slugFromTokKey(key) : key.slice(range.gte.length)
        if (seen.has(slug)) continue
        seen.add(slug)
        hits.set(slug, (hits.get(slug) || 0) + 1)
      }
    }

    const qNorm = String(q == null ? '' : q).trim().toLowerCase()
    const candidates = [...hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_SCAN)
    const ranked = []
    for (const [slug, matched] of candidates) {
      const row = await this._row(slug)
      if (!row || !matches(row, filters)) continue
      const exact = row.slug === qNorm || row.name.toLowerCase() === qNorm ? 1 : 0
      ranked.push({ row, matched, exact })
    }
    ranked.sort((a, b) =>
      b.matched - a.matched ||
      b.exact - a.exact ||
      b.row.stat.mirrors - a.row.stat.mirrors ||
      b.row.updatedAt - a.row.updatedAt ||
      cmp(a.row.slug, b.row.slug)
    )
    return { rows: ranked.slice(0, max).map(r => r.row), took: Date.now() - started }
  }

  async facets ({ limit = 20 } = {}) {
    const max = clampLimit(limit)
    const out = {}
    for (const [name, prefix] of FACETS) {
      const counts = new Map()
      let scanned = 0
      for await (const { key } of this.view.createReadStream({ gte: prefix, lt: prefix.slice(0, -1) + '0' })) {
        if (++scanned > MAX_SCAN) break
        const slug = slugFromIndexKey(key)
        const value = key.slice(prefix.length, key.length - slug.length - 1)
        counts.set(value, (counts.get(value) || 0) + 1)
      }
      out[name] = [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || cmp(a.value, b.value))
        .slice(0, max)
    }
    return out
  }

  async _row (slug) {
    if (!slug) return null
    const artifact = await getValue(this.view, KEYS.art(slug))
    if (!artifact) return null
    const stat = await getValue(this.view, KEYS.stat(slug))
    return { ...artifact, stat: stat || zeroStat() }
  }
}

// --- autobase handlers ----------------------------------------------------

function open (store) {
  return new Hyperbee(store.get('catalog'), { keyEncoding: 'utf-8', valueEncoding: 'json' })
}

async function apply (nodes, view, host) {
  for (const node of nodes) {
    const op = node.value
    if (op === null || op === undefined) continue
    if (!verifyOp(op)) continue

    if (op.t === 'addWriter' || op.t === 'removeWriter') {
      // Membership changes only from admitted writers: an un-acked optimistic
      // node is rolled back anyway, and acking it would let any keypair admit
      // itself as an indexer.
      if (node.optimistic) continue
      await applyWriterOp(view, host, op)
      continue
    }

    await host.ackWriter(node.from.key)
    await ensureWriter(view, host, node.from.key, op.at)

    switch (op.t) {
      case 'artifact': await applyArtifact(view, op); break
      case 'mirror': await applyMirror(view, op); break
      case 'vote': await applyVote(view, op); break
      case 'flag': await applyFlag(view, op); break
    }
  }
}

async function applyWriterOp (view, host, op) {
  const hex = op.key.toLowerCase()
  const key = b4a.from(hex, 'hex')
  if (op.t === 'addWriter') {
    const indexer = op.indexer !== false
    await host.addWriter(key, { indexer })
    await view.put(KEYS.writer(hex), { indexer, at: op.at })
    return
  }
  if (!host.removeable(key)) return
  await host.removeWriter(key)
  await view.del(KEYS.writer(hex))
}

// The bootstrap indexer never passes through an addWriter op, so writer/ is
// also fed by the first verified op each writer key lands. Indexer status
// comes from host.system.indexers: linearized system state at this apply
// position, checkpointed and rolled back together with the view, so it is as
// deterministic as the view itself.
async function ensureWriter (view, host, key, at) {
  const hex = b4a.toString(key, 'hex')
  if (await getValue(view, KEYS.writer(hex))) return
  const indexers = host.system ? host.system.indexers : []
  const indexer = indexers.some(idx => b4a.equals(idx.key, key))
  await view.put(KEYS.writer(hex), { indexer, at })
}

async function applyArtifact (view, op) {
  const by = op.by.toLowerCase()
  let record
  try {
    record = normaliseArtifact(op.artifact, { now: op.at })
  } catch {
    return
  }
  record.publisher = by

  const existing = await getValue(view, KEYS.art(record.slug))
  if (existing && existing.publisher !== by) {
    await putMirror(view, record.slug, by, record.driveKey, op.at)
    return
  }
  if (existing) {
    if (!(record.updatedAt > existing.updatedAt)) return
  } else {
    const held = await countRange(view, KEYS.pubRange(by))
    if (held >= QUOTA_ARTIFACTS_PER_PUBLISHER) return
  }

  const stat = existing ? await getValue(view, KEYS.stat(record.slug)) : null
  const mirror = await mirrorState(view, record.slug, by)
  const next = indexKeys(record)
  const keep = new Set(next)
  const stale = existing ? indexKeys(existing).filter(k => !keep.has(k)) : []

  const b = view.batch()
  for (const k of stale) await b.del(k)
  await b.put(KEYS.art(record.slug), record)
  for (const k of next) await b.put(k, '')
  // The publisher serves the bytes too, so it is the artifact's first mirror.
  await b.put(mirror.key, { driveKey: record.driveKey, at: op.at })
  await b.put(KEYS.stat(record.slug), {
    ...(stat || zeroStat()),
    mirrors: mirror.count,
    files: record.files.length,
    sizeBytes: record.sizeBytes
  })
  await b.flush()
}

async function applyMirror (view, op) {
  const slug = safeSlug(op.slug)
  if (!slug || !(await getValue(view, KEYS.art(slug)))) return
  await putMirror(view, slug, op.by.toLowerCase(), op.driveKey.toLowerCase(), op.at)
}

async function putMirror (view, slug, by, driveKey, at) {
  const mirror = await mirrorState(view, slug, by)
  const stat = (await getValue(view, KEYS.stat(slug))) || zeroStat()
  stat.mirrors = mirror.count
  const b = view.batch()
  await b.put(mirror.key, { driveKey, at })
  await b.put(KEYS.stat(slug), stat)
  await b.flush()
}

// One mirror row per announcing peer (mirror/<slug>/<publisherHex>), so
// stat.mirrors counts peers that can serve the bytes, not distinct drives.
// The row is not visible to the view until flush, hence the +1.
async function mirrorState (view, slug, by) {
  const key = KEYS.mirror(slug, by)
  const had = await getValue(view, key)
  const count = (await countRange(view, KEYS.mirrorRange(slug))) + (had ? 0 : 1)
  return { key, count }
}

async function applyVote (view, op) {
  const slug = safeSlug(op.slug)
  if (!slug || !(await getValue(view, KEYS.art(slug)))) return
  const by = op.by.toLowerCase()
  const prev = await getValue(view, voteKey(slug, by))
  if (prev && prev.value === op.value) return
  const stat = (await getValue(view, KEYS.stat(slug))) || zeroStat()
  if (prev) {
    if (prev.value === 1) stat.up = Math.max(0, stat.up - 1)
    else stat.down = Math.max(0, stat.down - 1)
  }
  if (op.value === 1) stat.up++
  else stat.down++
  const b = view.batch()
  await b.put(voteKey(slug, by), { value: op.value, at: op.at })
  await b.put(KEYS.stat(slug), stat)
  await b.flush()
}

async function applyFlag (view, op) {
  const slug = safeSlug(op.slug)
  if (!slug || !(await getValue(view, KEYS.art(slug)))) return
  const by = op.by.toLowerCase()
  const prev = await getValue(view, flagKey(slug, by))
  const b = view.batch()
  await b.put(flagKey(slug, by), { reason: cleanReason(op.reason), at: op.at })
  if (!prev) {
    const stat = (await getValue(view, KEYS.stat(slug))) || zeroStat()
    stat.flags++
    await b.put(KEYS.stat(slug), stat)
  }
  await b.flush()
}

// Every secondary index key an artifact record owns.
function indexKeys (a) {
  const keys = [
    KEYS.byTime(a.updatedAt, a.slug),
    KEYS.bySize(a.sizeBytes, a.slug),
    KEYS.byOwner(a.owner, a.slug),
    KEYS.byLicense(a.license, a.slug),
    KEYS.pub(a.publisher, a.slug)
  ]
  if (a.task) keys.push(KEYS.byTask(a.task, a.slug))
  for (const tag of a.tags) keys.push(KEYS.byTag(tag, a.slug))
  for (const fmt of a.formats) keys.push(KEYS.byFormat(fmt, a.slug))
  for (const tok of artifactTokens(a)) keys.push(KEYS.tok(tok, a.slug))
  return keys
}

// --- helpers --------------------------------------------------------------

const SORTS = new Set(['recent', 'size', 'mirrors'])

const COMPARE = {
  recent: (a, b) => b.updatedAt - a.updatedAt || cmp(a.slug, b.slug),
  size: (a, b) => b.sizeBytes - a.sizeBytes || cmp(a.slug, b.slug),
  mirrors: (a, b) => b.stat.mirrors - a.stat.mirrors || b.updatedAt - a.updatedAt || cmp(a.slug, b.slug)
}

function zeroStat () {
  return { mirrors: 0, up: 0, down: 0, flags: 0, files: 0, sizeBytes: 0 }
}

async function getValue (view, key) {
  const node = await view.get(key)
  return node ? node.value : null
}

async function countRange (view, range) {
  let n = 0
  for await (const _ of view.createReadStream(range)) n++ // eslint-disable-line no-unused-vars
  return n
}

function parseFilters (opts) {
  const out = []
  for (const [name, norm, rangeOf, test] of FILTERS) {
    if (opts[name] == null || opts[name] === '') continue
    const value = norm(opts[name])
    if (!value) continue
    out.push({ range: rangeOf(value), value, test })
  }
  return out
}

function matches (row, filters) {
  for (const f of filters) if (!f.test(row, f.value)) return false
  return true
}

function slugFromTokKey (key) {
  const rest = key.slice(4)
  return rest.slice(rest.indexOf('/') + 1)
}

function safeSlug (slug) {
  try {
    return normaliseSlug(slug) || null
  } catch {
    return null
  }
}

function cleanReason (reason) {
  if (reason == null) return null
  const s = String(reason).trim().slice(0, MAX_REASON)
  return s || null
}

function clampLimit (limit, fallback = 50) {
  const n = Math.floor(Number(limit))
  if (!Number.isFinite(n) || n < 1) return fallback
  return Math.min(n, MAX_LIMIT)
}

function lower (v) {
  return String(v).trim().toLowerCase()
}

function cmp (a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

module.exports = Catalog
