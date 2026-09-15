// Hyperbay test suite. Bare only: `bare test/all.js`
//
// These tests defend the contracts a peer depends on: signed ops, the index
// keyspace, byte-for-byte replication between two independent peers, and the
// HTTP bridge that lets ordinary tools pull weights out of the swarm.

const test = require('brittle')
const os = require('bare-os')
const fs = require('bare-fs')
const path = require('bare-path')
const Corestore = require('corestore')
const fetch = require('bare-fetch')

const schema = require('../lib/schema.js')
const { loadIdentity, signOp, verifyOp } = require('../lib/trust.js')
const { sha256hex } = require('../lib/hash.js')
const Catalog = require('../lib/catalog.js')
const DriveManager = require('../lib/drives.js')
const HyperbayNode = require('../lib/node.js')
const { createGateway } = require('../lib/gateway.js')

let counter = 0
function tmp (label) {
  return path.join(os.tmpdir(), 'hyperbay-test-' + label + '-' + Date.now() + '-' + counter++)
}

function identity (t) {
  return loadIdentity(tmp('id'))
}

async function catalog (t, { key = null, id } = {}) {
  const store = new Corestore(tmp('store'))
  const cat = new Catalog(store, key, { identity: id || identity(t) })
  await cat.ready()
  t.teardown(async () => {
    await cat.close()
    await store.close()
  })
  return cat
}

function artifact (over = {}) {
  return {
    owner: 'Qwen',
    name: 'Qwen3-8B',
    license: 'Apache-2.0',
    task: 'text-generation',
    tags: ['llm', 'gguf'],
    params: 8e9,
    driveKey: 'a'.repeat(64),
    files: [{ path: 'model.gguf', sizeBytes: 4_800_000_000, sha256: 'b'.repeat(64) }],
    ...over
  }
}

test('slug is the stable primary key', t => {
  t.is(schema.slugify('Alibaba-NLP', 'gte-base-en-v1.5'), 'alibaba-nlp/gte-base-en-v1.5')
  t.is(schema.slugify('Qwen', 'Qwen3 8B!'), 'qwen/qwen3-8b')
  t.is(schema.normaliseSlug('Qwen/Qwen3-8B'), 'qwen/qwen3-8b')
  t.exception(() => schema.slugify('owner', ''), /name is required/)
})

test('canonical form is order independent so signatures are stable', t => {
  t.is(schema.canonicalJSON({ b: 1, a: [2, { d: 4, c: 3 }] }), schema.canonicalJSON({ a: [2, { c: 3, d: 4 }], b: 1 }))
})

test('a tampered op fails verification', t => {
  const id = identity(t)
  const op = signOp({ t: 'artifact', artifact: schema.normaliseArtifact(artifact()) }, id)
  t.ok(verifyOp(op))
  t.absent(verifyOp({ ...op, artifact: { ...op.artifact, license: 'mit' } }), 'metadata swap detected')
  t.absent(verifyOp({ ...op, by: 'f'.repeat(64) }), 'publisher swap detected')
  t.absent(verifyOp({ ...op, sig: '0'.repeat(128) }), 'forged signature detected')
  t.absent(verifyOp({ t: 'artifact', artifact: op.artifact }), 'unsigned op rejected')
})

test('newest-first ordering falls out of the time key', t => {
  t.ok(schema.invTimeKey(2000) < schema.invTimeKey(1000))
  t.ok(schema.sizeKey(10) < schema.sizeKey(1000))
})

test('publish then read back through the view', async t => {
  const cat = await catalog(t)
  const published = await cat.publish(artifact())
  t.is(published.slug, 'qwen/qwen3-8b')

  const got = await cat.get('qwen/qwen3-8b')
  t.is(got.license, 'apache-2.0')
  t.is(got.sizeBytes, 4_800_000_000)
  t.is(got.publisher, cat.identity.hex, 'publisher is bound to the signing key')
  t.ok(got.formats.includes('gguf'), 'format inferred from the file extension')
})

test('search matches name, tag and prefix', async t => {
  const cat = await catalog(t)
  await cat.publish(artifact())
  await cat.publish(artifact({ owner: 'Meta', name: 'Llama-4-8B', tags: ['llm', 'safetensors'] }))

  t.is((await cat.search('qwen')).rows.length, 1)
  t.is((await cat.search('llam')).rows.length, 1, 'prefix match drives typeahead')
  t.is((await cat.search('llm')).rows.length, 2, 'tag token matches both')
  t.is((await cat.search('nothing-here')).rows.length, 0)
})

test('filters and sorts use the secondary indexes', async t => {
  const cat = await catalog(t)
  await cat.publish(artifact())
  await cat.publish(artifact({ owner: 'Meta', name: 'Llama-4-8B', tags: ['safetensors'], files: [{ path: 'model.safetensors', sizeBytes: 100 }] }))

  t.is((await cat.list({ tag: 'gguf' })).rows.length, 1)
  t.is((await cat.list({ owner: 'meta' })).rows.length, 1)
  t.is((await cat.list({ license: 'apache-2.0' })).rows.length, 2)

  const bySize = await cat.list({ sort: 'size' })
  t.ok(bySize.rows[0].sizeBytes > bySize.rows[1].sizeBytes, 'largest first')

  const facets = await cat.facets({ limit: 10 })
  t.ok(facets.owners.length >= 2)
  t.ok(facets.tags.some(f => f.value === 'gguf'))
})

test('a forged op never reaches the view', async t => {
  const cat = await catalog(t)
  await cat.base.append({
    t: 'artifact',
    by: 'f'.repeat(64),
    at: Date.now(),
    sig: '0'.repeat(128),
    artifact: artifact({ owner: 'evil', name: 'backdoor' })
  }, { optimistic: true })
  await cat.update()
  t.absent(await cat.get('evil/backdoor'), 'unsigned publish dropped by apply')
})

test('votes are idempotent per publisher', async t => {
  const cat = await catalog(t)
  await cat.publish(artifact())
  await cat.vote('qwen/qwen3-8b', 1)
  await cat.vote('qwen/qwen3-8b', 1)
  await cat.update()
  t.is((await cat.stats('qwen/qwen3-8b')).up, 1, 'replaying a vote cannot inflate the score')

  await cat.vote('qwen/qwen3-8b', -1)
  await cat.update()
  const stat = await cat.stats('qwen/qwen3-8b')
  t.is(stat.up, 0)
  t.is(stat.down, 1, 'changing a vote moves the counter')
})

// Two independent peers wired exactly the way HyperbayNode wires a swarm
// connection: one Corestore replication for the cores, plus the catalog's
// wakeup channel so an optimistic append from a non-writer reaches an indexer.
async function pair (t, label) {
  const storeA = new Corestore(tmp(label + '-a'))
  const storeB = new Corestore(tmp(label + '-b'))
  const a = new Catalog(storeA, null, { identity: identity(t) })
  await a.ready()
  const b = new Catalog(storeB, a.key, { identity: identity(t) })
  await b.ready()

  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  a.addStream(s1)
  b.addStream(s2)
  s1.pipe(s2).pipe(s1)

  t.teardown(async () => {
    await b.close()
    await a.close()
    await storeB.close()
    await storeA.close()
    s1.destroy()
    s2.destroy()
  })

  return { a, b }
}

// Replication is asynchronous; poll the indexer rather than assuming one
// update() is enough.
async function settle (catalog, check, { tries = 40, wait = 50 } = {}) {
  for (let i = 0; i < tries; i++) {
    await catalog.update()
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, wait))
  }
  return null
}

test('a second publisher cannot rewrite someone elses metadata', async t => {
  const { a, b } = await pair(t, 'cat')

  await a.publish(artifact())
  t.ok(await settle(b, () => b.get('qwen/qwen3-8b')), 'the second peer reads the index it did not write')

  // Same slug, different publisher, different drive: an optimistic append the
  // indexer applies as a mirror, never as an overwrite.
  await b.publish(artifact({ license: 'proprietary', driveKey: 'c'.repeat(64) }))
  const mirrors = await settle(a, async () => {
    const rows = await a.mirrors('qwen/qwen3-8b')
    return rows.length > 1 ? rows : null
  })

  const record = await a.get('qwen/qwen3-8b')
  t.is(record.license, 'apache-2.0', 'original metadata survives')
  t.is(record.publisher, a.identity.hex, 'ownership stays with the original signer')
  t.ok(mirrors && mirrors.some(m => m.driveKey === 'c'.repeat(64)), 'the second peer is recorded as a mirror instead')
  t.ok(mirrors && mirrors.some(m => m.publisher === b.identity.hex), 'the mirror row is keyed to the announcing peer')
})

test('seeders of one drive each count as a mirror', async t => {
  const { a, b } = await pair(t, 'mir')

  const published = await a.publish(artifact())
  await settle(b, () => b.get(published.slug))

  // B seeds the SAME drive. That is what seeding means, and it has to raise the
  // count a downloader sees.
  await b.announceMirror(published.slug, published.driveKey)
  const two = await settle(a, async () => {
    const stat = await a.stats(published.slug)
    return stat.mirrors >= 2 ? stat : null
  })
  t.is(two && two.mirrors, 2, 'two peers serving one drive count twice')

  await b.announceMirror(published.slug, published.driveKey)
  await a.update()
  t.is((await a.stats(published.slug)).mirrors, 2, 're-announcing is idempotent')
})

test('bytes replicate between two peers and verify against the manifest', async t => {
  const dir = tmp('weights')
  fs.mkdirSync(path.join(dir, 'nested'), { recursive: true })
  const weights = Buffer.alloc(2 * 1024 * 1024, 9)
  fs.writeFileSync(path.join(dir, 'model.safetensors'), weights)
  fs.writeFileSync(path.join(dir, 'config.json'), '{"hidden":4096}')
  fs.writeFileSync(path.join(dir, 'nested', 'tokenizer.json'), '{"a":1}')

  const storeA = new Corestore(tmp('peer-a'))
  const storeB = new Corestore(tmp('peer-b'))
  const A = new DriveManager(storeA, null)
  const B = new DriveManager(storeB, null)
  await A.ready()
  await B.ready()
  t.teardown(async () => {
    await A.close()
    await B.close()
    await storeA.close()
    await storeB.close()
  })

  const published = await A.publishFolder(dir)
  t.is(published.files.length, 3)
  t.is(
    published.files.find(f => f.path === 'model.safetensors').sha256,
    sha256hex(weights),
    'manifest hash is the real content hash'
  )

  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  s1.pipe(s2).pipe(s1)

  const task = B.download(published.driveKey)
  await task.promise

  const report = await B.verify(published.driveKey, published.files)
  t.ok(report.ok, 'second peer holds byte-identical weights')
  t.is(report.checked, 3)

  const bad = await B.verify(published.driveKey, [{ path: 'config.json', sizeBytes: 15, sha256: 'f'.repeat(64) }])
  t.absent(bad.ok, 'a wrong hash is reported, not ignored')
})

test('the gateway serves weights to ordinary HTTP clients', async t => {
  const node = new HyperbayNode({ storage: tmp('gw-node'), swarm: false })
  await node.ready()

  const dir = tmp('gw-weights')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), 'hello world')

  const published = await node.publishFolder(dir, { owner: 'acme', name: 'tiny', license: 'mit' })

  const gateway = await createGateway(node, { port: 0 })
  t.teardown(async () => {
    await gateway.close()
    await node.close()
  })

  const base = 'http://127.0.0.1:' + gateway.port

  const listed = await (await fetch(base + '/api/artifacts')).json()
  t.is(listed.rows.length, 1)
  t.is(listed.rows[0].slug, published.slug)

  const whole = await fetch(base + '/f/' + published.slug + '/config.json')
  t.is(whole.status, 200)
  t.is(await whole.text(), 'hello world', 'a plain HTTP client can pull the bytes')

  const ranged = await fetch(base + '/f/' + published.slug + '/config.json', { headers: { range: 'bytes=0-4' } })
  t.is(ranged.status, 206, 'resumable downloads')
  t.is(await ranged.text(), 'hello')

  const hf = await fetch(base + '/' + published.slug + '/resolve/main/config.json')
  t.is(await hf.text(), 'hello world', 'huggingface_hub-compatible path works')

  const missing = await fetch(base + '/f/nope/nope/config.json')
  t.is(missing.status, 404)

  const shown = await (await fetch(base + '/api/catalog')).json()
  t.is(shown.catalogKey, node.catalogKey, 'the bridge reports the bay to share')

  const rejoin = await fetch(base + '/api/catalog', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: node.catalogKey })
  })
  t.is(rejoin.status, 200)
  t.absent((await rejoin.json()).changed, 'joining the bay it is already on is a no-op')

  const noKey = await fetch(base + '/api/catalog', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}'
  })
  t.is(noKey.status, 400, 'a join without a key is rejected')

  // The Seedbox screen iterates these rows, so the shape is a contract.
  const seeding = await (await fetch(base + '/api/seeding')).json()
  t.ok(Array.isArray(seeding), 'seeding is a list, not a wrapper object')
  t.is(seeding.length, 1)
  t.is(seeding[0].slug, published.slug, 'each row names its artifact')
  t.is(seeding[0].progress, 1, 'the publisher holds every byte')
})

test('a node rejoins its own bay after restart', async t => {
  const storage = tmp('persist')
  const first = new HyperbayNode({ storage, swarm: false })
  await first.ready()
  const key = first.catalogKey
  const idHex = first.identity.hex
  await first.close()

  const second = new HyperbayNode({ storage, swarm: false })
  await second.ready()
  t.teardown(() => second.close())

  t.is(second.catalogKey, key, 'catalog key is persisted')
  t.is(second.identity.hex, idHex, 'identity is persisted')
})

test('a node can join another peers bay and keep its own identity', async t => {
  const hostStorage = tmp('host')
  const joinerStorage = tmp('joiner')

  const host = new HyperbayNode({ storage: hostStorage, swarm: false })
  await host.ready()
  const joiner = new HyperbayNode({ storage: joinerStorage, swarm: false })
  await joiner.ready()

  const s1 = host.store.replicate(true)
  const s2 = joiner.store.replicate(false)
  host.catalog.addStream(s1)
  joiner.catalog.addStream(s2)
  s1.pipe(s2).pipe(s1)

  t.teardown(async () => {
    await joiner.close()
    await host.close()
    s1.destroy()
    s2.destroy()
  })

  const dir = tmp('host-weights')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'config.json'), '{"hidden":8}')
  const published = await host.publishFolder(dir, { owner: 'hostlab', name: 'shared', license: 'mit' })

  const ownKey = joiner.catalogKey
  const identity = joiner.identity.hex
  t.not(ownKey, host.catalogKey, 'the joiner starts on its own bay')
  t.absent(await joiner.catalog.get(published.slug), 'and cannot see the host artifact yet')

  const result = await joiner.joinCatalog(host.catalogKey)
  t.is(result.catalogKey, host.catalogKey, 'the joiner reports the bay it switched to')
  t.ok(result.changed)

  // Re-wire the new bay's wakeup channel onto the existing stream, which is
  // what HyperbayNode does for live swarm connections.
  joiner.catalog.addStream(s2)

  const found = await settle(joiner.catalog, () => joiner.catalog.get(published.slug))
  t.ok(found, 'the joiner now reads the hosts index')
  t.is(found.owner, 'hostlab')
  t.is(joiner.identity.hex, identity, 'joining does not change who this node is')

  const again = await joiner.joinCatalog(host.catalogKey)
  t.absent(again.changed, 'joining the same bay twice is a no-op')

  // The switch is persisted, so a restart stays on the joined bay.
  await joiner.close()
  const restarted = new HyperbayNode({ storage: joinerStorage, swarm: false })
  await restarted.ready()
  t.teardown(() => restarted.close())
  t.is(restarted.catalogKey, host.catalogKey, 'the joined bay survives a restart')
})
