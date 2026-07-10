import test from 'brittle'
import env from 'bare-env'
import os from 'bare-os'
import path from 'bare-path'
import { send, stream, close } from '../src/dispatch'
import { registerPlugin, clearPlugins } from '../src/plugins'
import { ModelType } from '../src/schemas'
import type { Request, Response } from '../src/schemas'
import { PluginsNotRegisteredError, RequestValidationFailedError } from '../src/errors'
import { makeFakePlugin } from './fixtures/fake-plugin'

// Keep the storage-root lock out of the real home: the first `ensureReady`
// reads HOME once (bare-env is the live module object the engine reads), so
// point it at a throwaway dir before any dispatch runs.
env['HOME'] = path.join(os.tmpdir(), `qvac-core-test-${os.pid()}`)

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
