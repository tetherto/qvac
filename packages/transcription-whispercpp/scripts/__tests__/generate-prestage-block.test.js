'use strict'

/**
 * Unit tests for the whisper model pre-stage block generator.
 * Pure build logic — no adb, no network.
 *
 * Run locally:
 *   node --test packages/transcription-whispercpp/scripts/__tests__/generate-prestage-block.test.js
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const { MODELS, buildScript } = require('../generate-prestage-block')

test('MODELS covers the full mobile set: functional + perf-sweep quants', () => {
  const names = MODELS.map((m) => m.name)
  // tiny + VAD (functional) plus the base/small q5_1/q8_0 perf-sweep quants.
  assert.deepEqual(names, [
    'ggml-tiny.bin',
    'ggml-silero-v5.1.2.bin',
    'ggml-base-q5_1.bin',
    'ggml-base-q8_0.bin',
    'ggml-small-q5_1.bin',
    'ggml-small-q8_0.bin'
  ])
  for (const m of MODELS) {
    assert.match(m.url, /^https:\/\/huggingface\.co\//)
    assert.ok(m.url.endsWith(m.name))
  }
})

test('buildScript stages every model to the prestage dir via adb push', () => {
  const script = buildScript([
    { name: 'a.bin', url: 'https://example.com/a.bin' },
    { name: 'b.bin', url: 'https://example.com/b.bin' }
  ])
  assert.match(script, /PRESTAGE_DIR=\/data\/local\/tmp\/prestaged-models/)
  assert.match(script, /stage "a\.bin" "https:\/\/example\.com\/a\.bin"/)
  assert.match(script, /stage "b\.bin" "https:\/\/example\.com\/b\.bin"/)
  assert.match(script, /adb push/)
  assert.match(script, /\[prestage\] done/)
})

test('buildScript stages the real whisper model set', () => {
  const script = buildScript(MODELS)
  assert.match(script, /stage "ggml-tiny\.bin"/)
  assert.match(script, /stage "ggml-silero-v5\.1\.2\.bin"/)
  assert.match(script, /stage "ggml-base-q5_1\.bin"/)
  assert.match(script, /stage "ggml-base-q8_0\.bin"/)
  assert.match(script, /stage "ggml-small-q5_1\.bin"/)
  assert.match(script, /stage "ggml-small-q8_0\.bin"/)
})
