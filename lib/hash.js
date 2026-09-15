// Streaming SHA-256 that works on both Node and Bare (no node:crypto).
// Used to record and re-verify upstream file hashes, which is what lets a
// mirror prove it carries the same bytes as the origin repo.

const sodium = require('sodium-universal')
const b4a = require('b4a')

class Sha256 {
  constructor () {
    this.state = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES)
    sodium.crypto_hash_sha256_init(this.state)
  }

  update (chunk) {
    sodium.crypto_hash_sha256_update(this.state, typeof chunk === 'string' ? b4a.from(chunk) : chunk)
    return this
  }

  digest () {
    const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
    sodium.crypto_hash_sha256_final(this.state, out)
    return out
  }

  hex () {
    return b4a.toString(this.digest(), 'hex')
  }
}

function sha256 (data) {
  const out = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
  sodium.crypto_hash_sha256(out, typeof data === 'string' ? b4a.from(data) : data)
  return out
}

function sha256hex (data) {
  return b4a.toString(sha256(data), 'hex')
}

async function hashStream (stream) {
  const h = new Sha256()
  let bytes = 0
  for await (const chunk of stream) {
    h.update(chunk)
    bytes += chunk.byteLength
  }
  return { sha256: h.hex(), sizeBytes: bytes }
}

module.exports = { Sha256, sha256, sha256hex, hashStream }
