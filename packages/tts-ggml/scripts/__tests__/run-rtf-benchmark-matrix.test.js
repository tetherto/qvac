'use strict'

/**
 * Unit tests for the pure label/env helpers in
 * scripts/run-rtf-benchmark-matrix.js.
 *
 * Guards the byte-stability of the LavaSR axes on the *producing* side: the
 * matrix run label (and therefore the artifact filename segment it feeds) must
 * only grow a `-lavasr` (enhancer) and/or `-denoise` (denoiser) tag when that
 * axis is enabled, so none/none runs stay byte-for-byte identical to pre-axis
 * runs and the two tokens stay distinct when both axes are on.
 *
 * Pure-function code paths only — requiring the module does not spawn any
 * benchmark (main() is guarded by require.main === module).
 *
 * Run locally:
 *   node --test scripts/__tests__/run-rtf-benchmark-matrix.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { buildLabel, buildEnv } = require('../run-rtf-benchmark-matrix')

test('buildLabel omits the enhancer tag for the default (enhancer=none)', () => {
  assert.equal(buildLabel({ engine: 'supertonic', useGPU: true }, 0), '1-supertonic-gpu')
  assert.equal(
    buildLabel({ engine: 'chatterbox', enhancer: 'none', useGPU: false }, 1),
    '2-chatterbox-cpu'
  )
})

test('buildLabel inserts the enhancer tag only when the enhancer is enabled', () => {
  assert.equal(
    buildLabel({ engine: 'supertonic', enhancer: 'lavasr', useGPU: true }, 2),
    '3-supertonic-lavasr-gpu'
  )
  assert.equal(
    buildLabel({ engine: 'chatterbox', enhancer: 'lavasr', useGPU: false }, 0),
    '1-chatterbox-lavasr-cpu'
  )
})

test('buildLabel lowercases the enhancer tag so the segment is stable', () => {
  assert.equal(
    buildLabel({ engine: 'supertonic', enhancer: 'LavaSR', useGPU: false }, 0),
    '1-supertonic-lavasr-cpu'
  )
})

test('buildLabel omits the denoiser tag for the default (denoiser=none)', () => {
  assert.equal(
    buildLabel({ engine: 'supertonic', denoiser: 'none', useGPU: true }, 0),
    '1-supertonic-gpu'
  )
})

test('buildLabel inserts the fixed denoise tag only when the denoiser is enabled', () => {
  assert.equal(
    buildLabel({ engine: 'supertonic', denoiser: 'lavasr', useGPU: true }, 2),
    '3-supertonic-denoise-gpu'
  )
  assert.equal(
    buildLabel({ engine: 'chatterbox', denoiser: 'LavaSR', useGPU: false }, 0),
    '1-chatterbox-denoise-cpu'
  )
})

test('buildLabel keeps enhancer and denoiser tokens distinct and ordered when both are on', () => {
  assert.equal(
    buildLabel({ engine: 'supertonic', enhancer: 'lavasr', denoiser: 'lavasr', useGPU: true }, 0),
    '1-supertonic-lavasr-denoise-gpu'
  )
})

test('buildLabel omits the enhancer quant tier tag for the fp16 default', () => {
  assert.equal(
    buildLabel({ engine: 'supertonic', enhancer: 'lavasr', enhancerVariant: 'f16', useGPU: false }, 0),
    '1-supertonic-lavasr-cpu'
  )
})

test('buildLabel inserts the quant tier tag after -lavasr for a non-default tier', () => {
  assert.equal(
    buildLabel({ engine: 'supertonic', enhancer: 'lavasr', enhancerVariant: 'q8_0', useGPU: false }, 0),
    '1-supertonic-lavasr-q8_0-cpu'
  )
  assert.equal(
    buildLabel({ engine: 'supertonic', enhancer: 'lavasr', enhancerVariant: 'f32', useGPU: true }, 2),
    '3-supertonic-lavasr-f32-gpu'
  )
})

test('buildLabel lowercases the quant tier so it matches the benchmark enhancerVariantTag', () => {
  assert.equal(
    buildLabel({ engine: 'supertonic', enhancer: 'lavasr', enhancerVariant: 'Q8_0', useGPU: false }, 0),
    '1-supertonic-lavasr-q8_0-cpu'
  )
  assert.equal(
    buildLabel({ engine: 'supertonic', enhancer: 'lavasr', enhancerVariant: 'F32', useGPU: true }, 2),
    '3-supertonic-lavasr-f32-gpu'
  )
})

test('buildLabel ignores the quant tier when the enhancer is off (tier inert)', () => {
  assert.equal(
    buildLabel({ engine: 'supertonic', enhancer: 'none', enhancerVariant: 'q8_0', useGPU: false }, 0),
    '1-supertonic-cpu'
  )
})

test('buildLabel orders enhancer, tier and denoise tokens when all are on', () => {
  assert.equal(
    buildLabel(
      { engine: 'supertonic', enhancer: 'lavasr', enhancerVariant: 'q8_0', denoiser: 'lavasr', useGPU: true },
      0
    ),
    '1-supertonic-lavasr-q8_0-denoise-gpu'
  )
})

test('buildLabel honours an explicit label verbatim', () => {
  assert.equal(buildLabel({ label: 'custom-label', enhancer: 'lavasr' }, 4), 'custom-label')
})

test('buildLabel falls back to the tts engine name when none is given', () => {
  assert.equal(buildLabel({ useGPU: false }, 0), '1-tts-cpu')
})

test('buildEnv forwards the enhancer quant tier, defaulting to fp16', () => {
  const savedTier = process.env.QVAC_TTS_GGML_BENCHMARK_ENHANCER_VARIANT
  delete process.env.QVAC_TTS_GGML_BENCHMARK_ENHANCER_VARIANT
  try {
    const withTier = buildEnv({ engine: 'supertonic', enhancer: 'lavasr', enhancerVariant: 'q8_0' }, 0)
    assert.equal(withTier.QVAC_TTS_GGML_BENCHMARK_ENHANCER_VARIANT, 'q8_0')
    assert.equal(withTier.QVAC_TTS_GGML_BENCHMARK_ENHANCER, 'lavasr')

    const withoutTier = buildEnv({ engine: 'supertonic', enhancer: 'lavasr' }, 0)
    assert.equal(withoutTier.QVAC_TTS_GGML_BENCHMARK_ENHANCER_VARIANT, 'f16')
  } finally {
    if (savedTier === undefined) delete process.env.QVAC_TTS_GGML_BENCHMARK_ENHANCER_VARIANT
    else process.env.QVAC_TTS_GGML_BENCHMARK_ENHANCER_VARIANT = savedTier
  }
})

test('buildEnv forwards optional CER and WER settings', () => {
  const env = buildEnv(
    {
      engine: 'chatterbox',
      quality: true,
      whisperModel: 'ggml-small.bin',
      werUpperBound: 0.4,
      cerUpperBound: 0.2
    },
    0
  )
  assert.equal(env.QVAC_TTS_GGML_BENCHMARK_QUALITY, 'true')
  assert.equal(env.QVAC_TTS_GGML_BENCHMARK_WHISPER_MODEL, 'ggml-small.bin')
  assert.equal(env.QVAC_TTS_GGML_BENCHMARK_WER_UPPER_BOUND, '0.4')
  assert.equal(env.QVAC_TTS_GGML_BENCHMARK_CER_UPPER_BOUND, '0.2')
})
