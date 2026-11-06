import test from 'brittle'
import { AbortController } from 'bare-abort-controller'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/index'
import { InferenceCancelledError } from '@/errors'
import { ModelType } from '@/schemas'
import {
  clearRagEmbedParent,
  createWorkspaceEmbeddingFunction,
  getRagEmbedParent,
  setRagEmbedParent,
  stashQueryEmbedding,
  takeQueryEmbedding
} from '@/rag/embedding-scope'

// A workspace's RAG instance keeps one embedding function for its lifetime.
// These tests pin how that function finds the request it works for: the
// registered RAG operation on the workspace is its parent, and a search's
// query vector is handed over through the stash instead of embedded again.

const WS = 'embed-scope-ws'

function registerEmbedModel(modelId: string) {
  let release: () => void = () => {}
  const running = new Promise<void>((resolve) => {
    release = resolve
  })
  let runs = 0
  registerModel(modelId, {
    model: {
      load: async () => {},
      unload: () => {},
      pause: () => {},
      run: async () => {
        runs++
        return {
          iterate: async function* () {},
          cancel: async () => {},
          await: async () => {
            await running
            return [[new Float32Array([1, 0])]]
          }
        }
      },
      // The real addon fails the running job on cancel; the fake lets it return.
      addon: {
        cancel: async () => {
          release()
        }
      }
    } as unknown as AnyModel,
    path: '/models/embed.gguf',
    config: {},
    modelType: ModelType.llamacppEmbedding
  })
  return { release, runs: () => runs }
}

test('rag embedding: an embed runs as a child of the workspace operation', async (t) => {
  const modelId = 'embed-scope-child'
  const model = registerEmbedModel(modelId)
  const registry = getRequestRegistry()
  const parentAbort = new AbortController()
  const parent = { signal: parentAbort.signal, requestId: 'rag-1', sessionId: 's-1' }
  setRagEmbedParent(WS, parent)
  t.is(getRagEmbedParent(WS), parent)

  const embedding = createWorkspaceEmbeddingFunction(modelId, WS)
  const pending = embedding('chunk text')
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  const inner = registry.listBySession('s-1')
  t.is(inner.length, 1, 'the embed is registered under the operation session')
  t.is(inner[0]?.kind, 'embeddings')
  t.is(registry.cancel({ modelId, sessionId: 's-1' }), 1, 'a session cancel by model reaches it')
  await t.exception(pending, InferenceCancelledError as unknown as new () => Error)

  clearRagEmbedParent(WS, parent)
  t.is(getRagEmbedParent(WS), undefined)
  model.release()
  unregisterModel(modelId)
})

test('rag embedding: a parent abort aborts the embed', async (t) => {
  const modelId = 'embed-scope-parent-abort'
  const model = registerEmbedModel(modelId)
  const parentAbort = new AbortController()
  const parent = { signal: parentAbort.signal, requestId: 'rag-2', sessionId: undefined }
  setRagEmbedParent(WS, parent)

  const pending = createWorkspaceEmbeddingFunction(modelId, WS)('chunk text')
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  parentAbort.abort('sessionClosed')
  await t.exception(pending, InferenceCancelledError as unknown as new () => Error)

  clearRagEmbedParent(WS, parent)
  model.release()
  unregisterModel(modelId)
})

test('rag embedding: clearing another operation parent is a no-op', (t) => {
  const first = { signal: new AbortController().signal, requestId: 'r-1', sessionId: 'A' }
  const second = { signal: new AbortController().signal, requestId: 'r-2', sessionId: 'B' }
  setRagEmbedParent(WS, first)
  setRagEmbedParent(WS, second)
  clearRagEmbedParent(WS, first)
  t.is(getRagEmbedParent(WS), second, "the older operation's unwind leaves the newer parent")
  clearRagEmbedParent(WS, second)
  t.is(getRagEmbedParent(WS), undefined)
})

test('rag embedding: a stashed query vector is handed back once, without a model run', async (t) => {
  const modelId = 'embed-scope-stash'
  const model = registerEmbedModel(modelId)
  model.release()
  const embedding = createWorkspaceEmbeddingFunction(modelId, WS)

  stashQueryEmbedding(WS, 'the query', [0.5, 0.5])
  t.alike(await embedding('the query'), [0.5, 0.5])
  t.is(model.runs(), 0, 'the stashed vector replaces the model run')
  t.is(takeQueryEmbedding(WS, 'the query'), undefined, 'the stash is consumed')

  const again = await embedding('the query')
  t.is(model.runs(), 1, 'a later request for the same text embeds again')
  t.alike(again, [1, 0])
  unregisterModel(modelId)
})
