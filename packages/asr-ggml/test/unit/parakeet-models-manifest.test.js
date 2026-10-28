'use strict'

// Guards the parakeet (s3Path) entries of test/integration/models.manifest.json —
// the single source of truth for the CI-staged parakeet model set AND the model
// cache key. The whisper (urls) entries and the sidecars have their own guards.
// Kept import-light (reads files only, never requires the native addon) so it
// runs under brittle-bare without a prebuild.
//
// It fails loudly if:
//   - documentation or other non-key metadata is added to the hashed manifest,
//   - the manifest schema drifts (missing s3Path / malformed sha256 / bytes),
//   - the staged set no longer matches the expected desktop GGUFs, or
//   - a manifest filename or its S3 date prefix is not referenced by
//     test/integration/parakeet-helpers.js (i.e. the manifest and the runtime
//     model config have drifted apart).

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')

const MANIFEST_PATH = path.join(__dirname, '..', 'integration', 'models.manifest.json')
const HELPERS_PATH = path.join(__dirname, '..', 'integration', 'parakeet-helpers.js')

// The desktop quant sweep staged by integration-test-asr-ggml.yml
// (f16 + q8_0 + q4_0 for Unified and the existing core model types), plus
// the Sortformer-Streaming v2.1 q8_0 GGUF that parakeet-sortformer-aosc-streaming.test.js
// loads via MODEL_CONFIGS.sortformerStreaming, plus Indic Conformer CTC q8_0
// (desktop default; mobile uses q4_0 via the Device Farm manifest).
const EXPECTED_FILES = [
  'parakeet-unified-en-0.6b.f16.gguf',
  'parakeet-unified-en-0.6b.q8_0.gguf',
  'parakeet-unified-en-0.6b.q4_0.gguf',
  'parakeet-tdt-0.6b-v3.f16.gguf',
  'parakeet-ctc-0.6b.f16.gguf',
  'parakeet-eou-120m-v1.f16.gguf',
  'sortformer-4spk-v1.f16.gguf',
  'parakeet-ctc-0.6b.q4_0.gguf',
  'parakeet-tdt-0.6b-v3.q8_0.gguf',
  'parakeet-ctc-0.6b.q8_0.gguf',
  'parakeet-eou-120m-v1.q8_0.gguf',
  'sortformer-4spk-v1.q8_0.gguf',
  'parakeet-tdt-0.6b-v3.q4_0.gguf',
  'parakeet-eou-120m-v1.q4_0.gguf',
  'sortformer-4spk-v1.q4_0.gguf',
  'diar_streaming_sortformer_4spk-v2.1.q8_0.gguf',
  'indic-conformer-ctc.q8_0.gguf'
]

const KNOWN_DATE_PREFIXES = [
  '2026-08-13',
  '2026-07-01',
  '2026-05-11',
  '2026-05-27',
  '2026-05-20',
  '2026-08-07'
]
const KNOWN_MODEL_FAMILIES = ['parakeet', 'indic_conformer']

// The manifest with only the parakeet entries: every non-urls entry is parakeet's.
function loadManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  const models = Object.fromEntries(
    Object.entries(manifest.models).filter(([, entry]) => !entry.urls)
  )
  return { ...manifest, models }
}

test('manifest: contains only cache-key-bearing fields', (t) => {
  const manifest = loadManifest()
  t.alike(
    Object.keys(manifest).sort(),
    ['cacheEpoch', 'models', 'sidecars'],
    'top level excludes prose and unrelated metadata'
  )
  t.ok(
    Number.isInteger(manifest.cacheEpoch) && manifest.cacheEpoch > 0,
    'cacheEpoch is a positive integer'
  )
  for (const [name, entry] of Object.entries(manifest.models)) {
    t.is(typeof entry.s3Path, 'string', `${name}: source is s3`)
  }

  for (const [name, entry] of Object.entries(manifest.models)) {
    t.alike(
      Object.keys(entry).sort(),
      ['bytes', 'dest', 's3Path', 'sha256', 'targets'],
      `${name}: entry contains only staging and integrity fields`
    )
    t.is(entry.dest, `models/${name}`, `${name}: stages into models/`)
    t.ok(
      entry.targets.includes('test:integration') && entry.targets.includes('benchmark'),
      `${name}: staged for the integration tests and benchmarks`
    )
  }
})

test('manifest: staged set matches the expected desktop GGUFs', (t) => {
  const manifest = loadManifest()
  t.ok(manifest.models && typeof manifest.models === 'object', 'has models object')
  const names = Object.keys(manifest.models).sort()
  t.alike(names, EXPECTED_FILES.slice().sort(), 'exact staged filename set')
})

test('manifest: every entry has a well-formed s3Path + pinned integrity', (t) => {
  const manifest = loadManifest()
  for (const [name, entry] of Object.entries(manifest.models)) {
    t.is(typeof entry.s3Path, 'string', `${name}: s3Path is a string`)
    const m = entry.s3Path.match(
      /^qvac_models_compiled\/ggml\/(parakeet|indic_conformer)\/(\d{4}-\d{2}-\d{2})\/(.+)$/
    )
    t.ok(m, `${name}: s3Path matches registry layout`)
    if (m) {
      t.ok(KNOWN_MODEL_FAMILIES.includes(m[1]), `${name}: family ${m[1]} is known`)
      t.ok(KNOWN_DATE_PREFIXES.includes(m[2]), `${name}: date prefix ${m[2]} is known`)
      t.is(m[3], name, `${name}: s3Path basename matches the key`)
    }

    t.ok(/^[0-9a-f]{64}$/.test(entry.sha256), `${name}: sha256 is pinned as 64-hex`)
    t.ok(
      Number.isInteger(entry.bytes) && entry.bytes > 0,
      `${name}: bytes is pinned as a positive int`
    )
  }
})

test('manifest: filenames + date prefixes are referenced by parakeet-helpers.js', (t) => {
  const manifest = loadManifest()
  const helpers = fs.readFileSync(HELPERS_PATH, 'utf8')
  for (const [name, entry] of Object.entries(manifest.models)) {
    t.ok(helpers.includes(name), `${name}: referenced in helpers.js MODEL_CONFIGS`)
    const datePrefix = entry.s3Path.split('/')[3]
    t.ok(
      helpers.includes(datePrefix),
      `${name}: registry date ${datePrefix} referenced in helpers.js`
    )
  }
})
