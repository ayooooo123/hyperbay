// HTTP transport for the UI when it is served by the gateway (lib/gateway.js).
// Mirrors the surface of lib/api.js so app.js is written once and runs
// identically under Pear (direct transport) and in a browser (this file).
// Browser globals only: fetch + EventSource. Never a bare-* module.

const EVENT_NAMES = ['update', 'progress', 'peers', 'traffic', 'job']

export function createHttpApi (base = '') {
  const root = base.replace(/\/$/, '')

  async function call (method, path, body) {
    const init = { method, headers: { accept: 'application/json' } }
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    const res = await fetch(root + path, init)
    if (res.status === 404) return null
    if (!res.ok) {
      let msg = `${method} ${path} → ${res.status}`
      try {
        const err = await res.json()
        if (err && err.error) msg = String(err.error)
      } catch {}
      throw new Error(msg)
    }
    if (res.status === 204) return null
    return res.json()
  }

  function qs (params) {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === '') continue
      if (Array.isArray(v)) { if (v.length) sp.set(k, v.join(',')) } else sp.set(k, String(v))
    }
    const s = sp.toString()
    return s ? '?' + s : ''
  }

  const slugPath = (slug) => String(slug).split('/').map(encodeURIComponent).join('/')

  return {
    state: () => call('GET', '/api/state'),
    artifacts: (params) => call('GET', '/api/artifacts' + qs(params)),
    artifact: (slug) => call('GET', `/api/artifacts/${slugPath(slug)}`),
    files: (slug) => call('GET', `/api/artifacts/${slugPath(slug)}/files`),
    mirrors: (slug) => call('GET', `/api/artifacts/${slugPath(slug)}/mirrors`),
    facets: () => call('GET', '/api/facets'),
    peers: () => call('GET', '/api/peers'),
    seeding: () => call('GET', '/api/seeding'),
    seed: (slug) => call('POST', '/api/seed', { slug }),
    unseed: (slug) => call('DELETE', '/api/seed', { slug }),
    download: (opts) => call('POST', '/api/download', opts),
    publish: (opts) => call('POST', '/api/publish', opts),
    import: (opts) => call('POST', '/api/import', opts),
    vote: (slug, value) => call('POST', '/api/vote', { slug, value }),
    flag: (slug, reason) => call('POST', '/api/flag', { slug, reason }),
    joinCatalog: (key) => call('POST', '/api/catalog', { key }),
    fileUrl: (slug, path) => `${root}/f/${slugPath(slug)}/${String(path).split('/').map(encodeURIComponent).join('/')}`,

    // SSE. The gateway emits named events (`event: progress`) carrying a JSON
    // body; a bare `message` with an `event` field inside the body is accepted
    // too. Reconnection is EventSource's own; we surface it as a 'transport'
    // event so the chrome can show a degraded state.
    subscribe (fn) {
      const es = new EventSource(root + '/api/events')
      const parse = (name, raw) => {
        let data = {}
        try { data = JSON.parse(raw) } catch { return }
        if (!data || typeof data !== 'object') return
        fn({ ...data, event: name || data.event })
      }
      for (const name of EVENT_NAMES) es.addEventListener(name, (e) => parse(name, e.data))
      es.onmessage = (e) => parse(null, e.data)
      es.onopen = () => fn({ event: 'transport', connected: true })
      es.onerror = () => fn({ event: 'transport', connected: false })
      return () => es.close()
    }
  }
}
