'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  wordErrorRate,
  assertBackend,
  profileEvidence,
  assertEnvironment,
  validateProfileCapture
} = require('../device/hexagon-validation.cjs')

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
    { GGML_HEXAGON_OPSTAGE: '0b11' },
    { GGML_HEXAGON_OPSTAGE: '03' },
    { GGML_HEXAGON_USE_HMX: '0' },
    { GGML_HEXAGON_USE_HMX: '0x1' },
    { GGML_HEXAGON_NHMX: '1e2' },
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

function profileFixture() {
  const identities = [30, 60].map((seconds, i) => ({
    sample: `${seconds}s.raw`,
    seconds,
    sha256: String(i + 1).repeat(64)
  }))
  const evidence = [
    'ggml-hex: HTP0 profile-op IM2COL|test|usec 1 cycles 2',
    'ggml-hex: HTP0 profile-op CONV_2D_DW|test|usec 1 cycles 2',
    'ggml-hex: HTP0 profile-op MUL_MAT|test|hmx-tiled|usec 1 cycles 2'
  ]
  const capture = {
    mode: 'profile',
    evidence: 'pending external validation',
    model: 'ctc.gguf',
    modelSha256: 'a'.repeat(64),
    audioSha256: identities.map((identity) => identity.sha256),
    results: identities.map((identity) => ({
      ...identity,
      backend: 'hexagon',
      text: 'test transcript',
      wer: 0,
      info: { backendId: 5, backendDevice: 'NPU', backendName: 'HTP0' },
      stats: {
        backendId: 5,
        backendDevice: 2,
        encoderMs: 10,
        decoderMs: 0,
        totalWallMs: 11,
        audioDurationMs: identity.seconds * 1000
      }
    }))
  }
  const windows = identities.map((identity) => [
    'HEXAGON_CTC_PROFILE_BEGIN ' + JSON.stringify(identity),
    ...evidence,
    'HEXAGON_CTC_PROFILE_END ' + JSON.stringify(identity)
  ])
  const final = 'HEXAGON_CTC_PROFILE_CAPTURE ' + JSON.stringify(capture)
  return { windows, evidence, capture, final }
}

test('profile verifier requires complete separate 30/60s evidence and matching hashes', () => {
  const { windows, capture, final } = profileFixture()
  const log = [...windows.flat(), final].join('\n')
  const result = validateProfileCapture(log)
  assert.equal(result.evidence, 'verified')
  assert.equal(result.samples.length, 2)
  assert.throws(() => validateProfileCapture(windows.flat().join('\n')), /complete/)
  assert.throws(() => validateProfileCapture(log + '\n' + final), /duplicate/)
  assert.throws(() => validateProfileCapture(log + '\nHEXAGON_CTC_FAILED {}'), /failed/)
  assert.throws(
    () => validateProfileCapture([...windows[1], ...windows[0], final].join('\n')),
    /ordered/
  )
  capture.audioSha256[1] = 'f'.repeat(64)
  assert.throws(
    () =>
      validateProfileCapture(
        [...windows.flat(), 'HEXAGON_CTC_PROFILE_CAPTURE ' + JSON.stringify(capture)].join('\n')
      ),
    /differs/
  )
})

test('profile verifier never borrows evidence from another sample or outside its window', () => {
  const { windows, evidence, final } = profileFixture()
  windows[1].splice(1, evidence.length)
  assert.throws(
    () => validateProfileCapture([...windows.flat(), ...evidence, final].join('\n')),
    /evidence/
  )
  assert.throws(
    () => profileEvidence(evidence.map((line) => JSON.stringify({ text: line }))),
    /evidence/
  )
})

test('profile verifier rejects open/nested windows, wrong mode and contradictory identities', () => {
  const { windows, capture } = profileFixture()
  assert.throws(() => validateProfileCapture(windows[0].slice(0, -1).join('\n')), /complete/)
  assert.throws(() => validateProfileCapture([windows[0][0], windows[1][0]].join('\n')), /nested/)
  assert.throws(
    () => validateProfileCapture([windows[0][0], windows[1][4]].join('\n')),
    /mismatched/
  )
  capture.mode = 'timing'
  assert.throws(
    () =>
      validateProfileCapture(
        [...windows.flat(), 'HEXAGON_CTC_PROFILE_CAPTURE ' + JSON.stringify(capture)].join('\n')
      ),
    /Invalid/
  )
  assert.throws(() => validateProfileCapture('HEXAGON_CTC_RESULT {}'), /timing/)
})
