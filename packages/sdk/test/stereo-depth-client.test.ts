import test from 'brittle'
import { createEstimateDisparityCall } from '@/client/api/estimate-disparity'
import { summarizeRequest } from '@/logging/utils'
import { InvalidResponseError, RequestValidationFailedError } from '@/utils/errors-client'
import { InferenceCancelledError } from '@/utils/errors-server'
import { encodeFloat32Base64 } from '@qvac/inference/surface'

const left = new Uint8Array([1, 2, 3])
const right = new Uint8Array([4, 5, 6])
const values = Float32Array.from([0.5, 1.5, 2.5, 3.5, 4.5, 5.5])
const reply = {
  type: 'estimateDisparity',
  width: 3,
  height: 2,
  disparity: encodeFloat32Base64(values),
  stats: { totalTime: 40, backendId: 1, cpuFallbackNodes: 0 }
}

test('stereo client encodes both views, exposes requestId and decodes the map', async (t) => {
  let sent: unknown
  const send = async (input: unknown, options: unknown) => {
    sent = { input, options }
    return reply
  }
  const call = createEstimateDisparityCall(
    { modelId: 'm', left, right },
    { timeout: 1000 },
    send as never
  )
  t.ok(call.requestId)
  const result = await call
  t.is(result.width, 3)
  t.is(result.height, 2)
  t.ok(result.disparity instanceof Float32Array)
  t.alike(Array.from(result.disparity), Array.from(values))
  t.alike(result.stats, reply.stats)
  t.alike(sent, {
    input: {
      type: 'estimateDisparity',
      requestId: call.requestId,
      modelId: 'm',
      left: 'AQID',
      right: 'BAUG'
    },
    options: { timeout: 1000 }
  })
})

test('stereo client sends raw RGB dimensions with both views', async (t) => {
  const rgb = new Uint8Array(32 * 40 * 3)
  let sent: Record<string, unknown> = {}
  await createEstimateDisparityCall(
    { modelId: 'm', left: rgb, right: rgb, width: 32, height: 40, channels: 3 },
    undefined,
    (async (input: Record<string, unknown>) => {
      sent = input
      return reply
    }) as never
  )
  t.is(sent['width'], 32)
  t.is(sent['height'], 40)
  t.is(sent['channels'], 3)
})

test('stereo request logs image lengths and optional dimensions', (t) => {
  const request = {
    type: 'estimateDisparity' as const,
    modelId: 'm',
    requestId: 'stereo-call',
    left: 'AQID',
    right: 'BAUGBwg='
  }
  const summary = {
    type: 'estimateDisparity',
    modelId: 'm',
    left: '[4 base64 chars]',
    right: '[8 base64 chars]'
  }

  t.alike(summarizeRequest(request), summary)
  t.alike(summarizeRequest({ ...request, width: 32, height: 40, channels: 3 }), {
    ...summary,
    width: 32,
    height: 40
  })
})

test('stereo client rejects invalid pairs before RPC and malformed replies', async (t) => {
  let sends = 0
  const send = async () => {
    sends++
    return reply
  }
  const rgb = new Uint8Array(32 * 32 * 3)
  for (const params of [
    { left: new Uint8Array() },
    { right: new Uint8Array() },
    { left: 'AQID' },
    { width: 32 },
    { left: rgb, right: rgb, width: 16, height: 32, channels: 3 },
    { left: rgb, right: new Uint8Array(3), width: 32, height: 32, channels: 3 }
  ]) {
    await t.exception(
      createEstimateDisparityCall(
        { modelId: 'm', left, right, ...params } as never,
        undefined,
        send as never
      ),
      RequestValidationFailedError as unknown as new () => Error
    )
  }
  t.is(sends, 0)
  for (const bad of [
    { type: 'heartbeat' },
    { ...reply, width: 4 },
    { ...reply, disparity: 'not base64!' }
  ]) {
    await t.exception(
      createEstimateDisparityCall(
        { modelId: 'm', left, right },
        undefined,
        (async () => bad) as never
      ),
      InvalidResponseError as unknown as new () => Error
    )
  }
})

test('stereo client preserves cancellation and worker errors', async (t) => {
  for (const failure of [
    new InferenceCancelledError('stereo-call'),
    new Error('BridgeDepth GGUF weights not found')
  ]) {
    try {
      await createEstimateDisparityCall({ modelId: 'm', left, right }, undefined, (async () => {
        throw failure
      }) as never)
      t.fail('Expected transport failure')
    } catch (error) {
      t.is(error, failure)
    }
  }
})
