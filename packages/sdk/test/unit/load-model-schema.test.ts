import test from 'brittle'
import {
  loadModelOptionsToRequestSchema,
  loadModelRequestSchema,
  loadModelSrcRequestSchema,
  modelProgressUpdateSchema
} from '@/schemas/load-model'
import { contractValidate } from './utils/contract-validator'
import { llmConfigBaseSchema, ModelType } from '@/schemas'
import {
  getExplicitRegistryMetadata,
  resolveRegistryDownloadMetadata
} from '@/server/rpc/handlers/load-model/registry-metadata'
import type { RegistryItem } from '@/models/registry'

test('loadModelSrcRequestSchema: rejects unknown top-level keys', (t) => {
  const invalidRequest = {
    type: 'loadModel',
    modelType: ModelType.llamacppCompletion,
    modelSrc: 'model.gguf',
    modelConfig: {},
    unknownTopLevelField: 'should-fail'
  }

  const result = loadModelSrcRequestSchema.safeParse(invalidRequest)
  t.is(result.success, false)
})

test('loadModelOptionsToRequestSchema: points misplaced LLM config fields to modelConfig', (t) => {
  try {
    loadModelOptionsToRequestSchema.parse({
      modelSrc: 'model.gguf',
      modelType: 'llm',
      ctx_size: 2048
    })
    t.fail('expected misplaced ctx_size to fail validation')
  } catch (error) {
    t.ok(error instanceof Error)
    t.ok(error instanceof Error && error.message.includes('modelConfig.ctx_size'))
  }
})

test('loadModelOptionsToRequestSchema: points misplaced non-LLM config fields to modelConfig', (t) => {
  const cases = [
    {
      input: {
        modelSrc: 'whisper.bin',
        modelType: 'whisper',
        language: 'en'
      },
      hint: 'modelConfig.language'
    },
    {
      input: {
        modelSrc: 'embed.gguf',
        modelType: 'embeddings',
        batchSize: 512
      },
      hint: 'modelConfig.batchSize'
    }
  ]

  for (const { input, hint } of cases) {
    try {
      loadModelOptionsToRequestSchema.parse(input)
      t.fail(`expected misplaced ${hint} to fail validation`)
    } catch (error) {
      t.ok(error instanceof Error)
      t.ok(error instanceof Error && error.message.includes(hint))
    }
  }
})

test('loadModelSrcRequestSchema: accepts companion sources inside modelConfig', (t) => {
  const validWhisperRequest = {
    type: 'loadModel',
    modelType: ModelType.whispercppTranscription,
    modelSrc: 'model.bin',
    modelConfig: {
      language: 'en',
      vadModelSrc: 'vad.bin'
    }
  }

  const validOcrRequest = {
    type: 'loadModel',
    modelType: ModelType.ggmlOcr,
    modelSrc: 'recognizer.gguf',
    modelConfig: {
      detectorModelSrc: 'detector.gguf'
    }
  }

  t.is(loadModelSrcRequestSchema.safeParse(validWhisperRequest).success, true)
  t.is(loadModelSrcRequestSchema.safeParse(validOcrRequest).success, true)
})

test('llmConfigBaseSchema: preserves projection descriptor cache metadata', (t) => {
  const descriptor = {
    src: 'registry://hf/future/Qwen3.5-2B.mmproj-Q8_0.gguf',
    name: 'MMPROJ_QWEN3_5_2B_MULTIMODAL_Q8_0',
    expectedSize: 364_664_384,
    sha256Checksum: '526dbf85f350baf3a5107b1f14e629e94571c7cbab4277476fbdaaa8c4a31a64'
  }

  const parsed = llmConfigBaseSchema.parse({
    projectionModelSrc: descriptor
  })

  t.alike(parsed.projectionModelSrc, descriptor)
})

test('getExplicitRegistryMetadata: ignores non-registry descriptors', (t) => {
  const metadata = getExplicitRegistryMetadata({
    src: 'https://example.com/model.gguf',
    expectedSize: 123,
    sha256Checksum: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  })

  t.is(metadata, undefined)
})

test('getExplicitRegistryMetadata: ignores registry descriptors without cache metadata', (t) => {
  const metadata = getExplicitRegistryMetadata({
    src: 'registry://hf/future/model.gguf',
    name: 'FUTURE_MODEL'
  })

  t.is(metadata, undefined)
})

test('resolveRegistryDownloadMetadata: descriptor metadata covers uncatalogued registry paths', (t) => {
  const metadata = resolveRegistryDownloadMetadata(
    undefined,
    {
      expectedSize: 364_664_384,
      sha256Checksum: '526dbf85f350baf3a5107b1f14e629e94571c7cbab4277476fbdaaa8c4a31a64'
    },
    undefined
  )

  t.is(metadata.expectedSize, 364_664_384)
  t.is(metadata.checksum, '526dbf85f350baf3a5107b1f14e629e94571c7cbab4277476fbdaaa8c4a31a64')
})

test('resolveRegistryDownloadMetadata: catalog metadata wins over descriptor metadata', (t) => {
  const catalogMetadata: RegistryItem = {
    name: 'CATALOG_MODEL',
    registryPath: 'known/model.gguf',
    registrySource: 'hf',
    blobCoreKey: 'catalog-core-key',
    blobBlockOffset: 1,
    blobBlockLength: 2,
    blobByteOffset: 3,
    modelId: 'model.gguf',
    addon: 'llm',
    expectedSize: 123,
    sha256Checksum: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    engine: 'llamacpp-completion',
    quantization: 'q4_0',
    params: '1B'
  }

  const metadata = resolveRegistryDownloadMetadata(
    catalogMetadata,
    {
      expectedSize: 999,
      sha256Checksum: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    },
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  )

  t.is(metadata.expectedSize, 123)
  t.is(metadata.checksum, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
})

test('loadModelSrcRequestSchema: accepts classification load with empty modelSrc (bundled weights)', (t) => {
  // Classification ships bundled GGUF weights, so callers can omit modelSrc.
  // The client-side transform produces modelSrc: "" in that case; the server
  // schema must accept it without falling through to the custom-plugin arm.
  const bundledLoad = {
    type: 'loadModel',
    modelType: ModelType.ggmlClassification,
    modelSrc: '',
    modelConfig: {}
  }

  const bundledWithTopK = {
    type: 'loadModel',
    modelType: ModelType.ggmlClassification,
    modelSrc: '',
    modelConfig: { topK: 3 }
  }

  const customGguf = {
    type: 'loadModel',
    modelType: ModelType.ggmlClassification,
    modelSrc: '/path/to/my-classifier.gguf',
    modelConfig: {}
  }

  t.is(loadModelSrcRequestSchema.safeParse(bundledLoad).success, true)
  t.is(loadModelSrcRequestSchema.safeParse(bundledWithTopK).success, true)
  t.is(loadModelSrcRequestSchema.safeParse(customGguf).success, true)
})

test('loadModelRequestSchema: custom plugin allows unknown modelConfig keys', (t) => {
  const customPluginRequest = {
    type: 'loadModel',
    modelType: 'my-custom-plugin',
    modelSrc: 'model.bin',
    modelConfig: {
      customOption1: 'value1',
      customOption2: 123,
      nestedConfig: { deep: true }
    }
  }

  const result = loadModelSrcRequestSchema.safeParse(customPluginRequest)
  t.is(result.success, true)
  if (result.success) {
    t.is((result.data.modelConfig as Record<string, unknown>)?.customOption1, 'value1')
  }
})

test('contract loadModel.request: accepts the modelConfig variations Zod accepts', (t) => {
  const variations: Array<[string, Record<string, unknown>]> = [
    [
      'whisper companion sources',
      {
        type: 'loadModel',
        modelType: 'whispercpp-transcription',
        modelSrc: 'model.bin',
        modelConfig: { language: 'en', vadModelSrc: 'vad.bin' }
      }
    ],
    [
      'ocr detector companion',
      {
        type: 'loadModel',
        modelType: 'ggml-ocr',
        modelSrc: 'recognizer.gguf',
        modelConfig: { detectorModelSrc: 'detector.gguf' }
      }
    ],
    [
      'classification bundled weights (empty modelSrc)',
      {
        type: 'loadModel',
        modelType: 'ggml-classification',
        modelSrc: '',
        modelConfig: { topK: 3 }
      }
    ],
    [
      'llm projection descriptor',
      {
        type: 'loadModel',
        modelType: 'llamacpp-completion',
        modelSrc: 'model.gguf',
        modelConfig: {
          projectionModelSrc: {
            src: 'registry://hf/future/Qwen3.5-2B.mmproj-Q8_0.gguf',
            name: 'MMPROJ_QWEN3_5_2B_MULTIMODAL_Q8_0',
            expectedSize: 364_664_384,
            sha256Checksum: '526dbf85f350baf3a5107b1f14e629e94571c7cbab4277476fbdaaa8c4a31a64'
          }
        }
      }
    ],
    [
      'custom plugin with free-form modelConfig',
      {
        type: 'loadModel',
        modelType: 'my-custom-plugin',
        modelSrc: 'model.bin',
        modelConfig: { customOption1: 'value1', nestedConfig: { deep: true } }
      }
    ]
  ]

  for (const [label, payload] of variations) {
    t.is(loadModelRequestSchema.safeParse(payload).success, true, `zod accepts ${label}`)
    const contract = contractValidate('loadModel.request', payload)
    t.ok(contract.valid, `contract accepts ${label}: ${contract.errors}`)
  }
})

test('contract loadModel.request: rejects structurally invalid requests', (t) => {
  const invalid: Array<[string, Record<string, unknown>]> = [
    ['missing modelSrc and modelType', { type: 'loadModel' }],
    [
      'numeric modelSrc',
      {
        type: 'loadModel',
        modelType: 'llamacpp-completion',
        modelSrc: 123,
        modelConfig: {}
      }
    ]
  ]

  for (const [label, payload] of invalid) {
    t.is(loadModelRequestSchema.safeParse(payload).success, false, `zod rejects ${label}`)
    t.is(contractValidate('loadModel.request', payload).valid, false, `contract rejects ${label}`)
  }
})

test('contract loadModel.request: runtime-only refinements stay server-side', (t) => {
  // Zod rejects these via refinements (custom-plugin arm excludes built-in
  // modelTypes; misplaced-config hints), which JSON Schema cannot express.
  // The exported contract is intentionally looser here: clients trust the
  // wire and the server remains the source of truth for these rejections.
  const runtimeOnlyRejections: Array<[string, Record<string, unknown>]> = [
    [
      'unknown top-level key',
      {
        type: 'loadModel',
        modelType: 'llamacpp-completion',
        modelSrc: 'model.gguf',
        modelConfig: {},
        unknownTopLevelField: 'should-fail'
      }
    ],
    [
      'misplaced ctx_size outside modelConfig',
      {
        type: 'loadModel',
        modelType: 'llamacpp-completion',
        modelSrc: 'model.gguf',
        modelConfig: {},
        ctx_size: 2048
      }
    ]
  ]

  for (const [label, payload] of runtimeOnlyRejections) {
    t.is(loadModelRequestSchema.safeParse(payload).success, false, `zod rejects ${label}`)
    const contract = contractValidate('loadModel.request', payload)
    t.ok(contract.valid, `contract accepts ${label} (server-side refinement)`)
  }
})

test('contract modelProgress.response: validates loadModel progress updates', (t) => {
  const progressUpdate = {
    type: 'modelProgress',
    downloaded: 1024,
    total: 4096,
    percentage: 25,
    downloadKey: 'model.gguf',
    shardInfo: {
      currentShard: 1,
      totalShards: 4,
      shardName: 'model-00001-of-00004.gguf',
      overallDownloaded: 1024,
      overallTotal: 16384,
      overallPercentage: 6.25
    }
  }

  t.is(modelProgressUpdateSchema.safeParse(progressUpdate).success, true)
  const contract = contractValidate('modelProgress.response', progressUpdate)
  t.ok(contract.valid, `contract accepts sharded progress update: ${contract.errors}`)

  const missingKey = { type: 'modelProgress', downloaded: 1, total: 2, percentage: 50 }
  t.is(modelProgressUpdateSchema.safeParse(missingKey).success, false)
  t.is(contractValidate('modelProgress.response', missingKey).valid, false)
})
