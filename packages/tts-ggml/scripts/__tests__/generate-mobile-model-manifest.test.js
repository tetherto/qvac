'use strict'

/**
 * Unit tests for the pure manifest builder in
 * scripts/generate-mobile-model-manifest.js.
 *
 * Guards that the mobile model manifest carries a `lavasr` section (the fp16
 * enhancer + denoiser) targeting the on-device `lavasr/` subdir the resolver
 * scans, alongside the unchanged q4/q8 engine sections. A fake presign keeps
 * the test hermetic (no `aws` shell-out).
 *
 * Run locally:
 *   node --test scripts/__tests__/generate-mobile-model-manifest.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  buildManifest,
  Q4_MODELS,
  Q8_MODELS,
  FUNCTIONAL_MODELS,
  LAVASR_MODELS,
  COSYVOICE_MODELS,
  QUALITY_MODELS
} = require('../generate-mobile-model-manifest')

// Deterministic stand-in for `aws s3 presign`: echoes the key so tests can
// assert which S3 object each signed entry points at.
function fakePresign(entry) {
  return { name: entry.name, targetName: entry.targetName, url: `signed:${entry.s3Key}` }
}

test('the manifest exposes benchmark and functional model sections', () => {
  const { manifest } = buildManifest(fakePresign)
  assert.ok(Array.isArray(manifest.q4) && manifest.q4.length > 0, 'q4 section is populated')
  assert.ok(Array.isArray(manifest.q8) && manifest.q8.length > 0, 'q8 section is populated')
  assert.equal(manifest.functional.length, 4, 'functional section has every Supertonic 3 tier')
  assert.equal(manifest.lavasr.length, 2, 'lavasr section has the enhancer + denoiser')
  assert.equal(manifest.cosyvoice.length, 6, 'cosyvoice section has the 6 model-dir files')
  assert.equal(manifest.quality.length, 1, 'quality section has the mobile Whisper model')
})

test('the functional section stages every Supertonic 3 quant under its resolver filename', () => {
  const { manifest } = buildManifest(fakePresign)
  assert.deepEqual(
    manifest.functional.map((entry) => entry.targetName),
    [
      'supertonic3-f16.gguf',
      'supertonic3-f32.gguf',
      'supertonic3-q8_0.gguf',
      'supertonic3-q4_0.gguf'
    ]
  )
  assert.match(manifest.functional[0].url, /supertonic\/2026-06-10\/supertonic3-f16\.gguf$/)
  assert.match(manifest.functional[2].url, /supertonic\/2026-06-15\/supertonic3-q8_0\.gguf$/)
})

test('the cosyvoice section targets the on-device cosyvoice3/ subdir the resolver scans', () => {
  const { manifest } = buildManifest(fakePresign)
  assert.deepEqual(
    manifest.cosyvoice.map((e) => e.targetName),
    [
      'cosyvoice3/cosyvoice3-llm-q8_0.gguf',
      'cosyvoice3/cosyvoice3-flow-f32.gguf',
      'cosyvoice3/cosyvoice3-hift-f32.gguf',
      'cosyvoice3/voice.gguf',
      'cosyvoice3/vocab.json',
      'cosyvoice3/merges.txt'
    ]
  )
})

test('the cosyvoice entries are signed from the published cosy_voice registry paths', () => {
  const { manifest } = buildManifest(fakePresign)
  for (const entry of manifest.cosyvoice) {
    assert.match(entry.url, /ggml\/cosy_voice\/2026-07-23\//)
  }
  // The registry publishes the voice as `voice-en.gguf` but it is staged as
  // `voice.gguf` (the name the engine's model_dir resolves).
  const voice = manifest.cosyvoice.find((e) => e.targetName === 'cosyvoice3/voice.gguf')
  assert.match(voice.url, /voice-en\.gguf$/)
})

test('the quality model uses a pinned public URL and the on-device whisper directory', () => {
  const { manifest } = buildManifest(fakePresign)
  assert.deepEqual(manifest.quality, QUALITY_MODELS)
  assert.equal(manifest.quality[0].targetName, 'whisper/ggml-tiny.bin')
  assert.match(manifest.quality[0].url, /resolve\/[0-9a-f]{40}\/ggml-tiny\.bin$/)
})

test('the lavasr section targets the on-device lavasr/ subdir names the resolver scans', () => {
  const { manifest } = buildManifest(fakePresign)
  assert.deepEqual(
    manifest.lavasr.map((e) => e.targetName),
    ['lavasr/lavasr-enhancer.gguf', 'lavasr/lavasr-denoiser.gguf']
  )
})

// The registry dates are pinned so a change to the prestage manifest paths fails
// here as a reminder to keep them in lockstep with REGISTRY_DATE_LAVASR /
// REGISTRY_DATE_LAVASR_DENOISER in test/utils/downloadModel.js (the resolver that
// fetches the same GGUFs). That module is Bare-only, so this Node test can't
// require it to compare the constants directly.
test('the lavasr entries are signed from the published fp16 registry paths', () => {
  const { manifest } = buildManifest(fakePresign)
  const [enhancer, denoiser] = manifest.lavasr
  assert.match(enhancer.url, /ggml\/lavasr\/2026-06-26\/lavasr-enhancer-f16\.gguf$/)
  assert.match(denoiser.url, /ggml\/lavasr\/2026-07-03\/lavasr-denoiser-f16\.gguf$/)
})

test('LAVASR_MODELS keeps the fp16 registry key / on-disk target split', () => {
  const [enhancer, denoiser] = LAVASR_MODELS
  assert.match(enhancer.s3Key, /lavasr-enhancer-f16\.gguf$/)
  assert.equal(enhancer.targetName, 'lavasr/lavasr-enhancer.gguf')
  assert.match(denoiser.s3Key, /lavasr-denoiser-f16\.gguf$/)
  assert.equal(denoiser.targetName, 'lavasr/lavasr-denoiser.gguf')
})

test('signedCount counts each distinct GGUF once across all sections', () => {
  const { signedCount } = buildManifest(fakePresign)
  const distinct = new Set(
    [
      ...Q4_MODELS,
      ...Q8_MODELS,
      ...FUNCTIONAL_MODELS,
      ...LAVASR_MODELS,
      ...COSYVOICE_MODELS
    ].map((entry) => entry.name)
  )
  assert.equal(signedCount, distinct.size)
})
