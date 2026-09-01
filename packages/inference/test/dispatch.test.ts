import test from 'brittle'
import env from 'bare-env'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { send, stream, close } from '@/dispatch'
import { registerPlugin, clearPlugins } from '@/plugins'
import { ModelType } from '@/schemas'
import type { Request, Response } from '@/schemas'
import { PluginsNotRegisteredError, RequestValidationFailedError } from '@/errors'
import { makeFakePlugin } from './fixtures/fake-plugin'

// Keep the storage-root lock out of the real home: the first `ensureReady`
// reads HOME once (bare-env is the live module object the engine reads), so
// point it at a throwaway dir before any dispatch runs.
env['HOME'] = path.join(os.tmpdir(), `qvac-inference-test-${os.pid()}`)

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

// Defaults apply before the request schema runs, so the retired key must
// reject in that first parse — a non-strict one would strip it.
test('send rejects a loadModel carrying retired n_discarded before any handler runs', async function (t) {
  clearPlugins()
  registerPlugin(makeFakePlugin(ModelType.llamacppCompletion))
  try {
    await send({
      type: 'loadModel',
      modelType: ModelType.llamacppCompletion,
      modelSrc: 'model.gguf',
      modelConfig: { ctx_size: 2048, n_discarded: 256 }
    } as unknown as Request)
    t.fail('expected the retired key to fail request preparation')
  } catch (error) {
    t.ok(
      error instanceof RequestValidationFailedError,
      'the defaults parse rejects as a structured validation failure, not a raw ZodError'
    )
    t.ok(
      error instanceof Error && /n_discarded/.test(error.message),
      'the failure names the retired key'
    )
  } finally {
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

test('concurrent first sends share one initialization', async function (t) {
  // Force a resolvable on-disk config so `initializeConfig` calls `setConfig`.
  // With that, overlapping first calls that each ran their own initialization
  // would have the second `setConfig` throw `ConfigAlreadySetError`; the shared
  // readiness promise keeps it to exactly one.
  // Any key resolves the config; `loggerLevel` must not be the one, because
  // `setGlobalLogLevel` outlives this test and would override the explicit
  // level of every logger a later test builds.
  const configPath = path.join(os.tmpdir(), `qvac-inference-config-${os.pid()}.json`)
  fs.writeFileSync(configPath, JSON.stringify({ httpDownloadConcurrency: 3 }))
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
