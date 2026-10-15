'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

// Exercise the shipped Bare helper against real temporary files using Node's
// equivalent filesystem/path APIs, without importing a native addon.
const helperPath = path.resolve(__dirname, '../../test/utils/mossGpuValidation.js')
const helperModule = { exports: {} }
vm.compileFunction(fs.readFileSync(helperPath, 'utf8'), ['require', 'module'], {
  filename: helperPath
})((specifier) => {
  if (specifier === 'bare-fs') return fs
  if (specifier === 'bare-path') return path
  throw new Error(`Unexpected helper dependency: ${specifier}`)
}, helperModule)
const { createMossGpuValidation } = helperModule.exports

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moss-gpu-validation-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const env = { QVAC_TEST_MOSS_FULL_GPU: 'true', TTS_CPP_GPU_BACKEND: 'CUDA' }
  const assets = {
    QVAC_TEST_MOSS_MODEL_DIR: [
      'moss-tts-delay-q4_k.gguf',
      'moss-ttsd-q4_k.gguf',
      'moss-codec-decoder-f16.gguf',
      'moss-codec-encoder-f16.gguf'
    ],
    QVAC_TEST_MOSS_SPEECH_MODEL_DIR: ['moss-speech-q8_0.gguf', 'moss-speech-codec-f16.gguf']
  }
  const files = []
  for (const [variable, names] of Object.entries(assets)) {
    env[variable] = path.join(root, variable)
    fs.mkdirSync(env[variable])
    for (const name of names) {
      const file = path.join(env[variable], name)
      fs.writeFileSync(file, 'placeholder; never loaded')
      files.push(file)
    }
  }
  const referenceAudio = path.join(root, 'reference.wav')
  fs.writeFileSync(referenceAudio, 'placeholder; never decoded')
  return { env, referenceAudio, files }
}

test('MOSS full GPU validation leaves optional developer runs unchanged', () => {
  assert.equal(createMossGpuValidation({}, '/missing.wav').enabled, false)
  assert.equal(createMossGpuValidation({ NO_GPU: 'true' }, '/missing.wav', false).enabled, false)
})

test('MOSS full GPU validation requires a backend and rejects NO_GPU conflicts', (t) => {
  const { env, referenceAudio } = fixture(t)
  for (const backend of ['', 'cpu', 'typo', ' cuda ']) {
    assert.throws(
      () => createMossGpuValidation({ ...env, TTS_CPP_GPU_BACKEND: backend }, referenceAudio),
      /set TTS_CPP_GPU_BACKEND/
    )
  }
  assert.throws(
    () => createMossGpuValidation({ ...env, NO_GPU: 'true' }, referenceAudio),
    /NO_GPU=true conflicts/
  )
  assert.throws(() => createMossGpuValidation(env, referenceAudio, false), /desktop GPU cases/)
  for (const backend of ['cuda', 'CuDa', 'VULKAN', 'vUlKaN', 'metal', 'opencl']) {
    assert.equal(
      createMossGpuValidation({ ...env, TTS_CPP_GPU_BACKEND: backend }, referenceAudio).enabled,
      true
    )
  }
})

test('MOSS full GPU validation rejects unset, absent and non-directory model paths', (t) => {
  const { env, referenceAudio } = fixture(t)
  for (const variable of ['QVAC_TEST_MOSS_MODEL_DIR', 'QVAC_TEST_MOSS_SPEECH_MODEL_DIR']) {
    for (const directory of [undefined, '', `${env[variable]}-missing`, referenceAudio]) {
      assert.throws(
        () => createMossGpuValidation({ ...env, [variable]: directory }, referenceAudio),
        new RegExp(`${variable} must name an existing model directory`)
      )
    }
  }
})

test('MOSS full GPU validation requires every backbone and codec, including encoder and TTSD', (t) => {
  const { env, referenceAudio, files } = fixture(t)
  const labels = [
    'TTS backbone',
    'TTSD backbone',
    'codec decoder',
    'codec encoder',
    'Speech backbone',
    'Speech codec'
  ]
  for (const [index, file] of files.entries()) {
    fs.unlinkSync(file)
    assert.throws(
      () => createMossGpuValidation(env, referenceAudio),
      new RegExp(`missing ${labels[index]}`)
    )
    // A directory with the right filename must not satisfy the asset check.
    fs.mkdirSync(file)
    assert.throws(
      () => createMossGpuValidation(env, referenceAudio),
      new RegExp(`missing ${labels[index]}`)
    )
    fs.rmdirSync(file)
    fs.writeFileSync(file, 'placeholder; never loaded')
  }
})

test('MOSS full GPU validation rejects missing or non-file reference audio', (t) => {
  const { env, referenceAudio } = fixture(t)
  fs.unlinkSync(referenceAudio)
  assert.throws(() => createMossGpuValidation(env, referenceAudio), /reference WAV is missing/)
  fs.mkdirSync(referenceAudio)
  assert.throws(() => createMossGpuValidation(env, referenceAudio), /reference WAV is missing/)
})

test('MOSS full GPU validation fails when a required case never completes', (t) => {
  const { env, referenceAudio } = fixture(t)
  const validation = createMossGpuValidation(env, referenceAudio)
  const assertions = { ok: assert.ok }
  const cases = ['GPU streaming', 'GPU cloning', 'GPU TTSD dialogue']
  assert.throws(() => validation.assertComplete(assertions, cases), /GPU streaming/)
  validation.completed('GPU streaming')
  validation.completed('GPU cloning')
  validation.completed('GPU cloning')
  assert.throws(() => validation.assertComplete(assertions, cases), /GPU TTSD dialogue/)
  validation.completed('GPU TTSD dialogue')
  validation.assertComplete(assertions, cases)
})
