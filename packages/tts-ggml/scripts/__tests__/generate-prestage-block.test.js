'use strict'

/**
 * Unit tests for the pure selection / script helpers in
 * scripts/generate-prestage-block.js.
 *
 * Guards the mobile LavaSR prestage wiring: an engine-only row must keep its
 * exact (pre-LavaSR) prestage list, an enhancer/denoiser row must additionally
 * push only the requested LavaSR GGUF into the `lavasr/` subdir, and the emitted
 * host script must create that subdir on both the host and the device.
 *
 * Pure-function code paths only — requiring the module does not read the
 * manifest or write stdout (main() is guarded by require.main === module).
 *
 * Run locally:
 *   node --test scripts/__tests__/generate-prestage-block.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  resolveVariant,
  requestedLavasrKinds,
  lavasrEntries,
  qualityEntries,
  selectEntries,
  buildTsv,
  buildPrestageScript,
  buildPrestageBlock,
  readOptionsFromEnv,
  PRESTAGE_DIR
} = require('../generate-prestage-block')

const MANIFEST = {
  q4: [
    { name: 'supertonic-q4_0.gguf', targetName: 'supertonic.gguf', url: 'https://s3/s-q4.gguf' }
  ],
  q8: [
    { name: 'supertonic-q8_0.gguf', targetName: 'supertonic.gguf', url: 'https://s3/s-q8.gguf' }
  ],
  lavasr: [
    {
      name: 'lavasr-enhancer-f16.gguf',
      targetName: 'lavasr/lavasr-enhancer.gguf',
      url: 'https://s3/enh.gguf'
    },
    {
      name: 'lavasr-denoiser-f16.gguf',
      targetName: 'lavasr/lavasr-denoiser.gguf',
      url: 'https://s3/den.gguf'
    }
  ],
  quality: [
    {
      name: 'ggml-tiny.bin',
      targetName: 'whisper/ggml-tiny.bin',
      url: 'https://hf/ggml-tiny.bin'
    }
  ]
}

function decodeBlockTsv(block) {
  const match = block.match(/echo "([A-Za-z0-9+/=]+)" \| base64 -d/)
  assert.ok(match, 'prestage block embeds a base64 TSV')
  return Buffer.from(match[1], 'base64').toString('utf8')
}

test('resolveVariant lowercases and validates, defaulting to q4', () => {
  assert.equal(resolveVariant('q4'), 'q4')
  assert.equal(resolveVariant('Q8'), 'q8')
  assert.equal(resolveVariant(undefined), 'q4')
  assert.equal(resolveVariant(''), 'q4')
  assert.throws(() => resolveVariant('f16'), /Unsupported variant/)
})

test('requestedLavasrKinds maps only the axes that are on', () => {
  assert.deepEqual(requestedLavasrKinds({ enhancer: 'none', denoiser: 'none' }), [])
  assert.deepEqual(requestedLavasrKinds({ enhancer: 'lavasr', denoiser: 'none' }), ['enhancer'])
  assert.deepEqual(requestedLavasrKinds({ enhancer: 'none', denoiser: 'lavasr' }), ['denoiser'])
  assert.deepEqual(requestedLavasrKinds({ enhancer: 'lavasr', denoiser: 'lavasr' }), [
    'enhancer',
    'denoiser'
  ])
})

test('lavasrEntries returns only the manifest entries for the requested axes', () => {
  assert.deepEqual(lavasrEntries(MANIFEST, { enhancer: 'none', denoiser: 'none' }), [])
  assert.deepEqual(
    lavasrEntries(MANIFEST, { enhancer: 'lavasr', denoiser: 'none' }).map((e) => e.targetName),
    ['lavasr/lavasr-enhancer.gguf']
  )
  assert.deepEqual(
    lavasrEntries(MANIFEST, { enhancer: 'none', denoiser: 'lavasr' }).map((e) => e.targetName),
    ['lavasr/lavasr-denoiser.gguf']
  )
})

test('lavasrEntries is empty when the manifest has no lavasr section', () => {
  assert.deepEqual(lavasrEntries({ q4: [] }, { enhancer: 'lavasr', denoiser: 'lavasr' }), [])
})

test('qualityEntries selects the Whisper model only when quality is enabled', () => {
  assert.deepEqual(qualityEntries(MANIFEST, false), [])
  assert.deepEqual(qualityEntries(MANIFEST, true), MANIFEST.quality)
})

test('selectEntries keeps an engine-only row byte-identical to pre-LavaSR', () => {
  const engineOnly = selectEntries(MANIFEST, { variant: 'q4', enhancer: 'none', denoiser: 'none' })
  assert.deepEqual(engineOnly, MANIFEST.q4)
})

test('selectEntries appends only the requested LavaSR GGUF after the engine models', () => {
  const withEnhancer = selectEntries(MANIFEST, {
    variant: 'q4',
    enhancer: 'lavasr',
    denoiser: 'none'
  })
  assert.deepEqual(
    withEnhancer.map((e) => e.targetName),
    ['supertonic.gguf', 'lavasr/lavasr-enhancer.gguf']
  )

  const withBoth = selectEntries(MANIFEST, {
    variant: 'q4',
    enhancer: 'lavasr',
    denoiser: 'lavasr'
  })
  assert.deepEqual(
    withBoth.map((e) => e.targetName),
    ['supertonic.gguf', 'lavasr/lavasr-enhancer.gguf', 'lavasr/lavasr-denoiser.gguf']
  )
})

test('selectEntries appends the mobile Whisper model when quality is enabled', () => {
  const entries = selectEntries(MANIFEST, {
    variant: 'q4',
    enhancer: 'none',
    denoiser: 'none',
    quality: true
  })
  assert.deepEqual(
    entries.map((entry) => entry.targetName),
    ['supertonic.gguf', 'whisper/ggml-tiny.bin']
  )
})

test('buildTsv emits one tab-separated targetName/url line per entry', () => {
  assert.equal(
    buildTsv([
      { targetName: 'a.gguf', url: 'u1' },
      { targetName: 'lavasr/b.gguf', url: 'u2' }
    ]),
    'a.gguf\tu1\nlavasr/b.gguf\tu2\n'
  )
})

test('buildPrestageScript makes the per-target subdir on host and device', () => {
  const script = buildPrestageScript('QkFTRTY0', 'q4')
  assert.ok(script.includes(`PRESTAGE_DIR=${PRESTAGE_DIR}`), 'pins the on-device prestage dir')
  assert.ok(
    script.includes('mkdir -p "/tmp/prestage/$(dirname "$TARGET")"'),
    'creates the host-side subdir'
  )
  assert.ok(
    script.includes('adb shell mkdir -p "$PRESTAGE_DIR/$(dirname "$TARGET")"'),
    'creates the device-side subdir so nested lavasr/ targets push cleanly'
  )
})

test('buildPrestageBlock for an engine-only row stages no lavasr files', () => {
  const block = buildPrestageBlock(MANIFEST, { variant: 'q4', enhancer: 'none', denoiser: 'none' })
  const tsv = decodeBlockTsv(block)
  assert.equal(tsv, 'supertonic.gguf\thttps://s3/s-q4.gguf\n')
  assert.ok(!tsv.includes('lavasr/'), 'no lavasr GGUF staged for an engine-only row')
})

test('buildPrestageBlock for a lavasr row stages the engine model and the enhancer', () => {
  const block = buildPrestageBlock(MANIFEST, {
    variant: 'q4',
    enhancer: 'lavasr',
    denoiser: 'none'
  })
  const tsv = decodeBlockTsv(block)
  assert.ok(tsv.includes('supertonic.gguf\thttps://s3/s-q4.gguf'), 'engine model still staged')
  assert.ok(
    tsv.includes('lavasr/lavasr-enhancer.gguf\thttps://s3/enh.gguf'),
    'enhancer staged into the lavasr/ subdir'
  )
  assert.ok(!tsv.includes('lavasr-denoiser'), 'denoiser not staged when only enhancer is on')
})

test('readOptionsFromEnv defaults the LavaSR axes to none and quality to enabled', () => {
  assert.deepEqual(readOptionsFromEnv({ TTS_GGML_MOBILE_BENCHMARK_VARIANT: 'q8' }), {
    variant: 'q8',
    enhancer: 'none',
    denoiser: 'none',
    quality: true
  })
  assert.deepEqual(
    readOptionsFromEnv({
      TTS_GGML_MOBILE_BENCHMARK_VARIANT: 'q4',
      TTS_GGML_MOBILE_BENCHMARK_ENHANCER: 'lavasr',
      TTS_GGML_MOBILE_BENCHMARK_DENOISER: 'lavasr'
    }),
    { variant: 'q4', enhancer: 'lavasr', denoiser: 'lavasr', quality: true }
  )
  assert.equal(readOptionsFromEnv({ TTS_GGML_MOBILE_BENCHMARK_QUALITY: 'false' }).quality, false)
})
