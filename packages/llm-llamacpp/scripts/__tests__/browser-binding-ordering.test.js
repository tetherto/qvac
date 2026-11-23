'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

function delay() {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await delay()
  }
  throw new Error('Timed out waiting for browser binding state')
}

async function withMockedEngine(config, createModule, testBinding) {
  const bindingPath = require.resolve('../../binding.browser.js')
  const enginePath = require.resolve('../../browser/create-engine.js')
  const loadConfigPath = require.resolve('../../browser/load-config.js')
  const bindingModule = require.cache[bindingPath]
  const createEngine = require(enginePath)
  const loadConfig = require(loadConfigPath)

  require.cache[enginePath].exports = createModule
  require.cache[loadConfigPath].exports = {
    ...loadConfig,
    mountLoadFiles: () => Promise.resolve({ modelPath: '/model.gguf', projectionPath: '', config })
  }
  delete require.cache[bindingPath]
  const isolated = require(bindingPath)

  try {
    await testBinding(isolated)
  } finally {
    if (bindingModule) require.cache[bindingPath] = bindingModule
    else delete require.cache[bindingPath]
    require.cache[enginePath].exports = createEngine
    require.cache[loadConfigPath].exports = loadConfig
  }
}

test('browser binding orders legacy inference, cache and unload operations', async () => {
  const calls = []
  await withMockedEngine(
    { parallel: '1' },
    () => ({
      FS: { mkdirTree() {} },
      ccall(name) {
        calls.push(name)
        if (name === 'qvac_web_create') return 1
        return 0
      }
    }),
    async (isolated) => {
      for (let iteration = 0; iteration < 20; iteration++) {
        calls.length = 0
        const runFirst = isolated.createInstance({}, {}, () => {})
        await isolated.activate(runFirst)
        calls.length = 0
        await isolated.runJob(runFirst, [{ type: 'text', input: '[]' }])
        await isolated.saveCache(runFirst, '/cache/after-run.bin')
        assert.deepEqual(calls, ['qvac_web_validate', 'qvac_web_run', 'qvac_web_save_cache'])

        calls.length = 0
        const saveFirst = isolated.createInstance({}, {}, () => {})
        await isolated.activate(saveFirst)
        calls.length = 0
        const save = isolated.saveCache(saveFirst, '/cache/before-run.bin')
        await isolated.runJob(saveFirst, [{ type: 'text', input: '[]' }])
        await save
        await delay()
        assert.deepEqual(calls, ['qvac_web_save_cache', 'qvac_web_validate', 'qvac_web_run'])

        calls.length = 0
        const unloadAfterSave = isolated.createInstance({}, {}, () => {})
        await isolated.activate(unloadAfterSave)
        calls.length = 0
        await isolated.runJob(unloadAfterSave, [{ type: 'text', input: '[]' }])
        await waitUntil(() => isolated.activeJobs(unloadAfterSave) === 0)
        const saving = isolated.saveCache(unloadAfterSave, '/cache/before-unload.bin')
        const unloading = isolated.destroyInstance(unloadAfterSave)
        await saving
        await unloading
        assert.deepEqual(calls, [
          'qvac_web_validate',
          'qvac_web_run',
          'qvac_web_save_cache',
          'qvac_web_destroy'
        ])
      }
    }
  )
})

test('legacy browser inference owns admitted media bytes', async () => {
  const staged = []
  await withMockedEngine(
    { parallel: '1' },
    () => ({
      FS: { mkdirTree() {} },
      ccall(name, _returnType, _types, args = []) {
        if (name === 'qvac_web_create') return 1
        if (name === 'qvac_web_stage_media') staged.push(Uint8Array.from(args[4]))
        return 0
      }
    }),
    async (isolated) => {
      const handle = isolated.createInstance({}, { config: { parallel: '1' } }, () => {})
      await isolated.activate(handle)

      for (let iteration = 0; iteration < 20; iteration++) {
        const input = new Uint8Array([iteration, 2, 3, 4])
        const admission = await isolated.runJob(handle, [
          { type: 'media', content: input },
          { type: 'text', input: '[]' }
        ])
        input.fill(255)
        await waitUntil(() => isolated.activeJobs(handle) === 0)
        assert.equal(admission.accepted, true)
        assert.deepEqual(staged.at(-1), new Uint8Array([iteration, 2, 3, 4]))
      }

      assert.equal(staged.length, 20)
      await isolated.destroyInstance(handle)
    }
  )
})

test('cooperative browser inference cancels and cleans up when an output listener throws', async () => {
  const stopSignals = []
  let emit
  let submittedJobId
  let emitted = false

  await withMockedEngine(
    { parallel: '2' },
    (options) => {
      emit = options.qvacEmit
      return {
        FS: { mkdirTree() {} },
        ccall(name, _returnType, _types, args = []) {
          if (name === 'qvac_web_create') return 1
          if (name === 'qvac_web_submit') {
            submittedJobId = args[1]
            emitted = false
          }
          if (name === 'qvac_web_step' && !emitted) {
            emitted = true
            stopSignals.push(emit(1, submittedJobId, 'Output', 'token'))
            emit(
              1,
              submittedJobId,
              'Error',
              JSON.stringify({ error: 'cancelled', code: 'CANCELLED' })
            )
          }
          return 0
        }
      }
    },
    async (isolated) => {
      const events = []
      const handle = isolated.createInstance(
        {},
        { config: { parallel: '2' } },
        (_owner, event, _result, error) => {
          events.push({ event, code: error?.code, message: error?.message })
          if (event === 'Output') throw new Error('listener failed')
        }
      )
      await isolated.activate(handle)

      for (let iteration = 0; iteration < 20; iteration++) {
        const admission = await isolated.runJob(handle, [{ type: 'text', input: '[]' }])
        await waitUntil(() => isolated.activeJobs(handle) === 0)
        assert.equal(admission.accepted, true)
        assert.deepEqual(events.splice(0), [
          { event: 'Output', code: undefined, message: undefined },
          { event: 'Error', code: undefined, message: 'listener failed' }
        ])
        assert.equal(stopSignals.at(-1), 1)
      }

      assert.equal(stopSignals.length, 20)
      await isolated.destroyInstance(handle)
    }
  )
})
