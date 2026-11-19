import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { z } from 'zod'
import { send, stream, close } from '@/dispatch'
import { registerPlugin, clearPlugins } from '@/plugins'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/index'
import { clearSessions, openSession } from '@/runtime/session-registry'
import { startFinetune } from '@/plugins/builtin/llamacpp-completion/ops/finetune'
import { DeadlineClock } from '@/runtime/deadlines'
import { DeadlineExceededError } from '@/errors'
import { ModelType } from '@/schemas'
import type { Request, Response } from '@/schemas'
import type { QvacPlugin } from '@/schemas/plugin'
import {
  STALL_MODEL_ID,
  STALL_MODEL_TYPE,
  releaseStall,
  stallPlugin
} from './fixtures/stall-plugin'

// Keep the storage lock out of the real home.
env['HOME'] = path.join(os.tmpdir(), `qvac-inference-test-${os.pid()}`)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function setUp() {
  clearPlugins()
  clearSessions()
  registerPlugin(stallPlugin)
  registerModel(STALL_MODEL_ID, {
    model: { load: async () => {}, unload: async () => {} } as unknown as AnyModel,
    path: '/tmp/model.bin',
    config: {},
    modelType: STALL_MODEL_TYPE as never
  })
}

async function tearDown() {
  unregisterModel(STALL_MODEL_ID)
  clearSessions()
  await close()
  clearPlugins()
}

function invoke(
  type: 'pluginInvoke' | 'pluginInvokeStream',
  handler: string,
  params: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Request {
  return { type, modelId: STALL_MODEL_ID, handler, params, ...extra } as unknown as Request
}

async function failure(work: Promise<unknown>): Promise<DeadlineExceededError> {
  try {
    await work
  } catch (error) {
    if (error instanceof DeadlineExceededError) return error
    throw error
  }
  throw new Error('expected the call to fail on its deadline')
}

const overdueIds = () =>
  getRequestRegistry()
    .overdue()
    .map((ctx) => ctx.requestId)

test('a stream that stops yielding fails with boundary "idle"', async (t) => {
  setUp()
  try {
    const responses = stream(
      invoke('pluginInvokeStream', 'stall', { gate: 'idle' }, { deadline: { idleMs: 50 } })
    )
    const first = await responses.next()
    t.is(
      (first.value as unknown as { result: { n: number } }).result.n,
      1,
      'the first chunk arrives'
    )

    const error = await failure(responses.next())
    t.is(error.boundary, 'idle')
    t.is(error.timeoutMs, 50)
    t.is(error.modelId, STALL_MODEL_ID)
    t.is(error.capability, undefined, 'the handler is outside every contract')

    await sleep(20)
    t.alike(overdueIds(), [], 'the handler stopped on the abort, so nothing is overdue')
  } finally {
    await tearDown()
  }
})

test('a stream whose handler ignores the abort still fails at the deadline and stays overdue', async (t) => {
  setUp()
  try {
    const responses = stream(
      invoke(
        'pluginInvokeStream',
        'stallIgnoringAbort',
        { gate: 'ignore' },
        { requestId: 'stalled', deadline: { idleMs: 50 } }
      )
    )
    await responses.next()
    const error = await failure(responses.next())
    t.is(error.boundary, 'idle')
    t.alike(overdueIds(), ['stalled'], 'its work has not stopped')

    releaseStall('ignore')
    await sleep(20)
    t.alike(overdueIds(), [], 'cleared once the handler ended')
  } finally {
    await tearDown()
  }
})

test('a single-reply handler that never settles fails at its run deadline', async (t) => {
  setUp()
  try {
    const started = Date.now()
    const error = await failure(
      send(invoke('pluginInvoke', 'hang', { gate: 'hang' }, { deadline: { runMs: 50 } }))
    )
    t.is(error.boundary, 'run')
    t.ok(Date.now() - started < 1000, 'the caller did not wait for the handler')
    releaseStall('hang')
    await sleep(20)
  } finally {
    await tearDown()
  }
})

test('a stream that keeps yielding outlives an idle deadline shorter than the whole run', async (t) => {
  setUp()
  try {
    const seen: Response[] = []
    const responses = stream(
      invoke('pluginInvokeStream', 'ticks', { count: 8, gapMs: 20 }, { deadline: { idleMs: 80 } })
    )
    for await (const response of responses) seen.push(response)
    t.is(seen.length, 9, 'eight chunks over 160ms and the final frame')
  } finally {
    await tearDown()
  }
})

test('a gap between chunks longer than the idle deadline fails the stream', async (t) => {
  setUp()
  try {
    const responses = stream(
      invoke('pluginInvokeStream', 'ticks', { count: 3, gapMs: 120 }, { deadline: { idleMs: 40 } })
    )
    const error = await failure(responses.next())
    t.is(error.boundary, 'idle')
    await sleep(400)
  } finally {
    await tearDown()
  }
})

test('two sessions on one model: a stalled request bounds the other session by its queue deadline', async (t) => {
  setUp()
  openSession('a')
  openSession('b')
  try {
    const stalled = failure(
      send(
        invoke(
          'pluginInvoke',
          'occupy',
          { gate: 'occupy' },
          { sessionId: 'a', requestId: 'a-1', deadline: { runMs: 40 } }
        )
      )
    )
    await sleep(10)

    // Queued behind A's request with no queue deadline: it waits for the slot.
    const patient = send(
      invoke('pluginInvoke', 'quick', {}, { sessionId: 'b', requestId: 'b-patient' })
    )
    const bounded = await failure(
      send(
        invoke(
          'pluginInvoke',
          'quick',
          {},
          { sessionId: 'b', requestId: 'b-bounded', deadline: { queueMs: 80 } }
        )
      )
    )
    t.is(bounded.boundary, 'queue', "B's bounded request fails on its own queue deadline")
    t.is((await stalled).boundary, 'run', "A's request failed at its run deadline")
    t.ok(overdueIds().includes('a-1-inner'), "A's request still holds the slot")

    releaseStall('occupy')
    const result = (await patient) as unknown as { result: { done: boolean } }
    t.ok(result.result.done, "B's unbounded request runs once A's teardown has finished")
    t.alike(overdueIds(), [])
  } finally {
    await tearDown()
  }
})

test('loadModel fails with boundary "load" when the native load outlasts loadMs', async (t) => {
  let finishLoad: () => void = () => {}
  const loading = new Promise<void>((resolve) => {
    finishLoad = resolve
  })
  clearPlugins()
  registerPlugin({
    modelType: ModelType.llamacppCompletion,
    displayName: 'Slow load',
    addonPackage: '@qvac/llm-llamacpp',
    loadConfigSchema: z.looseObject({}),
    createModel: () => ({ model: { load: () => loading, unload: async () => {} } }),
    handlers: {}
  } as unknown as QvacPlugin)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qvac-load-deadline-'))
  const modelPath = path.join(dir, 'model.gguf')
  fs.writeFileSync(modelPath, '')
  try {
    const error = await failure(
      send({
        type: 'loadModel',
        modelType: ModelType.llamacppCompletion,
        modelSrc: modelPath,
        modelFitPolicy: 'off',
        deadline: { loadMs: 60, runMs: 1 }
      } as unknown as Request)
    )
    t.is(error.boundary, 'load', 'runMs on a load is not read')
    t.is(error.capability, undefined)
    finishLoad()
    await sleep(50)
  } finally {
    await close()
    clearPlugins()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

interface FakeFinetuneHandle {
  on(event: 'stats', listener: (stats: unknown) => void): FakeFinetuneHandle
  removeListener(event: 'stats', listener: (stats: unknown) => void): FakeFinetuneHandle
  await(): Promise<{ op: 'finetune'; status: 'COMPLETED' }>
}

function registerFinetuneModel(modelId: string, emitEveryMs: number, emitCount: number) {
  let finish: () => void = () => {}
  registerModel(modelId, {
    model: {
      finetune: async () => {
        const listeners = new Set<(stats: unknown) => void>()
        let emitted = 0
        const timer = setInterval(() => {
          emitted++
          for (const listener of listeners) listener({ global_steps: emitted })
          if (emitted >= emitCount) clearInterval(timer)
        }, emitEveryMs)
        const done = new Promise<void>((resolve) => {
          finish = () => {
            clearInterval(timer)
            resolve()
          }
        })
        const handle: FakeFinetuneHandle = {
          on: (_event, listener) => {
            listeners.add(listener)
            return handle
          },
          removeListener: (_event, listener) => {
            listeners.delete(listener)
            return handle
          },
          await: async () => {
            await done
            return { op: 'finetune', status: 'COMPLETED' }
          }
        }
        return handle
      },
      pause: async () => {},
      cancel: async () => finish()
    } as unknown as AnyModel,
    path: '/tmp/model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })
  return { finish: () => finish() }
}

function finetuneRequest(modelId: string, requestId: string) {
  return {
    type: 'finetune' as const,
    modelId,
    requestId,
    operation: 'start' as const,
    options: {
      trainDatasetDir: '/tmp/train.jsonl',
      validation: { type: 'none' as const },
      outputParametersDir: '/tmp/out',
      checkpointSaveDir: path.join(os.tmpdir(), `qvac-no-checkpoints-${os.pid()}`)
    }
  }
}

test('finetune stats restart the idle deadline when the caller asked for no progress', async (t) => {
  const modelId = 'finetune-idle-progress'
  const model = registerFinetuneModel(modelId, 20, 1000)
  const clock = new DeadlineClock(
    { idleMs: 70 },
    { requestId: 'ft-progress', capability: 'fine-tuning', modelId },
    { idleFromAdmission: false }
  )
  const unbind = getRequestRegistry().bindDeadline('ft-progress', undefined, clock)
  try {
    const run = startFinetune(finetuneRequest(modelId, 'ft-progress'))
    await sleep(250)
    t.is(clock.error, undefined, 'stats every 20ms keep a 70ms idle deadline from passing')
    model.finish()
    t.is((await run).status, 'COMPLETED')
  } finally {
    unbind()
    clock.close()
    unregisterModel(modelId)
  }
})

test('finetune fails on its idle deadline when stats stop arriving', async (t) => {
  const modelId = 'finetune-idle-stalled'
  registerFinetuneModel(modelId, 10, 2)
  const clock = new DeadlineClock(
    { idleMs: 60 },
    { requestId: 'ft-stalled', capability: 'fine-tuning', modelId },
    { idleFromAdmission: false }
  )
  const unbind = getRequestRegistry().bindDeadline('ft-stalled', undefined, clock)
  try {
    const run = startFinetune(finetuneRequest(modelId, 'ft-stalled'))
    const error = await failure(clock.expired)
    t.is(error.boundary, 'idle')
    t.is(error.capability, 'fine-tuning')
    // The abort reaches the model's cancel, which ends the fake run.
    await run
  } finally {
    unbind()
    clock.close()
    unregisterModel(modelId)
  }
})
