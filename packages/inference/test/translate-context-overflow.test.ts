import test from 'brittle'
import { registerModel, unregisterModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/index'
import { ModelType } from '@/schemas'
import { translate } from '@/plugins/ops/translate'
import type { AnyModel } from '@/runtime/model-registry'

// An LLM translate whose native iterate() rejects with `makeError()` right after
// the request's own signal is aborted — the race the fix guards: cancellation and
// a real addon error landing together. A context-overflow error must still surface
// (as completion does); any other error rides the soft-cancel path and is swallowed.
function registerThrowingLlmTranslate(
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
          await new Promise<void>((r) => setTimeout(r, 0))
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
  const it = gen[Symbol.asyncIterator]()
  for (let next = await it.next(); !next.done; next = await it.next()) void next
}

let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}-${idCounter}`
}

test('translate: a context-overflow error racing cancellation propagates, not swallowed', async (t) => {
  const modelId = makeId('llm-translate-overflow')
  const requestId = makeId('req')
  registerThrowingLlmTranslate(modelId, requestId, () =>
    Object.assign(new Error('the prompt exceeds the model context'), {
      code: '[ TextLlm :: ContextOverflow ]'
    })
  )

  let caught: unknown = null
  try {
    await drain(modelId, requestId)
  } catch (err) {
    caught = err
  }
  t.ok(
    caught instanceof Error &&
      /::\s*ContextOverflow\s*\]/.test((caught as { code?: string }).code ?? ''),
    'a context-overflow error surfaces even under an aborted signal'
  )

  unregisterModel(modelId)
})

test('translate: a non-overflow error racing cancellation is swallowed as a soft-cancel', async (t) => {
  const modelId = makeId('llm-translate-softcancel')
  const requestId = makeId('req')
  registerThrowingLlmTranslate(modelId, requestId, () => new Error('run cancelled'))

  let caught: unknown = null
  try {
    await drain(modelId, requestId)
  } catch (err) {
    caught = err
  }
  t.is(caught, null, 'a non-overflow error under abort does not leak as a generic error')

  unregisterModel(modelId)
})
