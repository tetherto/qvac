'use strict'

// Guards test/integration/parakeet-coreml.manifest.json — the pinned set of
// Apple Neural Engine encoder sidecars staged for the darwin Core ML benchmark
// lanes, and (via the same `*.manifest.json` cache-key glob as the model
// manifest) part of the model cache key.
//
// Kept import-light (reads files only, never requires the native addon) so it
// runs under brittle-bare without a prebuild. Mirrors the shape guarantees in
// parakeet-models-manifest.test.js.
//
// An empty `sidecars` object is valid and expected until the bundles are
// published to the registry: the benchmark lanes skip themselves until then.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')

const MANIFEST_PATH = path.join(__dirname, '..', 'integration', 'parakeet-coreml.manifest.json')

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
}

test('coreml manifest: contains only cache-key-bearing fields', (t) => {
  const manifest = loadManifest()
  t.alike(
    Object.keys(manifest).sort(),
    ['cacheEpoch', 'sidecars', 'source'],
    'top level excludes prose and unrelated metadata'
  )
  t.ok(
    Number.isInteger(manifest.cacheEpoch) && manifest.cacheEpoch > 0,
    'cacheEpoch is a positive integer'
  )
  t.is(manifest.source, 's3', 'source is s3')
  t.ok(
    manifest.sidecars && typeof manifest.sidecars === 'object',
    'sidecars is an object (may be empty until the bundles are published)'
  )
})

test('coreml manifest: every entry is a pinned .mlmodelc zip', (t) => {
  const manifest = loadManifest()

  for (const [name, entry] of Object.entries(manifest.sidecars)) {
    t.alike(
      Object.keys(entry).sort(),
      ['bytes', 's3Path', 'sha256'],
      `${name}: entry contains only staging and integrity fields`
    )

    // The staging step unzips `<x>.mlmodelc.zip` to `<x>.mlmodelc`, which is
    // the exact name parakeet.cpp derives from the GGUF beside it. Any other
    // suffix would stage a bundle the engine never looks for.
    t.ok(name.endsWith('-encoder.mlmodelc.zip'), `${name}: is an encoder .mlmodelc zip`)

    t.is(typeof entry.s3Path, 'string', `${name}: s3Path is a string`)
    t.is(path.basename(entry.s3Path), name, `${name}: s3Path basename matches the key`)

    t.ok(/^[0-9a-f]{64}$/.test(entry.sha256), `${name}: sha256 is pinned as 64-hex`)
    t.ok(
      Number.isInteger(entry.bytes) && entry.bytes > 0,
      `${name}: bytes is pinned as a positive int`
    )
  }
})
