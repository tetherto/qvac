'use strict'
// Resolve the `matrix_models` launch parameter into the
// canonical model specs harness.cjs runs ({ label, ctx_size, llm: { source },
// mmproj: { source } }). Any new model is benchmarkable with zero code changes —
// a model is just two https URLs (LLM gguf + mmproj gguf).
//
// Grammar (CONTRACT.md §3), tokens comma-separated, forms mix freely:
//   catalog name        qwen3.5-q8
//   ad-hoc URL pair     [label=]<llm-url>|<mmproj-url>[@ctx=N]
//   JSON escape hatch   json:[{label, ctx_size, llm:{source}, mmproj:{source}}, …]
// The whole value may be wrapped b64:<base64(utf8)> — used for the on-device
// transport (the device config channel is line/semicolon-delimited).
//
// `|` separates the two blobs because it never appears unencoded in URLs
// (`+`/`,` can occur inside presigned-S3 query strings). A literal comma inside
// a URL must be %-encoded, or use the json: form.

const HF_RE = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/([^/]+)\/(.+)$/
const LABEL_RE = /^[A-Za-z0-9._-]+$/

// Tiny stable hash so two ad-hoc blobs with the same basename can't collide in
// the model cache (cache is keyed by modelName).
function hash8 (s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

// One blob (llm or mmproj) from a URL. huggingface.co resolve-URLs are
// recognised and reported as Source=HF with repo+ref provenance (an unpinned
// ref like `main` is allowed but flagged); anything else reports as URL.
function blobFromUrl (url, role) {
  url = String(url || '').trim()
  if (!/^https:\/\//.test(url)) {
    throw new Error(`model ${role} blob must be an https URL (got '${url.slice(0, 60)}')`)
  }
  const file = url.split('?')[0].split('/').pop() || role
  const modelName = `adhoc-${hash8(url)}-${file}`
  const hf = url.match(HF_RE)
  if (hf) {
    const repo = hf[1]
    const ref = hf[2]
    const path = hf[3].split('?')[0]
    const pinned = /^[0-9a-f]{40}$/.test(ref)
    return {
      modelName,
      origin: `${repo}@${ref.slice(0, 10)} · ${path}${pinned ? '' : ' (unpinned ref)'}`,
      source: { type: 'hf', repo, sha: ref, file: path }
    }
  }
  return { modelName, origin: `${file} (URL)`, source: { type: 'url', url } }
}

// [label=]<llm-url>|<mmproj-url>[@ctx=N]
function parsePair (token) {
  let body = token
  let label = null
  let ctx = '4096'
  const eq = body.indexOf('=')
  if (eq > 0 && LABEL_RE.test(body.slice(0, eq))) {
    label = body.slice(0, eq)
    body = body.slice(eq + 1)
  }
  const at = body.match(/@ctx=(\d+)\s*$/)
  if (at) {
    ctx = at[1]
    body = body.slice(0, at.index)
  }
  const parts = body.split('|')
  if (parts.length !== 2) {
    throw new Error(`model token must be [label=]<llm-url>|<mmproj-url>[@ctx=N] (got '${token.slice(0, 80)}')`)
  }
  const llm = blobFromUrl(parts[0], 'llm')
  const mmproj = blobFromUrl(parts[1], 'mmproj')
  if (!label) {
    // Derive from the mmproj basename — it's usually the varying part.
    label = mmproj.modelName.replace(/^adhoc-[0-9a-f]{8}-/, '').replace(/\.gguf$/i, '')
      .toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 40) || `adhoc-${hash8(token)}`
  }
  return { label, name: label, ctx_size: ctx, llm, mmproj }
}

// json: form — validate the minimum the harness needs; registry-type sources
// are accepted here (desktop-only; the mobile app has no registry client).
function normalizeSpec (spec, i) {
  if (!spec || typeof spec !== 'object') throw new Error(`json model #${i}: not an object`)
  for (const role of ['llm', 'mmproj']) {
    const blob = spec[role]
    if (!blob || (!blob.source && !blob.downloadUrl)) {
      throw new Error(`json model #${i} ('${spec.label || '?'}'): missing ${role}.source`)
    }
    if (!blob.modelName) {
      const ident = JSON.stringify(blob.source || blob.downloadUrl)
      blob.modelName = `adhoc-${hash8(ident)}-${role}.gguf`
    }
    if (!blob.origin) blob.origin = blob.modelName
  }
  if (!spec.label) spec.label = `json-model-${i}`
  if (!spec.name) spec.name = spec.label
  if (!spec.ctx_size) spec.ctx_size = '4096'
  return spec
}

// Resolve the raw launch value. Empty → fallback (the config defaults).
// `catalog` maps short names to committed specs; unknown bare names fail fast
// so a typo never silently benchmarks the wrong thing.
function parseModels (raw, catalog, fallback) {
  raw = String(raw || '').trim()
  if (!raw) return fallback
  if (raw.startsWith('b64:')) {
    raw = Buffer.from(raw.slice(4), 'base64').toString('utf8').trim()
  }
  if (raw.startsWith('json:')) {
    const arr = JSON.parse(raw.slice(5))
    if (!Array.isArray(arr) || !arr.length) throw new Error('json: model list must be a non-empty array')
    return arr.map(normalizeSpec)
  }
  const specs = raw.split(',').map(t => t.trim()).filter(Boolean).map(t => {
    if (catalog && catalog[t]) return catalog[t]
    if (t.includes('|')) return parsePair(t)
    throw new Error(`unknown model '${t}' — not a catalog name (${Object.keys(catalog || {}).join(', ')}) and not an <llm-url>|<mmproj-url> pair`)
  })
  const seen = new Set()
  for (const s of specs) {
    if (seen.has(s.label)) throw new Error(`duplicate model label '${s.label}' — give each model a distinct label=`)
    seen.add(s.label)
  }
  return specs
}

module.exports = { parseModels, parsePair, blobFromUrl }
