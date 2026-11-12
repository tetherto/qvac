import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { send, stream, close } from '@/dispatch'
import { registerPlugin, clearPlugins } from '@/plugins'
import { ModelType } from '@/schemas'
import type { Request, Response } from '@/schemas'
import { z } from 'zod'
import { AbortController } from 'bare-abort-controller'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import type { PluginHandlerContext, QvacPlugin } from '@/schemas/plugin'
import {
  InferenceCancelledError,
  RequestIdConflictError,
  OwnerOnlyError as OwnerOnly,
  PluginsNotRegisteredError,
  RequestValidationFailedError,
  SessionNotOpenError as SessionNotOpen
} from '@/errors'
import { clearSessions, openSession } from '@/runtime/session-registry'
import { makeFakePlugin } from './fixtures/fake-plugin'
import { TEST_CACHE_DIR } from './fixtures/test-cache'

// Keep the storage-root lock out of the real home: the first `ensureReady`
// reads HOME once (bare-env is the live module object the engine reads), so
// point it at a throwaway dir before any dispatch runs.
env['HOME'] = path.join(os.tmpdir(), `qvac-inference-test-${os.pid()}`)

const OwnerOnlyError = OwnerOnly as unknown as new () => Error
const SessionNotOpenError = SessionNotOpen as unknown as new () => Error
const InferenceCancelled = InferenceCancelledError as unknown as new () => Error

function fakeRequest(type: string): Request {
  return { type } as unknown as Request
}

test('send rejects with PluginsNotRegisteredError when nothing is assembled', async function (t) {
  clearPlugins()
  await t.exception(
    () => send(fakeRequest('heartbeat')),
    PluginsNotRegisteredError,
    'the readiness guard fires before any handler runs'
  )
  await close()
})

test('send dispatches a model-free request in-process to its handler', async function (t) {
  clearPlugins()
  registerPlugin(makeFakePlugin(ModelType.llamacppCompletion))
  try {
    const response = (await send(fakeRequest('heartbeat'))) as Response & { number: number }
    t.is(response.type, 'heartbeat', 'the heartbeat handler answered')
    t.is(typeof response.number, 'number', 'and returned its payload')
  } finally {
    await close()
    clearPlugins()
  }
})

test('send refuses a runtime-wide operation from a session before its handler runs', async function (t) {
  clearPlugins()
  clearSessions()
  registerPlugin(makeFakePlugin(ModelType.llamacppCompletion))
  openSession('s-owner-only')
  try {
    const heartbeat = await send({ type: 'heartbeat', sessionId: 's-owner-only' } as Request)
    t.is(heartbeat.type, 'heartbeat', 'an ordinary request runs as the session')
    await t.exception(
      () => send({ type: 'suspend', sessionId: 's-owner-only' } as Request),
      OwnerOnlyError,
      'suspend from a session is refused'
    )
    await t.exception(
      () => send({ type: 'deleteCache', all: true, sessionId: 's-owner-only' } as Request),
      OwnerOnlyError,
      'deleteCache from a session is refused'
    )
    await t.exception(
      () => send({ type: 'suspend', sessionId: 'never-opened' } as Request),
      SessionNotOpenError,
      'an unknown session fails the open check first'
    )
    const state = (await send({
      type: 'state',
      sessionId: 's-owner-only'
    } as Request)) as Response & {
      state: string
    }
    t.is(state.state, 'active', 'the runtime was never suspended')
  } finally {
    clearSessions()
    await close()
    clearPlugins()
  }
})

test('stream yields a non-streaming handler result as a single response', async function (t) {
  clearPlugins()
  registerPlugin(makeFakePlugin(ModelType.llamacppCompletion))
  try {
    const responses: Response[] = []
    for await (const response of stream(fakeRequest('heartbeat'))) {
      responses.push(response)
    }
    t.is(responses.length, 1, 'one response for a non-streaming handler')
    t.is(responses[0]?.type, 'heartbeat')
  } finally {
    await close()
    clearPlugins()
  }
})

test('send rejects an unknown request type at the validation guard', async function (t) {
  clearPlugins()
  registerPlugin(makeFakePlugin(ModelType.llamacppCompletion))
  try {
    await send(fakeRequest('__no_such_handler__'))
    t.fail('expected send to reject for an unknown request type')
  } catch (error) {
    t.ok(
      error instanceof RequestValidationFailedError,
      'an unknown type is not in the request-schema union, so the dispatch guard rejects it'
    )
  } finally {
    await close()
    clearPlugins()
  }
})

test('send rejects an invalid load config value at the validation guard', async function (t) {
  clearPlugins()
  registerPlugin(makeFakePlugin(ModelType.llamacppEmbedding))
  const request = {
    type: 'loadModel',
    modelType: ModelType.llamacppEmbedding,
    modelSrc: 'model.gguf',
    modelConfig: { pooling: 'rank' }
  } as unknown as Request
  try {
    await send(request)
    t.fail('expected send to reject an invalid modelConfig value')
  } catch (error) {
    t.ok(
      error instanceof RequestValidationFailedError,
      'device-default resolution parses the config, so its failure is a request validation failure'
    )
    t.ok((error as Error).message.includes('pooling'), 'the message names the field')
  } finally {
    await close()
    clearPlugins()
  }
})

test('send rejects an invalid candidate config value at the validation guard', async function (t) {
  clearPlugins()
  registerPlugin(makeFakePlugin(ModelType.llamacppEmbedding))
  const request = {
    type: 'assessModelFit',
    models: [
      {
        modelType: ModelType.llamacppEmbedding,
        modelSrc: 'model.gguf',
        modelConfig: { pooling: 'rank' }
      }
    ]
  } as unknown as Request
  try {
    await send(request)
    t.fail('expected send to reject an invalid candidate modelConfig value')
  } catch (error) {
    t.ok(
      error instanceof RequestValidationFailedError,
      'each candidate config is parsed the same way a load config is'
    )
    t.ok((error as Error).message.includes('pooling'), 'the message names the field')
  } finally {
    await close()
    clearPlugins()
  }
})

test('concurrent first sends share one initialization', async function (t) {
  // Force a resolvable on-disk config so `initializeConfig` calls `setConfig`.
  // With that, overlapping first calls that each ran their own initialization
  // would have the second `setConfig` throw `ConfigAlreadySetError`; the shared
  // readiness promise keeps it to exactly one.
  // Any key resolves the config; `loggerLevel` must not be the one, because
  // `setGlobalLogLevel` outlives this test and would override the explicit
  // level of every logger a later test builds.
  const configPath = path.join(os.tmpdir(), `qvac-inference-config-${os.pid()}.json`)
  fs.writeFileSync(
    configPath,
    JSON.stringify({ httpDownloadConcurrency: 3, cacheDirectory: TEST_CACHE_DIR })
  )
  const previousConfigPath = env['QVAC_CONFIG_PATH']
  env['QVAC_CONFIG_PATH'] = configPath

  clearPlugins()
  registerPlugin(makeFakePlugin(ModelType.llamacppCompletion))
  try {
    const responses = (await Promise.all([
      send(fakeRequest('heartbeat')),
      send(fakeRequest('heartbeat'))
    ])) as Response[]
    t.is(responses.length, 2, 'both concurrent first calls resolved')
    t.ok(
      responses.every((r) => r.type === 'heartbeat'),
      'neither call rejected on a duplicate setConfig'
    )
  } finally {
    await close()
    clearPlugins()
    // bare-env is a proxy that rejects `delete`; an empty string is falsy, so
    // `resolveConfig` ignores it just as an unset variable.
    env['QVAC_CONFIG_PATH'] = previousConfigPath ?? ''
    fs.unlinkSync(configPath)
  }
})

test('close during in-flight init does not latch readiness', async function (t) {
  clearPlugins()
  registerPlugin(makeFakePlugin(ModelType.llamacppCompletion))

  // Kick a first send so `performReady` is suspended at `initializeConfig`,
  // then close before it resolves. The suspended init must not flip `ready`
  // true after teardown — otherwise the next send skips the guard against a
  // closed engine. The racing send's own outcome is undefined, so swallow it.
  const pending = send(fakeRequest('heartbeat')).catch(() => {})
  await close()
  await pending

  clearPlugins()
  await t.exception(
    () => send(fakeRequest('heartbeat')),
    PluginsNotRegisteredError,
    'readiness was reset by close, so the guard runs again'
  )
  await close()
})

test('close resets readiness so the next call re-runs the guard', async function (t) {
  clearPlugins()
  registerPlugin(makeFakePlugin(ModelType.llamacppCompletion))
  await send(fakeRequest('heartbeat'))
  await close()

  // With readiness reset and no plugins, the guard must fire again — proving
  // close() cleared the memoized ready flag rather than leaving it latched.
  clearPlugins()
  await t.exception(() => send(fakeRequest('heartbeat')), PluginsNotRegisteredError)
  await close()
})

// The host passes the transport's per-request signal, which aborts when the
// caller cancels the request over the transport. That cancels the request's
// registered work, whether it has begun or not.

const WAIT_PLUGIN_TYPE = 'dispatch-transport-cancel-test'

function registerWaitingPlugin() {
  const seen = { started: 0, stopped: 0 }
  const plugin = {
    modelType: WAIT_PLUGIN_TYPE,
    displayName: 'Transport cancel',
    addonPackage: '@qvac/dispatch-transport-cancel-test',
    loadConfigSchema: z.looseObject({}),
    skipPrimaryModelPathValidation: true,
    createModel: () => ({ model: { load: async () => {}, unload: async () => {} } }),
    handlers: {
      wait: {
        requestSchema: z.object({}),
        responseSchema: z.object({}),
        streaming: false,
        handler: async (_request: unknown, _input: unknown, context?: PluginHandlerContext) => {
          seen.started++
          const signal = context!.signal!
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', () => resolve(), { once: true })
          })
          seen.stopped++
          return {}
        }
      }
    }
  } as unknown as QvacPlugin
  clearPlugins()
  registerPlugin(plugin)
  registerModel('transport-cancel-model', {
    model: { load: async () => {}, unload: async () => {} } as unknown as AnyModel,
    path: '/tmp/model.bin',
    config: {},
    modelType: WAIT_PLUGIN_TYPE as never
  })
  return seen
}

function waitInvoke(requestId?: string): Request {
  return {
    type: 'pluginInvoke',
    modelId: 'transport-cancel-model',
    handler: 'wait',
    params: {},
    ...(requestId === undefined ? {} : { requestId })
  } as unknown as Request
}

async function untilStarted(seen: { started: number }, count: number) {
  while (seen.started < count) await new Promise<void>((resolve) => setTimeout(resolve, 5))
}

test('a transport abort cancels the running request', async function (t) {
  const seen = registerWaitingPlugin()
  const transport = new AbortController()
  try {
    const running = send(waitInvoke('transport-running'), { signal: transport.signal })
    await untilStarted(seen, 1)

    transport.abort(undefined)

    await t.exception(running, InferenceCancelled, 'the request ends cancelled')
    t.is(seen.stopped, 1, 'the handler saw the cancel')
  } finally {
    unregisterModel('transport-cancel-model')
    await close()
    clearPlugins()
  }
})

test('a transport abort cancels a request that came without a request id', async function (t) {
  const seen = registerWaitingPlugin()
  const transport = new AbortController()
  try {
    const running = send(waitInvoke(), { signal: transport.signal })
    await untilStarted(seen, 1)

    transport.abort(undefined)

    await t.exception(running, InferenceCancelled)
    t.is(seen.stopped, 1, 'the handler saw the cancel')
  } finally {
    unregisterModel('transport-cancel-model')
    await close()
    clearPlugins()
  }
})

test('a cancelled duplicate of a running request leaves the running one alone', async function (t) {
  const seen = registerWaitingPlugin()
  const first = new AbortController()
  const duplicate = new AbortController()
  duplicate.abort(undefined)
  try {
    const running = send(waitInvoke('transport-dup'), { signal: first.signal })
    await untilStarted(seen, 1)

    await t.exception(
      send(waitInvoke('transport-dup'), { signal: duplicate.signal }),
      RequestIdConflictError as unknown as new () => Error
    )
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    t.is(seen.stopped, 0, 'the running request keeps running')

    first.abort(undefined)
    await t.exception(running, InferenceCancelled)
  } finally {
    unregisterModel('transport-cancel-model')
    await close()
    clearPlugins()
  }
})

test('a transport abort before the request begins keeps its work from running', async function (t) {
  const seen = registerWaitingPlugin()
  const transport = new AbortController()
  transport.abort(undefined)
  try {
    await t.exception(
      send(waitInvoke('transport-early'), { signal: transport.signal }),
      InferenceCancelled
    )
    t.is(seen.started, 0, 'the handler never ran')
  } finally {
    unregisterModel('transport-cancel-model')
    await close()
    clearPlugins()
  }
})
