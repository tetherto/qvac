'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { assertMossBackend } = require('../../test/utils/mossBackend')

const filename = path.resolve(__dirname, '../../test/integration/moss-sfx.test.js')

function loadSuite(env, files = ['moss-sfx-v2-q8_0.gguf']) {
  const cases = []
  const modules = {
    'bare-path': path,
    'bare-fs': {
      existsSync: () => true,
      readdirSync: () => files,
      statSync: () => ({ isFile: () => true })
    },
    'bare-process': { env },
    brittle: (name, options, run) => cases.push({ name, options, run }),
    '@qvac/tts-ggml': class {
      load() {}
      unload() {}
      run() {
        return {
          stats: { backendDevice: 1, backendId: 3, gpuUnsupported: 0 },
          onUpdate: () => ({ await: () => {} })
        }
      }
    },
    '../utils/mossBackend': { assertMossBackend }
  }
  vm.compileFunction(fs.readFileSync(filename, 'utf8'), ['require'], { filename })(
    (name) => modules[name]
  )
  return cases
}

const strict = {
  QVAC_TEST_MOSS_FULL_GPU: 'true',
  TTS_CPP_GPU_BACKEND: 'cuda',
  QVAC_TEST_MOSS_SFX_MODEL_DIR: '/models'
}

test('SFX strict mode rejects missing fixtures, CPU and unspecified backends', () => {
  for (const env of [
    { ...strict, QVAC_TEST_MOSS_SFX_MODEL_DIR: '' },
    { ...strict, NO_GPU: 'true' },
    { ...strict, TTS_CPP_GPU_BACKEND: '' },
    { ...strict, TTS_CPP_GPU_BACKEND: 'cpu' }
  ]) {
    assert.throws(() => loadSuite(env), /full GPU validation requires/)
  }
  assert.throws(() => loadSuite(strict, []), /with a GGUF/)
  assert.equal(
    loadSuite(strict).some((c) => c.options.skip),
    false
  )
  assert.equal(
    loadSuite({}).every((c) => c.options.skip),
    true
  )
})

test('SFX asserts the requested backend for both generated GPU clips', async () => {
  const failures = []
  await loadSuite(strict)[1].run({
    ok: () => {},
    is: (actual, expected, message) => {
      if (actual !== expected) failures.push(message)
    }
  })
  assert(failures.includes('short clip: TTS_CPP_GPU_BACKEND=cuda'))
  assert(failures.includes('longer clip: TTS_CPP_GPU_BACKEND=cuda'))
})
