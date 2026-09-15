// DriveManager — one Hyperdrive per artifact. Publishes local folders and
// remote streams into fresh drives, replicates known drives by key, seeds them
// on the swarm, downloads with progress, and re-verifies the manifest hashes.
//
// Streaming is the invariant: model weights are multi-GB, so bytes are hashed
// as they flow into or out of a drive and never buffered whole.

const ReadyResource = require('ready-resource')
const EventEmitter = require('bare-events')
const Hyperdrive = require('hyperdrive')
const fs = require('bare-fs')
const fsp = require('bare-fs/promises')
const path = require('bare-path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const idEnc = require('hypercore-id-encoding')

const { Sha256, hashStream } = require('./hash.js')
const { normalisePath } = require('./schema.js')

const PROGRESS_INTERVAL = 250 // ms between progress events (~4x/second)
const SPEED_WINDOW = 5000 // ms of history behind the rolling bytes/sec
const DEFAULT_IGNORE = ['.git', '.cache', '.DS_Store']
const DEFAULT_IGNORE_SUFFIX = ['.lock']

class DriveManager extends ReadyResource {
  constructor (store, swarm = null, { identity = null } = {}) {
    super()
    this.store = store
    this.swarm = swarm || null
    this.identity = identity
    // driveKeyHex -> { drive, discovery, seeding, stats, joined, seedDownload, onpeer }
    this.drives = new Map()
    this._tasks = new Set()
  }

  async _open () {
    await this.store.ready()
  }

  async _close () {
    for (const task of this._tasks) task.cancel()

    const closing = []
    for (const rec of this.drives.values()) {
      if (rec.seedDownload) rec.seedDownload.destroy()
      rec.seedDownload = null
      if (rec.discovery) closing.push(rec.discovery.destroy().catch(noop))
      rec.discovery = null
    }
    await Promise.allSettled(closing)

    const drives = [...this.drives.values()]
    this.drives.clear()
    await Promise.allSettled(drives.map(rec => {
      if (rec.onpeer) {
        rec.drive.core.off('peer-add', rec.onpeer)
        rec.drive.core.off('peer-remove', rec.onpeer)
      }
      return rec.drive.close()
    }))
  }

  // --- publishing -----------------------------------------------------------

  async publishFolder (dir, { onProgress, ignore } = {}) {
    const root = path.resolve(dir)
    const ignored = makeIgnore(ignore)
    const files = []
    await walk(root, '', ignored, files)
    files.sort(byPath)

    let totalBytes = 0
    for (const f of files) totalBytes += f.sizeBytes

    const entries = (async function * () {
      for (const f of files) {
        yield { path: f.path, stream: fs.createReadStream(path.join(root, f.path)) }
      }
    })()

    return this.publishStream(entries, { onProgress, totalBytes, totalFiles: files.length })
  }

  // `entries` is an async iterable of { path, stream } | { path, buffer }.
  // Each source is pumped straight into drive.createWriteStream while the
  // SHA-256 is updated chunk by chunk. `totalBytes` / `totalFiles` are optional
  // hints for progress; unknown totals are reported as null.
  async publishStream (entries, { onProgress, totalBytes = null, totalFiles = null } = {}) {
    if (!this.opened) await this.ready()
    this._maybeClosed()

    const ns = this.store.namespace(b4a.toString(crypto.randomBytes(16), 'hex'))
    const drive = new Hyperdrive(ns)
    await drive.ready()

    const hex = b4a.toString(drive.key, 'hex')
    this._adopt(hex, drive)

    const files = []
    let bytes = 0
    let lastReport = 0

    const report = (file, fileBytes, force) => {
      if (!onProgress) return
      const now = Date.now()
      if (!force && now - lastReport < PROGRESS_INTERVAL) return
      lastReport = now
      onProgress({
        path: file,
        bytes: bytes + fileBytes,
        totalBytes,
        files: files.length,
        totalFiles
      })
    }

    for await (const entry of entries) {
      const rel = normalisePath(entry && entry.path)
      if (!rel) throw badArgument('publishStream entry needs a path')
      const source = entry.buffer != null ? entry.buffer : entry.stream
      if (source == null) throw badArgument('publishStream entry needs a stream or buffer: ' + rel)

      const ws = drive.createWriteStream('/' + rel)
      const { sha256, sizeBytes } = await pump(source, ws, n => report(rel, n, false))
      bytes += sizeBytes
      files.push({ path: rel, sizeBytes, sha256 })
      report(rel, 0, true)
    }

    files.sort(byPath)

    if (this.swarm) await this.seed(hex, { full: false })

    return { driveKey: hex, files, sizeBytes: bytes }
  }

  // --- drive access ---------------------------------------------------------

  get (driveKey) {
    this._maybeClosed()
    const key = toKey(driveKey)
    const hex = b4a.toString(key, 'hex')
    const rec = this.drives.get(hex)
    if (rec) return rec.drive
    // Hyperdrive closes the corestore it is given, so every drive gets its own
    // session of the manager's store (sessions share the underlying cores).
    return this._adopt(hex, new Hyperdrive(this.store.session(), key))
  }

  _record (driveKey) {
    this.get(driveKey)
    return this.drives.get(b4a.toString(toKey(driveKey), 'hex'))
  }

  _adopt (hex, drive) {
    const rec = {
      drive,
      discovery: null,
      seeding: false,
      stats: null,
      seedDownload: null,
      joined: null,
      onpeer: null
    }
    this.drives.set(hex, rec)

    rec.onpeer = () => this.emit('peer', { driveKey: hex, peers: peerCount(drive) })
    drive.core.on('peer-add', rec.onpeer)
    drive.core.on('peer-remove', rec.onpeer)

    // Join as a client so the drive can be read without an explicit seed().
    // lib/node.js owns the swarm 'connection' handler; we only announce the
    // topic and tell the drive that discovery is in flight so update() blocks
    // until the first swarm.flush() has settled instead of returning early.
    rec.joined = drive.ready().then(() => {
      if (!this.swarm || this.closing || this.swarm.destroyed) return
      rec.discovery = this.swarm.join(drive.discoveryKey, { server: false, client: true })
      const done = drive.findingPeers()
      this.swarm.flush().then(done, done)
    }).catch(noop)

    return drive
  }

  replicate (socket) {
    return this.store.replicate(socket)
  }

  // --- seeding --------------------------------------------------------------

  async seed (driveKey, { full = true } = {}) {
    if (!this.opened) await this.ready()
    const rec = this._record(driveKey)
    const hex = b4a.toString(rec.drive.key, 'hex')
    await rec.drive.ready()

    if (this.swarm) {
      await rec.joined
      if (rec.discovery && !rec.discovery.destroyed) {
        rec.discovery.refresh({ server: true, client: true }).catch(noop)
      }
    }

    if (full && !rec.seedDownload) {
      // Not awaited: this runs until every blob is local and is cancelled by
      // unseed() or _close(). Errors (drive closed) are swallowed by Download.
      rec.seedDownload = rec.drive.download('/', { recursive: true })
      rec.seedDownload.done().catch(noop)
    }

    const was = rec.seeding
    rec.seeding = true
    if (!was) this.emit('seeding', { driveKey: hex, seeding: true })
  }

  // Stops announcing and downloading. The drive stays in the map and keeps its
  // client-mode join, so reads still find peers; nothing on disk is deleted.
  async unseed (driveKey) {
    const hex = b4a.toString(toKey(driveKey), 'hex')
    const rec = this.drives.get(hex)
    if (!rec) return

    if (rec.seedDownload) {
      rec.seedDownload.destroy()
      rec.seedDownload = null
    }
    if (rec.discovery && !rec.discovery.destroyed) {
      rec.discovery.refresh({ server: false, client: true }).catch(noop)
    }

    const was = rec.seeding
    rec.seeding = false
    if (was) this.emit('seeding', { driveKey: hex, seeding: false })
  }

  // --- downloading ----------------------------------------------------------

  download (driveKey, { paths } = {}) {
    const rec = this._record(driveKey)
    const hex = b4a.toString(rec.drive.key, 'hex')
    const task = new DownloadTask(this, hex, rec.drive, paths)
    this._tasks.add(task)
    task.promise.then(() => this._tasks.delete(task), () => this._tasks.delete(task))
    return task
  }

  // --- reading --------------------------------------------------------------

  createReadStream (driveKey, filePath, { start, end } = {}) {
    return this.get(driveKey).createReadStream('/' + normalisePath(filePath), { start, end })
  }

  async entry (driveKey, filePath) {
    return this.get(driveKey).entry('/' + normalisePath(filePath))
  }

  async has (driveKey, filePath) {
    return this.get(driveKey).has('/' + normalisePath(filePath))
  }

  async listFiles (driveKey) {
    const drive = this.get(driveKey)
    const out = []
    for await (const e of drive.list('/')) {
      if (!e.value || !e.value.blob) continue
      out.push({ path: normalisePath(e.key), sizeBytes: e.value.blob.byteLength })
    }
    return out.sort(byPath)
  }

  // Re-hashes every manifest file that is fully present locally. Files whose
  // entry or blob is not local are reported in `missing` without waiting for
  // peers. `ok` means no checked file disagrees with the manifest; `missing`
  // is reported separately so a deliberate partial fetch is not a failure.
  async verify (driveKey, files) {
    const drive = this.get(driveKey)
    await drive.ready()

    const mismatches = []
    const missing = []
    let checked = 0

    for (const f of files || []) {
      const rel = normalisePath(f && f.path)
      if (!rel) continue

      let entry = null
      try {
        entry = drive.blobs ? await drive.entry('/' + rel, { wait: false, update: false }) : null
      } catch (err) {
        if (err.code !== 'BLOCK_NOT_AVAILABLE') throw err
      }
      if (!entry || !entry.value.blob || !(await drive.has('/' + rel))) {
        missing.push(rel)
        continue
      }

      let actual
      try {
        actual = (await hashStream(drive.createReadStream('/' + rel, { wait: false }))).sha256
      } catch (err) {
        if (err.code !== 'BLOCK_NOT_AVAILABLE') throw err
        missing.push(rel)
        continue
      }

      checked++
      const expected = String(f.sha256 || '').toLowerCase()
      if (actual !== expected) mismatches.push({ path: rel, expected, actual })
    }

    return { ok: mismatches.length === 0, checked, mismatches, missing }
  }

  // --- introspection --------------------------------------------------------

  async stat (driveKey) {
    const hex = b4a.toString(toKey(driveKey), 'hex')
    const zero = { driveKey: hex, peers: 0, files: 0, sizeBytes: 0, downloadedBytes: 0, progress: 0, seeding: false, version: 0 }
    if (this.closing) return zero

    try {
      const rec = this._record(hex)
      const drive = rec.drive
      await drive.ready()

      const entries = await this._entries(rec)
      let sizeBytes = 0
      for (const e of entries) sizeBytes += e.byteLength

      // downloadedBytes counts whole files whose block range is fully local
      // (a bitfield check per file, no I/O). A partially downloaded file
      // contributes 0: exact per-byte accounting would need a walk over every
      // block of the blobs core, which is not cheap for multi-GB drives.
      let downloadedBytes = 0
      if (drive.blobs && drive.blobs.core.opened) {
        for (const e of entries) {
          if (e.blockLength === 0 || await drive.blobs.core.has(e.blockOffset, e.blockOffset + e.blockLength)) {
            downloadedBytes += e.byteLength
          }
        }
      }

      return {
        driveKey: hex,
        peers: peerCount(drive),
        files: entries.length,
        sizeBytes,
        downloadedBytes,
        progress: sizeBytes > 0 ? downloadedBytes / sizeBytes : (entries.length > 0 ? 1 : 0),
        seeding: rec.seeding,
        version: drive.version
      }
    } catch {
      return zero
    }
  }

  async list () {
    return Promise.all([...this.drives.keys()].map(hex => this.stat(hex)))
  }

  // Entry listing cached per drive version. Never waits on the network: if a
  // db block is not local the previous listing (or nothing) is returned.
  async _entries (rec) {
    const drive = rec.drive
    const version = drive.version
    if (rec.stats && rec.stats.version === version) return rec.stats.entries

    const entries = []
    try {
      for await (const e of drive.list('/', { wait: false, update: false })) {
        if (!e.value || !e.value.blob) continue
        const blob = e.value.blob
        entries.push({
          path: normalisePath(e.key),
          byteLength: blob.byteLength,
          blockOffset: blob.blockOffset,
          blockLength: blob.blockLength
        })
      }
    } catch (err) {
      if (err.code !== 'BLOCK_NOT_AVAILABLE') throw err
      return rec.stats ? rec.stats.entries : []
    }

    rec.stats = { version, entries }
    return entries
  }

  _maybeClosed () {
    if (this.closing) throw new Error('DriveManager is closed')
  }
}

// One download of a whole drive or a subset of its paths. Emits 'progress' at
// most every PROGRESS_INTERVAL ms; `promise` resolves when every requested
// blob is local and rejects with code HYPERBAY_CANCELLED on cancel().
class DownloadTask extends EventEmitter {
  constructor (manager, driveKey, drive, paths) {
    super()
    this.manager = manager
    this.driveKey = driveKey
    this.drive = drive
    this.paths = Array.isArray(paths) && paths.length ? paths.map(normalisePath).filter(Boolean) : null

    this.bytes = 0
    this.totalBytes = 0
    this.path = null
    this.done = false
    this.cancelled = false

    this._downloads = []
    this._ranges = []
    this._speed = new Speedometer()
    this._timer = null
    this._lastBytes = -1
    this._lastSpeed = -1
    this._blobsCore = null
    this._onDownload = (index, bytes) => this._track(index, bytes)

    this._cancelled = new Promise((resolve, reject) => { this._rejectCancel = reject })
    this._cancelled.catch(noop)

    this.promise = this._run()
    this.promise.catch(noop)
  }

  cancel () {
    if (this.done || this.cancelled) return
    this.cancelled = true
    for (const d of this._downloads) d.destroy()
    this._rejectCancel(cancelledError())
  }

  _race (p) {
    return Promise.race([p, this._cancelled])
  }

  async _run () {
    try {
      const drive = this.drive
      await this._race(drive.ready())
      await this._waitForContent(drive)
      const blobs = await this._race(drive.getBlobs())
      if (!blobs) throw new Error('drive has no blob store')

      const entries = await this._race(this._collect(drive))
      for (const e of entries) this.totalBytes += e.byteLength
      this._ranges = entries
        .filter(e => e.blockLength > 0)
        .sort((a, b) => a.blockOffset - b.blockOffset)

      // Bytes already local count towards progress before any block arrives.
      for (const e of entries) {
        if (e.blockLength === 0 || await blobs.core.has(e.blockOffset, e.blockOffset + e.blockLength)) {
          this.bytes += e.byteLength
        }
      }
      this._throwIfCancelled()

      this._blobsCore = blobs.core
      blobs.core.on('download', this._onDownload)
      this._timer = setInterval(() => this._tick(false), PROGRESS_INTERVAL)
      if (this._timer.unref) this._timer.unref()
      this._tick(true)

      if (this.paths === null) {
        this._downloads.push(drive.download('/', { recursive: true }))
      } else {
        for (const p of this.paths) this._downloads.push(drive.download('/' + p))
      }
      await this._race(Promise.all(this._downloads.map(d => d.done())))
      this._throwIfCancelled()
      if (drive.closing) throw cancelledError()

      this.bytes = this.totalBytes
      this.done = true
      this._tick(true)
    } finally {
      this._teardown()
    }
  }

  // Block until the drive's db core has content locally. A fresh drive has
  // length 0 until a peer sends the first upgrade; update({ wait: true })
  // returns false immediately when no peer is connected yet, so wait for a
  // peer (or an eager upgrade) and ask again.
  async _waitForContent (drive) {
    const core = drive.core
    for (;;) {
      this._throwIfCancelled()
      await this._race(drive.update({ wait: true }))
      if (core.length > 0) return
      await this._race(waitEvent(core, ['peer-add', 'append'], this._cancelled))
    }
  }

  async _collect (drive) {
    const entries = []
    const push = e => {
      if (!e || !e.value || !e.value.blob) return
      const blob = e.value.blob
      entries.push({
        path: normalisePath(e.key),
        byteLength: blob.byteLength,
        blockOffset: blob.blockOffset,
        blockLength: blob.blockLength
      })
    }

    if (this.paths === null) {
      for await (const e of drive.list('/')) push(e)
      return entries
    }

    for (const p of this.paths) {
      const before = entries.length
      const e = await drive.entry('/' + p)
      if (e) {
        push(e)
      } else {
        for await (const child of drive.list('/' + p)) push(child)
      }
      if (entries.length === before) {
        const err = new Error('not in drive: ' + p)
        err.code = 'HYPERBAY_NOT_FOUND'
        throw err
      }
    }
    return entries
  }

  _track (index, bytes) {
    const range = findRange(this._ranges, index)
    if (range === null) return
    this.path = range.path
    this.bytes = Math.min(this.totalBytes, this.bytes + bytes)
    this._speed.add(bytes)
  }

  _tick (force) {
    const speed = this._speed.rate()
    if (!force && this.bytes === this._lastBytes && speed === this._lastSpeed) return
    this._lastBytes = this.bytes
    this._lastSpeed = speed
    const ev = {
      driveKey: this.driveKey,
      bytes: this.bytes,
      totalBytes: this.totalBytes,
      progress: this.totalBytes > 0 ? this.bytes / this.totalBytes : (this.done ? 1 : 0),
      speed,
      peers: this._blobsCore ? this._blobsCore.peers.length : peerCount(this.drive),
      path: this.path
    }
    this.emit('progress', ev)
    this.manager.emit('progress', ev)
  }

  _throwIfCancelled () {
    if (this.cancelled) throw cancelledError()
  }

  _teardown () {
    clearInterval(this._timer)
    this._timer = null
    if (this._blobsCore) this._blobsCore.off('download', this._onDownload)
    for (const d of this._downloads) d.destroy()
  }
}

// Rolling bytes/sec over the last SPEED_WINDOW ms.
class Speedometer {
  constructor () {
    this.samples = []
  }

  add (bytes) {
    this.samples.push({ at: Date.now(), bytes })
  }

  rate () {
    const now = Date.now()
    const cutoff = now - SPEED_WINDOW
    let i = 0
    while (i < this.samples.length && this.samples[i].at < cutoff) i++
    if (i > 0) this.samples.splice(0, i)
    if (this.samples.length === 0) return 0
    let total = 0
    for (const s of this.samples) total += s.bytes
    const span = Math.max(1000, now - this.samples[0].at)
    return Math.round(total * 1000 / span)
  }
}

// --- helpers ----------------------------------------------------------------

// Pump `source` (buffer, string, async iterable, or web ReadableStream) into a
// streamx writable, hashing every chunk on the way. Honours backpressure and
// resolves once the writable has closed, i.e. once hyperdrive committed the
// entry.
async function pump (source, ws, onChunk) {
  const h = new Sha256()
  let bytes = 0

  const closed = new Promise((resolve, reject) => {
    ws.once('error', reject)
    ws.once('close', resolve)
  })
  closed.catch(noop)

  try {
    for await (const chunk of iterate(source)) {
      const buf = typeof chunk === 'string' ? b4a.from(chunk) : chunk
      h.update(buf)
      bytes += buf.byteLength
      if (onChunk) onChunk(bytes)
      if (ws.write(buf) === false) await Promise.race([drained(ws), closed])
    }
    ws.end()
    await closed
  } catch (err) {
    ws.destroy(err)
    throw err
  }

  return { sha256: h.hex(), sizeBytes: bytes }
}

function iterate (source) {
  if (b4a.isBuffer(source) || source instanceof Uint8Array || typeof source === 'string') return [source]
  if (source[Symbol.asyncIterator] || source[Symbol.iterator]) return source
  if (typeof source.getReader === 'function') return readerIterator(source)
  throw badArgument('unsupported stream source')
}

async function * readerIterator (webStream) {
  const reader = webStream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

function drained (ws) {
  return new Promise(resolve => ws.once('drain', resolve))
}

function waitEvent (emitter, names, cancelled) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { for (const n of names) emitter.off(n, onevent) }
    const onevent = () => { cleanup(); resolve() }
    for (const n of names) emitter.on(n, onevent)
    cancelled.catch(err => { cleanup(); reject(err) })
  })
}

async function walk (root, rel, ignored, out) {
  const dir = rel ? path.join(root, rel) : root
  const dirents = await fsp.readdir(dir, { withFileTypes: true })
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const d of dirents) {
    const child = rel ? rel + '/' + d.name : d.name
    if (ignored(child)) continue
    if (d.isDirectory()) {
      await walk(root, child, ignored, out)
    } else if (d.isFile()) {
      const st = await fsp.stat(path.join(root, child))
      out.push({ path: child, sizeBytes: st.size })
    }
    // symlinks, sockets, devices: skipped
  }
}

function makeIgnore (extra) {
  const names = new Set(DEFAULT_IGNORE)
  const suffixes = [...DEFAULT_IGNORE_SUFFIX]
  const paths = []
  let fn = null

  for (const raw of [].concat(extra || [])) {
    if (typeof raw === 'function') {
      fn = raw
      continue
    }
    const s = normalisePath(raw).replace(/\/+$/, '')
    if (!s) continue
    if (s.startsWith('*')) suffixes.push(s.slice(1))
    else if (s.includes('/')) paths.push(s)
    else names.add(s)
  }

  return rel => {
    const segs = rel.split('/')
    for (const seg of segs) if (names.has(seg)) return true
    const base = segs[segs.length - 1]
    for (const suf of suffixes) if (base.endsWith(suf)) return true
    for (const p of paths) if (rel === p || rel.startsWith(p + '/')) return true
    return fn ? !!fn(rel) : false
  }
}

function findRange (ranges, index) {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (index < r.blockOffset) hi = mid - 1
    else if (index >= r.blockOffset + r.blockLength) lo = mid + 1
    else return r
  }
  return null
}

function toKey (key) {
  if (b4a.isBuffer(key)) {
    if (key.byteLength !== 32) throw badArgument('drive key must be 32 bytes')
    return key
  }
  if (typeof key !== 'string') throw badArgument('drive key must be a hex string or buffer')
  try {
    return idEnc.decode(key)
  } catch {
    throw badArgument('invalid drive key: ' + key)
  }
}

function peerCount (drive) {
  const core = drive && drive.core
  return core && core.peers ? core.peers.length : 0
}

function byPath (a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
}

function cancelledError () {
  const err = new Error('download cancelled')
  err.code = 'HYPERBAY_CANCELLED'
  return err
}

function badArgument (msg) {
  const err = new Error(msg)
  err.code = 'HYPERBAY_BAD_ARGUMENT'
  return err
}

function noop () {}

module.exports = DriveManager
