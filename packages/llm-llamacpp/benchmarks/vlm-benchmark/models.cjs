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
// caller-supplied value must not be able to escape that directory. The leading (?!\.+$)
// is what closes that: the character class has no slash, but it does allow a name made
// only of dots, and `..` is a path segment that walks up one level.
const MODEL_NAME_RE = /^(?!\.+$)[A-Za-z0-9._-]+$/

// Per-model image preprocessing the GGUF cannot declare, e.g. VisionPsy Flash's
// --image-no-upscale. An allowlist, not a blocklist: llama.cpp gives most options several
// spellings and extra args are appended after buildCliArgs' fixed ones, so a late alias
// would win and a fabric bump could add one without touching this file.
//
// One entry per option, so the two sides cannot drift apart: both allowlists and the twin
// lookup are derived from here. A null side means the option exists on one leg only and so
// can never be paired, which is why --image-max-tiles is absent entirely (arg.cpp takes it,
// the addon has no handler) and why mmproj-use-gpu is addon-only. See CONTRACT.md section 3.
const MODEL_OPTIONS = Object.freeze([
  { cli: '--image-no-upscale', addon: 'image-no-upscale' },
  { cli: '--image-tile-mode', addon: 'image-tile-mode' },
  { cli: '--image-max-tokens', addon: 'image-max-tokens' },
  { cli: '--image-min-tokens', addon: 'image-min-tokens' },
  { cli: null, addon: 'mmproj-use-gpu' }
])

// The addon accepts either spelling of each key (LOAD_CONFIG_HANDLERS), so list both.
// reasoning-budget is deliberately absent everywhere: the harness pins it to 0 on every
// leg, so a spec setting it would change the comparison, not the model.
const addonSpellings = (key) => [key, key.replace(/-/g, '_')]

const ALLOWED_CLI_FLAGS = new Set(MODEL_OPTIONS.filter(o => o.cli).map(o => o.cli))
const ALLOWED_ADDON_KEYS = new Set(MODEL_OPTIONS.filter(o => o.addon).flatMap(o => addonSpellings(o.addon)))

// Canonical CLI flag -> addon key, and back. Both sides canonicalise before lookup, so
// --image_no_upscale and image_no_upscale land on the same option.
const CLI_TO_ADDON = new Map(MODEL_OPTIONS.filter(o => o.cli && o.addon).map(o => [o.cli, o.addon]))
const ADDON_TO_CLI = new Map(MODEL_OPTIONS.filter(o => o.cli && o.addon).map(o => [o.addon, o.cli]))

// llama.cpp rewrites `_` to `-` on any `--` argument before it looks the option up
// (common/arg.cpp, both parse loops), so `--image_no_upscale` reaches the same option
// as `--image-no-upscale`. Match that.
function canonicalCliFlag (a) {
  return a.startsWith('--') ? a.replace(/_/g, '-') : a
}

// A token is a flag if it starts with `-` and is not a negative number, since values
// like `-1` are legitimate arguments to the flag before them. Anchored to a complete
// number so a token such as `-1--ctx-size` is still treated as a flag and checked against
// the allowlist rather than waved through as a value.
function isFlagToken (a) {
  return a.startsWith('-') && !/^-\d+(\.\d+)?$/.test(a)
}

// One array element must stay one CLI token, because resolve-cli-model.cjs joins the array
// with a space into the env file and cli-fixture-runner.cjs splits it back on whitespace.
// An element carrying a space would therefore pass the allowlist as a single token and then
// become two, and since extra args are appended after the fixed ones it could override a
// benchmark-controlled flag such as --ctx-size.
function assertNoWhitespace (args, i, label) {
  const bad = args.filter(a => /\s/.test(a))
  if (bad.length) {
    throw new Error(`json model #${i} ('${label || '?'}'): cliArgs elements must not contain whitespace, one element is one argument; rejected ${bad.map(a => JSON.stringify(a)).join(', ')}`)
  }
}

// arg.cpp looks the whole argv token up in arg_to_options and never splits on `=`, so
// `--image-no-upscale=on` is an unknown argument to it and aborts the run. The workflow
// swallows that as a warning, which shows up as an engine leg with no rows rather than an
// error, so reject the form here where the message can say why.
function assertNoEqualsForm (args, i, label) {
  const bad = args.filter(a => a.includes('='))
  if (bad.length) {
    throw new Error(`json model #${i} ('${label || '?'}'): cliArgs must use the split form, llama.cpp does not accept --flag=value; write ['--image-no-upscale', 'on'] instead of ${bad.map(a => JSON.stringify(a)).join(', ')}`)
  }
}

// Pair a cliArgs array down to {canonical flag -> value}. A flag with no following value,
// or followed by another flag, is a valueless switch and pairs to ''.
function cliArgsToMap (args) {
  const out = new Map()
  for (let n = 0; n < args.length; n++) {
    if (!isFlagToken(args[n])) continue
    const next = args[n + 1]
    out.set(canonicalCliFlag(args[n]), next != null && !isFlagToken(next) ? next : '')
  }
  return out
}

// An option set on one leg only silently compares different preprocessing under one model
// label, which is the failure the pairing exists to prevent. So a spec that sets an option
// having a twin must set both sides to the same value. Options with no twin, currently
// mmproj-use-gpu, are exempt: there is nothing to match them against.
function assertTwinsMatch (spec, i) {
  const label = spec.label || '?'
  const cli = cliArgsToMap(spec.cliArgs || [])
  const addon = new Map()
  for (const [k, v] of Object.entries(spec.addonConfig || {})) {
    addon.set(k.replace(/_/g, '-'), String(v))
  }
  const problems = []
  for (const [flag, value] of cli) {
    const twin = CLI_TO_ADDON.get(flag)
    if (!twin) continue
    if (!addon.has(twin)) problems.push(`${flag} is set for the CLI legs but addonConfig has no '${twin}'`)
    else if (addon.get(twin) !== value) problems.push(`${flag} is '${value}' but addonConfig '${twin}' is '${addon.get(twin)}'`)
  }
  for (const [key, value] of addon) {
    const twin = ADDON_TO_CLI.get(key)
    if (!twin) continue
    if (!cli.has(twin)) problems.push(`addonConfig '${key}' is set but cliArgs has no ${twin}`)
    else if (cli.get(twin) !== value) problems.push(`addonConfig '${key}' is '${value}' but ${twin} is '${cli.get(twin)}'`)
  }
  if (problems.length) {
    throw new Error(`json model #${i} ('${label}'): cliArgs and addonConfig must set the same preprocessing on both legs, otherwise the report compares different settings under one label; ${problems.join('; ')}`)
  }
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
    assertNoWhitespace(spec.cliArgs, i, spec.label)
    assertNoEqualsForm(spec.cliArgs, i, spec.label)
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
  assertTwinsMatch(spec, i)
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
    // Own-property check, so a name like `constructor` or `toString` falls through to the
    // unknown-model error below instead of resolving to an Object.prototype member.
    if (catalog && Object.prototype.hasOwnProperty.call(catalog, t)) return catalog[t]
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

// One canonical string for the per-model preprocessing a leg actually applied, so the report
// can compare legs that were configured through different mechanisms. The addon leg passes
// its addonConfig, the CLI legs the argv they were handed, and both come out as the same
// sorted `key=value` form keyed on the addon spelling. Empty means base preprocessing, which
// is the honest answer for an upstream-cli leg: cliArgs are fabric-fork flags and never reach
// it, so it runs the model without them even when the addon leg does not.
function preprocLabel ({ cliArgs, addonConfig } = {}) {
  const applied = new Map()
  for (const [k, v] of Object.entries(addonConfig || {})) applied.set(k.replace(/_/g, '-'), String(v))
  for (const [flag, value] of cliArgsToMap(cliArgs || [])) {
    const key = CLI_TO_ADDON.get(flag) || flag
    if (!applied.has(key)) applied.set(key, value)
  }
  return [...applied.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => (v === '' ? k : `${k}=${v}`))
    .join(' ')
}

// assertTwinsMatch is exported so a test can hold the committed catalog to the same rule
// as a json: spec; normalizeSpec only runs on the latter.
module.exports = { parseModels, parsePair, blobFromUrl, assertTwinsMatch, preprocLabel, MODEL_OPTIONS }
