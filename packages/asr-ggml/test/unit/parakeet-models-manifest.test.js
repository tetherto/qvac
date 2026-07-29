'use strict'

// Guards test/integration/models.manifest.json — the single source of truth for
// the CI-staged parakeet model set AND the cache-models cache key. Kept
// import-light (reads files only, never requires the native addon) so it runs
// under brittle-bare without a prebuild.
//
// It fails loudly if:
//   - documentation or other non-key metadata is added to the hashed manifest,
//   - the manifest schema drifts (missing s3Path / malformed sha256 / bytes),
//   - the staged set no longer matches the expected 13 desktop GGUFs, or
//   - a manifest filename or its S3 date prefix is not referenced by
//     test/integration/helpers.js (i.e. the manifest and the runtime model
//     config have drifted apart).

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')

const MANIFEST_PATH = path.join(__dirname, '..', 'integration', 'models.manifest.json')
const HELPERS_PATH = path.join(__dirname, '..', 'integration', 'helpers.js')

// The desktop quant sweep staged by integration-test-transcription-parakeet.yml
// (f16 + q8_0 for all four model types, q4_0 for tdt/ctc/eou/sortformer), plus
// the Sortformer-Streaming v2.1 q8_0 GGUF that sortformer-aosc-streaming.test.js
// loads via MODEL_CONFIGS.sortformerStreaming.
const EXPECTED_FILES = [
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
  'diar_streaming_sortformer_4spk-v2.1.q8_0.gguf'
]

const KNOWN_DATE_PREFIXES = ['2026-07-01', '2026-05-11', '2026-05-27', '2026-05-20']

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
}

test('manifest: contains only cache-key-bearing fields', (t) => {
  const manifest = loadManifest()
  t.alike(
    Object.keys(manifest).sort(),
    ['cacheEpoch', 'models', 'source'],
    'top level excludes prose and unrelated metadata'
  )
  t.ok(
    Number.isInteger(manifest.cacheEpoch) && manifest.cacheEpoch > 0,
    'cacheEpoch is a positive integer'
  )
  t.is(manifest.source, 's3', 'source is s3')

  for (const [name, entry] of Object.entries(manifest.models)) {
    t.alike(
      Object.keys(entry).sort(),
      ['bytes', 's3Path', 'sha256'],
      `${name}: entry contains only staging and integrity fields`
    )
  }
})

test('manifest: staged set matches the expected 13 desktop GGUFs', (t) => {
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
      /^qvac_models_compiled\/ggml\/parakeet\/(\d{4}-\d{2}-\d{2})\/(.+)$/
    )
    t.ok(m, `${name}: s3Path matches registry layout`)
    if (m) {
      t.ok(KNOWN_DATE_PREFIXES.includes(m[1]), `${name}: date prefix ${m[1]} is known`)
      t.is(m[2], name, `${name}: s3Path basename matches the key`)
    }

    t.ok(/^[0-9a-f]{64}$/.test(entry.sha256), `${name}: sha256 is pinned as 64-hex`)
    t.ok(
      Number.isInteger(entry.bytes) && entry.bytes > 0,
      `${name}: bytes is pinned as a positive int`
    )
  }
})

test('manifest: filenames + date prefixes are referenced by helpers.js', (t) => {
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
