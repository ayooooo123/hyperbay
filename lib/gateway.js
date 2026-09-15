// Local HTTP bridge. Runs on Bare (bare-http1) so curl, huggingface_hub and
// any local tool can pull multi-GB weight files straight out of a hyperdrive:
// every file route streams, never buffers, and tears the read stream down the
// moment the response closes.

const http = require('bare-http1')
const path = require('bare-path')
const { EventEmitter } = require('bare-events')
const fs = require('bare-fs').promises
const fsStreams = require('bare-fs')
const { slugify } = require('./schema')

const MAX_BODY = 1024 * 1024 // 1 MiB cap on JSON request bodies
const SSE_PING_MS = 15000

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // The UI ships as .mjs, and a browser refuses a module script served with
  // anything but a JavaScript MIME type.
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8'
}

const ALLOW_METHODS = 'GET, HEAD, POST, PUT, DELETE, OPTIONS'

function noop () {}

function sendJSON (res, status, value, headers) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength
  }, headers))
  res.end(body)
}

// err.statusCode wins (route-level 404/400/413), then schema codes, then 500.
function statusFor (err) {
  if (err && err.statusCode) return err.statusCode
  if (err && err.code === 'HYPERBAY_INVALID') return 400
  if (err && err.code === 'HYPERBAY_NOT_FOUND') return 404
  if (err && err.code === 'HYPERBAY_CONFLICT') return 409
  return 500
}

function failRequest (res, err) {
  if (res.headersSent || res.destroyed) return
  sendJSON(res, statusFor(err), {
    error: err && err.message ? err.message : String(err || 'error'),
    code: err && err.code ? err.code : 'HYPERBAY_ERROR'
  })
}

function httpError (status, message, code) {
  const err = new Error(message)
  err.statusCode = status
  err.code = code || (status === 404 ? 'HYPERBAY_NOT_FOUND' : 'HYPERBAY_ERROR')
  return err
}

function notFound (what) {
  return httpError(404, (what || 'Resource') + ' not found')
}

// Minimal query-string parser: 'a=1&b=x%20y' -> { a: '1', b: 'x y' }.
// Repeated keys collapse into arrays. Hand-rolled: no url/querystring module.
function parseQuery (search) {
  const out = {}
  if (!search) return out
  for (const pair of search.split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    const rawKey = eq === -1 ? pair : pair.slice(0, eq)
    const rawValue = eq === -1 ? '' : pair.slice(eq + 1)
    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
    const value = decodeURIComponent(rawValue.replace(/\+/g, ' '))
    if (key in out) out[key] = [].concat(out[key], value)
    else out[key] = value
  }
  return out
}

// Splits the request line into decoded path segments and a query object. Only
// whole segments are decoded, so a raw %2F can never smuggle in an extra '/'
// separator.
function splitURL (url) {
  const i = url.indexOf('?')
  const pathname = i === -1 ? url : url.slice(0, i)
  const query = parseQuery(i === -1 ? '' : url.slice(i + 1))
  const parts = []
  for (const segment of pathname.split('/')) {
    if (segment === '') continue
    parts.push(decodeURIComponent(segment))
  }
  return { parts, query }
}

function header (req, name) {
  const v = req.headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

// 'bytes=0-499', 'bytes=500-', 'bytes=-500' -> { start, end } or null when
// unsatisfiable. `total` may be null when the size is unknown.
function parseRange (spec, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(spec).trim())
  if (!m || (m[1] === '' && m[2] === '')) return null

  if (m[1] === '') {
    const suffix = Number(m[2])
    if (total === null || !(suffix > 0)) return null
    return { start: Math.max(0, total - suffix), end: total - 1 }
  }

  const start = Number(m[1])
  if (total !== null && start >= total) return null

  let end = m[2] === '' ? (total === null ? null : total - 1) : Number(m[2])
  if (end !== null && end < start) return null
  if (end !== null && total !== null) end = Math.min(end, total - 1)
  return { start, end }
}

// if-none-match holds a comma list of etags, possibly weak-tagged.
function etagMatches (ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false
  for (let candidate of ifNoneMatch.split(',')) {
    candidate = candidate.trim()
    if (candidate === '*') return true
    if (candidate.startsWith('W/')) candidate = candidate.slice(2)
    if (candidate === etag) return true
  }
  return false
}

// Reads a JSON request body with a hard size cap. Malformed, oversized or
// aborted bodies reject with a mapped statusCode (400 / 413).
function readJSONBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    let overflowed = false

    const done = (err, value) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(value)
    }

    req.on('data', chunk => {
      if (settled) return
      size += chunk.byteLength
      if (size > MAX_BODY) {
        // Not destroyed on purpose: bare-http1 ties the response to the same
        // socket, so killing the request here would prevent the 413 from ever
        // reaching the client. Mark it, drop the rest, and answer once the
        // body ends; the connection: close header retires the socket.
        overflowed = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (settled) return
      if (overflowed) return done(httpError(413, 'Request body too large (max 1 MiB)'))
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return done(null, {})
      let value
      try {
        value = JSON.parse(text)
      } catch {
        return done(httpError(400, 'Malformed JSON body'))
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return done(httpError(400, 'Request body must be a JSON object'))
      }
      done(null, value)
    })

    req.on('error', err => done(err))
    req.on('close', () => done(httpError(400, 'Request aborted')))
  })
}

function setCommonHeaders (res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'authorization, content-type, if-none-match, range, x-requested-with')
  res.setHeader('access-control-allow-methods', ALLOW_METHODS)
  res.setHeader('access-control-expose-headers', 'content-range, accept-ranges, etag, x-hyperbay-revision, x-repo-commit')
}

function normalizeSlug (owner, name) {
  const slug = slugify(owner, name)
  if (!slug || slug.indexOf('/') === -1) throw notFound('Artifact')
  return slug
}

function slugFromPath (slug) {
  const i = String(slug || '').indexOf('/')
  if (i === -1) throw notFound('Artifact')
  return normalizeSlug(slug.slice(0, i), slug.slice(i + 1))
}

// The single streaming file responder behind /f/... and the
// huggingface_hub-compatible /:owner/:name/resolve/:rev/... route.
//
// Supports: Range (single range, 206 + content-range, 416 when unsatisfiable),
// HEAD (headers only), etag from the manifest's per-file sha256, 304 on
// if-none-match, and client aborts — the read stream is destroyed the moment
// the response closes so a resumed download never wedges a multi-GB transfer.
async function sendFile (node, artifact, filePath, req, res) {
  if (typeof filePath !== 'string' || filePath === '' || filePath.includes('..')) {
    throw httpError(400, 'Invalid file path')
  }

  // File size and integrity live in the catalog manifest; the drive entry is
  // only consulted when there is no manifest to check against.
  let sizeBytes = null
  let sha256 = null
  const files = artifact.files
  if (Array.isArray(files)) {
    // The manifest is authoritative: a path it does not list does not exist
    // as far as HTTP clients are concerned — this is what keeps the
    // content-length and etag guarantees honest.
    const entry = files.find(f => f && f.path === filePath)
    if (!entry) throw notFound('File')
    sizeBytes = typeof entry.sizeBytes === 'number' ? entry.sizeBytes : null
    sha256 = entry.sha256 || null
  } else if (typeof node.drives.entry === 'function') {
    const entry = await node.drives.entry(artifact.driveKey, filePath)
    if (!entry || !entry.value || !entry.value.blob) throw notFound('File')
    sizeBytes = entry.value.blob.byteLength
    if (entry.value.metadata && entry.value.metadata.sha256) sha256 = entry.value.metadata.sha256
  } else {
    throw notFound('File')
  }

  const etag = sha256
  if (etag && etagMatches(header(req, 'if-none-match'), etag)) {
    res.writeHead(304, {
      etag,
      'accept-ranges': 'bytes',
      'cache-control': 'public, max-age=3600'
    })
    return res.end()
  }

  let start = 0
  let end = sizeBytes === null ? null : sizeBytes - 1
  let status = 200

  const rangeHeader = header(req, 'range')
  if (rangeHeader) {
    const range = parseRange(rangeHeader, sizeBytes)
    if (!range) {
      if (sizeBytes === null) throw httpError(416, 'Range not satisfiable')
      res.writeHead(416, { 'content-range': 'bytes */' + sizeBytes })
      return res.end()
    }
    start = range.start
    end = range.end
    status = 206
  }

  const headers = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=3600'
  }
  if (etag) headers.etag = etag

  if (sizeBytes !== null) {
    headers['content-length'] = String(end - start + 1)
    if (status === 206) headers['content-range'] = 'bytes ' + start + '-' + end + '/' + sizeBytes
  } else if (status === 206) {
    // A partial response of unknown length cannot be chunked (the client could
    // not tell it apart from a full body), so the connection is closed instead
    // to mark the end of the body.
    headers.connection = 'close'
  }

  res.writeHead(status, headers)

  if (req.method === 'HEAD') return res.end()

  const stream = node.drives.createReadStream(artifact.driveKey, filePath, { start, end })

  res.on('close', () => {
    if (!stream.destroyed) stream.destroy()
  })

  stream.on('error', err => {
    if (!res.headersSent) failRequest(res, err)
    else res.destroy()
  })

  stream.pipe(res)
}

// Serves ui/ for the browser UI. '..' segments are rejected outright and the
// file is resolved through realpath so a symlink inside ui/ cannot point out
// of the tree.
async function handleStatic (req, res, segments) {
  const rel = segments.join('/')
  if (rel.includes('..')) throw httpError(400, 'Invalid path')

  const root = path.resolve(__dirname, '..', 'ui')
  const target = path.join(root, rel)

  let real
  try {
    real = await fs.realpath(target)
  } catch {
    throw notFound('File')
  }

  if (real !== root && !real.startsWith(root + path.sep)) {
    throw httpError(400, 'Invalid path')
  }

  const stat = await fs.stat(real)
  if (!stat.isFile()) throw notFound('File')

  const type = CONTENT_TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream'

  res.writeHead(200, { 'content-type': type, 'content-length': stat.size })

  if (req.method === 'HEAD') return res.end()

  const stream = fsStreams.createReadStream(real)
  res.on('close', () => {
    if (!stream.destroyed) stream.destroy()
  })
  stream.on('error', noop)
  stream.pipe(res)
}

function createGateway (node, { port = 8433, host = '127.0.0.1', ui = true } = {}) {
  const jobs = new Map()
  let nextJobId = 1

  // Fan-out point between the node's events and every SSE client.
  const events = new EventEmitter()
  events.setMaxListeners(0)

  const onNodeUpdate = payload => events.emit('update', payload)
  const onNodeProgress = payload => events.emit('progress', payload)
  const onNodePeers = payload => events.emit('peers', payload)

  node.on('update', onNodeUpdate)
  node.on('progress', onNodeProgress)
  node.on('peers', onNodePeers)

  // Long-running operations (publish / import / download of multi-GB trees)
  // never hold an HTTP request open: they run in the background, respond
  // { ok: true, job } immediately, and stream progress over /api/events as
  // { job, ... } payloads.
  function startJob (kind, run) {
    const id = nextJobId++
    const job = { id, kind, status: 'running', result: null, error: null }
    jobs.set(id, job)

    const emit = payload => events.emit('progress', { job: id, kind, ...payload })
    emit({ status: 'running' })

    Promise.resolve()
      .then(() => run(emit))
      .then(result => {
        job.status = 'done'
        job.result = result
        emit({ status: 'done', result })
      })
      .catch(err => {
        job.status = 'error'
        job.error = err && err.message ? err.message : String(err)
        emit({ status: 'error', error: job.error })
      })

    return { ok: true, job: id }
  }

  async function getArtifact (slug) {
    const artifact = await node.catalog.get(slug)
    if (!artifact) throw notFound('Artifact')
    return artifact
  }

  async function handleEvents (req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })

    const send = (event, data) => {
      if (!res.destroyed) {
        res.write('event: ' + event + '\ndata: ' + JSON.stringify(data === undefined ? null : data) + '\n\n')
      }
    }

    const onUpdate = payload => send('update', payload)
    const onProgress = payload => send('progress', payload)
    const onPeers = payload => send('peers', payload)

    events.on('update', onUpdate)
    events.on('progress', onProgress)
    events.on('peers', onPeers)

    send('open', { ok: true })

    const ping = setInterval(() => {
      if (!res.destroyed) res.write(': ping\n\n')
    }, SSE_PING_MS)

    const cleanup = () => {
      clearInterval(ping)
      events.off('update', onUpdate)
      events.off('progress', onProgress)
      events.off('peers', onPeers)
    }

    res.on('close', cleanup)
    res.on('error', cleanup)
  }

  async function handleFileRoute (req, res, parts) {
    // parts = [owner, name, ...pathSegments]
    const slug = normalizeSlug(parts[0], parts[1])
    const artifact = await getArtifact(slug)
    return sendFile(node, artifact, parts.slice(2).join('/'), req, res)
  }

  async function handleResolveRoute (req, res, parts) {
    // parts = [owner, name, 'resolve', rev, ...pathSegments]
    const slug = normalizeSlug(parts[0], parts[1])
    const artifact = await getArtifact(slug)

    // ':rev' is accepted for huggingface_hub compatibility and echoed back;
    // the bytes always come from the hyperdrive the catalog points at.
    const rev = String(parts[3]).replace(/[^\x20-\x7e]/g, '')
    res.setHeader('x-hyperbay-revision', rev)
    res.setHeader('x-repo-commit', String((artifact.source && artifact.source.revision) || artifact.updatedAt || ''))

    return sendFile(node, artifact, parts.slice(4).join('/'), req, res)
  }

  async function handleApi (req, res, parts, query, bodyPromise) {
    switch (parts[1]) {
      case 'state':
        return sendJSON(res, 200, await node.state())

      case 'artifacts': {
        if (parts.length === 2) {
          const opts = {
            sort: query.sort,
            owner: query.owner,
            tag: query.tag,
            task: query.task,
            license: query.license,
            format: query.format,
            limit: query.limit === undefined ? undefined : Number(query.limit),
            cursor: query.cursor
          }
          // '?q=' turns the listing route into a search; the plain route
          // paginates the whole index.
          const rows = query.q
            ? await node.catalog.search(query.q, opts)
            : await node.catalog.list(opts)
          return sendJSON(res, 200, rows)
        }

        if (parts.length === 4) {
          const artifact = await getArtifact(normalizeSlug(parts[2], parts[3]))
          return sendJSON(res, 200, artifact)
        }

        if (parts.length === 5 && parts[4] === 'files') {
          const artifact = await getArtifact(normalizeSlug(parts[2], parts[3]))
          const files = await node.drives.listFiles(artifact.driveKey)
          return sendJSON(res, 200, { slug: artifact.slug, files })
        }

        throw notFound('Route')
      }

      case 'facets':
        return sendJSON(res, 200, await node.catalog.facets({
          limit: query.limit === undefined ? undefined : Number(query.limit)
        }))

      case 'peers': {
        const peers = node.swarm && node.swarm.peers ? node.swarm.peers : []
        return sendJSON(res, 200, { peers, state: await node.state() })
      }

      // The UI needs slug-annotated rows, and drives.list() is async — an
      // unawaited promise serialises to {}.
      case 'seeding':
        return sendJSON(res, 200, await node.seedingState())

      case 'seed': {
        const body = await bodyPromise
        const slug = slugFromPath(body.slug)
        const artifact = await getArtifact(slug)
        if (req.method === 'DELETE') {
          await node.drives.unseed(artifact.driveKey)
          return sendJSON(res, 200, { ok: true, slug, seeding: false })
        }
        await node.drives.seed(artifact.driveKey)
        return sendJSON(res, 200, { ok: true, slug, seeding: true })
      }

      case 'download': {
        const body = await bodyPromise
        const artifact = await getArtifact(slugFromPath(body.slug))
        return sendJSON(res, 200, startJob('download', async emit => {
          const task = node.drives.download(artifact.driveKey, { paths: body.paths })
          if (task && typeof task.on === 'function') task.on('progress', payload => emit(payload))
          if (task && task.promise) await task.promise
          if (body.dest) {
            // A copy landing on disk is cross-checked against the manifest
            // before the job may report success.
            const files = await node.drives.listFiles(artifact.driveKey)
            const check = await node.drives.verify(artifact.driveKey, files)
            if (check && check.ok === false) {
              throw Object.assign(new Error('Downloaded files failed verification'), {
                mismatches: check.mismatches
              })
            }
          }
          return { slug: artifact.slug, dest: body.dest || null, paths: body.paths || null }
        }))
      }

      case 'publish': {
        const body = await bodyPromise
        if (typeof body.dir !== 'string' || body.dir === '') {
          throw httpError(400, 'dir is required', 'HYPERBAY_INVALID')
        }
        return sendJSON(res, 200, startJob('publish', async emit => {
          const artifact = await node.publishFolder(body.dir, body.meta || {}, {
            onProgress: payload => emit(payload)
          })
          return { slug: artifact.slug, driveKey: artifact.driveKey, sizeBytes: artifact.sizeBytes }
        }))
      }

      case 'import': {
        const body = await bodyPromise
        if (typeof body.repo !== 'string' || body.repo === '') {
          throw httpError(400, 'repo is required', 'HYPERBAY_INVALID')
        }
        return sendJSON(res, 200, startJob('import', async emit => {
          const artifact = await node.importHuggingFace(body.repo, {
            revision: body.revision,
            include: body.include,
            exclude: body.exclude,
            onProgress: payload => emit(payload)
          })
          return { slug: artifact.slug, driveKey: artifact.driveKey, sizeBytes: artifact.sizeBytes }
        }))
      }

      case 'vote': {
        const body = await bodyPromise
        await node.catalog.vote(body.slug, body.value === 1 ? 1 : -1)
        return sendJSON(res, 200, { ok: true })
      }

      case 'flag': {
        const body = await bodyPromise
        await node.catalog.flag(body.slug, String(body.reason || ''))
        return sendJSON(res, 200, { ok: true })
      }

      // Joining another peer's bay is a first-class action: a shareable catalog
      // key is useless if you cannot point a running node at it.
      case 'catalog': {
        if (req.method === 'GET') return sendJSON(res, 200, { catalogKey: node.catalogKey })
        const body = await bodyPromise
        if (!body || !body.key) throw httpError(400, 'catalog key is required', 'HYPERBAY_INVALID')
        return sendJSON(res, 200, await node.joinCatalog(String(body.key).trim()))
      }

      case 'jobs': {
        if (parts.length === 2) {
          return sendJSON(res, 200, { jobs: [...jobs.values()] })
        }
        const job = jobs.get(Number(parts[2]))
        if (!job) throw notFound('Job')
        return sendJSON(res, 200, job)
      }

      case 'events':
        return handleEvents(req, res)

      default:
        throw notFound('Route')
    }
  }

  const server = http.createServer(async (req, res) => {
    setCommonHeaders(res)
    res.on('error', noop)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        allow: ALLOW_METHODS,
        'access-control-max-age': '86400'
      })
      res.end()
      return
    }

    const bodyPromise = (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE')
      ? readJSONBody(req)
      : Promise.resolve({})

    try {
      const { parts, query } = splitURL(req.url)

      if (parts.length === 0) {
        // '/' — the UI, or with ui disabled, the node state as JSON.
        if (ui) return await handleStatic(req, res, ['index.html'])
        return sendJSON(res, 200, await node.state())
      }

      if (parts[0] === 'api') {
        return await handleApi(req, res, parts, query, bodyPromise)
      }

      if (parts[0] === 'assets') {
        return await handleStatic(req, res, parts)
      }

      if (parts[0] === 'f' && parts.length >= 3) {
        return await handleFileRoute(req, res, parts.slice(1))
      }

      if (parts.length >= 4 && parts[2] === 'resolve') {
        return await handleResolveRoute(req, res, parts)
      }

      // Unknown route: with the UI enabled the client-side router owns it.
      if (ui && (req.method === 'GET' || req.method === 'HEAD')) {
        return await handleStatic(req, res, ['index.html'])
      }

      throw notFound('Route')
    } catch (err) {
      failRequest(res, err)
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)

    server.listen(port, host, () => {
      const bound = server.address()
      const boundPort = bound && typeof bound === 'object' ? bound.port : port

      resolve({
        server,
        port: boundPort,
        url: 'http://' + (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host) + ':' + boundPort,
        close () {
          node.off('update', onNodeUpdate)
          node.off('progress', onNodeProgress)
          node.off('peers', onNodePeers)
          return new Promise(resolveClose => {
            if (server.connections) {
              for (const socket of server.connections) socket.destroy()
            }
            server.close(() => resolveClose())
          })
        }
      })
    })
  })
}

module.exports = { createGateway }
