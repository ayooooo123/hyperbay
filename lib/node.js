// HyperbayNode — the single object the CLI, the HTTP gateway and the Pear
// desktop app all construct. Owns the Corestore, the Hyperswarm, the catalog
// (Autobase) and the drive manager (Hyperdrive), and is the only place that
// wires replication.

const ReadyResource = require('ready-resource')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const path = require('bare-path')
const b4a = require('b4a')
const idEnc = require('hypercore-id-encoding')

const Catalog = require('./catalog.js')
const DriveManager = require('./drives.js')
const { loadIdentity } = require('./trust.js')
const { resolveStorage, readConfig, writeConfig } = require('./config.js')
const { normaliseSlug, ValidationError } = require('./schema.js')

const RATE_INTERVAL = 1000

class HyperbayNode extends ReadyResource {
  constructor ({ storage, catalogKey = null, seed = false, swarm = true } = {}) {
    super()

    this.storagePath = resolveStorage(storage)
    this.config = readConfig(this.storagePath)
    this.identity = loadIdentity(this.storagePath)
    this.store = new Corestore(path.join(this.storagePath, 'cores'))

    // Reuse the node identity as the swarm keypair so a peer keeps a stable
    // network identity across restarts.
    this.swarm = swarm
      ? new Hyperswarm({ keyPair: { publicKey: this.identity.publicKey, secretKey: this.identity.secretKey } })
      : null

    // Each bay gets its own Corestore namespace, keyed by the catalog it
    // bootstraps from. That is what makes joining a different bay at runtime
    // safe: the local writer core of one bay never collides with another's.
    this.catalog = this._openCatalog(catalogKey || this.config.catalogKey)
    this.drives = new DriveManager(this.store.namespace('drives'), this.swarm, { identity: this.identity })

    this.autoSeed = seed
    this.traffic = { up: 0, down: 0, upTotal: 0, downTotal: 0 }

    this._rateTimer = null
    this._lastSample = { up: 0, down: 0, at: 0 }
    this._onCatalogUpdate = () => this.emit('update')
    this._onDriveProgress = ev => this.emit('progress', ev)
    this._onConnection = conn => {
      // One Corestore replication over the connection carries both the catalog
      // views and every artifact drive, since they are namespaces of the same
      // store. The wakeup channel is separate and is what lets an optimistic
      // append from a peer that is not a writer reach an indexer — without it,
      // open publishing silently does nothing.
      this.store.replicate(conn)
      this.catalog.addStream(conn)
      this.emit('peers', this.peerCount())
      conn.on('close', () => this.emit('peers', this.peerCount()))
    }
  }

  get key () {
    return this.catalog.key
  }

  get catalogKey () {
    return this.catalog.key ? idEnc.normalize(this.catalog.key) : null
  }

  peerCount () {
    return this.swarm ? this.swarm.connections.size : 0
  }

  _openCatalog (key) {
    const normalized = key ? idEnc.normalize(key) : null
    const namespace = normalized ? 'catalog/' + normalized : 'catalog'
    return new Catalog(this.store.namespace(namespace), normalized ? idEnc.decode(normalized) : null, {
      identity: this.identity
    })
  }

  // Join a different bay at runtime. This is the whole point of a catalog key
  // being shareable: a peer pastes one and starts replicating that index. The
  // node keeps its identity, its drives and everything it seeds — only the
  // index it reads and writes changes.
  async joinCatalog (key) {
    const normalized = key ? idEnc.normalize(key) : null
    if (normalized && normalized === this.catalogKey) return { catalogKey: normalized, changed: false }

    const previous = this.catalog
    const next = this._openCatalog(normalized)
    await next.ready()

    if (this.swarm) this.swarm.leave(previous.discoveryKey)
    previous.off('update', this._onCatalogUpdate)

    this.catalog = next
    this.catalog.on('update', this._onCatalogUpdate)

    this.config.catalogKey = idEnc.normalize(this.catalog.key)
    writeConfig(this.storagePath, this.config)

    if (this.swarm) {
      this.swarm.join(this.catalog.discoveryKey, { server: true, client: true })
      // Existing connections replicate the corestore already; the new bay's
      // cores still need the wakeup channel so optimistic writes flow.
      for (const conn of this.swarm.connections) this.catalog.addStream(conn)
    }

    await previous.close()
    this.emit('update')

    return { catalogKey: this.catalogKey, changed: true }
  }

  async _open () {
    await this.store.ready()
    await this.catalog.ready()
    await this.drives.ready()

    this.catalog.on('update', this._onCatalogUpdate)
    this.drives.on('progress', this._onDriveProgress)

    // Persist the catalog key on first boot so the next start rejoins the same
    // bay without being told which one it was.
    const normalized = idEnc.normalize(this.catalog.key)
    if (this.config.catalogKey !== normalized) {
      this.config.catalogKey = normalized
      writeConfig(this.storagePath, this.config)
    }

    if (this.swarm) {
      this.swarm.on('connection', this._onConnection)
      this.swarm.join(this.catalog.discoveryKey, { server: true, client: true })
      this._rateTimer = setInterval(() => this._sampleTraffic(), RATE_INTERVAL)
      if (this._rateTimer.unref) this._rateTimer.unref()
    }

    if (this.autoSeed) await this.resumeSeeding()
  }

  async _close () {
    clearInterval(this._rateTimer)
    this.catalog.off('update', this._onCatalogUpdate)
    this.drives.off('progress', this._onDriveProgress)
    if (this.swarm) {
      this.swarm.off('connection', this._onConnection)
      await this.swarm.destroy()
    }
    await this.drives.close()
    await this.catalog.close()
    await this.store.close()
  }

  // Real byte counters off the UDX sockets underneath each Hyperswarm
  // connection, differenced once a second to give live up/down rates.
  _sampleTraffic () {
    if (!this.swarm) return
    let up = 0
    let down = 0
    for (const conn of this.swarm.connections) {
      const raw = conn.rawStream
      if (!raw) continue
      up += raw.bytesTransmitted || 0
      down += raw.bytesReceived || 0
    }
    const now = Date.now()
    const elapsed = this._lastSample.at ? (now - this._lastSample.at) / 1000 : 0
    if (elapsed > 0) {
      // Connections churn, so a negative delta just means a socket went away.
      this.traffic.up = Math.max(0, (up - this._lastSample.up) / elapsed)
      this.traffic.down = Math.max(0, (down - this._lastSample.down) / elapsed)
    }
    this.traffic.upTotal = up
    this.traffic.downTotal = down
    this._lastSample = { up, down, at: now }
    this.emit('traffic', { ...this.traffic, peers: this.peerCount() })
  }

  async waitForPeers ({ timeout = 8000 } = {}) {
    if (!this.swarm) return 0
    await this.swarm.flush().catch(() => {})
    if (this.peerCount() > 0) return this.peerCount()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.swarm.off('connection', onConn)
        resolve(this.peerCount())
      }, timeout)
      const onConn = () => {
        clearTimeout(timer)
        this.swarm.off('connection', onConn)
        resolve(this.peerCount())
      }
      this.swarm.on('connection', onConn)
    })
  }

  // --- publishing -----------------------------------------------------------

  async publishFolder (dir, meta = {}, { onProgress } = {}) {
    const published = await this.drives.publishFolder(dir, { onProgress })
    const artifact = await this.catalog.publish({
      ...meta,
      driveKey: published.driveKey,
      files: published.files,
      sizeBytes: published.sizeBytes
    })
    await this.catalog.announceMirror(artifact.slug, published.driveKey)
    await this._rememberSeeding(artifact.slug)
    return artifact
  }

  async importHuggingFace (repo, opts = {}) {
    const { importHuggingFace } = require('./import/hf.js')
    const artifact = await importHuggingFace(repo, { ...opts, node: this })
    await this.catalog.announceMirror(artifact.slug, artifact.driveKey)
    await this._rememberSeeding(artifact.slug)
    return artifact
  }

  // --- consuming ------------------------------------------------------------

  async resolve (slug) {
    const artifact = await this.catalog.get(normaliseSlug(slug))
    if (!artifact) {
      const err = new ValidationError('unknown artifact: ' + slug)
      err.code = 'HYPERBAY_NOT_FOUND'
      throw err
    }
    return artifact
  }

  async fetchArtifact (slug, { paths, dest, onProgress } = {}) {
    const artifact = await this.resolve(slug)
    const task = this.drives.download(artifact.driveKey, { paths })
    if (onProgress) task.on('progress', onProgress)
    await task.promise

    const report = await this.drives.verify(artifact.driveKey, artifact.files)
    if (dest) await this._exportTo(artifact, dest, paths)
    return { artifact, verified: report }
  }

  // LocalDrive creates intermediate directories itself, so this is just a
  // stream copy out of the hyperdrive onto the filesystem.
  async _exportTo (artifact, dest, paths) {
    const LocalDrive = require('localdrive')
    const out = new LocalDrive(path.resolve(dest))
    const files = paths && paths.length ? artifact.files.filter(f => paths.includes(f.path)) : artifact.files
    for (const file of files) {
      const rs = this.drives.createReadStream(artifact.driveKey, file.path)
      const ws = out.createWriteStream('/' + file.path)
      await pipe(rs, ws)
    }
    return dest
  }

  async seedArtifact (slug) {
    const artifact = await this.resolve(slug)
    await this.drives.seed(artifact.driveKey)
    await this.catalog.announceMirror(artifact.slug, artifact.driveKey)
    await this._rememberSeeding(artifact.slug)
    return artifact
  }

  async unseedArtifact (slug) {
    const artifact = await this.resolve(slug)
    await this.drives.unseed(artifact.driveKey)
    this.config.seeding = this.config.seeding.filter(s => s !== artifact.slug)
    writeConfig(this.storagePath, this.config)
    return artifact
  }

  async resumeSeeding () {
    const resumed = []
    for (const slug of this.config.seeding) {
      try {
        const artifact = await this.catalog.get(slug)
        if (!artifact) continue
        await this.drives.seed(artifact.driveKey)
        resumed.push(slug)
      } catch {
        // A seed we can no longer resolve is not fatal; the catalog may simply
        // not have replicated yet.
      }
    }
    return resumed
  }

  async _rememberSeeding (slug) {
    if (this.config.seeding.includes(slug)) return
    this.config.seeding.push(slug)
    writeConfig(this.storagePath, this.config)
  }

  // --- introspection --------------------------------------------------------

  async seedingState () {
    const out = []
    for (const slug of this.config.seeding) {
      const artifact = await this.catalog.get(slug)
      if (!artifact) continue
      const stat = await this.drives.stat(artifact.driveKey)
      out.push({ slug, name: artifact.name, owner: artifact.owner, sizeBytes: artifact.sizeBytes, ...stat })
    }
    return out
  }

  async state () {
    return {
      catalogKey: this.catalogKey,
      identity: this.identity.hex,
      writable: this.catalog.writable,
      artifacts: this.catalog.length,
      peers: this.peerCount(),
      seeding: this.config.seeding.length,
      up: Math.round(this.traffic.up),
      down: Math.round(this.traffic.down),
      upTotal: this.traffic.upTotal,
      downTotal: this.traffic.downTotal,
      storage: this.storagePath
    }
  }

  peers () {
    if (!this.swarm) return []
    const out = []
    for (const conn of this.swarm.connections) {
      const raw = conn.rawStream
      out.push({
        publicKey: b4a.toString(conn.remotePublicKey, 'hex'),
        host: raw && raw.remoteHost ? raw.remoteHost : null,
        port: raw && raw.remotePort ? raw.remotePort : null,
        rtt: raw ? raw.rtt : null,
        up: raw ? raw.bytesTransmitted : 0,
        down: raw ? raw.bytesReceived : 0
      })
    }
    return out
  }
}

function pipe (rs, ws) {
  return new Promise((resolve, reject) => {
    rs.on('error', reject)
    ws.on('error', reject)
    ws.on('close', resolve)
    rs.pipe(ws)
  })
}

module.exports = HyperbayNode
