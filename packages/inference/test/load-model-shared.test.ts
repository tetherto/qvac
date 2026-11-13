import test from 'brittle'
import { AbortController, type AbortSignal } from 'bare-abort-controller'
import { z } from 'zod'

import { InferenceCancelledError, ModelReconfiguredError } from '@/errors/index'
import { handleLoadModel } from '@/handlers/load-model/handler'
import { getRequestRegistry } from '@/runtime/index'
import { loadModel } from '@/plugins/ops/load-model'
import { withModelWorkLock } from '@/runtime/model-work-lock'
import { unloadModel } from '@/plugins/ops/unload-model'
import { registerPlugin, unregisterPlugin } from '@/plugins/registry'
import {
  getModelEntry,
  registerModel,
  unregisterModel,
  type AnyModel
} from '@/runtime/model-registry'
import { ModelType } from '@/schemas/index'
import type { QvacPlugin } from '@/schemas/plugin'
import { openTestSessions } from './fixtures/sessions'

// Two sessions that load the same configuration share one native model. These
// tests pin the load path under concurrency: one native load per model id, a
// lease only once the model is registered, and a load that waits on a reload
// of the same id takes its lease after the reload.

const PLUGIN_TYPE = 'shared-load-test'

interface Deferred {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function registerCountingPlugin(t: { teardown(fn: () => void): void }) {
  const loads: Deferred[] = []
  const plugin = {
    modelType: PLUGIN_TYPE,
    displayName: 'Shared load',
    addonPackage: '@qvac/shared-load-test',
    loadConfigSchema: z.looseObject({}),
    skipPrimaryModelPathValidation: true,
    createModel: () => {
      const load = deferred()
      loads.push(load)
      return { model: { load: () => load.promise, unload: async () => {} } }
    },
    handlers: {}
  } as unknown as QvacPlugin
  registerPlugin(plugin)
  t.teardown(() => unregisterPlugin(plugin.modelType))
  return loads
}

function load(modelId: string, sessionId: string, signal?: AbortSignal) {
  return loadModel(
    {
      modelId,
      modelPath: '',
      options: {
        type: 'loadModel',
        modelSrc: '',
        modelType: PLUGIN_TYPE,
        modelConfig: {},
        modelFitPolicy: 'off'
      }
    } as never,
    {
      sessionId,
      ...(signal && { request: { signal, requestId: `req-${sessionId}` } })
    }
  )
}

test('shared load: two sessions loading one model at once share a single native load', async (t) => {
  openTestSessions(t, 'A', 'B')
  const loads = registerCountingPlugin(t)
  const modelId = 'shared-load-once'

  const first = load(modelId, 'A')
  const second = load(modelId, 'B')
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  t.is(loads.length, 1, 'the second load waits instead of creating a second native model')

  loads[0]!.resolve()
  await Promise.all([first, second])
  t.is(loads.length, 1)
  t.alike(Array.from(getModelEntry(modelId)!.leases).sort(), ['A', 'B'])
  unregisterModel(modelId)
})

test('shared load: a waiter loads the model itself after the first load fails', async (t) => {
  openTestSessions(t, 'A', 'B')
  const loads = registerCountingPlugin(t)
  const modelId = 'shared-load-retry'

  const first = load(modelId, 'A')
  const second = load(modelId, 'B')
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  loads[0]!.reject(new Error('native load failed'))
  await t.exception(first, /native load failed/)

  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  t.is(loads.length, 2, 'the waiter runs its own native load')
  loads[1]!.resolve()
  await second
  t.alike(Array.from(getModelEntry(modelId)!.leases), ['B'])
  unregisterModel(modelId)
})

test('shared load: a cancelled waiter leaves the lock before the other load finishes', async (t) => {
  openTestSessions(t, 'A', 'B')
  const loads = registerCountingPlugin(t)
  const modelId = 'shared-load-cancel-leaves'
  const controller = new AbortController()

  const first = load(modelId, 'A')
  const second = load(modelId, 'B', controller.signal)
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  controller.abort(undefined)
  await t.exception(
    second,
    InferenceCancelledError as unknown as new () => Error,
    'the waiter rejects while the first load is still running'
  )
  t.is(loads.length, 1)
  loads[0]!.resolve()
  await first
  t.alike(Array.from(getModelEntry(modelId)!.leases), ['A'], 'the first load was not touched')
  unregisterModel(modelId)
})

test('shared load: a session close waits for its running reload', async (t) => {
  openTestSessions(t, 'A')
  registerCountingPlugin(t)
  const modelId = 'b2c3d4e5f6071829'
  const reload = deferred()
  registerModel(
    modelId,
    {
      model: {
        load: async () => {},
        unload: () => {},
        pause: () => {},
        run: async () => ({
          iterate: async function* () {},
          await: async () => undefined,
          cancel: async () => {}
        }),
        reload: () => reload.promise
      } as AnyModel,
      path: '/models/shared.bin',
      config: {},
      modelType: ModelType.whispercppTranscription
    },
    'A'
  )
  const registry = getRequestRegistry()

  const reloading = handleLoadModel({
    type: 'loadModel',
    modelId,
    modelType: ModelType.whispercppTranscription,
    modelConfig: { language: 'en' },
    requestId: 'reload-a',
    sessionId: 'A'
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  t.ok(registry.get('reload-a', 'A'), 'the reload is a registered request of the session')

  let drained = false
  const drain = registry.drainSession('A', 'sessionClosed').then((count) => {
    drained = true
    return count
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  t.is(drained, false, 'the drain waits while the native reload runs')

  reload.resolve()
  t.is((await reloading).success, true)
  t.is(await drain, 1)
  unregisterModel(modelId)
})

test('shared load: a reload waiting for the lock is cancelled by id without running', async (t) => {
  openTestSessions(t, 'A')
  registerCountingPlugin(t)
  const modelId = 'c3d4e5f607182930'
  const registry = getRequestRegistry()
  const reload = deferred()
  let reloads = 0
  registerModel(
    modelId,
    {
      model: {
        load: async () => {},
        unload: () => {},
        pause: () => {},
        run: async () => ({
          iterate: async function* () {},
          await: async () => undefined,
          cancel: async () => {}
        }),
        reload: () => {
          reloads++
          return reload.promise
        }
      } as AnyModel,
      path: '/models/shared.bin',
      config: {},
      modelType: ModelType.whispercppTranscription
    },
    'A'
  )
  const reloadRequest = (requestId: string, language: string) =>
    handleLoadModel({
      type: 'loadModel',
      modelId,
      modelType: ModelType.whispercppTranscription,
      modelConfig: { language },
      requestId,
      sessionId: 'A'
    })

  const first = reloadRequest('reload-1', 'en')
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  const second = reloadRequest('reload-2', 'de')
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  t.is(registry.cancel({ requestId: 'reload-2', sessionId: 'A' }), 1, 'the queued reload is found')
  await t.exception(second, InferenceCancelledError as unknown as new () => Error)

  reload.resolve()
  t.is((await first).success, true)
  t.is(reloads, 1, 'the cancelled reload never reached the model')
  unregisterModel(modelId)
})

test('shared load: a load of a model being reconfigured is refused once the reload changed it', async (t) => {
  openTestSessions(t, 'A', 'B')
  registerCountingPlugin(t)
  const modelId = 'a1b2c3d4e5f60718'
  const reload = deferred()
  let reloads = 0
  registerModel(
    modelId,
    {
      model: {
        load: async () => {},
        unload: () => {},
        pause: () => {},
        run: async () => ({
          iterate: async function* () {},
          await: async () => undefined,
          cancel: async () => {}
        }),
        reload: () => {
          reloads++
          return reload.promise
        }
      } as AnyModel,
      path: '/models/shared.bin',
      config: {},
      modelType: ModelType.whispercppTranscription
    },
    'A'
  )

  const reloading = handleLoadModel({
    type: 'loadModel',
    modelId,
    modelType: ModelType.whispercppTranscription,
    modelConfig: { language: 'en' },
    sessionId: 'A'
  })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  t.is(reloads, 1, 'the sole holder reconfigures')

  const joining = load(modelId, 'B')
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  t.alike(
    Array.from(getModelEntry(modelId)!.leases),
    ['A'],
    'no lease while the configuration is changing'
  )

  reload.resolve()
  t.is((await reloading).success, true)
  await t.exception(
    joining,
    ModelReconfiguredError as unknown as new () => Error,
    'the waiter asked for the configuration the model had before the reload'
  )
  t.alike(Array.from(getModelEntry(modelId)!.leases), ['A'], 'the waiter took no lease')

  await load(modelId, 'A')
  t.alike(
    Array.from(getModelEntry(modelId)!.leases),
    ['A'],
    'the session that reconfigured it still loads it'
  )
  unregisterModel(modelId)
})

test('shared load: a model reloaded back to its loaded configuration is shared again', async (t) => {
  openTestSessions(t, 'A', 'B')
  registerCountingPlugin(t)
  const modelId = 'd4e5f60718293a4b'
  registerModel(
    modelId,
    {
      model: {
        load: async () => {},
        unload: () => {},
        pause: () => {},
        run: async () => ({
          iterate: async function* () {},
          await: async () => undefined,
          cancel: async () => {}
        }),
        reload: async () => {}
      } as AnyModel,
      path: '/models/shared.bin',
      config: { language: 'de' },
      modelType: ModelType.whispercppTranscription
    },
    'A'
  )
  const reload = (language: string) =>
    handleLoadModel({
      type: 'loadModel',
      modelId,
      modelType: ModelType.whispercppTranscription,
      modelConfig: { language },
      sessionId: 'A'
    })

  t.is((await reload('en')).success, true)
  await t.exception(load(modelId, 'B'), ModelReconfiguredError as unknown as new () => Error)
  t.is((await reload('de')).success, true)
  await load(modelId, 'B')
  t.alike(Array.from(getModelEntry(modelId)!.leases).sort(), ['A', 'B'])
  unregisterModel(modelId)
})

test('shared load: a load during the last-lease teardown waits and loads a fresh model', async (t) => {
  openTestSessions(t, 'A', 'B')
  const unloading = deferred()
  const loads: Deferred[] = []
  const plugin = {
    modelType: PLUGIN_TYPE,
    displayName: 'Shared load',
    addonPackage: '@qvac/shared-load-test',
    loadConfigSchema: z.looseObject({}),
    skipPrimaryModelPathValidation: true,
    createModel: () => {
      const load = deferred()
      loads.push(load)
      return { model: { load: () => load.promise, unload: () => unloading.promise } }
    },
    handlers: {}
  } as unknown as QvacPlugin
  registerPlugin(plugin)
  t.teardown(() => unregisterPlugin(plugin.modelType))
  const modelId = 'shared-load-teardown'

  const first = load(modelId, 'A')
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  loads[0]!.resolve()
  await first

  const releasing = unloadModel({ modelId, sessionId: 'A' })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  const joining = load(modelId, 'B')
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  t.is(loads.length, 1, 'no second native load while the first model is being freed')

  unloading.resolve()
  t.alike(await releasing, { released: true, unloaded: true })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  t.is(loads.length, 2, 'the waiting load runs once the teardown is done')
  loads[1]!.resolve()
  await joining
  t.alike(Array.from(getModelEntry(modelId)!.leases), ['B'])
  unregisterModel(modelId)
})

test('shared load: withModelWorkLock serializes tasks per model id and runs other ids at once', async (t) => {
  const first = deferred()
  const order: string[] = []
  const a = withModelWorkLock('m', async () => {
    order.push('a-start')
    await first.promise
    order.push('a-end')
  })
  const b = withModelWorkLock('m', async () => {
    order.push('b-start')
  })
  const other = withModelWorkLock('n', async () => {
    order.push('n-start')
  })
  await other
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  t.alike(order, ['a-start', 'n-start'], 'the same id waits, another id does not')
  first.resolve()
  await Promise.all([a, b])
  t.alike(order, ['a-start', 'n-start', 'a-end', 'b-start'])
})
