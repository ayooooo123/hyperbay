// Worker-pipe transport for the UI when it runs as the Pear desktop app.
//
// The Pear renderer cannot reach the worker's loopback gateway — cross-origin
// fetch is blocked, so `fetch('http://127.0.0.1:<port>/api/state')` fails with
// "Failed to fetch" no matter what CORS headers the gateway sets. The peer runs
// in a Bare worker anyway, so the UI speaks to it over the worker pipe instead:
// newline-delimited JSON, one request/response pair per call, plus unsolicited
// event frames.
//
// Mirrors createHttpApi exactly, so app.mjs is written once. Browser globals
// only: no bare-* module is ever imported here.

const REQUEST_TIMEOUT = 120000

export function createPipeApi (pipe, { fileBase = '' } = {}) {
  const pending = new Map()
  const listeners = new Set()
  const decoder = new TextDecoder()
  let buffer = ''
  let seq = 0

  function handle (frame) {
    if (frame.type === 'event') {
      const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload : { value: frame.payload }
      for (const fn of listeners) fn({ ...payload, event: frame.event })
      return
    }
    const entry = pending.get(frame.id)
    if (!entry) return
    pending.delete(frame.id)
    clearTimeout(entry.timer)
    if (frame.error) entry.reject(Object.assign(new Error(frame.error.message || 'worker call failed'), { code: frame.error.code }))
    else entry.resolve(frame.value === undefined ? null : frame.value)
  }

  pipe.on('data', chunk => {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      if (!line) continue
      try {
        handle(JSON.parse(line))
      } catch {
        // A frame we cannot parse is not worth killing the app over.
      }
    }
  })

  const fail = err => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    pending.clear()
    for (const fn of listeners) fn({ event: 'transport', connected: false })
  }

  pipe.on('error', err => fail(err))
  pipe.on('close', () => fail(new Error('the hyperbay worker closed')))

  function call (method, args = []) {
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(method + ' timed out after ' + REQUEST_TIMEOUT / 1000 + 's'))
      }, REQUEST_TIMEOUT)
      pending.set(id, { resolve, reject, timer })
      try {
        pipe.write(JSON.stringify({ id, method, args }) + '\n')
      } catch (err) {
        pending.delete(id)
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  const slugPath = slug => String(slug).split('/').map(encodeURIComponent).join('/')
  const root = fileBase.replace(/\/$/, '')

  return {
    state: () => call('state'),
    artifacts: params => call('artifacts', [params]),
    artifact: slug => call('artifact', [slug]),
    files: slug => call('files', [slug]),
    mirrors: slug => call('mirrors', [slug]),
    facets: () => call('facets'),
    peers: () => call('peers'),
    seeding: () => call('seeding'),
    seed: slug => call('seed', [slug]),
    unseed: slug => call('unseed', [slug]),
    download: opts => call('download', [opts]),
    publish: opts => call('publish', [opts]),
    import: opts => call('import', [opts]),
    vote: (slug, value) => call('vote', [slug, value]),
    joinCatalog: key => call('joinCatalog', [key]),
    flag: (slug, reason) => call('flag', [slug, reason]),

    // The worker still runs a loopback gateway for terminal tools, so the
    // copy-ready curl/huggingface-cli snippets point at a real URL even though
    // the app itself never fetches over it.
    fileUrl: (slug, path) => `${root}/f/${slugPath(slug)}/${String(path).split('/').map(encodeURIComponent).join('/')}`,

    subscribe (fn) {
      listeners.add(fn)
      fn({ event: 'transport', connected: true })
      return () => listeners.delete(fn)
    }
  }
}
