'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const source = fs.readFileSync(
  path.resolve(__dirname, '../../test/integration/moss-transcribe.test.js'),
  'utf8'
)

// Exercise the actual integration entry point without loading a native addon or
// large model. A failed brittle assertion is recorded even if the test returns.
async function runIntegration({ backend, model = true, audio = true, info } = {}) {
  const failures = []
  const passes = []
  const calls = []
  let completion
  const t = {
    fail: (message) => failures.push(message),
    pass: (message) => passes.push(message),
    ok: (value, message) => {
      if (!value) failures.push(message)
    },
    is: (actual, expected, message) => {
      if (actual !== expected) failures.push(message)
    }
  }
  class Model {
    constructor(options) {
      calls.push(options.config.mossTranscribeConfig)
    }
    load() {
      return Promise.resolve()
    }
    getBackendInfo() {
      return info || { backendId: 2, backendName: 'CUDA0' }
    }
    run() {
      calls.push('run')
      return {
        onUpdate(callback) {
          callback({ text: 'speech', speaker: 'S1', speakerId: 0, start: 0, end: 1 })
          return { await: () => Promise.resolve() }
        }
      }
    }
    unload() {
      return Promise.resolve()
    }
  }
  const modules = {
    'bare-fs': {
      existsSync: (filename) => (filename === '/model.gguf' ? model : audio),
      readFileSync: () => Buffer.alloc(64)
    },
    'bare-path': path,
    'bare-process': {
      env: {
        QVAC_TEST_MOSS_TRANSCRIBE_GGUF: model === null ? '' : '/model.gguf',
        QVAC_TEST_MOSS_TRANSCRIBE_BACKEND: backend
      }
    },
    brittle: (_name, _options, callback) => {
      completion = callback(t)
    },
    './parakeet-helpers.js': {
      ASRGgml: Model,
      binding: {},
      setupJsLogger: () => ({ releaseLogger() {} }),
      getTestPaths: () => ({ samplesDir: '/samples' })
    }
  }
  vm.runInNewContext(source, {
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `unexpected import: ${name}`)
      return modules[name]
    }
  })
  await completion
  return { failures, passes, calls }
}

test('explicit MOSS backend validation fails on every missing prerequisite', async () => {
  for (const backend of ['cuda', 'vulkan', 'CUDA1', 'Vulkan0', 'cpu']) {
    for (const fixture of [{ model: null }, { model: false }, { audio: false }]) {
      const result = await runIntegration({ backend, ...fixture })
      assert.equal(result.failures.length, 1, `${backend}: ${JSON.stringify(fixture)}`)
      assert.match(result.failures[0], /explicit backend validation requires all fixtures/)
      assert.equal(result.passes.length, 0)
      assert.equal(result.calls.length, 0)
    }
  }
})

test('default MOSS integration retains optional fixture skips', async () => {
  for (const backend of [undefined, '', 'auto']) {
    for (const fixture of [{ model: null }, { model: false }, { audio: false }]) {
      const result = await runIntegration({ backend, ...fixture })
      assert.equal(result.failures.length, 0)
      assert.equal(result.passes.length, 1)
      assert.equal(result.calls.length, 0)
    }
  }
})

test('MOSS integration checks the requested backend and runs both prompts', async () => {
  for (const [backend, backendId, backendName] of [
    ['cpu', 0, 'CPU'],
    ['cuda', 2, 'CUDA0'],
    ['vulkan', 3, 'Vulkan0'],
    ['CUDA1', 2, 'CUDA1'],
    ['Vulkan0', 3, 'Vulkan0']
  ]) {
    const result = await runIntegration({ backend, info: { backendId, backendName } })
    assert.deepEqual(result.failures, [])
    assert.equal(result.calls[0].backend, backend)
    assert.deepEqual(result.calls.slice(1), ['run', 'run'])
  }
})

test('MOSS integration rejects CPU fallback and a different exact device', async () => {
  for (const [backend, backendId, backendName] of [
    ['cuda', 0, 'CPU'],
    ['vulkan', 0, 'CPU'],
    ['CUDA1', 2, 'CUDA0'],
    ['Vulkan1', 3, 'Vulkan0'],
    ['cuda0', 2, 'CUDA0']
  ]) {
    const result = await runIntegration({ backend, info: { backendId, backendName } })
    assert.equal(result.failures.length, 1)
    assert.match(result.failures[0], /requested (backend|device) is active/)
  }
})
