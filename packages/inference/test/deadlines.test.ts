import test from 'brittle'
import { z } from 'zod'
import {
  DeadlineClock,
  resolveDeadline,
  warnUnprovidedDeadlineCapabilities
} from '@/runtime/deadlines'
import { resumeRuntime, suspendRuntime } from '@/runtime/runtime-lifecycle'
import { registerPlugin, clearPlugins } from '@/plugins'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { DeadlineExceededError } from '@/errors'
import { qvacConfigSchema, type QvacConfig, type Request } from '@/schemas'
import type { QvacPlugin } from '@/schemas/plugin'

const config: Pick<QvacConfig, 'deadlines'> = {
  deadlines: {
    capabilities: {
      default: { queueMs: 120_000, idleMs: 60_000 },
      completion: { idleMs: 300_000 },
      'image-generation': { idleMs: 600_000 },
      'video-generation': { idleMs: null },
      'acme.diarization': { runMs: 5_000 }
    },
    load: { loadMs: 300_000 }
  }
}

function request(fields: Record<string, unknown>): Request {
  return fields as unknown as Request
}

test('resolveDeadline: a call shortens the configured values and adds the ones config leaves out', (t) => {
  const resolved = resolveDeadline(
    request({
      type: 'completionStream',
      modelId: 'm',
      deadline: { queueMs: 10_000, idleMs: 90_000, runMs: 600_000 }
    }),
    config
  )
  t.alike(resolved?.limits, { queueMs: 10_000, idleMs: 90_000, runMs: 600_000 })
  t.is(resolved?.capability, 'completion')
})

test('resolveDeadline: a call cannot lengthen a configured value', (t) => {
  const resolved = resolveDeadline(
    request({ type: 'completionStream', modelId: 'm', deadline: { idleMs: 900_000 } }),
    config
  )
  t.is(resolved?.limits.idleMs, 300_000)
})

test('resolveDeadline: null removes a default for one capability and keeps the other defaults', (t) => {
  const resolved = resolveDeadline(request({ type: 'videoStream', modelId: 'm' }), config)
  t.alike(resolved?.limits, { queueMs: 120_000 }, 'no idle deadline for video generation')
})

test('resolveDeadline: operations of one registry kind resolve by their own capability', (t) => {
  const image = resolveDeadline(request({ type: 'diffusionStream', modelId: 'm' }), config)
  const upscale = resolveDeadline(request({ type: 'upscaleStream', modelId: 'm' }), config)
  t.is(image?.capability, 'image-generation')
  t.is(image?.limits.idleMs, 600_000)
  t.is(upscale?.capability, 'image-upscaling')
  t.is(upscale?.limits.idleMs, 60_000, 'upscaling has no entry, so it takes the default')
})

test('resolveDeadline: the duplex completion resolves as completion', (t) => {
  const resolved = resolveDeadline(request({ type: 'completionOrchestrate', modelId: 'm' }), config)
  t.is(resolved?.capability, 'completion')
  t.is(resolved?.limits.idleMs, 300_000)
})

test('resolveDeadline: loadModel takes only the load entry', (t) => {
  const configured = resolveDeadline(request({ type: 'loadModel' }), config)
  t.alike(configured?.limits, { loadMs: 300_000 }, 'nothing from capabilities.default')
  t.is(configured?.capability, undefined)

  const shortened = resolveDeadline(
    request({ type: 'loadModel', deadline: { loadMs: 1_000, runMs: 5 } }),
    config
  )
  t.alike(shortened?.limits, { loadMs: 1_000 }, 'the call shortens loadMs; runMs is not read')
})

test('resolveDeadline: request types outside capabilities take no deadline', (t) => {
  const called = { queueMs: 1, idleMs: 1, runMs: 1, loadMs: 1 }
  for (const type of ['vectorIndex', 'downloadAsset', 'heartbeat', 'unloadModel']) {
    t.is(resolveDeadline(request({ type, deadline: called }), config), undefined, type)
  }
})

test('resolveDeadline: nothing configured and nothing called is unbounded', (t) => {
  t.is(resolveDeadline(request({ type: 'completionStream', modelId: 'm' }), {}), undefined)
})

test('resolveDeadline: a plugin invoke resolves by the contract that lists its handler', (t) => {
  const handler = {
    requestSchema: z.object({}),
    responseSchema: z.object({}),
    streaming: false,
    handler: async () => ({})
  }
  clearPlugins()
  registerPlugin({
    modelType: 'deadline-resolve-test',
    displayName: 'Deadline resolve',
    addonPackage: '@qvac/deadline-resolve-test',
    loadConfigSchema: z.looseObject({}),
    createModel: () => ({ model: { load: async () => {}, unload: async () => {} } }),
    provides: [
      { id: 'acme.diarization', version: 1, operations: ['diarize'], optionalOperations: [] }
    ],
    handlers: { diarize: handler, inspect: handler }
  } as unknown as QvacPlugin)
  registerModel('deadline-resolve-model', {
    model: {} as unknown as AnyModel,
    path: '/tmp/model.bin',
    config: {},
    modelType: 'deadline-resolve-test' as never
  })
  t.teardown(() => {
    unregisterModel('deadline-resolve-model')
    clearPlugins()
  })
  const invoke = (handlerName: string) =>
    request({ type: 'pluginInvoke', modelId: 'deadline-resolve-model', handler: handlerName })

  const inContract = resolveDeadline(invoke('diarize'), config)
  t.is(inContract?.capability, 'acme.diarization')
  t.alike(inContract?.limits, { queueMs: 120_000, idleMs: 60_000, runMs: 5_000 })

  const outside = resolveDeadline(invoke('inspect'), config)
  t.is(outside?.capability, undefined)
  t.alike(outside?.limits, { queueMs: 120_000, idleMs: 60_000 }, 'the default entry applies')
})

test('config: a deadline key that is not a capability ID is refused', (t) => {
  const bad = qvacConfigSchema.safeParse({
    deadlines: { capabilities: { 'Image Generation': { idleMs: 1000 } } }
  })
  t.absent(bad.success)
  const good = qvacConfigSchema.safeParse(config)
  t.ok(good.success, 'the documented shape parses')
})

test('a configured capability ID that no plugin provides is warned about', (t) => {
  const warnings: string[] = []
  const logger = { warn: (message: unknown) => warnings.push(String(message)) }
  const plugins = [
    {
      provides: [
        { id: 'completion', version: 1, operations: ['completionStream'], optionalOperations: [] }
      ]
    }
  ] as unknown as QvacPlugin[]
  warnUnprovidedDeadlineCapabilities(
    { deadlines: { capabilities: { default: {}, completion: {}, 'acme.missing': {} } } },
    plugins,
    logger
  )
  t.is(warnings.length, 1, 'default and a provided capability are not reported')
  t.ok(warnings[0]?.includes('acme.missing'))
})

test('a deadline that passes while the runtime is suspended expires on resume', async (t) => {
  const clock = new DeadlineClock(
    { runMs: 60_000 },
    { requestId: 'r-suspended' },
    { idleFromAdmission: false }
  )
  const realNow = Date.now
  t.teardown(() => {
    Date.now = realNow
    clock.close()
  })
  clock.admitted()
  await suspendRuntime()
  // The timer has not fired; only the wall clock has moved past the deadline.
  Date.now = () => realNow() + 61_000
  t.is(clock.error, undefined, 'still pending while suspended')
  await resumeRuntime()

  await t.exception(clock.expired, DeadlineExceededError as unknown as new () => Error)
  t.is(clock.error?.boundary, 'run')
  t.is(clock.error?.timeoutMs, 60_000)
})

test('start: the run deadline counts from admission when the request is admitted later', async (t) => {
  const clock = new DeadlineClock(
    { runMs: 80 },
    { requestId: 'r-start' },
    { idleFromAdmission: false }
  )
  t.teardown(() => clock.close())
  clock.start()
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  clock.admitted()
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  t.is(clock.error, undefined, '100ms after start, 50ms after admission')

  await t.exception(clock.expired, DeadlineExceededError as unknown as new () => Error)
  t.is(clock.error?.boundary, 'run')
})

test('within: settled work keeps its outcome, pending work fails at the deadline', async (t) => {
  const clock = new DeadlineClock(
    { runMs: 40 },
    { requestId: 'r-within' },
    { idleFromAdmission: false }
  )
  t.teardown(() => clock.close())
  clock.admitted()

  t.is(await clock.within(Promise.resolve('reply')), 'reply')
  const handlerError = new Error('handler failed')
  let thrown: unknown
  try {
    await clock.within(Promise.reject(handlerError))
  } catch (error) {
    thrown = error
  }
  t.is(thrown, handlerError, "the work's own error is not replaced")

  const never = new Promise<string>(() => {})
  await t.exception(clock.within(never), DeadlineExceededError as unknown as new () => Error)
  await t.exception(
    clock.within(never),
    DeadlineExceededError as unknown as new () => Error,
    'work started after the deadline fails at once'
  )
})
