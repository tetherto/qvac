import test from 'brittle'
import { llmPlugin } from '@/server/bare/plugins/llamacpp-completion/plugin'
import {
  clearRegistry,
  registerModel,
  unregisterModel,
  type AnyModel
} from '@/server/bare/registry/model-registry'
import { getRequestRegistry } from '@/server/bare/runtime'
import { ModelType } from '@/schemas'
import { ContextOverflowError } from '@/utils/errors-server'

// -----------------------------------------------------------------------------
// QVAC-19346 regression — cancelling a *queued* same-model completion must not
// touch the shared native context the active request is decoding on.
//
// A loaded llama.cpp model is one native context. When a second completion is
// queued behind an active one (default policy serializes them) and the client
// then cancels the queued request, `begin()` resolves the queued request into
// an already-aborted context. The handler must NOT proceed to build the
// completion stream — doing so would call `addon.cancel()` / `model.run()` on
// the model the active request is still using, cancelling or corrupting it.
//
// Requires the Bare runtime (the plugin pulls in the N-API addon at import).
// -----------------------------------------------------------------------------

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

type LooseHandler = (
  request: unknown
) => AsyncGenerator<
  { type: string; done?: boolean; events: { type: string; stopReason?: string }[] },
  unknown,
  unknown
>

test('completion: cancelling a queued request never touches the active model addon', async (t) => {
  clearRegistry()
  const modelId = `queued-cancel-model-${Date.now()}`

  let runCalls = 0
  let addonCancelCalls = 0
  registerModel(modelId, {
    model: {
      run() {
        runCalls++
        throw new Error('model.run() must not be called for a queued+cancelled request')
      },
      addon: {
        cancel() {
          addonCancelCalls++
          return Promise.resolve()
        }
      }
    } as unknown as AnyModel,
    path: '/tmp/queued-cancel-model.gguf',
    config: {},
    modelType: ModelType.llamacppCompletion
  })

  const registry = getRequestRegistry()
  // Occupy the single completion slot for this model so the handler's request
  // queues behind it instead of running.
  const holder = await registry.begin({
    requestId: `active-${modelId}`,
    kind: 'completion',
    modelId
  })

  const handler = llmPlugin.handlers.completionStream.handler as unknown as LooseHandler
  const queuedRequestId = `queued-${modelId}`
  const gen = handler({
    modelId,
    requestId: queuedRequestId,
    history: [
      { role: 'system', content: 'You are a helpful assistant.', attachments: [] },
      { role: 'user', content: 'hello', attachments: [] }
    ],
    stream: true
  })

  // Start the generator — it runs up to `await begin()` and then waits in the
  // FIFO queue behind `holder`.
  const pending = gen.next()
  await settle()

  // Stop button on the still-queued request.
  const cancelled = registry.cancel({ requestId: queuedRequestId })
  t.is(cancelled, 1, 'the queued completion was cancelled')

  const first = await pending
  if (first.done) {
    t.fail('the generator returned before yielding a terminal event')
    await holder[Symbol.asyncDispose]()
    unregisterModel(modelId)
    clearRegistry()
    return
  }
  const event = first.value
  t.is(event.done, true, 'the yielded completion event is the terminal (done) event')
  const doneEvent = event.events.find((e) => e.type === 'completionDone')
  t.ok(doneEvent, 'a completionDone event is emitted')
  t.is(doneEvent?.stopReason, 'cancelled', 'and it reports a cancelled stopReason')

  const tail = await gen.next()
  t.is(tail.done, true, 'the generator returns after the terminal event')

  t.is(runCalls, 0, 'model.run() was never called for the queued+cancelled request')
  t.is(
    addonCancelCalls,
    0,
    "addon.cancel() was never called — the active request's context is untouched"
  )

  await holder[Symbol.asyncDispose]()
  unregisterModel(modelId)
  clearRegistry()
})

// The completion catch must classify a real typed error FIRST, so a failure
// that merely races an abort (cancel / unload / shutdown) is not masked as a
// cancellation. `iterate` aborts its own request, then throws, to force the
// error-under-abort ordering deterministically.
function registerThrowingModel(modelId: string, makeError: () => unknown): void {
  const registry = getRequestRegistry()
  registerModel(modelId, {
    model: {
      run() {
        return {
          iterate: async function* (): AsyncGenerator<string> {
            registry.cancel({ requestId: `req-${modelId}` })
            await settle()
            throw makeError()
          },
          await: () => Promise.resolve(),
          cancel: () => Promise.resolve(),
          stats: {}
        }
      },
      addon: { cancel: () => Promise.resolve() }
    } as unknown as AnyModel,
    path: `/tmp/${modelId}.gguf`,
    config: {},
    modelType: ModelType.llamacppCompletion
  })
}

function runToCompletion(modelId: string) {
  const handler = llmPlugin.handlers.completionStream.handler as unknown as LooseHandler
  return handler({
    modelId,
    requestId: `req-${modelId}`,
    history: [
      { role: 'system', content: 'You are a helpful assistant.', attachments: [] },
      { role: 'user', content: 'hello', attachments: [] }
    ],
    stream: true
  })
}

test('completion: a context overflow racing an abort surfaces as ContextOverflowError, not masked', async (t) => {
  clearRegistry()
  const modelId = `overflow-abort-${Date.now()}`
  registerThrowingModel(modelId, () =>
    Object.assign(new Error('context overflow at prefill step (5000 tokens, max 4096)'), {
      code: '[ TextLlm :: ContextOverflow ]'
    })
  )

  let caught: unknown = null
  try {
    for await (const _ of runToCompletion(modelId)) void _
  } catch (err) {
    caught = err
  }
  t.ok(
    caught instanceof ContextOverflowError,
    'a real overflow racing the abort still throws ContextOverflowError, not InferenceCancelledError'
  )

  unregisterModel(modelId)
  clearRegistry()
})

test('completion: accepted cancellation wins over addon rejection shape', async (t) => {
  clearRegistry()
  const modelId = `addon-cancel-${Date.now()}`
  registerThrowingModel(modelId, () => new Error('opaque addon failure'))

  let caught: unknown = null
  let cancelledReason: string | undefined
  try {
    for await (const ev of runToCompletion(modelId)) {
      const done = ev.events.find((e) => e.type === 'completionDone')
      if (done) cancelledReason = done.stopReason
    }
  } catch (err) {
    caught = err
  }
  t.is(caught, null, 'an addon rejection after accepted cancellation does not throw')
  t.is(cancelledReason, 'cancelled', 'the request signal determines the terminal outcome')

  unregisterModel(modelId)
  clearRegistry()
})
