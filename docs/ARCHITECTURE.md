# Hyperbay — architecture and module contracts

Decentralized, self-hosted alternative to centralized model-weight mirrors
(huggingbay.xyz / huggingface.co). No server owns the index, no server owns the
bytes. Everything is a Hypercore.

## Layers

| Layer | Holepunch primitive | Module |
|---|---|---|
| Peer discovery / NAT holepunching | `hyperswarm` (DHT) | `lib/swarm.js` (inside `lib/node.js`) |
| Storage engine | `corestore` | `lib/node.js` |
| Multi-writer catalog (the index) | `autobase` + `hyperbee` view | `lib/catalog.js` |
| Content distribution (the weights) | `hyperdrive` (+ `hyperblobs`) | `lib/drives.js` |
| Identity / signatures | `hypercore-crypto` ed25519 | `lib/trust.js` |
| Local HTTP bridge (curl/ollama/hf_hub) | `http` / `bare-http1` | `lib/gateway.js` |
| UI | plain HTML/CSS/JS, dual transport | `ui/` + `lib/api.js` |

## Core invariants

1. **The catalog is an Autobase.** Any peer replicates it read-only by key.
   The view is a Hyperbee, so queries are sparse — a peer answers searches
   without downloading the whole index.
2. **Publishing is open.** The base runs `optimistic: true`. Every op carries an
   ed25519 signature over its canonical form. `apply` verifies the signature and
   only then calls `host.ackWriter`. Unsigned/badly-signed ops are dropped
   silently. Indexers exist only to provide linearization quorum, not to gate
   publishing.
3. **Spam is bounded deterministically**, never by human moderation: `apply`
   enforces `QUOTA_ARTIFACTS_PER_PUBLISHER` (see `lib/schema.js`) counted from
   the view itself, so every peer computes the identical result.
4. **Bytes live in one Hyperdrive per artifact.** Files are stored at their
   repo-relative path. Integrity is doubly guaranteed: Hypercore's merkle tree
   (per 64KiB block, enforced by the protocol) plus the upstream `sha256` per
   file recorded in the manifest (cross-checks the mirror against the origin).
5. **Mirrors are additive.** Re-seeding an artifact is joining
   `drive.discoveryKey` on the swarm. More seeders = more bandwidth, no
   coordination. `mirror` ops announce that you seed something.
6. **Nothing is required to be online.** Catalog reads work from local storage;
   swarm presence only affects freshness and download availability.

## Canonical slug

`<owner>/<name>` lowercased, non-`[a-z0-9._/-]` collapsed to `-`.
This is the primary key everywhere: `art/<slug>`.

## Hyperbee view keyspace

All keys are utf-8 strings, values JSON.

```
art/<slug>                        -> Artifact
by-time/<invTs>/<slug>            -> ''          newest-first natural order
by-size/<padSize>/<slug>          -> ''
by-owner/<owner>/<slug>           -> ''
by-tag/<tag>/<slug>               -> ''
by-task/<task>/<slug>             -> ''
by-license/<license>/<slug>       -> ''
by-format/<format>/<slug>         -> ''
tok/<token>/<slug>                -> ''          inverted search index
mirror/<slug>/<publisherHex>      -> { driveKey, at }
stat/<slug>                       -> { mirrors, up, down, flags, files, sizeBytes }
pub/<publisherHex>/<slug>         -> ''          publisher quota accounting
writer/<keyHex>                   -> { indexer, at }
```

`invTs` = `(2^53-1 - updatedAt)` zero-padded to 16 chars, so a forward
`createReadStream` over `by-time/` yields newest first.
`padSize` = `sizeBytes` zero-padded to 20 chars.

## Op envelope (what writers append to the Autobase)

```js
{
  t: 'artifact' | 'mirror' | 'vote' | 'flag' | 'addWriter' | 'removeWriter',
  by: '<publisher ed25519 public key, hex>',
  at: <ms epoch>,
  sig: '<hex signature over canonicalJSON({t, by, at, ...payload})>',
  ...payload
}
```

Payloads:

- `artifact` → `{ artifact: Artifact }`
- `mirror`   → `{ slug, driveKey }`
- `vote`     → `{ slug, value: 1 | -1 }`
- `flag`     → `{ slug, reason }`
- `addWriter`/`removeWriter` → `{ key: '<hex>' , indexer: bool }`

## Artifact record

```js
{
  slug, name, owner,
  kind: 'model' | 'dataset' | 'adapter' | 'quant',
  summary, description,
  license, task, modality, framework,
  params: Number|null,          // parameter count
  quant: String|null,           // 'Q4_K_M', 'fp16', ...
  tags: [String],
  formats: [String],            // safetensors | gguf | onnx | pt | json
  files: [{ path, sizeBytes, sha256 }],
  sizeBytes: Number,
  driveKey: '<hex>',            // the Hyperdrive holding the bytes
  source: { url, revision, mirroredFrom },
  publisher: '<hex>',
  publishedAt, updatedAt
}
```

Later `artifact` ops for the same slug from **any** publisher are accepted but
only overwrite `art/<slug>` when `updatedAt` is newer **and** the publisher
matches the record's current publisher; otherwise they are recorded as an
alternative mirror (`mirror/<slug>/<publisherHex>`). This is how a second peer
re-hosts someone else's model without being able to rewrite their metadata.

Mirrors are keyed by the **announcing peer**, not by drive key, because the
normal case is many peers seeding the *same* drive — that is what seeding is.
`stat.mirrors` therefore counts distinct seeding peers, which is the signal a
downloader actually wants (how many places can serve me these bytes). A peer
re-hosting under its own drive key shows up as its own row with its own
`driveKey`, so alternative drives are still discoverable via `mirrors(slug)`.

## Module contracts

### `lib/schema.js` (owned: done)
Pure. No I/O.
```js
canonicalJSON(value) -> String        // stable key order, for signing
slugify(owner, name) -> String
normaliseArtifact(input) -> Artifact  // throws ValidationError on bad input
validateOp(op) -> op                  // shape only, no crypto
tokenize(text) -> [String]            // search tokens, deduped, >=2 chars
invTimeKey(ms) -> String
sizeKey(bytes) -> String
KEYS = { art, byTime, byOwner, ... }  // key builders
QUOTA_ARTIFACTS_PER_PUBLISHER
```

### `lib/trust.js` (owned: done)
```js
loadIdentity(storagePath) -> { publicKey, secretKey, hex }   // persisted keypair
signOp(op, identity) -> op            // adds .by/.at/.sig
verifyOp(op) -> Boolean               // pure, deterministic — safe in apply()
```

### `lib/catalog.js`
```js
class Catalog extends ReadyResource {
  constructor(store /* Corestore */, key /* Buffer|null */, { identity, ackInterval })
  get key() : Buffer
  get discoveryKey() : Buffer
  get writable() : Boolean
  get length() : Number

  async update()
  async publish(artifact)                      // normalise+sign+append 'artifact'
  async announceMirror(slug, driveKeyHex)
  async vote(slug, value)
  async flag(slug, reason)
  async addWriter(keyHex, { indexer = true })
  async removeWriter(keyHex)

  async get(slug) -> Artifact | null
  async list({ sort = 'recent'|'size'|'mirrors', owner, tag, task, license,
               format, limit = 50, cursor }) -> { rows, cursor }
  async search(q, { limit = 50, ...filters }) -> { rows, took }
  async mirrors(slug) -> [{ driveKey, publisher, at }]
  async stats(slug) -> Stat
  async facets({ limit = 20 }) -> { owners, tags, tasks, licenses, formats }
  async replicate(stream)                      // delegates to autobase
  // events: 'update'
}
```
`rows` are `Artifact` objects enriched with `{ stat }`.

### `lib/drives.js`
```js
class DriveManager extends ReadyResource {
  constructor(store, swarm, { identity })
  async publishFolder(dir, { onProgress }) -> { driveKey, files, sizeBytes }
  async publishStream(entries /* async iterable {path, stream|buffer} */, opts) -> same
  get(driveKeyHex) -> Hyperdrive                 // memoised, auto-replicating
  async seed(driveKeyHex, { full = true })       // join topic + download all
  async unseed(driveKeyHex)
  download(driveKeyHex, { paths }) -> DownloadTask
  createReadStream(driveKeyHex, path, { start, end }) -> Stream   // gateway ranges
  async entry(driveKeyHex, path)
  async listFiles(driveKeyHex) -> [{ path, sizeBytes }]
  async verify(driveKeyHex, files) -> { ok, mismatches }
  async stat(driveKeyHex) -> { peers, bytes, downloadedBytes, seeding, progress }
  list() -> [{ driveKey, seeding, ...stat }]
  // events: 'progress' ({ driveKey, ... }), 'seeding', 'peer'
}
// DownloadTask: { promise, cancel(), on('progress') }
```

### `lib/node.js`
Single object the CLI, gateway and Pear app all construct.
```js
class HyperbayNode extends ReadyResource {
  constructor({ storage, catalogKey, seed = false, swarm = true })
  catalog, drives, swarm, store, identity
  async ready(); async close()
  async publishFolder(dir, meta, { onProgress })    // drives + catalog in one shot
  async importHuggingFace(repo, opts)
  async fetchArtifact(slug, { paths, dest })
  async state() -> { key, identity, peers, artifacts, seeding, up, down }
  // events: 'update', 'progress', 'peers'
}
```

### `lib/gateway.js`
```js
createGateway(node, { port = 8433, host = '127.0.0.1', ui = true }) -> { server, port, close() }
```
Routes (all JSON unless noted):
```
GET    /                          -> ui/index.html
GET    /assets/*                  -> ui/assets
GET    /api/state
GET    /api/artifacts?q&sort&owner&tag&task&license&format&limit&cursor
GET    /api/artifacts/:owner/:name
GET    /api/artifacts/:owner/:name/files
GET    /api/facets
GET    /api/peers
GET    /api/seeding
POST   /api/seed        { slug }
DELETE /api/seed        { slug }
POST   /api/download    { slug, paths?, dest? }
POST   /api/publish     { dir, meta }            // local folder -> drive -> catalog
POST   /api/import      { repo, revision? }      // HF mirror -> drive -> catalog
POST   /api/vote        { slug, value }
POST   /api/flag        { slug, reason }
GET    /api/catalog                               -> { catalogKey }
POST   /api/catalog     { key }                   // join another peer's bay
GET    /api/jobs | /api/jobs/:id                  // publish/import/download
GET    /api/events                                -> text/event-stream
GET    /f/:owner/:name/*path                      -> raw bytes, Range + ETag
GET    /:owner/:name/resolve/:rev/*path           -> huggingface_hub-compatible
```

### `lib/api.js`
One client surface, two transports, so the UI is written once.
```js
createApi({ transport: 'http', base }) | createApi({ transport: 'direct', node })
-> {
  state, artifacts, artifact, files, mirrors, facets, peers, seeding,
  seed, unseed, download, publish, import: importRepo, vote, flag,
  joinCatalog(key),                   // switch which bay this node reads
  subscribe(fn) -> unsubscribe,       // SSE in http, EventEmitter in direct
  fileUrl(slug, path) -> String
}
```

`joinCatalog` is what makes a shareable catalog key useful: the node keeps its
identity, its drives and everything it seeds, and only the index it replicates
changes. Each bay lives in its own Corestore namespace (`catalog/<key>`) so one
bay's local writer core never collides with another's.

### `lib/import/hf.js`
```js
async function importHuggingFace(repo, { node, revision = 'main', include, exclude, onProgress })
  -> Artifact
```
Uses only the public HF API (`/api/models/:repo`, `/resolve/:rev/:path`).
Gated/private repos are refused, not bypassed.

### `ui/`
- `index.html`, `assets/app.css`, `assets/app.mjs`, `assets/icons.mjs`,
  `assets/http-api.mjs`, `assets/pipe-api.mjs`.
- **`.mjs`, not `.js`**: the package is `"type": "commonjs"` so Pear treats a
  `.js` file as CommonJS and refuses to instantiate it as an ES module. The
  extension is what makes the UI load in the desktop app at all.
- Dark, dense, torrent-index feel: facet rail, results table with
  seeders/mirrors/size columns, artifact detail with per-file rows, publish and
  seed dashboards, live throughput.
- Browser globals only. Never imports a `bare-*` module.
- Identical screens on both transports (`http-api.mjs` in a browser,
  `pipe-api.mjs` in the desktop app).

### `worker.js` — the desktop peer
The Pear renderer is plain Chromium. It has no `require`, no `Bare`, and cannot
run Hypercore (`import 'corestore'` there fails with "Bare is not defined"). It
also cannot reach a loopback HTTP server: cross-origin `fetch` from the app
window is blocked whatever CORS the gateway sets. So the desktop app is:

```
ui/index.html (Chromium)          worker.js (Bare)
  assets/app.mjs                    HyperbayNode  ── Hyperswarm / DHT
  assets/pipe-api.mjs  ── pipe ──>   createApi({ transport: 'direct' })
                                     createGateway(port: 0)  ── curl, hf_hub
```

- `Pear.worker.run('./worker.js')` returns a Duplex. The worker sends one
  `{ type: 'ready', url, port, catalogKey, identity }` JSON line, then serves
  newline-delimited JSON RPC: `{ id, method, args }` → `{ id, value | error }`,
  plus unsolicited `{ type: 'event', event, payload }` frames.
- The worker still starts the loopback gateway, because that is what keeps
  `curl` and `huggingface-cli` working against the desktop app from a terminal.
  The window just never fetches over it — it only quotes the URL in the
  copy-ready snippets.
- `lib/api.js`'s direct transport is what the worker executes against, so the
  single API surface is genuinely shared rather than duplicated.

### `bin/hyperbay.js`
```
hyperbay serve [--port 8433] [--storage DIR] [--catalog KEY] [--open]
hyperbay publish <dir> [--name] [--owner] [--license] ...
hyperbay import <owner/repo> [--revision main]
hyperbay get <slug> [dest] [--file path]...
hyperbay seed <slug|driveKey> ...        # headless seedbox mode
hyperbay search <query>
hyperbay info <slug>
hyperbay id | writers | writers add <key>
hyperbay catalog                          # print catalog key to share
```

## Storage layout

```
<storage>/            default: ~/.hyperbay  (Pear: Pear.config.storage)
  cores/              corestore
  identity.json       ed25519 keypair (0600)
  config.json         { catalogKey, seeding: [slug], gateway: { port } }
```

## Runtime: Bare only

There is no Node.js in this project. Every file runs on **Bare** — the same
runtime Pear ships — so the CLI, the gateway and the desktop app all execute
identical code with no shims and no build step.

- Run the CLI with `bare bin/hyperbay.js ...`, tests with `bare test/all.js`,
  the desktop app with `pear run --dev .`.
- Bare has **no Node builtins and no global `fetch`**. Require the Bare modules
  explicitly — there is no `imports` condition map to fall back on:

  | need | require |
  |---|---|
  | fs | `bare-fs`, `bare-fs/promises` |
  | path | `bare-path` |
  | os | `bare-os` |
  | events | `bare-events` |
  | http server + client | `bare-http1` |
  | HTTP(S) fetch | `bare-fetch` |
  | URL parsing | `bare-url` |
  | spawn | `bare-subprocess` |
  | streams | `streamx` (preferred) or `bare-stream` |
  | hashing | `sodium-universal` via `lib/hash.js` — there is no `node:crypto` |

- `require('fs')`, `require('http')`, `require('node:*')` and `process.exit()`
  are all errors. `Buffer` and `console` are globals; exit with `Bare.exit(n)`
  and read args from `Bare.argv`.
- No top-level `await` (CommonJS): wrap entrypoints in an async `main()`.
- UI code under `ui/` is the one exception: it runs in the Pear renderer
  (Chromium), so it uses browser globals (`fetch`, `EventSource`, `canvas`) and
  must never require a `bare-*` module.

## Style rules for this repo

- CommonJS `require`, 2-space indent, no semicolons — holepunch house style.
- No TypeScript, no bundler. Pear bundles the source as-is.
- `ReadyResource` from `ready-resource` for lifecycle.
