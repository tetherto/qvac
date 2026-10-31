import { getAddonFromEngine } from '@/schemas/engine-addon-map'
import test from 'brittle'
import {
  ModelType,
  embedImageClientParamsSchema,
  embedImageRequestSchema,
  embedImageResponseSchema,
  imageEmbeddingConfigSchema,
  loadModelOptionsBaseSchema,
  loadModelOptionsToRequestSchema,
  loadModelSrcRequestSchema,
  configSchemaForModelType,
  requestSchema,
  responseSchema
} from '@/schemas/index'

test('MegaLoc loading requires a source and preserves backend options across the wire', (t) => {
  const options = {
    modelType: ModelType.ggmlImageEmbedding,
    modelSrc: '/tmp/megaloc-f16.gguf',
    modelConfig: { backend: 'MTL0', threads: 1024, backendsDir: '/tmp/backends' }
  }
  t.ok(loadModelOptionsBaseSchema.safeParse(options).success)
  const request = loadModelOptionsToRequestSchema.parse(options)
  t.alike(request.modelConfig, options.modelConfig)
  t.ok(loadModelSrcRequestSchema.safeParse(request).success)
  t.is(configSchemaForModelType(ModelType.ggmlImageEmbedding), imageEmbeddingConfigSchema)
  t.is(getAddonFromEngine(ModelType.ggmlImageEmbedding), 'classification')
  t.absent(loadModelOptionsBaseSchema.safeParse({ modelType: options.modelType }).success)
  for (const modelConfig of [
    { threads: 0 },
    { threads: 1025 },
    { threads: 1.5 },
    { backend: '' },
    { topK: 1 },
    { modelPath: '/tmp/other.gguf' }
  ]) {
    t.absent(loadModelOptionsBaseSchema.safeParse({ ...options, modelConfig }).success)
    t.absent(loadModelSrcRequestSchema.safeParse({ ...request, modelConfig }).success)
  }
})

test('image inputs accept encoded bytes or a complete packed RGB description', (t) => {
  t.ok(
    embedImageRequestSchema.safeParse({ type: 'embedImage', modelId: 'm', image: 'AQID' }).success
  )
  t.ok(
    embedImageClientParamsSchema.safeParse({
      modelId: 'm',
      image: new Uint8Array([1, 2, 3]),
      width: 1,
      height: 1,
      channels: 3
    }).success
  )
  for (const input of [
    { image: new Uint8Array() },
    { width: 1 },
    { width: 1, height: 1 },
    { width: 0, height: 1, channels: 3 },
    { width: 16385, height: 1, channels: 3 },
    { width: 1, height: 1, channels: 4 },
    { image: new Uint8Array(2), width: 1, height: 1, channels: 3 }
  ]) {
    t.absent(
      embedImageClientParamsSchema.safeParse({ modelId: 'm', image: new Uint8Array(3), ...input })
        .success
    )
  }
  for (const image of ['', 'not base64!', 'A']) {
    t.absent(embedImageRequestSchema.safeParse({ type: 'embedImage', modelId: 'm', image }).success)
  }
})

test('image embeddings are registered unary messages with finite 8448-value descriptors', (t) => {
  t.ok(
    requestSchema.safeParse({
      type: 'embedImage',
      modelId: 'm',
      image: 'AQID',
      requestId: 'image-call'
    }).success
  )
  const reply = {
    type: 'embedImage',
    embedding: [1, ...new Array(8447).fill(0)],
    stats: { backendId: 0, totalTime: 5, cpuFallbackNodes: 0, weightBytes: 1024 }
  }
  t.ok(responseSchema.safeParse(reply).success)
  for (const embedding of [
    [],
    [1],
    new Array(8449).fill(0),
    [Number.NaN, ...new Array(8447).fill(0)],
    [Infinity, ...new Array(8447).fill(0)]
  ]) {
    t.absent(embedImageResponseSchema.safeParse({ ...reply, embedding }).success)
  }
})
