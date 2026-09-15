// Pure schema / keyspace helpers. No I/O, no crypto, fully deterministic —
// safe to call from inside an Autobase apply() where every peer must compute
// byte-identical results.

const MAX_SAFE = Number.MAX_SAFE_INTEGER
const TIME_PAD = 16
const SIZE_PAD = 20

// Deterministic spam ceiling: how many distinct artifacts one publisher key may
// hold in the view. Enforced in apply() from the view itself, so the limit is
// identical on every peer without any human moderator.
const QUOTA_ARTIFACTS_PER_PUBLISHER = 369

const KINDS = new Set(['model', 'dataset', 'adapter', 'quant'])

const FORMAT_BY_EXT = {
  safetensors: 'safetensors',
  gguf: 'gguf',
  ggml: 'gguf',
  onnx: 'onnx',
  bin: 'pytorch',
  pt: 'pytorch',
  pth: 'pytorch',
  ckpt: 'pytorch',
  msgpack: 'flax',
  h5: 'keras',
  tflite: 'tflite',
  mlmodel: 'coreml',
  mlpackage: 'coreml',
  npz: 'numpy',
  json: 'json',
  md: 'card',
  txt: 'text',
  model: 'sentencepiece',
  vocab: 'vocab'
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has',
  'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
  'were', 'will', 'with'
])

class ValidationError extends Error {
  constructor (msg) {
    super(msg)
    this.name = 'ValidationError'
    this.code = 'HYPERBAY_INVALID'
  }
}

// Stable stringify: object keys sorted, no whitespace. The signing preimage.
function canonicalJSON (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']'
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort()
  let out = '{'
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out += ','
    out += JSON.stringify(keys[i]) + ':' + canonicalJSON(value[keys[i]])
  }
  return out + '}'
}

function cleanSegment (s) {
  return String(s == null ? '' : s)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

function slugify (owner, name) {
  const o = cleanSegment(owner)
  const n = cleanSegment(name)
  if (!n) throw new ValidationError('artifact name is required')
  return o ? o + '/' + n : n
}

function tokenize (text) {
  if (!text) return []
  const seen = new Set()
  const parts = String(text).toLowerCase().split(/[^a-z0-9.+]+/)
  for (const raw of parts) {
    const tok = raw.replace(/^[.+]+|[.+]+$/g, '')
    if (tok.length < 2 || tok.length > 40) continue
    if (STOPWORDS.has(tok)) continue
    seen.add(tok)
  }
  return [...seen]
}

function pad (n, width) {
  const s = String(n)
  return s.length >= width ? s : '0'.repeat(width - s.length) + s
}

// Inverted timestamp so a forward read stream yields newest first.
function invTimeKey (ms) {
  const t = Math.max(0, Math.min(MAX_SAFE, Math.floor(Number(ms) || 0)))
  return pad(MAX_SAFE - t, TIME_PAD)
}

function sizeKey (bytes) {
  return pad(Math.max(0, Math.floor(Number(bytes) || 0)), SIZE_PAD)
}

const KEYS = {
  art: slug => 'art/' + slug,
  artRange: () => ({ gte: 'art/', lt: 'art0' }),
  byTime: (ms, slug) => 'by-time/' + invTimeKey(ms) + '/' + slug,
  byTimeRange: () => ({ gte: 'by-time/', lt: 'by-time0' }),
  bySize: (bytes, slug) => 'by-size/' + sizeKey(bytes) + '/' + slug,
  bySizeRange: () => ({ gte: 'by-size/', lt: 'by-size0' }),
  byOwner: (owner, slug) => 'by-owner/' + owner + '/' + slug,
  byOwnerRange: owner => ({ gte: 'by-owner/' + owner + '/', lt: 'by-owner/' + owner + '0' }),
  byTag: (tag, slug) => 'by-tag/' + tag + '/' + slug,
  byTagRange: tag => ({ gte: 'by-tag/' + tag + '/', lt: 'by-tag/' + tag + '0' }),
  byTask: (task, slug) => 'by-task/' + task + '/' + slug,
  byTaskRange: task => ({ gte: 'by-task/' + task + '/', lt: 'by-task/' + task + '0' }),
  byLicense: (license, slug) => 'by-license/' + license + '/' + slug,
  byLicenseRange: license => ({ gte: 'by-license/' + license + '/', lt: 'by-license/' + license + '0' }),
  byFormat: (format, slug) => 'by-format/' + format + '/' + slug,
  byFormatRange: format => ({ gte: 'by-format/' + format + '/', lt: 'by-format/' + format + '0' }),
  tok: (token, slug) => 'tok/' + token + '/' + slug,
  tokRange: token => ({ gte: 'tok/' + token + '/', lt: 'tok/' + token + '0' }),
  tokPrefixRange: prefix => ({ gte: 'tok/' + prefix, lt: 'tok/' + prefix + '\uffff' }),
  mirror: (slug, driveKey) => 'mirror/' + slug + '/' + driveKey,
  mirrorRange: slug => ({ gte: 'mirror/' + slug + '/', lt: 'mirror/' + slug + '0' }),
  stat: slug => 'stat/' + slug,
  pub: (publisher, slug) => 'pub/' + publisher + '/' + slug,
  pubRange: publisher => ({ gte: 'pub/' + publisher + '/', lt: 'pub/' + publisher + '0' }),
  writer: keyHex => 'writer/' + keyHex,
  writerRange: () => ({ gte: 'writer/', lt: 'writer0' })
}

// Extract the trailing slug from an index key like `by-tag/gguf/qwen/qwen3-8b`.
// Slugs contain exactly one `/`, so take the last two segments.
function slugFromIndexKey (key) {
  const parts = key.split('/')
  if (parts.length < 2) return null
  const tail = parts.slice(-2).join('/')
  return tail || null
}

function formatOf (path) {
  const i = path.lastIndexOf('.')
  if (i < 0) return null
  const ext = path.slice(i + 1).toLowerCase()
  return FORMAT_BY_EXT[ext] || null
}

function normalisePath (p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.?\/+/, '').trim()
}

function normaliseFiles (input) {
  if (!Array.isArray(input)) return []
  const byPath = new Map()
  for (const raw of input) {
    if (!raw) continue
    const path = normalisePath(raw.path)
    if (!path || path.includes('..')) continue
    const sizeBytes = Math.max(0, Math.floor(Number(raw.sizeBytes ?? raw.size ?? 0) || 0))
    const sha256 = raw.sha256 && /^[0-9a-f]{64}$/i.test(raw.sha256) ? String(raw.sha256).toLowerCase() : null
    byPath.set(path, { path, sizeBytes, sha256 })
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function uniqueStrings (input, { lower = true, max = 64 } = {}) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const raw of input) {
    if (raw == null) continue
    let v = String(raw).trim()
    if (lower) v = v.toLowerCase()
    if (!v || v.length > 64 || seen.has(v)) continue
    seen.add(v)
    out.push(v)
    if (out.length >= max) break
  }
  return out.sort()
}

function str (v, max, fallback = null) {
  if (v == null) return fallback
  const s = String(v).trim()
  if (!s) return fallback
  return s.length > max ? s.slice(0, max) : s
}

function isHexKey (v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v)
}

// Build the canonical stored record. Throws ValidationError on anything that
// would poison the index.
function normaliseArtifact (input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') throw new ValidationError('artifact must be an object')

  const owner = cleanSegment(input.owner)
  const name = str(input.name, 128)
  if (!name) throw new ValidationError('artifact.name is required')
  const slug = input.slug ? normaliseSlug(input.slug) : slugify(owner, name)

  if (!isHexKey(input.driveKey)) throw new ValidationError('artifact.driveKey must be a 32-byte hex key')

  const kind = KINDS.has(input.kind) ? input.kind : 'model'
  const files = normaliseFiles(input.files)
  const declaredSize = Math.max(0, Math.floor(Number(input.sizeBytes) || 0))
  const sizeBytes = files.length ? files.reduce((a, f) => a + f.sizeBytes, 0) : declaredSize

  const formats = uniqueStrings([
    ...(Array.isArray(input.formats) ? input.formats : []),
    ...files.map(f => formatOf(f.path)).filter(Boolean)
  ], { max: 16 })

  const publishedAt = Math.floor(Number(input.publishedAt) || now)
  const updatedAt = Math.max(publishedAt, Math.floor(Number(input.updatedAt) || now))

  const source = input.source && typeof input.source === 'object' ? input.source : {}

  return {
    slug,
    owner: owner || slug.split('/')[0],
    name,
    kind,
    summary: str(input.summary, 400),
    description: str(input.description, 20000),
    license: str(input.license, 64, 'unknown').toLowerCase(),
    task: input.task ? cleanSegment(input.task) : null,
    modality: input.modality ? cleanSegment(input.modality) : null,
    framework: input.framework ? cleanSegment(input.framework) : null,
    params: input.params == null ? null : Math.max(0, Math.floor(Number(input.params) || 0)) || null,
    quant: str(input.quant, 32),
    tags: uniqueStrings(input.tags, { max: 48 }),
    formats,
    files,
    sizeBytes,
    driveKey: String(input.driveKey).toLowerCase(),
    source: {
      url: str(source.url, 512),
      revision: str(source.revision, 128),
      mirroredFrom: str(source.mirroredFrom, 128)
    },
    publisher: isHexKey(input.publisher) ? String(input.publisher).toLowerCase() : null,
    publishedAt,
    updatedAt
  }
}

function normaliseSlug (slug) {
  const parts = String(slug).split('/').filter(Boolean)
  if (parts.length === 1) return cleanSegment(parts[0])
  if (parts.length !== 2) throw new ValidationError('slug must be "owner/name"')
  return slugify(parts[0], parts[1])
}

// The searchable token set for an artifact. Deterministic and bounded.
function artifactTokens (artifact) {
  const seen = new Set()
  const push = text => {
    for (const t of tokenize(text)) seen.add(t)
  }
  push(artifact.slug.replace('/', ' '))
  push(artifact.owner)
  push(artifact.name)
  push(artifact.summary)
  push(artifact.task)
  push(artifact.modality)
  push(artifact.framework)
  push(artifact.quant)
  push(artifact.license)
  push(artifact.kind)
  for (const tag of artifact.tags) push(tag)
  for (const fmt of artifact.formats) push(fmt)
  if (artifact.params) seen.add(humanParams(artifact.params))
  return [...seen].slice(0, 144)
}

function humanParams (n) {
  if (n >= 1e12) return trimZero(n / 1e12) + 't'
  if (n >= 1e9) return trimZero(n / 1e9) + 'b'
  if (n >= 1e6) return trimZero(n / 1e6) + 'm'
  return String(n)
}

function trimZero (v) {
  const s = v.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

const OP_TYPES = new Set(['artifact', 'mirror', 'vote', 'flag', 'addWriter', 'removeWriter'])

// Shape-only validation. Signature checking lives in lib/trust.js.
function validateOp (op) {
  if (!op || typeof op !== 'object') throw new ValidationError('op must be an object')
  if (!OP_TYPES.has(op.t)) throw new ValidationError('unknown op type: ' + op.t)
  if (!isHexKey(op.by)) throw new ValidationError('op.by must be a hex public key')
  if (!Number.isFinite(op.at)) throw new ValidationError('op.at must be a number')

  switch (op.t) {
    case 'artifact':
      if (!op.artifact || typeof op.artifact !== 'object') throw new ValidationError('artifact op needs .artifact')
      break
    case 'mirror':
      if (!op.slug) throw new ValidationError('mirror op needs .slug')
      if (!isHexKey(op.driveKey)) throw new ValidationError('mirror op needs .driveKey')
      break
    case 'vote':
      if (!op.slug) throw new ValidationError('vote op needs .slug')
      if (op.value !== 1 && op.value !== -1) throw new ValidationError('vote.value must be 1 or -1')
      break
    case 'flag':
      if (!op.slug) throw new ValidationError('flag op needs .slug')
      break
    case 'addWriter':
    case 'removeWriter':
      if (!isHexKey(op.key)) throw new ValidationError('writer op needs hex .key')
      break
  }
  return op
}

module.exports = {
  ValidationError,
  QUOTA_ARTIFACTS_PER_PUBLISHER,
  KINDS,
  KEYS,
  canonicalJSON,
  slugify,
  normaliseSlug,
  cleanSegment,
  tokenize,
  artifactTokens,
  normaliseArtifact,
  normaliseFiles,
  normalisePath,
  validateOp,
  invTimeKey,
  sizeKey,
  slugFromIndexKey,
  formatOf,
  humanParams,
  isHexKey
}
