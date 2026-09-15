// Identity + op signing. verifyOp() is pure and deterministic so it is safe to
// call inside an Autobase apply() handler.

const fs = require('bare-fs')
const path = require('bare-path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { canonicalJSON, validateOp, ValidationError } = require('./schema.js')

// Fields that are not part of the signing preimage.
const UNSIGNED = new Set(['sig'])

function preimage (op) {
  const signed = {}
  for (const key of Object.keys(op)) {
    if (UNSIGNED.has(key)) continue
    signed[key] = op[key]
  }
  return b4a.from(canonicalJSON(signed), 'utf8')
}

function loadIdentity (storage) {
  const file = path.join(storage, 'identity.json')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && raw.publicKey && raw.secretKey) {
      return {
        publicKey: b4a.from(raw.publicKey, 'hex'),
        secretKey: b4a.from(raw.secretKey, 'hex'),
        hex: String(raw.publicKey).toLowerCase()
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  const keyPair = crypto.keyPair()
  fs.mkdirSync(storage, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({
    publicKey: b4a.toString(keyPair.publicKey, 'hex'),
    secretKey: b4a.toString(keyPair.secretKey, 'hex')
  }, null, 2), { mode: 0o600 })

  return {
    publicKey: keyPair.publicKey,
    secretKey: keyPair.secretKey,
    hex: b4a.toString(keyPair.publicKey, 'hex')
  }
}

function signOp (op, identity, { now = Date.now() } = {}) {
  if (!identity || !identity.secretKey) throw new ValidationError('signing requires an identity')
  const unsigned = { ...op, by: identity.hex, at: Math.floor(op.at ?? now) }
  delete unsigned.sig
  validateOp(unsigned)
  const sig = crypto.sign(preimage(unsigned), identity.secretKey)
  return { ...unsigned, sig: b4a.toString(sig, 'hex') }
}

// Never throws: a malformed op from a hostile peer must simply be false,
// identically on every node.
function verifyOp (op) {
  try {
    if (!op || typeof op !== 'object') return false
    if (typeof op.sig !== 'string' || op.sig.length !== 128) return false
    validateOp(op)
    return crypto.verify(preimage(op), b4a.from(op.sig, 'hex'), b4a.from(op.by, 'hex'))
  } catch {
    return false
  }
}

module.exports = { loadIdentity, signOp, verifyOp, preimage }
