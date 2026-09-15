// Storage location + on-disk config. Bare only.

const fs = require('bare-fs')
const path = require('bare-path')
const os = require('bare-os')

const DEFAULT_PORT = 8433

const DEFAULTS = {
  catalogKey: null,
  seeding: [],
  gateway: { port: DEFAULT_PORT, host: '127.0.0.1' }
}

// Under Pear the app gets a sandboxed per-app storage dir; standalone Bare
// falls back to ~/.hyperbay so the CLI and the desktop app can share a bay when
// pointed at the same path.
function resolveStorage (storage) {
  if (storage) return path.resolve(storage)
  const pear = global.Pear
  if (pear && pear.config && pear.config.storage) return pear.config.storage
  return path.join(os.homedir(), '.hyperbay')
}

function configPath (dir) {
  return path.join(dir, 'config.json')
}

function readConfig (dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(dir), 'utf8'))
    return {
      ...DEFAULTS,
      ...raw,
      seeding: Array.isArray(raw.seeding) ? raw.seeding : [],
      gateway: { ...DEFAULTS.gateway, ...(raw.gateway || {}) }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    return { ...DEFAULTS, seeding: [], gateway: { ...DEFAULTS.gateway } }
  }
}

function writeConfig (dir, config) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(configPath(dir), JSON.stringify(config, null, 2))
  return config
}

module.exports = { resolveStorage, readConfig, writeConfig, configPath, DEFAULTS, DEFAULT_PORT }
