import test from 'brittle'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { embed, embedBatch } from '@/plugins/builtin/ggml-image-embedding/ops/embed'
import { imageEmbeddingPlugin } from '@/plugins/builtin/ggml-image-embedding/plugin'
import { ModelType } from '@/schemas/index'
import { EmbedFailedError, InferenceCancelledError, InvalidResponseError } from '@/errors/index'

const descriptor = Float32Array.from([1, ...new Array(8447).fill(0)])
const stats = { total_time_ms: 12, backend_id: 1, cpu_fallback_nodes: 2, weight_bytes: 1024 }

function fixture(
  t: { teardown(cleanup: () => void): void },
  id: string,
  embed: (image: Uint8Array, options?: unknown) => Promise<unknown>
) {
  registerModel(id, {
    model: { embed, getRuntimeStats: () => stats } as unknown as AnyModel,
    path: '/tmp/megaloc.gguf',
    config: {},
    modelType: ModelType.ggmlImageEmbedding
  })
  t.teardown(() => {
    unregisterModel(id)
  })
}

test('MegaLoc op preserves image bytes, RGB dimensions, descriptors and native statistics', async (t) => {
  const calls: unknown[] = []
  fixture(t, 'image-result', async (image, options) => {
    calls.push({ image: Array.from(image), options })
    return descriptor
  })
  const result = await embed({
    type: 'embed',
    modelId: 'image-result',
    input: { image: 'AQID', width: 1, height: 1, channels: 3 },
    requestId: 'image-result-call'
  })
  t.alike(result.embedding, Array.from(descriptor))
  t.alike(result.stats, { totalTime: 12, backendId: 1, cpuFallbackNodes: 2, weightBytes: 1024 })
  t.alike(calls, [{ image: [1, 2, 3], options: { width: 1, height: 1, channels: 3 } }])
  await embed({ type: 'embed', modelId: 'image-result', input: { image: 'AQID' } })
  t.alike(calls[1], { image: [1, 2, 3], options: undefined })
  t.absent(getRequestRegistry().get('image-result-call'))
  t.alike(imageEmbeddingPlugin.handlers['embed']?.cancel, { scope: 'none' })
  t.absent('classify' in imageEmbeddingPlugin.handlers)
})

test('MegaLoc op rejects invalid wire RGB input before entering native inference', async (t) => {
  let runs = 0
  fixture(t, 'image-invalid', async () => {
    runs++
    return descriptor
  })
  await t.exception(() =>
    embed({
      type: 'embed',
      modelId: 'image-invalid',
      input: { image: 'AQI=', width: 1, height: 1, channels: 3 }
    })
  )
  t.is(runs, 0)
})

test('MegaLoc errors release the request so the next embedding can succeed', async (t) => {
  let output = new Float32Array(1)
  fixture(t, 'image-recovery', async () => output)
  const request = {
    type: 'embed' as const,
    modelId: 'image-recovery',
    input: { image: 'AQID' },
    requestId: 'image-recovery-call'
  }
  await t.exception(() => embed(request), InvalidResponseError as unknown as new () => Error)
  t.absent(getRequestRegistry().get(request.requestId))
  output = descriptor
  t.alike((await embed(request)).embedding, Array.from(descriptor))
})

test('MegaLoc queues per model, cancels queued work and drops active cancelled results', async (t) => {
  const starts: number[] = []
  let finish: (value: Float32Array) => void = () => {}
  fixture(t, 'image-queue', async (image) => {
    starts.push(image[0]!)
    return new Promise<Float32Array>((resolve) => {
      finish = resolve
    })
  })
  fixture(t, 'image-independent', async () => descriptor)
  const request = { type: 'embed' as const, modelId: 'image-queue', input: { image: 'AQID' } }
  const first = embed({ ...request, requestId: 'image-active' })
  const firstFailure = t.exception(
    () => first,
    InferenceCancelledError as unknown as new () => Error
  )
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 5))
  const queued = embed({ ...request, requestId: 'image-queued' })
  const queuedFailure = t.exception(
    () => queued,
    InferenceCancelledError as unknown as new () => Error
  )
  t.alike(
    (await embed({ ...request, modelId: 'image-independent' })).embedding,
    Array.from(descriptor)
  )
  t.is(getRequestRegistry().cancel({ requestId: 'image-queued' }), 1)
  await queuedFailure
  t.alike(starts, [1])
  t.is(getRequestRegistry().cancel({ requestId: 'image-active' }), 1)
  t.ok(getRequestRegistry().get('image-active'))
  const next = embed({ ...request, input: { image: 'BAUG' }, requestId: 'image-next' })
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 5))
  t.alike(starts, [1])
  finish(descriptor)
  await firstFailure
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 5))
  t.alike(starts, [1, 4])
  finish(descriptor)
  await next
  t.absent(getRequestRegistry().get('image-active'))
  t.absent(getRequestRegistry().get('image-next'))
})

test('MegaLoc embed and embedBatch preserve order, single shape and batch statistics', async (t) => {
  const seen: number[] = []
  fixture(t, 'image-batch', async (image) => {
    seen.push(image[0]!)
    return image[0] === 1 ? descriptor : Float32Array.from([0, 1, ...new Array(8446).fill(0)])
  })
  const single = await embed({ type: 'embed', modelId: 'image-batch', input: { image: 'AQID' } })
  const batch = await embedBatch({
    type: 'embedBatch',
    modelId: 'image-batch',
    inputs: [{ image: 'AQID' }, [{ media: { type: 'base64', value: 'BAUG' } }]],
    requestId: 'image-batch-call'
  })
  t.alike(batch.embedding[0], single.embedding)
  t.is(batch.embedding[1]![1], 1)
  t.alike(seen, [1, 1, 4])
  t.is(batch.stats.totalTime, 24)
  t.is(batch.stats.backendId, 1)
  t.absent(getRequestRegistry().get('image-batch-call'))
  t.alike(
    (await embedBatch({ type: 'embedBatch', modelId: 'image-batch', inputs: [{ image: 'AQID' }] }))
      .embedding,
    [single.embedding]
  )
  t.alike(
    (
      await embed({
        type: 'embed',
        modelId: 'image-batch',
        inputs: [[{ media: { type: 'base64', value: 'AQID' } }]]
      })
    ).embedding,
    [single.embedding]
  )
  await t.exception(
    // @ts-expect-error The legacy inputs batch takes text or media parts. Images use embedBatch.
    embed({ type: 'embed', modelId: 'image-batch', inputs: [{ image: 'AQID' }] })
  )
})

test('MegaLoc batch validates all inputs before native work and stops after cancellation', async (t) => {
  let runs = 0
  fixture(t, 'image-batch-cancel', async () => {
    runs++
    getRequestRegistry().cancel({ requestId: 'cancel-image-batch' })
    return descriptor
  })
  await t.exception(
    embedBatch({
      type: 'embedBatch',
      modelId: 'image-batch-cancel',
      inputs: [{ image: 'AQID' }, 'text']
    }),
    /one image/
  )
  t.is(runs, 0)
  await t.exception(
    embedBatch({
      type: 'embedBatch',
      modelId: 'image-batch-cancel',
      inputs: [{ image: 'AQID' }, { image: 'BAUG' }],
      requestId: 'cancel-image-batch'
    }),
    InferenceCancelledError as unknown as new () => Error
  )
  t.is(runs, 1)
  t.absent(getRequestRegistry().get('cancel-image-batch'))
})

test('MegaLoc rejects mismatched RGB bytes without waiting behind an active call', async (t) => {
  let finish: (value: Float32Array) => void = () => {}
  fixture(t, 'image-busy', async () => new Promise<Float32Array>((resolve) => (finish = resolve)))
  const active = embed({ type: 'embed', modelId: 'image-busy', input: { image: 'AQID' } })
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 5))
  await t.exception(
    embed({
      type: 'embed',
      modelId: 'image-busy',
      input: { image: 'AQIDBA==', width: 1, height: 1, channels: 3 }
    }),
    /byte length/
  )
  finish(descriptor)
  await active
})

test('MegaLoc wraps unreadable file media in EmbedFailedError', async (t) => {
  let runs = 0
  fixture(t, 'image-missing-file', async () => {
    runs++
    return descriptor
  })
  await t.exception(
    embedBatch({
      type: 'embedBatch',
      modelId: 'image-missing-file',
      inputs: [[{ media: { type: 'filePath', value: '/nonexistent/megaloc-test.jpg' } }]]
    }),
    EmbedFailedError as unknown as new () => Error
  )
  t.is(runs, 0)
})

test('MegaLoc batch keeps summed totalTime when the final image reports none', async (t) => {
  const perCall = [{ total_time_ms: 5, backend_id: 1 }, { total_time_ms: 7 }, { backend_id: 2 }]
  let call = 0
  registerModel('image-partial-stats', {
    model: {
      embed: async () => descriptor,
      getRuntimeStats: () => perCall[call++]
    } as unknown as AnyModel,
    path: '/tmp/megaloc.gguf',
    config: {},
    modelType: ModelType.ggmlImageEmbedding
  })
  t.teardown(() => {
    unregisterModel('image-partial-stats')
  })
  const result = await embedBatch({
    type: 'embedBatch',
    modelId: 'image-partial-stats',
    inputs: [{ image: 'AQID' }, { image: 'AQID' }, { image: 'AQID' }]
  })
  t.alike(result.stats, { totalTime: 12, backendId: 2 })
})
