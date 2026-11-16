import test from 'brittle'
import { z } from 'zod'
import { clearPlugins, registerPlugin } from '@/plugins'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/index'
import { handlePluginInvokeStream } from '@/handlers/plugin-invoke'
import { InferenceCancelledError } from '@/errors'
import { requestParent, type PluginHandlerContext, type QvacPlugin } from '@/schemas/plugin'
import { openTestSessions } from './fixtures/sessions'

// A handler reached through `pluginInvoke` receives the invoke's request as
// its context. An op that registers its own request begins it with
// `requestParent(context)`, so the inner request runs as the caller's session
// and aborts with the invoke: a cancel of the invoke by id, or a close of the
// session, reaches the native job without waiting for the next chunk.

const PLUGIN_TYPE = 'invoke-context-test'

interface InnerRequest {
  sessionId: string
  requestId: string
}

function registerInnerPlugin(t: { teardown(fn: () => void): void }) {
  const seen: { inner: InnerRequest | undefined; innerAborted: boolean; contexts: unknown[] } = {
    inner: undefined,
    innerAborted: false,
    contexts: []
  }
  const plugin = {
    modelType: PLUGIN_TYPE,
    displayName: 'Invoke context',
    addonPackage: '@qvac/invoke-context-test',
    loadConfigSchema: z.looseObject({}),
    skipPrimaryModelPathValidation: true,
    createModel: () => ({ model: { load: async () => {}, unload: async () => {} } }),
    handlers: {
      inner: {
        requestSchema: z.object({ modelId: z.string(), sessionId: z.string().optional() }),
        responseSchema: z.object({ step: z.string() }),
        streaming: true,
        handler: async function* (
          request: { modelId: string; sessionId?: string },
          _inputStream?: AsyncIterable<unknown>,
          context?: PluginHandlerContext
        ) {
          seen.contexts.push(context)
          await using ctx = await getRequestRegistry().begin({
            requestId: `inner-${seen.contexts.length}`,
            sessionId: request.sessionId,
            ...requestParent(context),
            kind: 'diffusion',
            modelId: request.modelId
          })
          seen.inner = { sessionId: ctx.sessionId, requestId: ctx.requestId }
          ctx.signal.addEventListener('abort', () => {
            seen.innerAborted = true
          })
          yield { step: 'started' }
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) resolve()
            else ctx.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          yield { step: 'aborted' }
        }
      }
    }
  } as unknown as QvacPlugin
  clearPlugins()
  registerPlugin(plugin)
  t.teardown(() => clearPlugins())
  return seen
}

function sessionRequests(sessionId: string) {
  return getRequestRegistry()
    .list()
    .filter((ctx) => ctx.sessionId === sessionId)
}

function registerFakeModel(modelId: string) {
  registerModel(modelId, {
    model: { load: async () => {}, unload: async () => {} } as unknown as AnyModel,
    path: '/tmp/model.bin',
    config: {},
    modelType: PLUGIN_TYPE as never
  })
}

test('plugin invoke: the inner request runs as the caller session and aborts with the invoke', async (t) => {
  openTestSessions(t, 's-1')
  const seen = registerInnerPlugin(t)
  const modelId = 'invoke-context-cancel'
  registerFakeModel(modelId)
  const registry = getRequestRegistry()

  const stream = handlePluginInvokeStream({
    type: 'pluginInvokeStream',
    modelId,
    handler: 'inner',
    params: { modelId },
    requestId: 'r-outer',
    sessionId: 's-1'
  })
  const first = await stream.next()
  t.alike(first.value, { type: 'pluginInvokeStream', result: { step: 'started' }, done: false })
  t.alike(seen.contexts[0], {
    signal: registry.get('r-outer', 's-1')?.signal,
    requestId: 'r-outer',
    sessionId: 's-1'
  })
  t.is(seen.inner?.sessionId, 's-1', 'the inner request belongs to the caller session')
  t.not(seen.inner?.requestId, 'r-outer', 'the inner request has its own id')
  t.is(sessionRequests('s-1').length, 2, 'the invoke and the inner request are both registered')

  t.is(registry.cancel({ requestId: 'r-outer', sessionId: 's-1' }), 1)
  t.is(seen.innerAborted, true, 'the inner request aborted with the invoke, before the next chunk')

  await t.exception(stream.next(), InferenceCancelledError as unknown as new () => Error)
  t.is(sessionRequests('s-1').length, 0)
  unregisterModel(modelId)
})

test('plugin invoke: closing the session drains the inner request', async (t) => {
  openTestSessions(t, 's-2')
  const seen = registerInnerPlugin(t)
  const modelId = 'invoke-context-drain'
  registerFakeModel(modelId)
  const registry = getRequestRegistry()

  const stream = handlePluginInvokeStream({
    type: 'pluginInvokeStream',
    modelId,
    handler: 'inner',
    params: { modelId },
    requestId: 'r-drain',
    sessionId: 's-2'
  })
  await stream.next()

  const drain = registry.drainSession('s-2', 'sessionClosed')
  // The drain first waits for begins still in admission, then cancels.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  t.is(seen.innerAborted, true, 'the drain reached the inner request through the invoke')
  await t.exception(stream.next(), InferenceCancelledError as unknown as new () => Error)
  t.is(await drain, 1, 'the invoke is the session request the drain counted')
  t.is(sessionRequests('s-2').length, 0)
  unregisterModel(modelId)
})

test('plugin invoke: the owner invoke registers the inner request as the owner', async (t) => {
  const seen = registerInnerPlugin(t)
  const modelId = 'invoke-context-owner'
  registerFakeModel(modelId)
  const registry = getRequestRegistry()

  const stream = handlePluginInvokeStream({
    type: 'pluginInvokeStream',
    modelId,
    handler: 'inner',
    params: { modelId, sessionId: 'named-in-params' },
    requestId: 'r-owner'
  })
  await stream.next()
  t.is(seen.contexts[0] && (seen.contexts[0] as PluginHandlerContext).sessionId, undefined)
  t.is(seen.inner?.sessionId, 'owner', 'the context overrides a session named inside the params')

  registry.cancel({ requestId: 'r-owner' })
  await t.exception(stream.next(), InferenceCancelledError as unknown as new () => Error)
  unregisterModel(modelId)
})

test('plugin invoke: a handler called without a context registers a root request', async (t) => {
  openTestSessions(t, 's-3')
  const seen = registerInnerPlugin(t)
  const modelId = 'invoke-context-direct'
  registerFakeModel(modelId)
  const registry = getRequestRegistry()
  const { getPluginHandler } = await import('@/plugins')
  const handler = getPluginHandler(PLUGIN_TYPE, 'inner')!.handler as (
    request: unknown
  ) => AsyncGenerator<unknown>

  const stream = handler({ modelId, sessionId: 's-3' })
  await stream.next()
  t.is(seen.inner?.sessionId, 's-3', 'direct dispatch keeps the session the request names')
  registry.cancel({ requestId: seen.inner!.requestId, sessionId: 's-3' })
  await stream.next()
  await stream.return(undefined)
  unregisterModel(modelId)
})
