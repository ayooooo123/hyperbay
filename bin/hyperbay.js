#!/usr/bin/env bare
// Hyperbay CLI. Bare only — run with `bare bin/hyperbay.js <cmd>`.

const path = require('bare-path')
const process = require('bare-process')
const goodbye = require('graceful-goodbye')

// Flags win; environment is the fallback so a container needs no arguments.
const env = process.env
const ENV_DEFAULTS = {
  storage: env.HYPERBAY_STORAGE,
  catalog: env.HYPERBAY_CATALOG,
  port: env.HYPERBAY_PORT,
  host: env.HYPERBAY_HOST
}

function opt (flags, name) {
  const value = flags[name]
  if (value !== undefined && value !== true) return value
  if (value === true) return true
  return ENV_DEFAULTS[name] || undefined
}

const HyperbayNode = require('../lib/node.js')
const { createGateway } = require('../lib/gateway.js')
const { DEFAULT_PORT } = require('../lib/config.js')
const { humanParams } = require('../lib/schema.js')

const USAGE = `hyperbay — a decentralized bay for open model weights

  hyperbay serve [--port N] [--open]        run the gateway + UI, seed what you mirror
  hyperbay publish <dir> [meta...]          turn a local folder into a seeded artifact
  hyperbay import <owner/repo> [--revision] mirror a public Hugging Face repo into the bay
  hyperbay get <slug> [dest] [--file p]     download an artifact from the swarm
  hyperbay seed <slug>...                   mirror artifacts for others (headless seedbox)
  hyperbay unseed <slug>...                 stop mirroring
  hyperbay search <query>                   search the catalog
  hyperbay list [--sort recent|size|mirrors]
  hyperbay info <slug>                      artifact detail + mirrors + file hashes
  hyperbay verify <slug>                    re-hash local bytes against the manifest
  hyperbay catalog                          print the catalog key others join with
  hyperbay id                               print this node's identity + writer key
  hyperbay writers [add <key>]              list or admit catalog indexers

Global flags
  --storage DIR      bay location (default ~/.hyperbay)
  --catalog KEY      join an existing bay by catalog key
  --no-swarm         work offline, local storage only

Publish metadata flags
  --name --owner --license --task --framework --modality --quant --kind
  --tags a,b,c --summary "..." --params 8000000000
`

function parseArgs (argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2)
      let value = eq > 0 ? arg.slice(eq + 1) : null
      if (value === null) {
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) {
          value = next
          i++
        } else {
          value = true
        }
      }
      if (name.startsWith('no-') && value === true) flags[name.slice(3)] = false
      else if (flags[name] === undefined) flags[name] = value
      else flags[name] = [].concat(flags[name], value)
    } else {
      positional.push(arg)
    }
  }
  return { flags, positional }
}

function bytes (n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = Number(n) || 0
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return (u === 0 ? v : v.toFixed(v < 10 ? 2 : 1)) + ' ' + units[u]
}

function ago (ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return Math.round(s) + 's ago'
  if (s < 3600) return Math.round(s / 60) + 'm ago'
  if (s < 86400) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86400) + 'd ago'
}

function short (hex, n = 8) {
  if (!hex) return '-'
  return hex.length <= n * 2 ? hex : hex.slice(0, n) + '…' + hex.slice(-4)
}

function row (artifact) {
  const stat = artifact.stat || {}
  const params = artifact.params ? ' ' + humanParams(artifact.params) : ''
  return [
    pad(artifact.slug, 44),
    pad(bytes(artifact.sizeBytes), 10),
    pad(String(artifact.files.length), 5),
    pad('↑' + (stat.mirrors ?? 1), 5),
    pad(artifact.license || '-', 14),
    pad((artifact.formats[0] || '-') + params, 18),
    ago(artifact.updatedAt)
  ].join(' ')
}

function pad (s, n) {
  s = String(s)
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}

function metaFromFlags (flags, dir) {
  const tags = flags.tags && flags.tags !== true ? String(flags.tags).split(',').map(t => t.trim()).filter(Boolean) : []
  return {
    name: flags.name && flags.name !== true ? flags.name : path.basename(path.resolve(dir)),
    owner: flags.owner && flags.owner !== true ? flags.owner : 'local',
    license: flags.license && flags.license !== true ? flags.license : 'unknown',
    kind: flags.kind && flags.kind !== true ? flags.kind : 'model',
    task: flags.task !== true ? flags.task : null,
    framework: flags.framework !== true ? flags.framework : null,
    modality: flags.modality !== true ? flags.modality : null,
    quant: flags.quant !== true ? flags.quant : null,
    summary: flags.summary !== true ? flags.summary : null,
    params: flags.params && flags.params !== true ? Number(flags.params) : null,
    tags
  }
}

async function withNode (flags, fn) {
  const node = new HyperbayNode({
    storage: opt(flags, 'storage'),
    catalogKey: opt(flags, 'catalog'),
    swarm: flags.swarm !== false
  })
  await node.ready()
  try {
    return await fn(node)
  } finally {
    await node.close()
  }
}

// A fresh peer has nothing until the catalog replicates, so read commands give
// the swarm a moment to produce the index before reporting "empty".
async function syncCatalog (node, { timeout = 6000 } = {}) {
  if (node.swarm) {
    await node.waitForPeers({ timeout })
    await node.catalog.update()
  }
}

function progressLine (label) {
  let last = 0
  return ev => {
    const now = Date.now()
    if (now - last < 250) return
    last = now
    const pct = ev.totalBytes ? ((ev.bytes / ev.totalBytes) * 100).toFixed(1) + '%' : bytes(ev.bytes)
    const speed = ev.speed ? ' ' + bytes(ev.speed) + '/s' : ''
    const peers = ev.peers !== undefined ? ' ' + ev.peers + ' peers' : ''
    console.log(label + ' ' + pct + speed + peers + (ev.path ? ' ' + ev.path : ''))
  }
}

const commands = {
  async serve (flags) {
    const node = new HyperbayNode({
      storage: opt(flags, 'storage'),
      catalogKey: opt(flags, 'catalog'),
      swarm: flags.swarm !== false,
      seed: true
    })
    await node.ready()

    const port = opt(flags, 'port') ? Number(opt(flags, 'port')) : (node.config.gateway.port || DEFAULT_PORT)
    const host = opt(flags, 'host') || node.config.gateway.host
    const gateway = await createGateway(node, { port, host })

    const state = await node.state()
    console.log('hyperbay serving   ' + gateway.url)
    console.log('catalog key        ' + state.catalogKey)
    console.log('identity           ' + state.identity)
    console.log('storage            ' + state.storage)
    console.log('seeding            ' + state.seeding + ' artifacts')
    console.log('')
    console.log('share the catalog key above — a peer joins with:')
    console.log('  bare bin/hyperbay.js serve --catalog ' + state.catalogKey)

    node.on('peers', n => console.log('peers: ' + n))

    if (flags.open) {
      const { spawn } = require('bare-subprocess')
      spawn('open', [gateway.url], { stdio: 'ignore' }).unref?.()
    }

    goodbye(async () => {
      await gateway.close()
      await node.close()
    })

    // Hold the process open; the gateway and swarm own the event loop now.
    return new Promise(() => {})
  },

  async publish (flags, [dir]) {
    if (!dir) throw new Error('usage: hyperbay publish <dir>')
    return withNode(flags, async node => {
      const artifact = await node.publishFolder(dir, metaFromFlags(flags, dir), {
        onProgress: progressLine('publishing')
      })
      console.log('published  ' + artifact.slug)
      console.log('drive      ' + artifact.driveKey)
      console.log('files      ' + artifact.files.length + '  ' + bytes(artifact.sizeBytes))
      console.log('catalog    ' + node.catalogKey)
      console.log('')
      console.log('seeding now — keep this node online for others to fetch it')
    })
  },

  async import (flags, [repo]) {
    if (!repo) throw new Error('usage: hyperbay import <owner/repo>')
    return withNode(flags, async node => {
      const artifact = await node.importHuggingFace(repo, {
        revision: flags.revision && flags.revision !== true ? flags.revision : 'main',
        include: flags.include && flags.include !== true ? String(flags.include).split(',') : undefined,
        exclude: flags.exclude && flags.exclude !== true ? String(flags.exclude).split(',') : undefined,
        onProgress: progressLine('mirroring')
      })
      console.log('mirrored   ' + artifact.slug + '  from  ' + artifact.source.url)
      console.log('drive      ' + artifact.driveKey)
      console.log('files      ' + artifact.files.length + '  ' + bytes(artifact.sizeBytes))
    })
  },

  async get (flags, [slug, dest]) {
    if (!slug) throw new Error('usage: hyperbay get <slug> [dest]')
    return withNode(flags, async node => {
      await syncCatalog(node)
      const files = flags.file ? [].concat(flags.file) : undefined
      const target = dest || path.join('.', slug.replace('/', '__'))
      const { artifact, verified } = await node.fetchArtifact(slug, {
        paths: files,
        dest: target,
        onProgress: progressLine('downloading')
      })
      console.log('downloaded ' + artifact.slug + ' -> ' + path.resolve(target))
      console.log('verified   ' + verified.checked + ' files, ' +
        (verified.ok ? 'all hashes match upstream' : 'MISMATCH: ' + JSON.stringify(verified.mismatches)))
      if (!verified.ok) throw new Error('hash verification failed')
    })
  },

  async seed (flags, slugs) {
    if (!slugs.length) throw new Error('usage: hyperbay seed <slug>...')
    const node = new HyperbayNode({
      storage: opt(flags, 'storage'),
      catalogKey: opt(flags, 'catalog'),
      seed: true
    })
    await node.ready()
    await syncCatalog(node)
    for (const slug of slugs) {
      const artifact = await node.seedArtifact(slug)
      console.log('seeding ' + artifact.slug + '  ' + bytes(artifact.sizeBytes) + '  drive ' + short(artifact.driveKey))
    }
    console.log('')
    console.log('mirroring ' + slugs.length + ' artifact(s). ctrl-c to stop.')
    node.on('peers', n => console.log('peers: ' + n))
    goodbye(() => node.close())
    return new Promise(() => {})
  },

  async unseed (flags, slugs) {
    if (!slugs.length) throw new Error('usage: hyperbay unseed <slug>...')
    return withNode(flags, async node => {
      for (const slug of slugs) {
        const artifact = await node.unseedArtifact(slug)
        console.log('stopped seeding ' + artifact.slug)
      }
    })
  },

  async search (flags, terms) {
    const q = terms.join(' ')
    if (!q) throw new Error('usage: hyperbay search <query>')
    return withNode(flags, async node => {
      await syncCatalog(node)
      const { rows, took } = await node.catalog.search(q, { limit: 40 })
      if (!rows.length) {
        console.log('nothing matched "' + q + '" in ' + node.catalog.length + ' catalog ops')
        return
      }
      for (const artifact of rows) console.log(row(artifact))
      console.log('')
      console.log(rows.length + ' results in ' + took + 'ms')
    })
  },

  async list (flags) {
    return withNode(flags, async node => {
      await syncCatalog(node)
      const sort = flags.sort && flags.sort !== true ? flags.sort : 'recent'
      const { rows } = await node.catalog.list({ sort, limit: Number(flags.limit) || 40 })
      if (!rows.length) {
        console.log('catalog is empty — publish something or join a bay with --catalog <key>')
        return
      }
      for (const artifact of rows) console.log(row(artifact))
    })
  },

  async info (flags, [slug]) {
    if (!slug) throw new Error('usage: hyperbay info <slug>')
    return withNode(flags, async node => {
      await syncCatalog(node)
      const artifact = await node.resolve(slug)
      const stat = await node.catalog.stats(artifact.slug)
      const mirrors = await node.catalog.mirrors(artifact.slug)
      console.log(artifact.slug + '   ' + (artifact.summary || ''))
      console.log('license    ' + artifact.license)
      console.log('task       ' + (artifact.task || '-') + '   framework ' + (artifact.framework || '-'))
      console.log('params     ' + (artifact.params ? humanParams(artifact.params) : '-') + '   quant ' + (artifact.quant || '-'))
      console.log('size       ' + bytes(artifact.sizeBytes) + ' across ' + artifact.files.length + ' files')
      console.log('drive      ' + artifact.driveKey)
      console.log('publisher  ' + artifact.publisher)
      console.log('source     ' + (artifact.source.url || '-') + ' @ ' + (artifact.source.revision || '-'))
      console.log('mirrors    ' + (stat.mirrors ?? mirrors.length) + '   votes +' + (stat.up || 0) + '/-' + (stat.down || 0) + '   flags ' + (stat.flags || 0))
      console.log('')
      for (const file of artifact.files) {
        console.log('  ' + pad(file.path, 48) + pad(bytes(file.sizeBytes), 12) + short(file.sha256, 10))
      }
      console.log('')
      console.log('fetch:  bare bin/hyperbay.js get ' + artifact.slug)
      console.log('curl:   curl -O http://127.0.0.1:' + DEFAULT_PORT + '/f/' + artifact.slug + '/' + (artifact.files[0] ? artifact.files[0].path : ''))
    })
  },

  async verify (flags, [slug]) {
    if (!slug) throw new Error('usage: hyperbay verify <slug>')
    return withNode(flags, async node => {
      await syncCatalog(node)
      const artifact = await node.resolve(slug)
      const report = await node.drives.verify(artifact.driveKey, artifact.files)
      console.log('checked ' + report.checked + ' of ' + artifact.files.length + ' files')
      if (report.missing.length) console.log('not local: ' + report.missing.length + ' files')
      for (const m of report.mismatches) console.log('MISMATCH ' + m.path + '\n  expected ' + m.expected + '\n  actual   ' + m.actual)
      console.log(report.ok ? 'OK — local bytes match the published manifest' : 'FAILED')
      if (!report.ok) throw new Error('verification failed')
    })
  },

  async catalog (flags) {
    return withNode(flags, async node => {
      console.log(node.catalogKey)
    })
  },

  async id (flags) {
    return withNode(flags, async node => {
      console.log('identity   ' + node.identity.hex)
      console.log('writer key ' + node.catalog.local)
      console.log('writable   ' + node.catalog.writable)
      console.log('')
      console.log('publishing is open to any peer — the writer key only matters for indexers')
    })
  },

  async writers (flags, [sub, key]) {
    return withNode(flags, async node => {
      if (sub === 'add') {
        if (!key) throw new Error('usage: hyperbay writers add <writer-key>')
        await node.catalog.addWriter(key)
        console.log('admitted indexer ' + short(key, 12))
        return
      }
      await syncCatalog(node)
      const writers = await node.catalog.writers()
      for (const w of writers) console.log(short(w.key, 12) + '  ' + (w.indexer ? 'indexer' : 'writer'))
    })
  },

  async help () {
    console.log(USAGE)
  }
}

async function main () {
  const argv = Bare.argv.slice(2)
  const { flags, positional } = parseArgs(argv)
  const name = positional.shift() || (flags.help || flags.version ? 'help' : 'help')
  const command = commands[name]

  if (!command) {
    console.error('unknown command: ' + name + '\n')
    console.log(USAGE)
    Bare.exit(1)
    return
  }

  await command(flags, positional)
}

main().catch(err => {
  console.error('error: ' + (err && err.message ? err.message : err))
  if (Bare.argv.includes('--debug')) console.error(err)
  Bare.exit(1)
})
