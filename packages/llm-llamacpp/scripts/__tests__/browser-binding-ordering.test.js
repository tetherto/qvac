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
  const persistentFilesPath = require.resolve('../../browser/persistent-files.js')
  const bindingModule = require.cache[bindingPath]
  const createEngine = require(enginePath)
  const loadConfig = require(loadConfigPath)
  const persistentFiles = require(persistentFilesPath)

  require.cache[enginePath].exports = createModule
  require.cache[loadConfigPath].exports = {
    ...loadConfig,
    mountLoadFiles: () => Promise.resolve({ modelPath: '/model.gguf', projectionPath: '', config })
  }
  require.cache[persistentFilesPath].exports = {
    ...persistentFiles,
    hasOpfs: () => true,
    hydrateFile: () => Promise.resolve(false),
    persistFile: () => Promise.resolve(true),
    persistTree: () => Promise.resolve(true)
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
    require.cache[persistentFilesPath].exports = persistentFiles
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
          'qvac_web_save_cache',
          'qvac_web_destroy'
        ])
      }
    }
  )
})

test('cooperative browser inference resumes after the last model unloads', async () => {
  await withMockedEngine(
    { parallel: '2' },
    (options) => {
      let nextHandle = 1
      const jobs = new Map()
      return {
        FS: { mkdirTree() {} },
        ccall(name, _returnType, _types, args = []) {
          if (name === 'qvac_web_create') return nextHandle++
          if (name === 'qvac_web_submit') jobs.set(`${args[0]}:${args[1]}`, true)
          if (name === 'qvac_web_step') {
            const prefix = `${args[0]}:`
            const key = [...jobs.keys()].find((candidate) => candidate.startsWith(prefix))
            if (key) {
              const id = Number(key.slice(prefix.length))
              jobs.delete(key)
              options.qvacEmit(args[0], id, 'JobEnded', '{}')
            }
          }
          if (name === 'qvac_web_active_slots') {
            const prefix = `${args[0]}:`
            return [...jobs.keys()].filter((candidate) => candidate.startsWith(prefix)).length
          }
          return 0
        }
      }
    },
    async (isolated) => {
      for (let iteration = 0; iteration < 20; iteration++) {
        const handle = isolated.createInstance({}, { config: { parallel: '2' } }, () => {})
        await isolated.activate(handle)
        const admission = await isolated.runJob(handle, [{ type: 'text', input: '[]' }])
        await waitUntil(() => isolated.activeJobs(handle) === 0)
        assert.equal(admission.accepted, true)
        await isolated.destroyInstance(handle)
      }
    }
  )
})

test('legacy validation waits for a suspended cooperative engine call', async () => {
  let releaseStep
  let signalStepStarted
  let stepInFlight = false
  let validationDuringStep = false
  let validationCount = 0

  await withMockedEngine(
    { parallel: '2' },
    (options) => {
      let nextHandle = 1
      const jobs = new Map()
      return {
        FS: { mkdirTree() {} },
        ccall(name, _returnType, _types, args = []) {
          if (name === 'qvac_web_create') return nextHandle++
          if (name === 'qvac_web_submit') jobs.set(args[0], args[1])
          if (name === 'qvac_web_step') {
            stepInFlight = true
            signalStepStarted()
            return new Promise((resolve) => {
              releaseStep = () => {
                const id = jobs.get(args[0])
                jobs.delete(args[0])
                options.qvacEmit(args[0], id, 'JobEnded', '{}')
                stepInFlight = false
                resolve(0)
              }
            })
          }
          if (name === 'qvac_web_validate') {
            validationCount++
            validationDuringStep ||= stepInFlight
          }
          if (name === 'qvac_web_run') options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
          if (name === 'qvac_web_active_slots') return jobs.has(args[0]) ? 1 : 0
          return 0
        }
      }
    },
    async (isolated) => {
      for (let iteration = 0; iteration < 20; iteration++) {
        validationCount = 0
        validationDuringStep = false
        const stepStarted = new Promise((resolve) => {
          signalStepStarted = resolve
        })
        const cooperative = isolated.createInstance({}, { config: { parallel: '2' } }, () => {})
        const legacy = isolated.createInstance({}, { config: { parallel: '2' } }, () => {})
        await isolated.activate(cooperative)
        await isolated.activate(legacy)
        legacy.cooperative = false

        await isolated.runJob(cooperative, [{ type: 'text', input: '[]' }])
        await stepStarted
        const legacyAdmission = isolated.runJob(legacy, [{ type: 'text', input: '[]' }], false)
        await delay()
        assert.equal(validationCount, 0, `iteration ${iteration + 1}`)
        releaseStep()
        await legacyAdmission
        await waitUntil(
          () => isolated.activeJobs(cooperative) === 0 && isolated.activeJobs(legacy) === 0
        )
        assert.equal(validationDuringStep, false, `iteration ${iteration + 1}`)
        assert.equal(validationCount, 1, `iteration ${iteration + 1}`)
        await isolated.destroyInstance(cooperative)
        await isolated.destroyInstance(legacy)
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

test('legacy browser inference accepts media without a text message', async () => {
  const validations = []
  const staged = []
  await withMockedEngine(
    { parallel: '1' },
    (options) => ({
      FS: { mkdirTree() {} },
      ccall(name, _returnType, _types, args = []) {
        if (name === 'qvac_web_create') return 1
        if (name === 'qvac_web_validate') validations.push([JSON.parse(args[1]), args[2]])
        if (name === 'qvac_web_stage_media') staged.push(Uint8Array.from(args[4]))
        if (name === 'qvac_web_run') options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
        return 0
      }
    }),
    async (isolated) => {
      const handle = isolated.createInstance({}, { config: { parallel: '1' } }, () => {})
      await isolated.activate(handle)

      for (let iteration = 0; iteration < 20; iteration++) {
        const admission = await isolated.runJob(handle, [
          { type: 'media', content: new Uint8Array([iteration, 7, 8]) }
        ])
        await waitUntil(() => isolated.activeJobs(handle) === 0)
        assert.equal(admission.accepted, true)
        assert.deepEqual(validations.at(-1), [[], 1], `iteration ${iteration + 1}`)
        assert.deepEqual(staged.at(-1), new Uint8Array([iteration, 7, 8]))
      }

      assert.equal(validations.length, 20)
      assert.equal(staged.length, 20)
      await isolated.destroyInstance(handle)
    }
  )
})

test('browser media staging preserves chunk boundaries and empty inputs', async () => {
  const staged = []
  const size = 2 * 1024 * 1024 + 137
  const input = new Uint8Array(size)
  for (let index = 0; index < input.length; index++) input[index] = index % 251

  await withMockedEngine(
    { parallel: '1' },
    () => ({
      FS: { mkdirTree() {} },
      ccall(name, _returnType, _types, args = []) {
        if (name === 'qvac_web_create') return 1
        if (name === 'qvac_web_stage_media') {
          staged.push({
            prompt: args[2],
            media: args[3],
            bytes: Uint8Array.from(args[4]),
            length: args[5]
          })
        }
        return 0
      }
    }),
    async (isolated) => {
      const handle = isolated.createInstance({}, { config: { parallel: '1' } }, () => {})
      await isolated.activate(handle)

      for (let iteration = 0; iteration < 20; iteration++) {
        const start = staged.length
        await isolated.runJob(handle, [
          { type: 'media', content: input },
          { type: 'media', content: new Uint8Array(0) },
          { type: 'text', input: '[]' }
        ])
        await waitUntil(() => isolated.activeJobs(handle) === 0)

        const calls = staged.slice(start)
        assert.deepEqual(
          calls.map(({ prompt, media, length }) => [prompt, media, length]),
          [
            [0, 0, 1024 * 1024],
            [0, 0, 1024 * 1024],
            [0, 0, 137],
            [0, 1, 0]
          ],
          `iteration ${iteration + 1}`
        )
        const reconstructed = new Uint8Array(size)
        let offset = 0
        for (const { bytes } of calls.slice(0, 3)) {
          reconstructed.set(bytes, offset)
          offset += bytes.length
        }
        const mismatch = reconstructed.findIndex((byte, index) => byte !== input[index])
        assert.equal(mismatch, -1, `iteration ${iteration + 1}`)
        assert.equal(calls[3].bytes.length, 0, `empty input, iteration ${iteration + 1}`)
      }

      assert.equal(staged.length, 80)
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
