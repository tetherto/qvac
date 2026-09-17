'use strict'

// Guards test/integration/whisper-models.manifest.json — the set
// scripts/stage-whisper-models.mjs pre-populates into the shared
// packages/asr-ggml/models cache entry, and (via the
// test/integration/*.manifest.json glob) part of that entry's cache key.
//
// Why this guard matters more than it looks: once on-merge-model-cache-asr.yml
// seeds the entry, every PR leg gets an EXACT primary-key hit and actions/cache
// skips its post-job save. Anything the tests need but the seed did not stage
// is therefore re-downloaded on every run and never makes it into the cache. A
// test quietly switching to a different whisper model would restore that
// silent, permanent regression — so the drift is caught here instead.
//
// Kept import-light (reads files only, never requires the native addon) so it
// runs under brittle-bare without a prebuild.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')

const INTEGRATION_DIR = path.join(__dirname, '..', 'integration')
const MANIFEST_PATH = path.join(INTEGRATION_DIR, 'whisper-models.manifest.json')

// mobile-*.test.js and mobile-*.js run on Device Farm, where the model is
// pulled on-device over the session network into the app's own sandbox. They
// never touch packages/asr-ggml/models on a CI runner, so their heavier quant
// sweep (ggml-base-q5_1 / q8_0, ggml-small-q5_1 / q8_0) is deliberately NOT
// staged into the desktop cache entry.
const isDesktopSource = (name) => name.endsWith('.js') && !name.startsWith('mobile-')

const MODEL_LITERAL = /'(ggml-[A-Za-z0-9._-]+\.bin)'/g

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
}

function desktopModelReferences() {
  const refs = new Map()
  for (const name of fs.readdirSync(INTEGRATION_DIR).filter(isDesktopSource)) {
    const source = fs.readFileSync(path.join(INTEGRATION_DIR, name), 'utf8')
    for (const match of source.matchAll(MODEL_LITERAL)) {
      if (!refs.has(match[1])) refs.set(match[1], [])
      refs.get(match[1]).push(name)
    }
  }
  return refs
}

test('whisper manifest carries only cache-key-relevant metadata', (t) => {
  const manifest = readManifest()
  t.alike(
    Object.keys(manifest).sort(),
    ['cacheEpoch', 'models', 'source'],
    'unexpected top-level key — everything here is hashed into the cache key'
  )
  t.is(manifest.source, 'huggingface')
  t.ok(Number.isInteger(manifest.cacheEpoch) && manifest.cacheEpoch >= 1)
})

test('every whisper model is pinned by revision, sha256 and size', (t) => {
  const { models } = readManifest()
  const names = Object.keys(models)
  t.ok(names.length > 0, 'manifest declares at least one model')

  for (const name of names) {
    const entry = models[name]
    t.alike(Object.keys(entry).sort(), ['bytes', 'sha256', 'urls'], `${name}: schema`)
    t.ok(Array.isArray(entry.urls) && entry.urls.length > 0, `${name}: has urls`)
    for (const url of entry.urls) {
      t.ok(url.startsWith('https://huggingface.co/'), `${name}: ${url} is a HuggingFace URL`)
      // A floating resolve/main would let the bytes behind an unchanged cache
      // key change under us. Pin the revision; bumping it re-keys and re-seeds.
      t.ok(
        /\/resolve\/[0-9a-f]{40}\//.test(url),
        `${name}: ${url} must pin a 40-char revision, not a branch`
      )
    }
    t.ok(/^[0-9a-f]{64}$/.test(entry.sha256), `${name}: sha256 is 64 hex chars`)
    t.ok(Number.isInteger(entry.bytes) && entry.bytes > 0, `${name}: bytes is a positive integer`)
  }
})

test('the manifest and the desktop tests agree on the model set', (t) => {
  const { models } = readManifest()
  const refs = desktopModelReferences()

  for (const [name, files] of refs) {
    t.ok(
      Object.prototype.hasOwnProperty.call(models, name),
      `${name} is used by ${files.join(', ')} but is not staged by the seed — ` +
        'it would be re-downloaded on every run and never cached'
    )
  }

  for (const name of Object.keys(models)) {
    t.ok(refs.has(name), `${name} is staged into the cache entry but no desktop test uses it`)
  }
})
