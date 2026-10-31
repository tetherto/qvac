import test from 'brittle'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { embedImage } from '@/plugins/builtin/ggml-image-embedding/ops/embed-image'
import { imageEmbeddingPlugin } from '@/plugins/builtin/ggml-image-embedding/plugin'
import { ModelType } from '@/schemas/index'
import { InferenceCancelledError, InvalidResponseError } from '@/errors/index'

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
  const result = await embedImage({
    type: 'embedImage',
    modelId: 'image-result',
    image: 'AQID',
    width: 1,
    height: 1,
    channels: 3,
    requestId: 'image-result-call'
  })
  t.alike(result.embedding, Array.from(descriptor))
  t.alike(result.stats, { totalTime: 12, backendId: 1, cpuFallbackNodes: 2, weightBytes: 1024 })
  t.alike(calls, [{ image: [1, 2, 3], options: { width: 1, height: 1, channels: 3 } }])
  await embedImage({ type: 'embedImage', modelId: 'image-result', image: 'AQID' })
  t.alike(calls[1], { image: [1, 2, 3], options: undefined })
  t.absent(getRequestRegistry().get('image-result-call'))
  t.alike(imageEmbeddingPlugin.handlers['embedImage']?.cancel, { scope: 'none' })
  t.absent('classify' in imageEmbeddingPlugin.handlers)
})

test('MegaLoc op rejects invalid wire RGB input before entering native inference', async (t) => {
  let runs = 0
  fixture(t, 'image-invalid', async () => {
    runs++
    return descriptor
  })
  await t.exception(() =>
    embedImage({
      type: 'embedImage',
      modelId: 'image-invalid',
      image: 'AQI=',
      width: 1,
      height: 1,
      channels: 3
    })
  )
  t.is(runs, 0)
})

test('MegaLoc errors release the request so the next embedding can succeed', async (t) => {
  let output = new Float32Array(1)
  fixture(t, 'image-recovery', async () => output)
  const request = {
    type: 'embedImage' as const,
    modelId: 'image-recovery',
    image: 'AQID',
    requestId: 'image-recovery-call'
  }
  await t.exception(() => embedImage(request), InvalidResponseError as unknown as new () => Error)
  t.absent(getRequestRegistry().get(request.requestId))
  output = descriptor
  t.alike((await embedImage(request)).embedding, Array.from(descriptor))
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
  const request = { type: 'embedImage' as const, modelId: 'image-queue', image: 'AQID' }
  const first = embedImage({ ...request, requestId: 'image-active' })
  const firstFailure = t.exception(
    () => first,
    InferenceCancelledError as unknown as new () => Error
  )
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 5))
  const queued = embedImage({ ...request, requestId: 'image-queued' })
  const queuedFailure = t.exception(
    () => queued,
    InferenceCancelledError as unknown as new () => Error
  )
  t.alike(
    (await embedImage({ ...request, modelId: 'image-independent' })).embedding,
    Array.from(descriptor)
  )
  t.is(getRequestRegistry().cancel({ requestId: 'image-queued' }), 1)
  await queuedFailure
  t.alike(starts, [1])
  t.is(getRequestRegistry().cancel({ requestId: 'image-active' }), 1)
  t.ok(getRequestRegistry().get('image-active'))
  const next = embedImage({ ...request, image: 'BAUG', requestId: 'image-next' })
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
