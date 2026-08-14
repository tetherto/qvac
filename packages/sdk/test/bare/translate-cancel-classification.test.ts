import test from 'brittle'
import { registerModel, unregisterModel } from '@/server/bare/registry/model-registry'
import { getRequestRegistry } from '@/server/bare/runtime'
import { ModelType } from '@/schemas'
import { translate } from '@/server/bare/ops/translate'
import type { AnyModel } from '@/server/bare/registry/model-registry'

// A cancelled LLM translate routes to this run's response.cancel(), so the addon
// rejects iterate() with a `Cancelled` error. That must be swallowed as a clean
// soft-cancel under an aborted signal — not leak to the client as a generic
// error. `iterate` aborts its own request, then throws, to force the ordering.
let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}-${Date.now()}`
}

function registerCancellingLlmTranslate(
  modelId: string,
  requestId: string,
  makeError: () => unknown
) {
  const registry = getRequestRegistry()
  registerModel(modelId, {
    model: {
      run: async () => ({
        iterate: async function* (): AsyncGenerator<string> {
          registry.cancel({ requestId })
          await new Promise((r) => setTimeout(r, 0))
          throw makeError()
        },
        stats: {},
        cancel: async () => {}
      })
    } as unknown as AnyModel,
    path: `/tmp/${modelId}.gguf`,
    config: {},
    modelType: ModelType.llamacppCompletion
  })
}

async function drain(modelId: string, requestId: string) {
  const gen = translate(
    {
      modelId,
      text: 'hello',
      from: 'en',
      to: 'es',
      stream: true,
      modelType: ModelType.llamacppCompletion
    } as never,
    requestId
  )
  for await (const _ of gen) void _
}

test('translate: an aborted LLM translate swallows a recognized addon Cancelled error', async (t) => {
  const modelId = makeId('llm-translate-cancel')
  const requestId = makeId('req')
  registerCancellingLlmTranslate(modelId, requestId, () =>
    Object.assign(new Error('run cancelled'), { code: '[ TextLlm :: Cancelled ]' })
  )

  let caught: unknown = null
  try {
    await drain(modelId, requestId)
  } catch (err) {
    caught = err
  }
  t.is(caught, null, 'a recognized addon cancellation under abort does not leak as a generic error')

  unregisterModel(modelId)
})

test('translate: an aborted LLM translate swallows the plain queued-cancel error', async (t) => {
  const modelId = makeId('llm-translate-queued-cancel')
  const requestId = makeId('req')
  // The published queued-cancel shape: a plain Error (no code) whose message is
  // the scheduler's "cancelled before it could run" — isAddonCancelledError matches
  // it by message, so it must also ride the soft-cancel path under an abort.
  registerCancellingLlmTranslate(
    modelId,
    requestId,
    () => new Error('request was cancelled before it could run')
  )

  let caught: unknown = null
  try {
    await drain(modelId, requestId)
  } catch (err) {
    caught = err
  }
  t.is(caught, null, 'the plain queued-cancel error under abort does not leak as a generic error')

  unregisterModel(modelId)
})

test('translate: an aborted LLM translate still propagates an unrelated addon error', async (t) => {
  const modelId = makeId('llm-translate-fail')
  const requestId = makeId('req')
  registerCancellingLlmTranslate(modelId, requestId, () => new Error('genuine decode failure'))

  let caught: unknown = null
  try {
    await drain(modelId, requestId)
  } catch (err) {
    caught = err
  }
  t.ok(
    caught instanceof Error && /genuine decode failure/.test(caught.message),
    'a real error racing the abort still propagates, not masked as cancellation'
  )

  unregisterModel(modelId)
})
