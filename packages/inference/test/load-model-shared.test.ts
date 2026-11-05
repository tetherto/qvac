import test from 'brittle'
import { AbortController, type AbortSignal } from 'bare-abort-controller'
import { z } from 'zod'

import { InferenceCancelledError, ModelLeasedError } from '@/errors/index'
import { handleLoadModel } from '@/handlers/load-model/handler'
import { loadModel, withModelWorkLock } from '@/plugins/ops/load-model'
import { registerPlugin, unregisterPlugin } from '@/plugins/registry'
import {
  getModelEntry,
  isModelLoaded,
  registerModel,
  unregisterModel,
  type AnyModel
} from '@/runtime/model-registry'
import { ModelType } from '@/schemas/index'
import type { QvacPlugin } from '@/schemas/plugin'

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
  const loads = registerCountingPlugin(t)
  const modelId = 'shared-load-once'

  const first = load(modelId, 'A')
  const second = load(modelId, 'B')
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  t.is(loads.length, 1, 'the second load waits instead of creating a second native model')
  t.absent(isModelLoaded(modelId), 'no lease is taken before the model is registered')

  loads[0]!.resolve()
  await Promise.all([first, second])
  t.is(loads.length, 1)
  t.alike(Array.from(getModelEntry(modelId)!.leases).sort(), ['A', 'B'])
  unregisterModel(modelId)
})

test('shared load: a waiter loads the model itself after the first load fails', async (t) => {
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

test('shared load: a cancel that lands while waiting takes no lease', async (t) => {
  const loads = registerCountingPlugin(t)
  const modelId = 'shared-load-cancel-waiting'
  const controller = new AbortController()

  const first = load(modelId, 'A')
  const second = load(modelId, 'B', controller.signal)
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  controller.abort(undefined)
  loads[0]!.resolve()
  await first
  await t.exception(second, InferenceCancelledError as unknown as new () => Error)
  t.alike(Array.from(getModelEntry(modelId)!.leases), ['A'])
  unregisterModel(modelId)
})

test('shared load: a load of a model being reconfigured takes its lease after the reload', async (t) => {
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
  await joining
  t.alike(Array.from(getModelEntry(modelId)!.leases).sort(), ['A', 'B'])

  await t.exception(
    handleLoadModel({
      type: 'loadModel',
      modelId,
      modelType: ModelType.whispercppTranscription,
      modelConfig: { language: 'de' },
      sessionId: 'A'
    }),
    ModelLeasedError as unknown as new () => Error,
    'the next reload sees the lease the waiter took'
  )
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
