'use strict'

const test = require('brittle')
const binding = require('../../binding.browser.js')
const {
  ensureMessageCacheDirectories,
  ensureParentDirectory
} = require('../../browser/cache-files.js')

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
})

test('destroying an instance with no resources does not load the engine', async (t) => {
  let loads = 0
  const isolated = isolatedBinding(() => {
    loads++
    return {}
  })

  for (let iteration = 0; iteration < 20; iteration++) {
    const handle = isolated.createInstance({}, { projectionPath: '/projection.gguf' }, () => {})
    await t.exception.all(() => isolated.activate(handle), /Projection model is not supported/)
    await isolated.destroyInstance(handle)
    t.is(loads, 0, `iteration ${iteration + 1}`)
  }
})

test('invalid parallel configuration does not retain or load an engine', async (t) => {
  let loads = 0
  const isolated = isolatedBinding(() => {
    loads++
    return {}
  })

  for (let iteration = 0; iteration < 20; iteration++) {
    const handle = isolated.createInstance({}, { config: { parallel: 2 } }, () => {})
    await t.exception.all(() => isolated.activate(handle), /parallel > 1 is not supported/)
    await isolated.destroyInstance(handle)
    t.is(loads, 0, `iteration ${iteration + 1}`)
  }
})

test('healthy unload reports filesystem cleanup errors and detaches the handle', async (t) => {
  let loads = 0
  const isolated = isolatedBinding(() => {
    loads++
    return {
      FS: {
        unmount: () => {
          throw new Error('unmount failed')
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
    await t.exception.all(() => isolated.destroyInstance(failed), /unmount failed/)
    t.is(failed.engine, null, `detached iteration ${iteration + 1}`)

    const recovered = isolated.createInstance({}, {}, () => {})
    await isolated.activate(recovered)
    await isolated.destroyInstance(recovered)
    t.is(recovered.engine, null, `recovered iteration ${iteration + 1}`)
  }
  t.is(loads, 1)
})

test('ordinary destroy failures detach resources and preserve the engine', async (t) => {
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
    t.is(failed.engine, null, `detached iteration ${iteration + 1}`)
    t.is(failed.mounts.length, 0, `mounts cleared iteration ${iteration + 1}`)

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

test('fatal WebAssembly errors invalidate their engine generation', async (t) => {
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

test('browser binding reports worker-wide jobs to every model', async (t) => {
  const first = instance()
  const second = instance()

  for (let iteration = 0; iteration < 20; iteration++) {
    const admission = await binding.runJob(first, [{ type: 'text', input: '[]' }])
    t.is(binding.activeJobs(second), 1, `iteration ${iteration + 1}`)
    await binding.cancelJob(first, admission.id)
    await delay()
    t.is(binding.activeJobs(second), 0, `settled iteration ${iteration + 1}`)
  }
})

test('browser binding rejects path and ordered-part media before admission', async (t) => {
  const handle = instance()
  const prompts = [
    [{ role: 'user', type: 'media', content: '/image.png' }],
    [
      {
        role: 'user',
        content: [
          { type: 'text', content: 'Describe this' },
          { type: 'media', content: '/image.png' }
        ]
      }
    ]
  ]

  for (let iteration = 0; iteration < 20; iteration++) {
    for (const prompt of prompts) {
      await t.exception.all(
        () => binding.runJob(handle, [{ type: 'text', input: JSON.stringify(prompt) }]),
        /Media input is not supported/
      )
      t.is(binding.activeJobs(handle), 0)
    }
  }
})

test('browser binding rejects projection models before loading the engine', async (t) => {
  const handle = binding.createInstance(
    {},
    { path: '/model.gguf', projectionPath: '/projection.gguf' },
    () => {}
  )

  await t.exception.all(() => binding.activate(handle), /Projection model is not supported/)
  t.is(binding.activeJobs(handle), 0)
})

test('browser calcTokens fails fast while the engine queue is busy', async (t) => {
  const handle = instance()
  const admission = await binding.runJob(handle, [{ type: 'text', input: '[]' }])

  for (let iteration = 0; iteration < 20; iteration++) {
    let error = null
    try {
      await binding.calcTokens(handle, { text: 'hello' })
    } catch (cause) {
      error = cause
    }
    t.is(error?.code, 'RUN_BUSY', `iteration ${iteration + 1}`)
  }
  await binding.cancelJob(handle, admission.id)
  await delay()
  t.is(binding.activeJobs(handle), 0)
})
