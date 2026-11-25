'use strict'

const test = require('brittle')
const { LlamaInterface } = require('../../addon.js')
const binding = require('../../binding.browser.js')
const LlmLlamacpp = require('../../index.js')
const {
  ensureMessageCacheDirectories,
  ensureParentDirectory
} = require('../../browser/cache-files.js')
const { MOUNTED_FILES_KEY } = require('../../browser/model-files.js')
const { prepareRunData } = require('../../browser/run-data.js')

function instance(output = () => {}) {
  return binding.createInstance({}, {}, output)
}

function delay() {
  return new Promise((resolve) => setTimeout(resolve, 10))
}

function isolatedBinding(createEngine) {
  binding._setEngineFactoryForTest(createEngine)
  return binding
}

function fakeEngine(onRun) {
  return (options) => ({
    FS: {},
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return 1
      if (name === 'qvac_web_run') return onRun(options.qvacEmit, args)
      if (name === 'qvac_web_calc_tokens') return 3
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  })
}

function cooperativeEngine(options) {
  let nextHandle = 1
  const handles = new Map()
  return {
    FS: { mkdirTree() {} },
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') {
        const handle = nextHandle++
        handles.set(handle, { jobs: new Map() })
        return handle
      }
      if (name === 'qvac_web_submit') {
        handles.get(args[0]).jobs.set(args[1], {
          batch: args[2] !== 0,
          input: JSON.parse(args[3]),
          cancelled: false
        })
        return 0
      }
      if (name === 'qvac_web_step') {
        const [id, job] = handles.get(args[0]).jobs.entries().next().value ?? []
        if (id === undefined) return 0
        if (job.cancelled) {
          options.qvacEmit(
            args[0],
            id,
            'Error',
            JSON.stringify({ error: 'Job cancelled', code: 'CANCELLED' })
          )
        } else if (job.batch) {
          for (const item of job.input) {
            const stop = options.qvacEmit(
              args[0],
              id,
              'BatchOutput',
              JSON.stringify({ id: item.id, text: item.id })
            )
            if (stop) job.cancelled = true
          }
          if (job.cancelled) {
            options.qvacEmit(
              args[0],
              id,
              'Error',
              JSON.stringify({ error: 'Job cancelled', code: 'CANCELLED' })
            )
          } else {
            options.qvacEmit(
              args[0],
              id,
              'BatchResult',
              JSON.stringify(job.input.map((item) => ({ id: item.id, text: item.id })))
            )
            options.qvacEmit(args[0], id, 'JobEnded', '{}')
          }
        } else {
          options.qvacEmit(args[0], id, 'Output', 'token')
          options.qvacEmit(args[0], id, 'JobEnded', '{}')
        }
        handles.get(args[0]).jobs.delete(id)
        return handles.get(args[0]).jobs.size
      }
      if (name === 'qvac_web_cancel_job') {
        const job = handles.get(args[0]).jobs.get(args[1])
        if (job) job.cancelled = true
        return 0
      }
      if (name === 'qvac_web_active_slots') return handles.get(args[0]).jobs.size
      if (name === 'qvac_web_cache_request') return 0
      if (name === 'qvac_web_cache_poll') return 0
      if (name === 'qvac_web_destroy') {
        handles.delete(args[0])
        return 0
      }
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  }
}

async function publicModel(isolated) {
  const model = new LlmLlamacpp({
    files: { model: ['/tmp/test.gguf'] },
    config: { device: 'gpu', ctx_size: '256', parallel: 1 },
    logger: { info() {}, warn() {}, error() {}, debug() {} }
  })
  model.addon = new LlamaInterface(
    isolated,
    { path: '', projectionPath: '', config: { parallel: 1 } },
    model._addonOutputCallback.bind(model)
  )
  await model.addon.activate()
  return model
}

test('browser binding rolls back admission when serialization throws', (t) => {
  const handle = instance()
  const circular = {}
  circular.self = circular

  let error = null
  try {
    binding.runJob(handle, [{ type: 'text', input: '[]', generationParams: circular }])
  } catch (cause) {
    error = cause
  }
  t.ok(/circular/i.test(error?.message))
  t.is(binding.activeJobs(handle), 0)
})

test('browser binding rejects non-finite generation values before admission', (t) => {
  const handle = instance()
  const values = [NaN, Infinity, -Infinity]

  for (let iteration = 0; iteration < 20; iteration++) {
    for (const reasoningBudget of values) {
      let error = null
      try {
        binding.runJob(handle, [
          { type: 'text', input: '[]', generationParams: { reasoning_budget: reasoningBudget } }
        ])
      } catch (cause) {
        error = cause
      }
      t.ok(/reasoning_budget must be a finite number/.test(error?.message))
      t.is(binding.activeJobs(handle), 0)
    }
  }
})

test('browser binding validates inputs before admission', async (t) => {
  let result = '{}'
  let runs = 0
  const isolated = isolatedBinding(() => ({
    FS: {},
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return 1
      if (name === 'qvac_web_validate') {
        const [{ type, generationParams }] = JSON.parse(args[1])
        if (type !== 'text') {
          result = JSON.stringify({
            error: `Unknown input type: ${type}`,
            code: 'INVALID_ARGUMENT'
          })
          return -1
        }
        if (generationParams?.temp === 'invalid') {
          result = JSON.stringify({
            error: 'Expected property temp to be of type number',
            code: 'INVALID_ARGUMENT'
          })
          return -1
        }
      }
      if (name === 'qvac_web_run') runs++
      if (name === 'qvac_web_result') return result
      return 0
    }
  }))
  const events = []
  const handle = isolated.createInstance({}, {}, (...event) => events.push(event))
  await isolated.activate(handle)

  for (let iteration = 0; iteration < 20; iteration++) {
    await t.exception.all(
      () => isolated.runJob(handle, [{ type: 'unknown' }]),
      /Unknown input type: unknown/
    )
    await t.exception.all(
      () =>
        isolated.runJob(handle, [
          { type: 'text', input: '[]', generationParams: { temp: 'invalid' } }
        ]),
      /Expected property temp to be of type number/
    )
    t.is(isolated.activeJobs(handle), 0, `active jobs, iteration ${iteration + 1}`)
    t.is(events.length, 0, `no events, iteration ${iteration + 1}`)
  }
  t.is(runs, 0)
  await isolated.destroyInstance(handle)
})

test('browser admission reserves worker capacity before validation', async (t) => {
  let runs = 0
  const isolated = isolatedBinding((options) => ({
    FS: {},
    async ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return 1
      if (name === 'qvac_web_run') {
        runs++
        await delay()
        options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
      }
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  }))

  for (let iteration = 0; iteration < 20; iteration++) {
    const first = await publicModel(isolated)
    const second = await publicModel(isolated)
    const running = first.run([{ role: 'user', content: 'first' }])
    const rejected = second.run([{ role: 'user', content: 'second' }])
    const response = await running
    await t.exception(rejected, /already set or being processed/, `iteration ${iteration + 1}`)
    await response.await()
    t.is(runs, iteration + 1, `only the admitted request ran, iteration ${iteration + 1}`)
    await first.unload()
    await second.unload()
  }
})

test('rejectWhenBusy false queues legacy browser requests', async (t) => {
  let runs = 0
  const isolated = isolatedBinding((options) => ({
    FS: {},
    async ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return 1
      if (name === 'qvac_web_run') {
        runs++
        await delay()
        options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
      }
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  }))

  const model = await publicModel(isolated)
  for (let iteration = 0; iteration < 20; iteration++) {
    const first = await model.run([{ role: 'user', content: 'first' }])
    const second = await model.run([{ role: 'user', content: 'second' }], { rejectWhenBusy: false })
    await first.await()
    await second.await()
    t.is(runs, (iteration + 1) * 2, `iteration ${iteration + 1}`)
  }
  await model.unload()
})

test('failed browser validation releases its admission reservation', async (t) => {
  let result = '{}'
  const isolated = isolatedBinding((options) => ({
    FS: {},
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return 1
      if (name === 'qvac_web_validate' && JSON.parse(args[1])[0].type !== 'text') {
        result = JSON.stringify({ error: 'invalid input', code: 'INVALID_ARGUMENT' })
        return -1
      }
      if (name === 'qvac_web_run') options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
      if (name === 'qvac_web_result') return result
      return 0
    }
  }))

  for (let iteration = 0; iteration < 20; iteration++) {
    const handle = isolated.createInstance({}, {}, () => {})
    await isolated.activate(handle)
    await t.exception.all(
      () => isolated.runJob(handle, [{ type: 'invalid' }]),
      /invalid input/,
      `iteration ${iteration + 1}`
    )
    t.is(isolated.activeJobs(handle), 0, `reservation released, iteration ${iteration + 1}`)
    await isolated.runJob(handle, [{ type: 'text', input: '[]' }])
    await delay()
    t.is(isolated.activeJobs(handle), 0, `valid follow-up settled, iteration ${iteration + 1}`)
    await isolated.destroyInstance(handle)
  }
})

test('browser binding rejects an unactivated handle before admission', async (t) => {
  const isolated = isolatedBinding(
    fakeEngine((emit, [native, id]) => {
      emit(native, id, 'JobEnded', '{}')
      return 0
    })
  )

  for (let iteration = 0; iteration < 20; iteration++) {
    const handle = isolated.createInstance({}, {}, () => {})
    await t.exception.all(
      () => isolated.runJob(handle, [{ type: 'text', input: '[]' }]),
      /Model is not loaded/
    )
    t.is(isolated.activeJobs(handle), 0, `active jobs, iteration ${iteration + 1}`)
    await isolated.activate(handle)
    const admission = await isolated.runJob(handle, [{ type: 'text', input: '[]' }])
    t.is(admission.id, 1, `first id, iteration ${iteration + 1}`)
    await delay()
    await isolated.destroyInstance(handle)
  }
})

test('browser cache paths create their private filesystem parents', (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const directories = []
    const module = { FS: { mkdirTree: (path) => directories.push(path) } }
    const messages = [
      { cacheKey: '/.qvac/cache/chat/model/config.bin' },
      { baseCacheKey: 'cache/base.bin' },
      { cacheKey: 'root.bin' },
      null
    ]
    const serialized = JSON.stringify(messages)
    messages[0].cacheKey = '/mutated/after-admission.bin'

    ensureMessageCacheDirectories(module, serialized)
    ensureParentDirectory(module, '/cache/manual.bin')
    ensureParentDirectory(module, '')

    t.alike(directories, ['/.qvac/cache/chat/model', '/cache'], `iteration ${iteration + 1}`)
  }
})

test('browser binding cleans cancelled jobs when an output listener throws', async (t) => {
  const terminal = []
  const isolated = isolatedBinding(
    fakeEngine((emit, [handle, id]) => {
      emit(handle, id, 'Output', 'token')
      emit(handle, id, 'JobEnded', '{}')
      return 0
    })
  )
  const handle = isolated.createInstance({}, {}, (_owner, event, _data, error) => {
    if (event === 'Output') throw new Error('listener failed')
    terminal.push({ event, error })
  })
  await isolated.activate(handle)

  for (let iteration = 0; iteration < 20; iteration++) {
    await isolated.runJob(handle, [{ type: 'text', input: '[]' }])
    await delay()
    t.is(isolated.activeJobs(handle), 0, `iteration ${iteration + 1}`)
    t.is(terminal[iteration].event, 'Error')
    t.is(terminal[iteration].error.message, 'listener failed')
  }
  await isolated.destroyInstance(handle)
})

test('browser binding exposes cancellation while a job has emitted no output', async (t) => {
  const terminals = []
  const isolated = isolatedBinding((options) => ({
    FS: {},
    ccall: async (name, _returnType, _types, args) => {
      if (name === 'qvac_web_create') return 1
      if (name === 'qvac_web_run') {
        while (!options.qvacCancelled(args[0], args[1])) await delay()
        options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
      }
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  }))

  for (let iteration = 0; iteration < 20; iteration++) {
    const current = isolated.createInstance({}, {}, (_owner, event) => terminals.push(event))
    await isolated.activate(current)
    const { id } = await isolated.runJob(current, [{ type: 'text', input: '[]', prefill: true }])
    await delay()
    await isolated.cancelJob(current, id)
    while (isolated.activeJobs(current) !== 0) await delay()
    t.is(terminals[iteration], 'JobEnded', `iteration ${iteration + 1}`)
    await isolated.destroyInstance(current)
  }
})

test('browser binding publishes job completion after releasing the engine queue', async (t) => {
  const tokenCounts = []
  let isolated
  let handle
  isolated = isolatedBinding(
    fakeEngine((emit, [native, id]) => {
      emit(native, id, 'JobEnded', '{}')
      return 0
    })
  )
  handle = isolated.createInstance({}, {}, (_owner, event) => {
    if (event === 'JobEnded') tokenCounts.push(isolated.calcTokens(handle, { text: 'hello' }))
  })
  await isolated.activate(handle)

  for (let iteration = 0; iteration < 20; iteration++) {
    await isolated.runJob(handle, [{ type: 'text', input: '[]' }])
    await delay()
    t.is(await tokenCounts[iteration], 3, `iteration ${iteration + 1}`)
  }
  await isolated.destroyInstance(handle)
})

test('browser run data stages media bytes without JSON expansion', (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const first = new Uint8Array([0, 1, 127, 128, 254, 255])
    const second = new Uint8Array([9, 8, 7])
    const prepared = prepareRunData([
      { type: 'media', content: first },
      { type: 'media', content: second },
      { type: 'text', input: '[{"role":"user","type":"media","content":""}]' }
    ])

    t.alike(JSON.parse(prepared.json), [
      { type: 'text', input: '[{"role":"user","type":"media","content":""}]' }
    ])
    t.alike(prepared.media, [[first, second]], `iteration ${iteration + 1}`)
    t.ok(prepared.json.length < first.byteLength + second.byteLength + 100)
  }
})

test('browser run data owns bytes from Uint8Array subclasses', (t) => {
  class SharedSliceArray extends Uint8Array {
    slice() {
      return this.subarray()
    }
  }

  for (let iteration = 0; iteration < 20; iteration++) {
    const source = new SharedSliceArray([iteration, 2, 3])
    const prepared = prepareRunData([{ type: 'media', content: source }])
    source[0] = 255

    t.alike(prepared.media[0][0], new Uint8Array([iteration, 2, 3]), `iteration ${iteration + 1}`)
  }
})

test('browser run data preserves media grouping for a batch', (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const first = new Uint8Array([1, 2])
    const second = new Uint8Array([3, 4])
    const prepared = prepareRunData([
      {
        id: 'a',
        messages: [
          { type: 'media', content: first },
          { type: 'text', input: '[]' }
        ]
      },
      {
        id: 'b',
        messages: [
          { type: 'media', content: second },
          { type: 'text', input: '[]' }
        ]
      }
    ])

    t.alike(JSON.parse(prepared.json), [
      { id: 'a', messages: [{ type: 'text', input: '[]' }] },
      { id: 'b', messages: [{ type: 'text', input: '[]' }] }
    ])
    t.alike(prepared.media, [[first], [second]], `iteration ${iteration + 1}`)
    t.alike(prepared.ids, ['a', 'b'])
  }
})

test('browser run data preserves empty media groups before media prompts', (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const image = new Uint8Array([1, 2, 3])
    const prepared = prepareRunData([
      { id: 'text', messages: [{ type: 'text', input: '[]' }] },
      {
        id: 'image',
        messages: [
          { type: 'media', content: image },
          { type: 'text', input: '[]' }
        ]
      }
    ])
    t.alike(prepared.media, [[], [image]], `iteration ${iteration + 1}`)
  }
})

test('browser run data enforces native batch id rules', (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const first = prepareRunData([
      { messages: [{ type: 'text', input: '[]' }] },
      { id: `provided-${iteration}`, messages: [{ type: 'text', input: '[]' }] }
    ])
    const second = prepareRunData([{ messages: [{ type: 'text', input: '[]' }] }])
    t.ok(/^batch-\d+$/.test(first.ids[0]))
    t.is(first.ids[1], `provided-${iteration}`)
    t.unlike(first.ids[0], second.ids[0])

    const messages = []
    for (const run of [
      () =>
        prepareRunData([
          { id: 'same', messages: [] },
          { id: 'same', messages: [] }
        ]),
      () => prepareRunData([{ id: '', messages: [] }]),
      () => prepareRunData([{ id: `batch-${iteration}`, messages: [] }])
    ]) {
      try {
        run()
      } catch (error) {
        messages.push(error.message)
      }
    }
    t.alike(messages, [
      'Duplicate batch prompt id: same',
      'Batch prompt id must be a non-empty string when provided',
      `Batch prompt id prefix 'batch-' is reserved for auto-minted ids: batch-${iteration}`
    ])
  }
})

test('cooperative browser batches preserve prompt ids and terminal order', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const events = []
    const isolated = isolatedBinding(cooperativeEngine)
    const handle = isolated.createInstance({}, { config: { parallel: 2 } }, (...event) => {
      events.push(event)
    })
    await isolated.activate(handle)
    const admission = await isolated.runJob(handle, [
      { id: 'first', messages: [{ type: 'text', input: '[]' }] },
      { id: 'second', messages: [{ type: 'text', input: '[]' }] }
    ])
    while (isolated.activeJobs(handle) !== 0) await delay()

    t.alike(admission.ids, ['first', 'second'], `ids, iteration ${iteration + 1}`)
    t.alike(
      events.map((event) => event[1]),
      ['BatchOutput', 'BatchOutput', 'BatchResult', 'JobEnded'],
      `event order, iteration ${iteration + 1}`
    )
    t.alike(
      events.slice(0, 2).map((event) => event[2].id),
      ['first', 'second'],
      `stream routing, iteration ${iteration + 1}`
    )
    await isolated.destroyInstance(handle)
  }
})

test('cooperative listener failure cancels only its job and releases it', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const terminals = []
    const isolated = isolatedBinding(cooperativeEngine)
    const handle = isolated.createInstance(
      {},
      { config: { parallel: 2 } },
      (_owner, event, _data, error) => {
        if (event === 'BatchOutput') throw new Error('listener failed')
        terminals.push({ event, error })
      }
    )
    await isolated.activate(handle)
    await isolated.runJob(handle, [
      { id: 'first', messages: [{ type: 'text', input: '[]' }] },
      { id: 'second', messages: [{ type: 'text', input: '[]' }] }
    ])
    while (isolated.activeJobs(handle) !== 0) await delay()

    t.is(terminals.length, 1, `one terminal, iteration ${iteration + 1}`)
    t.is(terminals[0].event, 'Error', `terminal type, iteration ${iteration + 1}`)
    t.is(terminals[0].error.message, 'listener failed', `error, iteration ${iteration + 1}`)
    t.is(isolated.activeSlots(handle), 0, `slots released, iteration ${iteration + 1}`)
    await isolated.destroyInstance(handle)
  }
})

test('a failed cooperative step does not end a job still waiting to submit', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const live = new Map()
    let failNextStep = false
    let stepFailing = null
    const isolated = isolatedBinding((options) => ({
      FS: { mkdirTree() {} },
      ccall(name, _returnType, _types, args, ccallOptions) {
        if (name === 'qvac_web_create') return 1
        if (name === 'qvac_web_result') return JSON.stringify({ error: 'step failed' })
        if (name === 'qvac_web_submit') live.set(args[1], 0)
        if (name === 'qvac_web_active_slots') return live.size
        if (name !== 'qvac_web_step') return 0
        if (failNextStep) {
          failNextStep = false
          stepFailing()
          return new Promise((resolve) =>
            setTimeout(() => {
              for (const id of [...live.keys()]) {
                live.delete(id)
                options.qvacEmit(args[0], id, 'Error', JSON.stringify({ error: 'step failed' }))
              }
              resolve(-1)
            }, 20)
          )
        }
        for (const [id, steps] of [...live]) {
          if (steps < 3) {
            live.set(id, steps + 1)
          } else {
            live.delete(id)
            options.qvacEmit(args[0], id, 'JobEnded', '{}')
          }
        }
        return ccallOptions?.async ? Promise.resolve(0) : 0
      }
    }))
    const terminals = new Map()
    const admitted = new Set()
    const handle = isolated.createInstance({}, { config: { parallel: 2 } }, (...event) => {
      const [, type, , , id] = event
      if (type !== 'JobEnded' && type !== 'Error') return
      t.ok(admitted.has(id), `terminal after admission, iteration ${iteration + 1}`)
      terminals.set(id, [...(terminals.get(id) ?? []), type])
    })
    await isolated.activate(handle)
    failNextStep = true
    const failing = new Promise((resolve) => {
      stepFailing = resolve
    })
    const first = await isolated.runJob(handle, [{ type: 'text', input: '[]' }])
    admitted.add(first.id)
    await failing
    const second = await isolated.runJob(handle, [{ type: 'text', input: '[]' }])
    admitted.add(second.id)
    while (isolated.activeJobs(handle) !== 0) await delay()

    t.alike(terminals.get(first.id), ['Error'], `failed job ends, iteration ${iteration + 1}`)
    t.alike(terminals.get(second.id), ['JobEnded'], `queued job runs, iteration ${iteration + 1}`)
    t.is(live.size, 0, `no native job left, iteration ${iteration + 1}`)
    await isolated.destroyInstance(handle)
  }
})

test('cooperative cache operation does not wait for an unrelated live job', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const isolated = isolatedBinding(cooperativeEngine)
    const handle = isolated.createInstance({}, { config: { parallel: 2 } }, () => {})
    await isolated.activate(handle)
    await isolated.runJob(handle, [{ type: 'text', input: '[]' }])
    await isolated.saveCache(handle, `/cache/unrelated-${iteration}.bin`)
    t.is(isolated.activeJobs(handle), 1, `job still live, iteration ${iteration + 1}`)
    while (isolated.activeJobs(handle) !== 0) await delay()
    await isolated.destroyInstance(handle)
  }
})

test('browser unload cancels a legacy job waiting for admission', async (t) => {
  const runs = []
  const isolated = isolatedBinding((options) => ({
    FS: {},
    async ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') return 1
      if (name === 'qvac_web_run') {
        const input = JSON.parse(args[2])[0].input
        runs.push(input)
        while (!options.qvacCancelled(args[0], args[1])) await delay()
        options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
      }
      if (name === 'qvac_web_result') return '{}'
      return 0
    }
  }))

  for (let iteration = 0; iteration < 20; iteration++) {
    const handle = isolated.createInstance({}, {}, () => {})
    await isolated.activate(handle)
    await isolated.runJob(handle, [{ type: 'text', input: 'run1' }])
    await delay()
    const second = isolated.runJob(handle, [{ type: 'text', input: 'run2' }], false)
    const destroyed = isolated.destroyInstance(handle)
    await t.exception.all(() => second, /Job cancelled/)
    await destroyed
    t.alike(runs.slice(iteration, iteration + 1), ['run1'], `iteration ${iteration + 1}`)
    t.is(isolated.activeJobs(handle), 0, `active jobs, iteration ${iteration + 1}`)
  }
})

test('browser active job counts remain scoped to each model', async (t) => {
  const isolated = isolatedBinding(
    fakeEngine(async (emit, [native, id]) => {
      await delay()
      emit(native, id, 'JobEnded', '{}')
      return 0
    })
  )
  const first = isolated.createInstance({}, {}, () => {})
  const second = isolated.createInstance({}, {}, () => {})
  await isolated.activate(first)
  await isolated.activate(second)

  for (let iteration = 0; iteration < 20; iteration++) {
    const admission = await isolated.runJob(first, [{ type: 'text', input: '[]' }])
    t.is(isolated.activeJobs(first), 1, `first model, iteration ${iteration + 1}`)
    t.is(isolated.activeJobs(second), 0, `second model, iteration ${iteration + 1}`)
    await isolated.cancelJob(first, admission.id)
    await delay()
    t.is(isolated.activeJobs(first), 0, `settled iteration ${iteration + 1}`)
  }
  await isolated.destroyInstance(first)
  await isolated.destroyInstance(second)
})

test('invalid browser load config does not load an engine', async (t) => {
  let loads = 0
  const isolated = isolatedBinding(() => {
    loads++
    return {}
  })

  for (let iteration = 0; iteration < 20; iteration++) {
    for (const [params, message] of [
      [{ config: { mmap: 'true' } }, /mmap is not supported/],
      [{ config: { 'lora-scaled': '/m/lora.gguf:0.5' } }, /lora-scaled is not supported/],
      [
        { config: { spec_draft_model: undefined, 'spec-draft-model': '/m/d.gguf' } },
        /must not both be set/
      ],
      [{ path: 'model.gguf' }, /absolute OPFS path, got: model\.gguf/],
      [{ projectionPath: 'mmproj.gguf' }, /absolute OPFS path, got: mmproj\.gguf/],
      [{ config: { lora: 'adapter.gguf' } }, /absolute OPFS path, got: adapter\.gguf/],
      [{ config: { spec_draft_model: 'draft.gguf' } }, /absolute OPFS path, got: draft\.gguf/],
      [
        { config: { spec_draft_model: '/m/draft-00002-of-00002.gguf' } },
        /must be loaded from its first shard/
      ]
    ]) {
      const handle = isolated.createInstance(
        {},
        { path: '/m/model.gguf', config: {}, ...params },
        () => {}
      )
      await t.exception.all(() => isolated.activate(handle), message)
      await isolated.destroyInstance(handle)
    }
    t.is(loads, 0, `iteration ${iteration + 1}`)
  }
})

test('browser engine creation receives the mounted load asset paths', async (t) => {
  globalThis[MOUNTED_FILES_KEY] = new Map([
    ['/m/model.gguf', { name: 'model.gguf' }],
    ['/m/mmproj.gguf', { name: 'mmproj.gguf' }],
    ['/m/a,b.gguf', { name: 'a,b.gguf' }],
    ['/m/draft.gguf', { name: 'draft.gguf' }]
  ])
  t.teardown(() => delete globalThis[MOUNTED_FILES_KEY])
  const created = []
  const isolated = isolatedBinding(() => ({
    FS: {
      filesystems: { WORKERFS: { stream_ops: { read() {} } } },
      mkdirTree() {},
      mount() {},
      unmount() {},
      rmdir() {}
    },
    ccall(name, _returnType, _types, args) {
      if (name === 'qvac_web_create') {
        created.push(args)
        return 1
      }
      return 0
    }
  }))

  for (let iteration = 0; iteration < 20; iteration++) {
    const handle = isolated.createInstance(
      {},
      {
        path: '/m/model.gguf',
        projectionPath: '/m/mmproj.gguf',
        config: { lora: '/m/a,b.gguf', spec_draft_model: '/m/draft.gguf', parallel: '2' }
      },
      () => {}
    )
    await isolated.activate(handle)
    const [modelPath, projectionPath, configJson] = created.pop()
    const config = JSON.parse(configJson)
    t.ok(/^\/qvac-files\/\d+\/model\.gguf$/.test(modelPath), modelPath)
    t.ok(/^\/qvac-files\/\d+\/mmproj\.gguf$/.test(projectionPath), projectionPath)
    t.ok(/^"\/qvac-files\/\d+\/a,b\.gguf"$/.test(config.lora), config.lora)
    t.ok(/^\/qvac-files\/\d+\/draft\.gguf$/.test(config.spec_draft_model), config.spec_draft_model)
    t.is(config.parallel, '2')
    await isolated.destroyInstance(handle)
  }
})

test('healthy unload retains failed filesystem cleanup for retry', async (t) => {
  let loads = 0
  let failUnmount = false
  const isolated = isolatedBinding(() => {
    loads++
    return {
      FS: {
        unmount: () => {
          if (failUnmount) {
            failUnmount = false
            throw new Error('unmount failed')
          }
        },
        rmdir: () => {}
      },
      ccall(name) {
        if (name === 'qvac_web_create') return 1
        if (name === 'qvac_web_result') return '{}'
        return 0
      }
    }
  })

  for (let iteration = 0; iteration < 20; iteration++) {
    const failed = isolated.createInstance({}, {}, () => {})
    await isolated.activate(failed)
    failed.mounts.push(`/qvac-files/${iteration}`)
    failUnmount = true
    await t.exception.all(() => isolated.destroyInstance(failed), /unmount failed/)
    t.ok(failed.engine, `engine retained iteration ${iteration + 1}`)
    t.alike(
      failed.mounts,
      [{ mountpoint: `/qvac-files/${iteration}`, mounted: true }],
      `mount retained iteration ${iteration + 1}`
    )
    await isolated.destroyInstance(failed)
    t.is(failed.engine, null, `retry detached iteration ${iteration + 1}`)
    t.alike(failed.mounts, [], `retry cleared mount iteration ${iteration + 1}`)

    const recovered = isolated.createInstance({}, {}, () => {})
    await isolated.activate(recovered)
    await isolated.destroyInstance(recovered)
    t.is(recovered.engine, null, `recovered iteration ${iteration + 1}`)
  }
  t.is(loads, 1)
})

test('ordinary destroy failures retain native resources and remain retryable', async (t) => {
  let failDestroy = false
  let loads = 0
  const isolated = isolatedBinding(() => {
    loads++
    return {
      FS: { unmount: () => {}, rmdir: () => {} },
      ccall(name) {
        if (name === 'qvac_web_create') return 1
        if (name === 'qvac_web_destroy' && failDestroy) {
          failDestroy = false
          return -1
        }
        if (name === 'qvac_web_result') return JSON.stringify({ error: 'destroy failed' })
        return 0
      }
    }
  })

  for (let iteration = 0; iteration < 20; iteration++) {
    const failed = isolated.createInstance({}, {}, () => {})
    await isolated.activate(failed)
    failed.mounts.push(`/qvac-files/${iteration}`)
    failDestroy = true
    await t.exception.all(() => isolated.destroyInstance(failed), /destroy failed/)
    t.ok(failed.engine, `engine retained iteration ${iteration + 1}`)
    t.is(failed.native, 1, `native handle retained iteration ${iteration + 1}`)
    t.alike(
      failed.mounts,
      [`/qvac-files/${iteration}`],
      `mount retained iteration ${iteration + 1}`
    )
    await isolated.destroyInstance(failed)
    t.is(failed.engine, null, `retry detached iteration ${iteration + 1}`)
    t.is(failed.native, 0, `retry cleared native handle iteration ${iteration + 1}`)
    t.alike(failed.mounts, [], `retry cleared mount iteration ${iteration + 1}`)

    const recovered = isolated.createInstance({}, {}, () => {})
    await isolated.activate(recovered)
    await isolated.destroyInstance(recovered)
    t.is(recovered.engine, null, `recovered iteration ${iteration + 1}`)
  }
  t.is(loads, 1)
})

test('fatal destroy failures poison only their engine generation', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    let loads = 0
    const isolated = isolatedBinding(() => {
      const fatal = loads++ === 0
      return {
        FS: {
          unmount: () => {
            if (fatal) throw new Error('poisoned unmount')
          },
          rmdir: () => {
            if (fatal) throw new Error('poisoned rmdir')
          }
        },
        ccall(name) {
          if (name === 'qvac_web_create') return 1
          if (name === 'qvac_web_destroy' && fatal) {
            throw new WebAssembly.RuntimeError('destroy aborted')
          }
          if (name === 'qvac_web_result') return '{}'
          return 0
        }
      }
    })

    const failed = isolated.createInstance({}, {}, () => {})
    await isolated.activate(failed)
    failed.mounts.push(`/qvac-files/${iteration}`)
    await isolated.destroyInstance(failed)
    t.is(failed.engine, null, `detached iteration ${iteration + 1}`)
    t.is(failed.mounts.length, 0, `mounts cleared iteration ${iteration + 1}`)

    const recovered = isolated.createInstance({}, {}, () => {})
    await isolated.activate(recovered)
    await isolated.destroyInstance(recovered)
    t.is(loads, 2, `fresh engine iteration ${iteration + 1}`)
  }
})

test('poisoned engines suppress unsafe filesystem cleanup errors', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const isolated = isolatedBinding(() => ({
      FS: {
        unmount: () => {
          throw new Error('poisoned unmount')
        },
        rmdir: () => {
          throw new Error('poisoned rmdir')
        }
      },
      ccall(name) {
        if (name === 'qvac_web_create') return 1
        if (name === 'qvac_web_run') throw new WebAssembly.RuntimeError('aborted')
        if (name === 'qvac_web_result') return '{}'
        return 0
      }
    }))
    const handle = isolated.createInstance({}, {}, () => {})
    await isolated.activate(handle)
    handle.mounts.push(`/qvac-files/${iteration}`)
    await isolated.runJob(handle, [{ type: 'text', input: '[]' }])
    while (isolated.activeJobs(handle) !== 0) await delay()
    await isolated.destroyInstance(handle)
    t.is(handle.engine, null, `iteration ${iteration + 1}`)
  }
})

test('fatal WebAssembly errors invalidate only their engine generation', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    let loads = 0
    const terminal = []
    const isolated = isolatedBinding((options) => {
      const fatal = loads++ === 0
      return {
        FS: {},
        ccall(name, _returnType, _types, args) {
          if (name === 'qvac_web_create') return 1
          if (name === 'qvac_web_run') {
            if (fatal) throw new WebAssembly.RuntimeError('aborted')
            options.qvacEmit(args[0], args[1], 'JobEnded', '{}')
            return 0
          }
          if (name === 'qvac_web_calc_tokens') return 3
          if (name === 'qvac_web_result') return '{}'
          return 0
        }
      }
    })
    const failed = isolated.createInstance({}, {}, (_owner, event, _data, error) => {
      terminal.push({ event, error })
    })
    await isolated.activate(failed)
    await isolated.runJob(failed, [{ type: 'text', input: '[]' }])
    await delay()
    t.is(terminal[0].event, 'Error', `fatal terminal, iteration ${iteration + 1}`)
    t.is(terminal[0].error.message, 'aborted')
    await t.exception.all(
      () => isolated.runJob(failed, [{ type: 'text', input: '[]' }]),
      /engine terminated/
    )
    t.is(terminal.length, 1, `no rejected-job event, iteration ${iteration + 1}`)
    t.is(isolated.activeJobs(failed), 0, `no rejected active job, iteration ${iteration + 1}`)
    await t.exception.all(() => isolated.calcTokens(failed, { text: 'hello' }), /engine terminated/)
    await isolated.destroyInstance(failed)

    const recovered = isolated.createInstance({}, {}, (_owner, event) => terminal.push({ event }))
    await isolated.activate(recovered)
    await isolated.runJob(recovered, [{ type: 'text', input: '[]' }])
    await delay()
    t.is(terminal[1].event, 'JobEnded', `fresh terminal, iteration ${iteration + 1}`)
    t.is(loads, 2, `fresh engine created, iteration ${iteration + 1}`)
    await isolated.destroyInstance(recovered)
  }
})

test('browser calcTokens fails fast while the engine queue is busy', async (t) => {
  const isolated = isolatedBinding(
    fakeEngine(async (emit, [native, id]) => {
      await delay()
      emit(native, id, 'JobEnded', '{}')
      return 0
    })
  )
  const handle = isolated.createInstance({}, {}, () => {})
  await isolated.activate(handle)
  const admission = await isolated.runJob(handle, [{ type: 'text', input: '[]' }])

  for (let iteration = 0; iteration < 20; iteration++) {
    let error = null
    try {
      await isolated.calcTokens(handle, { text: 'hello' })
    } catch (cause) {
      error = cause
    }
    t.is(error?.code, 'RUN_BUSY', `iteration ${iteration + 1}`)
  }
  await isolated.cancelJob(handle, admission.id)
  await delay()
  t.is(isolated.activeJobs(handle), 0)
  await isolated.destroyInstance(handle)
})
