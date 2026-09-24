'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  wordErrorRate,
  assertBackend,
  profileEvidence,
  assertEnvironment
} = require('../../test/mobile/hexagon-validation.cjs')

test('WER handles substitution, insertion, deletion and English normalization', () => {
  assert.equal(wordErrorRate('One, TWO three.', 'one two three'), 0)
  assert.equal(wordErrorRate('one two three', 'one four three'), 1 / 3)
  assert.equal(wordErrorRate('one two three', 'one three'), 1 / 3)
  assert.equal(wordErrorRate('one two three', 'one two and three'), 1 / 3)
  assert.throws(() => wordErrorRate('', 'anything'), /reference/)
})

test('device validation refuses compute bypass and diagnostics in timing mode', () => {
  assertEnvironment({}, 'timing')
  assertEnvironment({ GGML_HEXAGON_PROFILE: '1', GGML_HEXAGON_OPSTAGE: '3' }, 'profile')
  for (const env of [
    { GGML_HEXAGON_OPSTAGE: '1' },
    { GGML_HEXAGON_USE_HMX: '0' },
    { GGML_HEXAGON_NHMX: '0' },
    { GGML_HEXAGON_PROFILE: '1' },
    { GGML_HEXAGON_VERBOSE: '1' },
    { GGML_HEXAGON_ETM: '1' }
  ]) {
    assert.throws(() => assertEnvironment(env, 'timing'))
  }
  assert.throws(() => assertEnvironment({}, 'profile'))
})

test('Hexagon evidence rejects backend selection logs and zero-cycle profiles', () => {
  assert.throws(() => profileEvidence(['backend=HTP0']), /evidence/)
  const lines = [
    'ggml-hex: HTP0 profile-op IM2COL|test|usec 1 cycles 2',
    'ggml-hex: HTP0 profile-op CONV_2D_DW|test|usec 1 cycles 2',
    'ggml-hex: HTP0 profile-op MUL_MAT|test|hmx-tiled|usec 1 cycles 2'
  ]
  assert.deepEqual(profileEvidence(lines), { im2col: 1, conv2dDw: 1, hmxMatmul: 1 })
  assert.throws(
    () => profileEvidence(lines.map((line) => line.replace('cycles 2', 'cycles 0'))),
    /evidence/
  )
  assert.throws(
    () => profileEvidence(lines.map((line) => line.replace('HTP0', 'HTP1'))),
    /evidence/
  )
})

test('Hexagon validation requires both actual NPU metadata and native inference stats', () => {
  const info = { backendId: 5, backendDevice: 'NPU', backendName: 'HTP0' }
  const stats = {
    backendId: 5,
    backendDevice: 2,
    encoderMs: 10,
    decoderMs: 0,
    totalWallMs: 11,
    audioDurationMs: 30000
  }
  assertBackend('hexagon', info, stats)
  assert.throws(() => assertBackend('hexagon', info, { ...stats, backendId: 0 }), /family/)
  assert.throws(() => assertBackend('hexagon', { ...info, backendDevice: 'CPU' }, stats), /class/)
  assert.throws(() => assertBackend('hexagon', info, { ...stats, encoderMs: 0 }), /inference/)
})
