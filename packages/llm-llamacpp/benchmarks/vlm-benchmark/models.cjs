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

// Bare filename only: modelName becomes a path segment under $MODEL_DIR (see
// resolve-cli-model.cjs / the benchmark-vlm-model-comparison.yml fetch_blob step), so a
// caller-supplied value must not be able to escape that directory.
const MODEL_NAME_RE = /^[A-Za-z0-9._-]+$/

// cliArgs exists for ONE purpose: per-model image preprocessing that the GGUF cannot
// declare, e.g. VisionPsy Flash's --image-no-upscale. So allow exactly that family and
// reject every other flag, rather than blocklisting the ones the harness sets.
//
// A blocklist cannot be made safe here. llama.cpp gives most options several spellings
// (common/arg.cpp: {"-n","--predict","--n-predict"}, {"-s","--seed"},
// {"--temp","--temperature"}, {"-mm","--mmproj"}, {"-ngl","--gpu-layers",
// "--n-gpu-layers"}), extraArgs are appended AFTER buildCliArgs' fixed flags so a late
// alias wins, and a fabric bump can add another alias without touching this file. An
// allowlist cannot rot that way: a new spelling of --seed is still not on it.
//
// These five are single-spelling in arg.cpp (:2418 :2425 :2432 :2452 :2463) and none
// of them is set by buildCliArgs. Adding to this list is a deliberate act; do it when a
// model genuinely needs a new preprocessing knob.
const ALLOWED_CLI_FLAGS = new Set([
  '--image-no-upscale', '--image-tile-mode', '--image-max-tiles',
  '--image-max-tokens', '--image-min-tokens'
])

// The addon twin. LOAD_CONFIG_HANDLERS in the addon accepts both spellings of each key,
// so both are listed. reasoning-budget is deliberately absent: the harness pins it to 0
// for every leg, so a spec that set it would be changing the comparison, not the model.
// mmproj-use-gpu is here rather than treated as a device setting: `device` picks the
// backend for the LLM layers, this picks it for the projector only, and on Android the
// addon auto-defaults it per GPU class (LlamaModel.cpp: GPU for Adreno 800+, CPU for
// Mali and anything undetected). Validating the projector on a Mali GPU is therefore
// impossible without overriding it, so a dispatch has to be able to set it.
const ALLOWED_ADDON_KEYS = new Set([
  'image-no-upscale', 'image_no_upscale', 'image-tile-mode', 'image_tile_mode',
  'image-max-tokens', 'image_max_tokens', 'image-min-tokens', 'image_min_tokens',
  'mmproj-use-gpu', 'mmproj_use_gpu'
])

// llama.cpp rewrites `_` to `-` on any `--` argument before it looks the option up
// (common/arg.cpp, both parse loops), so `--image_no_upscale` reaches the same option
// as `--image-no-upscale`. Match that, and split `--flag=value` so the flag is compared
// on its own.
function canonicalCliFlag (a) {
  const head = a.split('=')[0]
  return head.startsWith('--') ? head.replace(/_/g, '-') : head
}

// A token is a flag if it starts with `-` and is not a negative number, since values
// like `-1` are legitimate arguments to the flag before them.
function isFlagToken (a) {
  return a.startsWith('-') && !/^-\d/.test(a)
}

// Every URL the workflow hands to curl must be https. curl reads a leading dash as an
// option however the shell quotes it, so a value like `--config=/tmp/curlrc` would be
// obeyed rather than fetched; requiring the https:// prefix rejects that by construction.
const HTTPS_RE = /^https:\/\/[^\s]+$/

function assertHttpsUrl (value, what, i, label) {
  if (!HTTPS_RE.test(String(value))) {
    throw new Error(`json model #${i} ('${label || '?'}'): ${what} must be an https URL (got '${String(value).slice(0, 60)}')`)
  }
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
    if (blob.downloadUrl) {
      assertHttpsUrl(blob.downloadUrl, `${role}.downloadUrl`, i, spec.label)
    }
    // resolveBlob() turns a url/s3 source into exactly this downloadUrl, and
    // resolve-cli-model.cjs emits it into the env file the workflow curls, so it needs
    // the same check. `hf` is built from repo/sha/file and `registry` never reaches curl.
    const src = blob.source || {}
    if (src.type === 'url' || src.type === 's3') {
      assertHttpsUrl(src.url, `${role}.source.url`, i, spec.label)
    }
    if (!blob.modelName) {
      const ident = JSON.stringify(blob.source || blob.downloadUrl)
      blob.modelName = `adhoc-${hash8(ident)}-${role}.gguf`
    } else if (!MODEL_NAME_RE.test(blob.modelName)) {
      throw new Error(`json model #${i} ('${spec.label || '?'}'): ${role}.modelName must be a bare filename (got '${String(blob.modelName).slice(0, 60)}')`)
    }
    if (!blob.origin) blob.origin = blob.modelName
  }
  if (spec.cliArgs != null) {
    if (!Array.isArray(spec.cliArgs) || spec.cliArgs.some(a => typeof a !== 'string')) {
      throw new Error(`json model #${i} ('${spec.label || '?'}'): cliArgs must be an array of strings`)
    }
    const bad = spec.cliArgs.filter(a => isFlagToken(a) && !ALLOWED_CLI_FLAGS.has(canonicalCliFlag(a)))
    if (bad.length) {
      throw new Error(`json model #${i} ('${spec.label || '?'}'): cliArgs may only carry per-model image preprocessing flags (${[...ALLOWED_CLI_FLAGS].join(', ')}); rejected ${bad.join(', ')}`)
    }
  }
  if (spec.addonConfig != null) {
    const cfg = spec.addonConfig
    if (typeof cfg !== 'object' || Array.isArray(cfg) || Object.values(cfg).some(v => typeof v !== 'string')) {
      throw new Error(`json model #${i} ('${spec.label || '?'}'): addonConfig must be an object of string values`)
    }
    const bad = Object.keys(cfg).filter(k => !ALLOWED_ADDON_KEYS.has(k))
    if (bad.length) {
      throw new Error(`json model #${i} ('${spec.label || '?'}'): addonConfig may only carry per-model image preprocessing keys (${[...ALLOWED_ADDON_KEYS].join(', ')}); rejected ${bad.join(', ')}`)
    }
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
