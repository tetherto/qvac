import test from 'brittle'
import { registerModel, unregisterModel, type AnyModel } from '@/runtime/model-registry'
import { getRequestRegistry } from '@/runtime/request-context'
import { estimateDisparity } from '@/plugins/builtin/ggml-stereo-depth/ops/estimate-disparity'
import { stereoDepthPlugin } from '@/plugins/builtin/ggml-stereo-depth/plugin'
import { ModelType, decodeFloat32Base64 } from '@/schemas/index'
import { InferenceCancelledError, InvalidResponseError } from '@/errors/index'

const stats = { total_time_ms: 40, backend_id: 1, cpu_fallback_nodes: 0, weight_bytes: 196 }

function disparityMap(width: number, height: number) {
  return {
    width,
    height,
    disparity: Float32Array.from({ length: width * height }, (_, i) => i + 0.5)
  }
}

type Infer = (left: Uint8Array, right: Uint8Array, options?: unknown) => Promise<unknown>

function fixture(t: { teardown(cleanup: () => void): void }, id: string, infer: Infer) {
  registerModel(id, {
    model: { infer, getRuntimeStats: () => stats } as unknown as AnyModel,
    path: '/tmp/bridgedepth-vits-f32.gguf',
    config: {},
    modelType: ModelType.ggmlStereoDepth
  })
  t.teardown(() => {
    unregisterModel(id)
  })
}

// 'AQID' and 'BAUG' are base64 of [1, 2, 3] and [4, 5, 6].
const pair = { left: 'AQID', right: 'BAUG' }

test('BridgeDepth op passes both views and RGB dimensions and returns the map with stats', async (t) => {
  const calls: unknown[] = []
  fixture(t, 'stereo-result', async (left, right, options) => {
    calls.push({ left: Array.from(left), right: Array.from(right), options })
    const { width = 3, height = 2 } = (options ?? {}) as { width?: number; height?: number }
    return disparityMap(width, height)
  })
  const result = await estimateDisparity({
    type: 'estimateDisparity',
    modelId: 'stereo-result',
    ...pair,
    requestId: 'stereo-result-call'
  })
  t.is(result.type, 'estimateDisparity')
  t.is(result.width, 3)
  t.is(result.height, 2)
  t.alike(Array.from(decodeFloat32Base64(result.disparity)), [0.5, 1.5, 2.5, 3.5, 4.5, 5.5])
  t.alike(result.stats, { totalTime: 40, backendId: 1, cpuFallbackNodes: 0, weightBytes: 196 })
  t.alike(calls, [{ left: [1, 2, 3], right: [4, 5, 6], options: undefined }])
  t.absent(getRequestRegistry().get('stereo-result-call'))

  const rgb = 'A'.repeat((32 * 32 * 3 * 4) / 3)
  await estimateDisparity({
    type: 'estimateDisparity',
    modelId: 'stereo-result',
    left: rgb,
    right: rgb,
    width: 32,
    height: 32,
    channels: 3
  })
  t.alike((calls[1] as { options: unknown }).options, { width: 32, height: 32, channels: 3 })
  t.alike(stereoDepthPlugin.handlers['estimateDisparity']?.cancel, { scope: 'none' })
  t.is(stereoDepthPlugin.modelType, ModelType.ggmlStereoDepth)
})

test('BridgeDepth op rejects mismatched RGB bytes and partial dimensions before native work', async (t) => {
  let runs = 0
  fixture(t, 'stereo-invalid', async () => {
    runs++
    return disparityMap(1, 1)
  })
  const rgb = 'A'.repeat((32 * 32 * 3 * 4) / 3)
  await t.exception(
    estimateDisparity({
      type: 'estimateDisparity',
      modelId: 'stereo-invalid',
      left: rgb,
      right: 'AQID',
      width: 32,
      height: 32,
      channels: 3
    }),
    /byte length/
  )
  await t.exception(
    estimateDisparity({
      type: 'estimateDisparity',
      modelId: 'stereo-invalid',
      ...pair,
      width: 32
    }),
    /width, height and channels together/
  )
  t.is(runs, 0)
})

test('BridgeDepth op rejects a map whose size does not match its values', async (t) => {
  let output: unknown = { width: 2, height: 2, disparity: new Float32Array(3) }
  fixture(t, 'stereo-bad-output', async () => output)
  const request = {
    type: 'estimateDisparity' as const,
    modelId: 'stereo-bad-output',
    ...pair,
    requestId: 'stereo-bad-output-call'
  }
  await t.exception(
    () => estimateDisparity(request),
    InvalidResponseError as unknown as new () => Error
  )
  t.absent(getRequestRegistry().get(request.requestId))
  output = disparityMap(2, 2)
  t.is((await estimateDisparity(request)).width, 2)
})

test('BridgeDepth op rejects a map that is not the raw RGB input size', async (t) => {
  let output = disparityMap(32, 16)
  fixture(t, 'stereo-wrong-size', async () => output)
  const rgb = 'A'.repeat((32 * 32 * 3 * 4) / 3)
  const request = {
    type: 'estimateDisparity' as const,
    modelId: 'stereo-wrong-size',
    left: rgb,
    right: rgb,
    width: 32,
    height: 32,
    channels: 3 as const,
    requestId: 'stereo-wrong-size-call'
  }
  await t.exception(
    () => estimateDisparity(request),
    InvalidResponseError as unknown as new () => Error
  )
  t.absent(getRequestRegistry().get(request.requestId))
  output = disparityMap(32, 32)
  t.is((await estimateDisparity(request)).height, 32)
})

test('BridgeDepth queues per model, cancels queued work and drops active cancelled results', async (t) => {
  const starts: number[] = []
  let finish: (value: unknown) => void = () => {}
  fixture(t, 'stereo-queue', async (left) => {
    starts.push(left[0]!)
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const request = { type: 'estimateDisparity' as const, modelId: 'stereo-queue', ...pair }
  const first = estimateDisparity({ ...request, requestId: 'stereo-active' })
  const firstFailure = t.exception(
    () => first,
    InferenceCancelledError as unknown as new () => Error
  )
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 5))
  const queued = estimateDisparity({ ...request, requestId: 'stereo-queued' })
  const queuedFailure = t.exception(
    () => queued,
    InferenceCancelledError as unknown as new () => Error
  )
  t.is(getRequestRegistry().cancel({ requestId: 'stereo-queued' }), 1)
  await queuedFailure
  t.alike(starts, [1])

  t.is(getRequestRegistry().cancel({ requestId: 'stereo-active' }), 1)
  const next = estimateDisparity({ ...request, left: 'BAUG', requestId: 'stereo-next' })
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 5))
  t.alike(starts, [1])
  finish(disparityMap(1, 1))
  await firstFailure
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 5))
  t.alike(starts, [1, 4])
  finish(disparityMap(1, 1))
  t.is((await next).width, 1)
  t.absent(getRequestRegistry().get('stereo-active'))
  t.absent(getRequestRegistry().get('stereo-next'))
})

test('BridgeDepth op releases the request when the addon throws', async (t) => {
  let fail = true
  fixture(t, 'stereo-recovery', async () => {
    if (fail) throw new Error('BridgeDepth input sides must be between 32 and 4096')
    return disparityMap(1, 1)
  })
  const request = {
    type: 'estimateDisparity' as const,
    modelId: 'stereo-recovery',
    ...pair,
    requestId: 'stereo-recovery-call'
  }
  await t.exception(() => estimateDisparity(request), /between 32 and 4096/)
  t.absent(getRequestRegistry().get(request.requestId))
  fail = false
  t.is((await estimateDisparity(request)).height, 1)
})
