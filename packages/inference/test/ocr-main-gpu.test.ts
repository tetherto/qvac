import test from 'brittle'
import { ocrConfigSchema, ocrLoadConfigSchema } from '@/schemas/ocr'
import {
  loadModelOptionsSchema,
  loadBuiltinToRequestSchema,
  loadModelSrcRequestSchema
} from '@/schemas/load-model'
import { resolveModelConfigWithContext } from '@/runtime/model-config-utils'

test('ocrLoadConfigSchema: accepts mainGpu as a registry index or GPU class', (t) => {
  for (const mainGpu of [0, 1, 2147483647, 'integrated', 'dedicated']) {
    const result = ocrLoadConfigSchema.safeParse({ backendDevice: 'vulkan', mainGpu })
    t.ok(result.success, `accepts ${String(mainGpu)}`)
    if (result.success) t.is(result.data.mainGpu, mainGpu)
  }
})

test('ocrLoadConfigSchema: accepts mainGpu with each GPU backendDevice', (t) => {
  for (const backendDevice of ['vulkan', 'metal', 'opencl']) {
    t.ok(ocrLoadConfigSchema.safeParse({ backendDevice, mainGpu: 'dedicated' }).success)
  }
})

test('ocrLoadConfigSchema: rejects mainGpu values outside the canonical contract', (t) => {
  for (const mainGpu of [-1, 0.5, 2147483648, 'Dedicated', '1', 'discrete', true]) {
    const result = ocrLoadConfigSchema.safeParse({ backendDevice: 'vulkan', mainGpu })
    t.absent(result.success, `rejects ${String(mainGpu)}`)
  }
})

test('ocrLoadConfigSchema: rejects mainGpu without a GPU backendDevice', (t) => {
  for (const config of [{ mainGpu: 0 }, { backendDevice: 'cpu', mainGpu: 'dedicated' }]) {
    const result = ocrLoadConfigSchema.safeParse(config)
    t.absent(result.success)
    if (!result.success) {
      t.alike(result.error.issues[0]?.path, ['mainGpu'])
      t.ok(result.error.issues[0]?.message.includes('requires backendDevice'))
    }
  }
})

test('ocrLoadConfigSchema: rejects mainGpu combined with gpuDevice', (t) => {
  const result = ocrLoadConfigSchema.safeParse({
    backendDevice: 'vulkan',
    gpuDevice: 0,
    mainGpu: 1
  })
  t.absent(result.success)
  if (!result.success) {
    t.is(result.error.issues.length, 1)
    t.ok(result.error.issues[0]?.message.includes('cannot be combined with gpuDevice'))
  }
})

test('ocrLoadConfigSchema: configs without mainGpu keep their existing behaviour', (t) => {
  t.ok(ocrLoadConfigSchema.safeParse({}).success)
  t.ok(ocrLoadConfigSchema.safeParse({ backendDevice: 'cpu', gpuDevice: 1 }).success)
  t.ok(ocrLoadConfigSchema.safeParse({ backendDevice: 'vulkan', gpuDevice: 1 }).success)
})

test('ocrConfigSchema: stays an unrefined object so partial() keeps working', (t) => {
  t.ok(ocrConfigSchema.partial().safeParse({ mainGpu: 0 }).success)
})

const OCR_LOAD = { modelSrc: '/models/recognizer.gguf', modelType: 'ggml-ocr' }

// These run on the client and again in dispatch before device defaults merge,
// so they reject only the selector conflict and leave backendDevice to the plugin.
for (const [name, schema, extra] of [
  ['loadModelOptionsSchema', loadModelOptionsSchema, {}],
  ['loadBuiltinToRequestSchema', loadBuiltinToRequestSchema, {}],
  ['loadModelSrcRequestSchema', loadModelSrcRequestSchema, { type: 'loadModel' }]
] as const) {
  test(`${name}: rejects mainGpu with gpuDevice, defers backendDevice to the merged config`, (t) => {
    const base = { ...OCR_LOAD, ...extra }
    t.ok(
      schema.safeParse({ ...base, modelConfig: { backendDevice: 'vulkan', mainGpu: 'dedicated' } })
        .success
    )
    t.ok(
      schema.safeParse({ ...base, modelConfig: { mainGpu: 0 } }).success,
      'backendDevice may still come from a device default'
    )
    const conflict = schema.safeParse({
      ...base,
      modelConfig: { backendDevice: 'vulkan', gpuDevice: 0, mainGpu: 'dedicated' }
    })
    t.absent(conflict.success)
    t.ok(JSON.stringify(conflict.error).includes('cannot be combined with gpuDevice'))
  })
}

function mergeOcrDefaults(defaults: Record<string, unknown>, userInput: Record<string, unknown>) {
  return resolveModelConfigWithContext<Record<string, unknown>>(
    'ggml-ocr',
    userInput,
    { platform: 'linux' },
    [
      {
        name: 'Linux OCR defaults',
        match: { platform: 'linux' },
        defaults: { 'ggml-ocr': defaults }
      }
    ],
    []
  )
}

test('device defaults: a default backendDevice satisfies a user mainGpu', async (t) => {
  const { ocrPlugin } = await import('@/plugins/builtin/ggml-ocr/plugin')
  const merged = mergeOcrDefaults({ backendDevice: 'vulkan' }, { mainGpu: 'dedicated' })
  t.alike(merged, { backendDevice: 'vulkan', mainGpu: 'dedicated' })
  t.ok(ocrPlugin.loadConfigSchema.safeParse(merged).success)
})

test('device defaults: a merged selector conflict fails the plugin load config, not the merge', async (t) => {
  const { ocrPlugin } = await import('@/plugins/builtin/ggml-ocr/plugin')
  const merged = mergeOcrDefaults(
    { backendDevice: 'vulkan', gpuDevice: 0 },
    { mainGpu: 'dedicated' }
  )
  t.alike(merged, { backendDevice: 'vulkan', gpuDevice: 0, mainGpu: 'dedicated' })
  const result = ocrPlugin.loadConfigSchema.safeParse(merged)
  t.absent(result.success)
  t.ok(JSON.stringify(result.error).includes('cannot be combined with gpuDevice'))
})

test('ocrPlugin: loadConfigSchema rejects mainGpu when no GPU backendDevice is set', async (t) => {
  const { ocrPlugin } = await import('@/plugins/builtin/ggml-ocr/plugin')
  const result = ocrPlugin.loadConfigSchema.safeParse({ mainGpu: 0 })
  t.absent(result.success)
  t.ok(JSON.stringify(result.error).includes('requires backendDevice'))
})

test('ocrPlugin: forwards mainGpu to the addon as main-gpu', async (t) => {
  const { ocrPlugin } = await import('@/plugins/builtin/ggml-ocr/plugin')
  const result = ocrPlugin.createModel({
    modelId: 'ocr-main-gpu',
    modelPath: '/models/recognizer.gguf',
    modelConfig: { backendDevice: 'vulkan', mainGpu: 'dedicated' },
    artifacts: { detectorModelPath: '/models/detector.gguf' }
  })
  const params = (result.model as unknown as { params: Record<string, unknown> }).params
  t.is(params['main-gpu'], 'dedicated')
  t.is(params['backendDevice'], 'vulkan')
  t.absent('mainGpu' in params, 'the SDK spelling does not reach the addon')
})

test('ocrPlugin: omits main-gpu when mainGpu is unset', async (t) => {
  const { ocrPlugin } = await import('@/plugins/builtin/ggml-ocr/plugin')
  const result = ocrPlugin.createModel({
    modelId: 'ocr-no-main-gpu',
    modelPath: '/models/recognizer.gguf',
    modelConfig: { backendDevice: 'vulkan', gpuDevice: 1 },
    artifacts: { detectorModelPath: '/models/detector.gguf' }
  })
  const params = (result.model as unknown as { params: Record<string, unknown> }).params
  t.absent('main-gpu' in params)
  t.is(params['gpuDevice'], 1)
})
