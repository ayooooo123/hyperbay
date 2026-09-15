// HuggingFace -> Hyperbay importer.
//
// Talks to the public HF API only (`/api/models/:repo` + `/resolve/:rev/:path`).
// Gated or private repos are refused with HYPERBAY_GATED — we never send a
// token, never try an alternate host, never scrape around the gate. A mirror
// of something you are not allowed to redistribute is a liability, not a
// feature.
//
// Runs on Bare: `bare-fetch` for HTTP (no global fetch), no node: requires.

const fetch = require('bare-fetch')
const b4a = require('b4a')

const { normaliseArtifact, humanParams, formatOf } = require('../schema.js')

const USER_AGENT = 'hyperbay/0.1'
const MAX_ATTEMPTS = 3
const BACKOFF_BASE_MS = 500
const PROGRESS_INTERVAL_MS = 250 // ~4 emits/second
const DESCRIPTION_MAX = 20000

const DEFAULT_EXCLUDES = ['.gitattributes', '.gitignore', '.cache/**']

// ---------------------------------------------------------------------------
// tiny glob matcher: `*` matches within a path segment, `**` matches anything
// including slashes. No dependency, no regex injection (we escape first).
// ---------------------------------------------------------------------------

function globToRegExp (pattern) {
  let out = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i++
        if (pattern[i + 1] === '/') i++ // `**/foo` also matches root `foo`
      } else {
        out += '[^/]*'
      }
    } else if ('\\^$.|?*+()[]{}'.includes(c)) {
      out += '\\' + c
    } else {
      out += c
    }
  }
  return new RegExp(out + '$')
}

function matchesAny (path, patterns) {
  for (const p of patterns) if (globToRegExp(p).test(path)) return true
  return false
}

function asPatterns (v) {
  if (v == null) return []
  return (Array.isArray(v) ? v : [v]).map(String)
}

// siblings: [{ rfilename, size?, lfs? }] -> [{ path, sizeBytes }] sorted by path.
// Weight-format duplicates are deliberately KEPT — a mirror should be complete.
function planFiles (siblings, { include, exclude } = {}) {
  const inc = asPatterns(include)
  const exc = DEFAULT_EXCLUDES.concat(asPatterns(exclude))
  const rows = []
  for (const s of siblings || []) {
    const path = s && typeof s.rfilename === 'string' ? s.rfilename : null
    if (!path) continue
    if (inc.length && !matchesAny(path, inc)) continue
    if (matchesAny(path, exc)) continue
    rows.push({ path, sizeBytes: Math.max(0, Math.floor(Number(s.size) || 0)) })
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return rows
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function headers (extra) {
  return Object.assign({ 'user-agent': USER_AGENT }, extra)
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function gatedError (repo) {
  const err = new Error(
    'huggingface repo ' + repo + ' is gated or private: access requires accepting the model licence terms upstream. ' +
    'Hyperbay will not bypass the gate. Ask someone who has accepted the terms to mirror it.'
  )
  err.code = 'HYPERBAY_GATED'
  return err
}

// bare-fetch bodies are web ReadableStreams that also carry
// Symbol.asyncIterator; handle async-iterables, reader-based streams and
// sync iterables so this never assumes one spec shape.
function toAsyncIterable (body) {
  if (body == null) return emptyIterable()
  if (typeof body[Symbol.asyncIterator] === 'function') return body
  if (typeof body.getReader === 'function') return readerIterable(body)
  if (typeof body[Symbol.iterator] === 'function') return body
  throw new Error('unsupported response body type')
}

async function * emptyIterable () {}

async function * readerIterable (stream) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    try { reader.releaseLock() } catch {}
  }
}

function chunkBytes (chunk) {
  return chunk.byteLength != null ? chunk.byteLength : chunk.length
}

async function drain (body) {
  if (!body) return
  try {
    if (typeof body.cancel === 'function') await body.cancel()
    else if (typeof body[Symbol.asyncIterator] === 'function') for await (const _ of body) void _
  } catch {}
}

function repoPath (repo) {
  return repo.split('/').filter(Boolean).map(encodeURIComponent).join('/')
}

function resolveUrl (endpoint, repo, revision, path) {
  return endpoint + '/' + repoPath(repo) + '/resolve/' + encodeURIComponent(revision) + '/' + path.split('/').map(encodeURIComponent).join('/')
}

// GET with the variants the contract asks for: ?blobs=true, then ?full=true,
// then plain. 401/403 anywhere is the gate — refuse immediately.
async function fetchRepoMeta (repo, { endpoint = 'https://huggingface.co' } = {}) {
  const api = String(endpoint).replace(/\/+$/, '') + '/api/models/' + repoPath(repo)
  let lastStatus = null
  for (const variant of ['?blobs=true', '?full=true', '']) {
    let res
    try {
      res = await fetch(api + variant, { headers: headers() })
    } catch (err) {
      throw new Error('huggingface metadata request failed: ' + err.message)
    }
    if (res.status === 401 || res.status === 403) {
      await drain(res.body)
      throw gatedError(repo)
    }
    if (res.status === 404) {
      lastStatus = 404
      await drain(res.body)
      continue
    }
    if (!res.ok) {
      await drain(res.body)
      throw new Error('huggingface API returned HTTP ' + res.status + ' for ' + repo)
    }
    const meta = await res.json()
    if (meta && (meta.gated || meta.private === true)) throw gatedError(repo)
    return meta
  }
  const err = new Error('huggingface repo not found: ' + repo)
  err.code = lastStatus === 404 ? 'HYPERBAY_NOT_FOUND' : 'HYPERBAY_IMPORT_FAILED'
  throw err
}

// Learn a file's size (and LFS sha256) without downloading it.
async function headFile (url) {
  const res = await fetch(url, { method: 'HEAD', headers: headers() })
  if (res.status === 401 || res.status === 403) {
    await drain(res.body)
    throw gatedError(url)
  }
  await drain(res.body)
  if (!res.ok) return { sizeBytes: 0, sha256: null }
  const linked = Number(res.headers.get('x-linked-size')) || 0
  const length = Number(res.headers.get('content-length')) || 0
  const etag = res.headers.get('x-linked-etag') || res.headers.get('etag') || ''
  const sha = /(?:sha256\/)?([0-9a-f]{64})/i.exec(etag)
  return {
    sizeBytes: linked || length,
    sha256: sha ? sha[1].toLowerCase() : null
  }
}

async function fetchText (url, limit) {
  const res = await fetch(url, { headers: headers() })
  if (res.status === 401 || res.status === 403) {
    await drain(res.body)
    throw gatedError(url)
  }
  if (!res.ok) {
    await drain(res.body)
    return null
  }
  const text = await res.text()
  return text.length > limit ? text.slice(0, limit) : text
}

// A resumable byte stream for one origin file. Yields chunks; on a mid-stream
// failure it waits (exponential backoff) and re-fetches with a Range header
// from the byte offset already delivered. If the origin will not resume
// (no 206) but we already handed bytes to the consumer, restarting would
// corrupt the hash — so we throw instead of silently producing a bad mirror.
function openFileStream (url, { path, sizeBytes, onBytes }) {
  return (async function * () {
    let consumed = 0
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const extra = consumed > 0 ? { range: 'bytes=' + consumed + '-' } : {}
        const res = await fetch(url, { headers: headers(extra) })
        if (res.status === 401 || res.status === 403) {
          await drain(res.body)
          throw gatedError(path)
        }
        if (consumed > 0 && res.status !== 206) {
          await drain(res.body)
          const err = new Error('origin refused to resume ' + path + ' at byte ' + consumed + ' (HTTP ' + res.status + ')')
          err.unresumable = true
          throw err
        }
        if (!res.ok) {
          await drain(res.body)
          throw new Error('HTTP ' + res.status + ' for ' + path)
        }
        for await (const chunk of toAsyncIterable(res.body)) {
          consumed += chunkBytes(chunk)
          if (onBytes) onBytes(chunkBytes(chunk))
          yield chunk
        }
        if (sizeBytes > 0 && consumed < sizeBytes) {
          throw new Error('truncated: got ' + consumed + '/' + sizeBytes + ' bytes of ' + path)
        }
        return
      } catch (err) {
        if (err.code === 'HYPERBAY_GATED') throw err
        if (err.unresumable || attempt >= MAX_ATTEMPTS) {
          throw new Error('failed to mirror ' + path + ' after ' + attempt + ' attempt(s): ' + err.message)
        }
        await sleep(BACKOFF_BASE_MS * Math.pow(2, attempt - 1))
      }
    }
  })()
}

// ---------------------------------------------------------------------------
// progress, throttled to ~4 emits/second (phase changes force an emit)
// ---------------------------------------------------------------------------

function createProgress (onProgress) {
  const state = { phase: null, path: null, files: 0, totalFiles: 0, bytes: 0, totalBytes: 0, speed: 0 }
  if (typeof onProgress !== 'function') {
    return { update () {}, addBytes () {} }
  }
  let lastEmit = 0
  let lastBytes = 0
  let lastAt = Date.now()
  function emit (force) {
    const now = Date.now()
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return
    const secs = (now - lastAt) / 1000
    state.speed = secs > 0 ? (state.bytes - lastBytes) / secs : 0
    lastBytes = state.bytes
    lastAt = now
    lastEmit = now
    onProgress({ ...state })
  }
  function update (patch) {
    const forced = patch.phase != null && patch.phase !== state.phase
    Object.assign(state, patch)
    emit(forced)
  }
  function addBytes (n) {
    state.bytes += n
    emit(false)
  }
  return { update, addBytes }
}

// ---------------------------------------------------------------------------
// metadata -> Artifact mapping
// ---------------------------------------------------------------------------

const MODALITY_BY_TASK = {
  'text-generation': 'text',
  'text2text-generation': 'text',
  'summarization': 'text',
  'translation': 'text',
  'fill-mask': 'text',
  'question-answering': 'text',
  'zero-shot-classification': 'text',
  'token-classification': 'text',
  'sentence-similarity': 'text',
  'text-classification': 'text',
  'feature-extraction': 'text',
  'image-classification': 'image',
  'image-segmentation': 'image',
  'object-detection': 'image',
  'text-to-image': 'image',
  'image-to-image': 'image',
  'image-to-text': 'multimodal',
  'automatic-speech-recognition': 'audio',
  'text-to-speech': 'audio',
  'audio-classification': 'audio',
  'audio-to-audio': 'audio',
  'voice-activity-detection': 'audio',
  'depth-estimation': 'image',
  'video-classification': 'video',
  'text-to-video': 'video',
  'any-to-any': 'multimodal',
  'tabular-classification': 'tabular'
}

function modalityFor (task) {
  if (!task) return null
  const t = String(task).toLowerCase()
  if (MODALITY_BY_TASK[t]) return MODALITY_BY_TASK[t]
  if (t.includes('multimodal') || t.includes('vision-language')) return 'multimodal'
  if (t.includes('image')) return 'image'
  if (t.includes('audio') || t.includes('speech')) return 'audio'
  if (t.includes('video')) return 'video'
  if (t.includes('text')) return 'text'
  return null
}

// '8B' -> 8e9, '1.5b' -> 1.5e9, '8x22B' (MoE) -> 176e9. safetensors.total wins.
function parseParams (meta, name) {
  const total = meta && meta.safetensors && Number(meta.safetensors.total)
  if (total > 0) return Math.floor(total)
  const s = String(name || '')
  const moe = /(\d+)\s*x\s*(\d+(?:\.\d+)?)b(?![a-z0-9])/i.exec(s)
  if (moe) return Math.floor(Number(moe[1]) * Number(moe[2]) * 1e9)
  const single = /(\d+(?:\.\d+)?)b(?![a-z0-9])/i.exec(s)
  if (single) return Math.floor(Number(single[1]) * 1e9)
  return null
}

// Quant from GGUF-style filenames: Q4_K_M, IQ3_XXS, Q8_0, fp16, bf16, int8.
function parseQuant (paths) {
  for (const p of paths) {
    if (!/\.(gguf|ggml|bin|safetensors|ckpt|pt)$/i.test(p)) continue
    const q = /(IQ\d+_[A-Z]+|Q\d(?:_[A-Z0-9]+)+|Q\d+)/.exec(p)
    if (q) return q[1]
    const f = /\b(fp16|bf16|int8|int4|f16|f32)\b/i.exec(p)
    if (f) return f[1].toLowerCase()
  }
  return null
}

function licenseOf (meta) {
  const card = meta && meta.cardData
  if (card && card.license) {
    return Array.isArray(card.license) ? String(card.license[0]) : String(card.license)
  }
  const tags = (meta && Array.isArray(meta.tags) ? meta.tags : []).map(String)
  const tag = tags.find((t) => t.toLowerCase().startsWith('license:'))
  return tag ? tag.slice('license:'.length) : null
}

function toHexKey (key) {
  if (typeof key === 'string') return key.toLowerCase()
  try {
    return b4a.toString(key, 'hex')
  } catch {
    return String(key)
  }
}

// Pure: no I/O. `description` is injected by the caller (README text) so this
// stays testable offline.
function buildArtifactFromRepo (meta, { driveKey, files, sizeBytes, revision, endpoint, description }) {
  const id = String((meta && (meta.id || meta._id)) || '')
  const segments = id.split('/').filter(Boolean)
  const name = segments.length ? segments[segments.length - 1] : id
  const owner = (meta && meta.author) || (segments.length > 1 ? segments[0] : null)
  const task = (meta && meta.pipeline_tag) || null
  const framework = (meta && meta.library_name) || null
  const params = parseParams(meta, name)
  const list = Array.isArray(files) ? files : []
  const quant = parseQuant(list.map((f) => f && f.path).filter(Boolean))

  const summaryBits = []
  if (params) summaryBits.push(humanParams(params).toUpperCase())
  if (task) summaryBits.push(task)
  summaryBits.push('model')
  if (framework) summaryBits.push(framework)
  if (quant) summaryBits.push(quant)

  return normaliseArtifact({
    owner,
    name,
    kind: 'model',
    summary: summaryBits.join(' · '),
    description: description || null,
    license: licenseOf(meta),
    task,
    modality: modalityFor(task),
    framework,
    params,
    quant,
    tags: meta && Array.isArray(meta.tags) ? meta.tags : [],
    formats: list.map((f) => (f && f.path ? formatOf(f.path) : null)).filter(Boolean),
    files: list,
    sizeBytes,
    driveKey: driveKey == null ? null : toHexKey(driveKey),
    source: {
      url: String(endpoint || 'https://huggingface.co').replace(/\/+$/, '') + '/' + id,
      revision: (meta && meta.sha) || revision || null,
      mirroredFrom: 'huggingface'
    }
  })
}

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

async function importHuggingFace (repo, { node, revision = 'main', include, exclude, endpoint = 'https://huggingface.co', onProgress, publish = true } = {}) {
  if (!repo || typeof repo !== 'string') throw new Error('importHuggingFace requires an "owner/name" repo id')
  if (!node || !node.drives || typeof node.drives.publishStream !== 'function') throw new Error('importHuggingFace requires node.drives.publishStream')

  const progress = createProgress(onProgress)
  const ep = String(endpoint).replace(/\/+$/, '')

  // 1. metadata (public API only; gated/private -> HYPERBAY_GATED)
  progress.update({ phase: 'meta' })
  const meta = await fetchRepoMeta(repo, { endpoint: ep })
  const siblings = Array.isArray(meta.siblings) ? meta.siblings : []

  // 3. plan
  const planned = planFiles(siblings, { include, exclude })
  if (!planned.length) throw new Error('nothing to mirror in ' + repo + ' after include/exclude filtering')
  progress.update({ phase: 'plan', files: 0, totalFiles: planned.length })

  // Origin hashes we can actually compare against: LFS sha256 from the API.
  // Non-LFS files only expose a git blob sha1, which is NOT a content sha256 —
  // comparing it would be a false mismatch, so we simply do not.
  const expected = new Map()
  for (const s of siblings) {
    if (s && s.lfs && s.lfs.sha256) expected.set(s.rfilename, { sha256: String(s.lfs.sha256).toLowerCase(), sizeBytes: Number(s.lfs.size) || 0 })
  }

  // sizes: siblings[].size when the API gave them, else HEAD (never buffer)
  let totalBytes = 0
  let n = 0
  for (const f of planned) {
    n++
    if (!f.sizeBytes) {
      const info = await headFile(resolveUrl(ep, repo, revision, f.path))
      f.sizeBytes = info.sizeBytes
      if (info.sha256 && !expected.has(f.path)) expected.set(f.path, { sha256: info.sha256, sizeBytes: info.sizeBytes })
    }
    const exp = expected.get(f.path)
    if (!f.sizeBytes && exp && exp.sizeBytes) f.sizeBytes = exp.sizeBytes
    totalBytes += f.sizeBytes
    progress.update({ path: f.path, files: n, totalFiles: planned.length, totalBytes })
  }

  // README text for the artifact description (small, capped)
  let description = null
  if (planned.some((f) => f.path === 'README.md')) {
    description = await fetchText(resolveUrl(ep, repo, revision, 'README.md'), DESCRIPTION_MAX)
  }

  // 4. stream every file into the drive
  const entries = (async function * () {
    for (const f of planned) {
      const url = resolveUrl(ep, repo, revision, f.path)
      progress.update({ phase: 'download', path: f.path, totalBytes })
      yield { path: f.path, stream: openFileStream(url, { path: f.path, sizeBytes: f.sizeBytes, onBytes: progress.addBytes }) }
      progress.update({ files: planned.findIndex((p) => p.path === f.path) + 1, totalFiles: planned.length, totalBytes })
    }
  })()

  progress.update({ phase: 'download', files: 0, totalFiles: planned.length, bytes: 0, totalBytes })
  const res = await node.drives.publishStream(entries, { onProgress })

  // 5. provenance: the bytes we received must match the origin
  const got = Array.isArray(res && res.files) ? res.files : []
  const byPath = new Map(planned.map((f) => [f.path, f]))
  for (const f of got) {
    const exp = expected.get(f.path)
    if (exp && exp.sha256 && f.sha256 && exp.sha256 !== String(f.sha256).toLowerCase()) {
      throw new Error('sha256 mismatch for ' + f.path + ': huggingface says ' + exp.sha256 + ', mirrored bytes hash to ' + String(f.sha256).toLowerCase() + ' — refusing to publish a mirror that does not match the origin')
    }
    const plan = byPath.get(f.path)
    if (plan && plan.sizeBytes && f.sizeBytes !== plan.sizeBytes) {
      throw new Error('size mismatch for ' + f.path + ': expected ' + plan.sizeBytes + ' bytes, mirrored ' + f.sizeBytes)
    }
  }
  if (got.length !== planned.length) {
    throw new Error('drive accepted ' + got.length + '/' + planned.length + ' files from ' + repo)
  }

  // 6. artifact
  progress.update({ phase: 'publish', files: planned.length, totalFiles: planned.length, totalBytes })
  const artifact = buildArtifactFromRepo(meta, {
    driveKey: res.driveKey,
    files: got,
    sizeBytes: res.sizeBytes != null ? res.sizeBytes : totalBytes,
    revision,
    endpoint: ep,
    description
  })

  // 7. publish
  if (publish !== false) {
    if (!node.catalog || typeof node.catalog.publish !== 'function') throw new Error('importHuggingFace requires node.catalog.publish to publish')
    await node.catalog.publish(artifact)
  }
  progress.update({ phase: 'done', files: planned.length, totalFiles: planned.length, bytes: artifact.sizeBytes, totalBytes })
  return artifact
}

module.exports = { importHuggingFace, fetchRepoMeta, buildArtifactFromRepo, planFiles }
