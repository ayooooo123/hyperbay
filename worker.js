// Pear desktop worker.
//
// The Pear renderer is plain Chromium: it has no `require`, no `Bare`, and so
// it cannot run Hypercore at all (importing corestore there fails with "Bare is
// not defined"). It also cannot reach a loopback HTTP server — cross-origin
// fetch from the app window is blocked regardless of CORS headers. So the
// desktop app runs the real peer here, in a Bare worker, and the window drives
// it over the worker pipe with newline-delimited JSON.
//
// The loopback gateway still runs, because that is what makes `curl` and
// `huggingface-cli` work against the desktop app from a terminal. The UI just
// does not depend on it.

/* global Pear */

const HyperbayNode = require('./lib/node.js')
const { createGateway } = require('./lib/gateway.js')
const { createApi } = require('./lib/api.js')

const pipe = Pear.worker.pipe()

function send (frame) {
  pipe.write(JSON.stringify(frame) + '\n')
}

function serialisable (value) {
  return value === undefined ? null : value
}

async function main () {
  // No storage option: HyperbayNode resolves Pear.config.storage, so the
  // desktop app keeps its bay in the per-app sandbox.
  const node = new HyperbayNode({ seed: true })
  await node.ready()

  const gateway = await createGateway(node, { port: 0, host: '127.0.0.1' })
  const api = createApi({ transport: 'direct', node })
  const state = await node.state()

  Pear.teardown(async () => {
    await gateway.close()
    await node.close()
  })

  // One subscription, fanned to the window as event frames.
  const unsubscribe = api.subscribe(payload => {
    const event = payload && payload.event ? payload.event : 'update'
    send({ type: 'event', event, payload })
  })

  let buffer = ''
  pipe.on('data', async chunk => {
    buffer += chunk.toString()
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
      if (!line) continue

      let request
      try {
        request = JSON.parse(line)
      } catch {
        continue
      }
      if (!request || typeof request.method !== 'string') continue

      const fn = api[request.method]
      if (typeof fn !== 'function') {
        send({ id: request.id, error: { message: 'unknown method: ' + request.method, code: 'HYPERBAY_NO_METHOD' } })
        continue
      }

      try {
        const value = await fn(...(Array.isArray(request.args) ? request.args : []))
        send({ id: request.id, value: serialisable(value) })
      } catch (err) {
        send({ id: request.id, error: { message: err && err.message ? err.message : String(err), code: err && err.code } })
      }
    }
  })

  pipe.on('close', () => unsubscribe())

  send({
    type: 'ready',
    url: gateway.url,
    port: gateway.port,
    catalogKey: state.catalogKey,
    identity: state.identity,
    storage: state.storage
  })
}

main().catch(err => {
  send({ type: 'error', error: err && err.message ? err.message : String(err) })
})
