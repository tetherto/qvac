import test from 'brittle'
import { registerModel, unregisterModel } from '@/server/bare/registry/model-registry'
import { getRequestRegistry } from '@/server/bare/runtime'
import { ModelType } from '@/schemas'
import { translate } from '@/server/bare/ops/translate'
import type { AnyModel } from '@/server/bare/registry/model-registry'

// Once cancellation is accepted, the SDK-owned request signal determines the
// terminal outcome; addon rejection shape is an internal transport detail.
let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}-${Date.now()}`
}

function registerCancellingLlmTranslate(
  modelId: string,
  requestId: string,
  makeError: () => unknown,
  cancelBeforeThrow = true
) {
  const registry = getRequestRegistry()
  registerModel(modelId, {
    model: {
      run: async () => ({
        iterate: async function* (): AsyncGenerator<string> {
          if (cancelBeforeThrow) {
            registry.cancel({ requestId })
            await new Promise((r) => setTimeout(r, 0))
          }
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

test('translate: accepted cancellation wins over addon rejection shape', async (t) => {
  const modelId = makeId('llm-translate-cancel')
  const requestId = makeId('req')
  registerCancellingLlmTranslate(modelId, requestId, () => new Error('opaque addon failure'))

  let caught: unknown = null
  try {
    await drain(modelId, requestId)
  } catch (err) {
    caught = err
  }
  t.is(caught, null, 'an addon rejection after accepted cancellation ends cleanly')

  unregisterModel(modelId)
})

test('translate: addon errors propagate when cancellation was not accepted', async (t) => {
  const modelId = makeId('llm-translate-fail')
  const requestId = makeId('req')
  registerCancellingLlmTranslate(
    modelId,
    requestId,
    () => new Error('genuine decode failure'),
    false
  )

  let caught: unknown = null
  try {
    await drain(modelId, requestId)
  } catch (err) {
    caught = err
  }
  t.ok(
    caught instanceof Error && /genuine decode failure/.test(caught.message),
    'without an accepted cancellation, the addon error still propagates'
  )

  unregisterModel(modelId)
})
