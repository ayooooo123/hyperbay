// One client surface, two transports, so the UI is written once: the Pear
// desktop app calls the node in-process ('direct'), the browser goes through
// the gateway ('http'). Every method resolves to plain JSON-serialisable data
// and the two transports are indistinguishable to callers.
//
// Globals are resolved lazily and defensively: the Chromium renderer has fetch
// and EventSource, plain bare has neither (bare-fetch / bare-http1 fill in).

function pickFetch () {
  if (typeof globalThis.fetch === 'function') return globalThis.fetch
  return require('bare-fetch') // verified: http(s), Request/Response/Headers
}

function pickEventSource () {
  return typeof globalThis.EventSource === 'function' ? globalThis.EventSource : null
}

// Joining is string-level on purpose: in http mode with an empty base the
// paths stay relative ('/api/state'), which is what the UI wants.
function joinBase (base, pathname) {
  if (!base) return pathname
  return base.replace(/\/+$/, '') + pathname
}

function query (params) {
  const pairs = []
  for (const key of Object.keys(params)) {
    const value = params[key]
    if (value === undefined || value === null || value === '') continue
    pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value))
  }
  return pairs.length === 0 ? '' : '?' + pairs.join('&')
}

function httpApi (base) {
  const doFetch = pickFetch()

  async function request (method, pathname, body) {
    const init = { method }
    if (body !== undefined) {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body)
    }
    const res = await doFetch(joinBase(base, pathname), init)
    const text = await res.text()
    let value = null
    if (text !== '') {
      try {
        value = JSON.parse(text)
      } catch {
        throw new Error('Gateway returned invalid JSON (' + res.status + ')')
      }
    }
    if (!res.ok) {
      const err = new Error((value && value.error) || 'Request failed (' + res.status + ')')
      err.status = res.status
      if (value && value.code) err.code = value.code
      throw err
    }
    return value
  }

  return {
    transport: 'http',

    state () {
      return request('GET', '/api/state')
    },

    artifacts (opts = {}) {
      const search = query({
        q: opts.q,
        sort: opts.sort,
        owner: opts.owner,
        tag: opts.tag,
        task: opts.task,
        license: opts.license,
        format: opts.format,
        limit: opts.limit,
        cursor: opts.cursor
      })
      return request('GET', '/api/artifacts' + search)
    },

    artifact (slug) {
      return request('GET', '/api/artifacts/' + slug)
    },

    files (slug) {
      return request('GET', '/api/artifacts/' + slug + '/files')
    },

    facets () {
      return request('GET', '/api/facets')
    },

    peers () {
      return request('GET', '/api/peers')
    },

    seeding () {
      return request('GET', '/api/seeding')
    },

    seed (slug) {
      return request('POST', '/api/seed', { slug })
    },

    unseed (slug) {
      return request('DELETE', '/api/seed', { slug })
    },

    download (slug, opts = {}) {
      return request('POST', '/api/download', { slug, paths: opts.paths, dest: opts.dest })
    },

    publish (dir, meta = {}) {
      return request('POST', '/api/publish', { dir, meta })
    },

    importRepo (repo, opts = {}) {
      return request('POST', '/api/import', {
        repo,
        revision: opts.revision,
        include: opts.include,
        exclude: opts.exclude
      })
    },

    vote (slug, value) {
      return request('POST', '/api/vote', { slug, value })
    },

    flag (slug, reason) {
      return request('POST', '/api/flag', { slug, reason })
    },

    // Switch the bay this node reads and writes. Identity, drives and whatever
    // it seeds are kept; only the index changes.
    joinCatalog (key) {
      return request('POST', '/api/catalog', { key })
    },

    fileUrl (slug, filePath) {
      const slugPath = String(slug || '').split('/').map(encodeURIComponent).join('/')
      const filePart = String(filePath || '')
        .split('/')
        .map(encodeURIComponent)
        .join('/')
      return '/f/' + slugPath + '/' + filePart
    },

    // EventSource when the runtime has one, otherwise an SSE line parser over
    // a raw bare-http1 request — with retry/backoff either way, so the UI
    // reconnects after the gateway restarts.
    subscribe (fn) {
      let closed = false
      let attempt = 0
      let timer = null
      const unsubscribers = []

      function teardown () {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        while (unsubscribers.length > 0) unsubscribers.pop()()
      }

      function reconnect () {
        if (closed) return
        const delay = Math.min(30000, 500 * Math.pow(2, attempt))
        attempt++
        timer = setTimeout(connect, delay)
      }

      function dispatch (event, data) {
        let value = data
        try {
          value = JSON.parse(data)
        } catch {}
        try {
          fn(value, event)
        } catch {}
      }

      function connectEventSource () {
        const es = new EventSource(joinBase(base, '/api/events'))

        es.onopen = () => {
          attempt = 0
        }
        es.onmessage = e => dispatch('message', e.data)

        for (const name of ['update', 'progress', 'peers', 'open']) {
          es.addEventListener(name, e => dispatch(name, e.data))
        }

        es.onerror = () => {
          if (closed) return
          es.close()
          teardown()
          reconnect()
        }

        unsubscribers.push(() => es.close())
      }

      function connectStream () {
        const http = require('bare-http1')
        const url = new URL(joinBase(base, '/api/events'))
        // A plain bare runtime has no global URL; bare-url fills in.
        const parsed = typeof url === 'object' && url !== null
          ? url
          : require('bare-url').URL.parse(joinBase(base, '/api/events'))

        const req = http.request({
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname + (parsed.search || '')
        })

        const onAbort = () => req.destroy()
        if (typeof globalThis.addEventListener === 'function') {
          globalThis.addEventListener('unload', onAbort)
          unsubscribers.push(() => globalThis.removeEventListener('unload', onAbort))
        }

        req.on('response', res => {
          if (res.statusCode !== 200) {
            res.resume()
            req.destroy()
            reconnect()
            return
          }
          attempt = 0

          let buffer = ''
          let eventName = 'message'
          let dataLines = []

          const flush = () => {
            if (dataLines.length > 0) dispatch(eventName, dataLines.join('\n'))
            eventName = 'message'
            dataLines = []
          }

          res.setEncoding('utf8')
          res.on('data', chunk => {
            buffer += chunk
            let index
            while ((index = buffer.indexOf('\n')) !== -1) {
              let line = buffer.slice(0, index)
              buffer = buffer.slice(index + 1)
              if (line.endsWith('\r')) line = line.slice(0, -1)
              if (line === '') {
                flush()
                continue
              }
              if (line.startsWith(':')) continue // keep-alive comment
              if (line.startsWith('event:')) {
                eventName = line.slice(6).trim()
                continue
              }
              if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
            }
          })

          res.on('end', () => {
            flush()
            if (!closed) reconnect()
          })
        })

        req.on('error', () => {
          if (!closed) reconnect()
        })
        req.on('close', () => {
          if (!closed) reconnect()
        })

        req.end()
        unsubscribers.push(() => req.destroy())
      }

      function connect () {
        if (closed) return
        if (pickEventSource()) connectEventSource()
        else connectStream()
      }

      connect()

      return function unsubscribe () {
        closed = true
        teardown()
      }
    }
  }
}

function directApi (node) {
  async function call (fn) {
    return fn()
  }

  return {
    transport: 'direct',

    state () {
      return call(() => node.state())
    },

    artifacts (opts = {}) {
      return call(async () => {
        if (opts.q) return node.catalog.search(opts.q, opts)
        return node.catalog.list(opts)
      })
    },

    artifact (slug) {
      return call(async () => node.catalog.get(slug))
    },

    files (slug) {
      return call(async () => {
        const artifact = await node.catalog.get(slug)
        if (!artifact) return { slug, files: [] }
        return { slug, files: await node.drives.listFiles(artifact.driveKey) }
      })
    },

    facets () {
      return call(() => node.catalog.facets())
    },

    peers () {
      return call(async () => {
        const peers = node.swarm && node.swarm.peers ? node.swarm.peers : []
        return { peers, state: await node.state() }
      })
    },

    seeding () {
      return call(() => node.seedingState())
    },

    seed (slug) {
      return call(async () => {
        const artifact = await node.catalog.get(slug)
        if (!artifact) return { ok: false }
        await node.drives.seed(artifact.driveKey)
        return { ok: true, slug, seeding: true }
      })
    },

    unseed (slug) {
      return call(async () => {
        const artifact = await node.catalog.get(slug)
        if (!artifact) return { ok: false }
        await node.drives.unseed(artifact.driveKey)
        return { ok: true, slug, seeding: false }
      })
    },

    download (slug, opts = {}) {
      return call(async () => {
        const artifact = await node.catalog.get(slug)
        if (!artifact) return { ok: false }
        const task = node.drives.download(artifact.driveKey, { paths: opts.paths })
        if (task && task.promise) await task.promise
        return { ok: true, slug }
      })
    },

    publish (dir, meta = {}) {
      return call(() => node.publishFolder(dir, meta))
    },

    importRepo (repo, opts = {}) {
      return call(() => node.importHuggingFace(repo, opts))
    },

    vote (slug, value) {
      return call(() => node.catalog.vote(slug, value))
    },

    flag (slug, reason) {
      return call(() => node.catalog.flag(slug, reason))
    },

    joinCatalog (key) {
      return call(() => node.joinCatalog(key))
    },

    fileUrl (slug, filePath) {
      const slugPath = String(slug || '').split('/').map(encodeURIComponent).join('/')
      const filePart = String(filePath || '')
        .split('/')
        .map(encodeURIComponent)
        .join('/')
      return '/f/' + slugPath + '/' + filePart
    },

    // Directly on the node's EventEmitter. The payload shape matches the SSE
    // stream: one JSON-serialisable object per event.
    subscribe (fn) {
      const names = ['update', 'progress', 'peers']
      for (const name of names) node.on(name, fn)
      return function unsubscribe () {
        for (const name of names) {
          if (typeof node.off === 'function') node.off(name, fn)
          else if (typeof node.removeListener === 'function') node.removeListener(name, fn)
        }
      }
    }
  }
}

function createApi (opts = {}) {
  let { transport, node } = opts

  if (!transport) {
    // Auto-detect: http when fetch exists and no node was handed in.
    if (node) transport = 'direct'
    else if (typeof globalThis.fetch === 'function') transport = 'http'
    else transport = 'direct'
  }

  if (transport === 'direct') {
    if (!node) throw new Error("createApi({ transport: 'direct' }) requires a node")
    return directApi(node)
  }

  return httpApi(opts.base || '')
}

module.exports = { createApi }
