import test from 'brittle'
import Buffer from 'bare-buffer'
import { getAddonFromEngine } from '@/schemas/engine-addon-map'
import {
  ModelType,
  configSchemaForModelType,
  decodeFloat32Base64,
  encodeFloat32Base64,
  estimateDisparityClientParamsSchema,
  estimateDisparityRequestSchema,
  estimateDisparityResponseSchema,
  loadModelOptionsBaseSchema,
  loadModelOptionsToRequestSchema,
  loadModelSrcRequestSchema,
  requestSchema,
  responseSchema,
  stereoDepthConfigSchema
} from '@/schemas/index'
import { summarizeRequest } from '@/logging/utils'

test('BridgeDepth loading requires a source and preserves backend options across the wire', (t) => {
  const options = {
    modelType: ModelType.ggmlStereoDepth,
    modelSrc: '/tmp/bridgedepth-vits-f32.gguf',
    modelConfig: { backend: 'Vulkan0', threads: 8, backendsDir: '/tmp/backends' }
  }
  t.ok(loadModelOptionsBaseSchema.safeParse(options).success)
  const request = loadModelOptionsToRequestSchema.parse(options)
  t.is(request.modelType, ModelType.ggmlStereoDepth)
  t.alike(request.modelConfig, options.modelConfig)
  t.ok(loadModelSrcRequestSchema.safeParse(request).success)
  t.is(configSchemaForModelType(ModelType.ggmlStereoDepth), stereoDepthConfigSchema)
  t.is(getAddonFromEngine(ModelType.ggmlStereoDepth), 'classification')
  t.absent(loadModelOptionsBaseSchema.safeParse({ modelType: options.modelType }).success)
  for (const modelConfig of [
    { threads: 0 },
    { threads: 1025 },
    { backend: '' },
    { topK: 1 },
    { modelPath: '/tmp/other.gguf' }
  ]) {
    t.absent(loadModelOptionsBaseSchema.safeParse({ ...options, modelConfig }).success)
    t.absent(loadModelSrcRequestSchema.safeParse({ ...request, modelConfig }).success)
  }
})

test('stereo client params accept encoded pairs or a complete packed RGB description', (t) => {
  const rgb = new Uint8Array(32 * 40 * 3)
  t.ok(
    estimateDisparityClientParamsSchema.safeParse({
      modelId: 'm',
      left: new Uint8Array([1]),
      right: new Uint8Array([2])
    }).success
  )
  t.ok(
    estimateDisparityClientParamsSchema.safeParse({
      modelId: 'm',
      left: rgb,
      right: rgb,
      width: 32,
      height: 40,
      channels: 3
    }).success
  )
  for (const params of [
    { left: new Uint8Array() },
    { right: new Uint8Array() },
    { width: 32 },
    { width: 32, height: 40 },
    { width: 31, height: 40, channels: 3, left: new Uint8Array(31 * 40 * 3) },
    { width: 4097, height: 40, channels: 3, left: new Uint8Array(4097 * 40 * 3) },
    { width: 32, height: 40, channels: 4 },
    { width: 32, height: 40, channels: 3, right: new Uint8Array(3) },
    { modelId: '' }
  ]) {
    t.absent(
      estimateDisparityClientParamsSchema.safeParse({
        modelId: 'm',
        left: rgb,
        right: rgb,
        ...params
      }).success,
      JSON.stringify(Object.keys(params))
    )
  }
})

test('stereo requests are registered tracked messages with valid base64 views', (t) => {
  const request = {
    type: 'estimateDisparity',
    modelId: 'm',
    left: 'AQID',
    right: 'BAUG',
    requestId: 'stereo-call',
    sessionId: 'session'
  }
  t.ok(requestSchema.safeParse(request).success)
  t.ok(estimateDisparityRequestSchema.safeParse(request).success)
  for (const left of ['', 'not base64!', 'A']) {
    t.absent(estimateDisparityRequestSchema.safeParse({ ...request, left }).success)
  }
  t.alike(summarizeRequest(estimateDisparityRequestSchema.parse(request)), {
    type: 'estimateDisparity',
    modelId: 'm',
    left: '[4 base64 chars]',
    right: '[4 base64 chars]'
  })
})

test('stereo responses carry width * height float32 values as base64', (t) => {
  const values = Float32Array.from([0, 1.25, -2, 1e-3, 128.5, Number.POSITIVE_INFINITY])
  const reply = {
    type: 'estimateDisparity',
    width: 3,
    height: 2,
    disparity: encodeFloat32Base64(values),
    stats: { totalTime: 5, backendId: 0, cpuFallbackNodes: 0, weightBytes: 1024 }
  }
  t.ok(responseSchema.safeParse(reply).success)
  t.ok(estimateDisparityResponseSchema.safeParse(reply).success)
  t.absent(estimateDisparityResponseSchema.safeParse({ ...reply, width: 2 }).success)
  t.absent(estimateDisparityResponseSchema.safeParse({ ...reply, disparity: 'x' }).success)
})

test('float32 wire codec round-trips with and without Buffer and owns its bytes', (t) => {
  // `undefined` would select the default (global Buffer when present), so
  // `null` forces the btoa/atob branch.
  const NO_BUFFER = null as never
  const values = Float32Array.from({ length: 1000 }, (_, i) => i / 7 - 3)
  const encoded = encodeFloat32Base64(values, Buffer)
  t.is(encodeFloat32Base64(values, NO_BUFFER), encoded)
  t.alike(Array.from(decodeFloat32Base64(encoded, Buffer)), Array.from(values))
  const decoded = decodeFloat32Base64(encoded, NO_BUFFER)
  t.alike(Array.from(decoded), Array.from(values))
  t.is(decoded.byteOffset, 0)
  t.is(decoded.buffer.byteLength, values.byteLength)

  const view = new Float32Array(values.buffer, 8, 4)
  t.alike(Array.from(decodeFloat32Base64(encodeFloat32Base64(view, Buffer))), Array.from(view))
  // A small Buffer decode is a view into a shared pool; the result must not be.
  const small = decodeFloat32Base64(encodeFloat32Base64(Float32Array.of(1, 2)), Buffer)
  t.is(small.buffer.byteLength, 8)
})
