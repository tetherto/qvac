import test from 'brittle'
import { VlaModel } from '@qvac/vla-ggml'
import { llmConfigSchema, embedConfigSchema } from '@/schemas/llamacpp-config'
import { loadModelOptionsToRequestSchema, loadModelSrcRequestSchema } from '@/schemas/load-model'
import { deviceConfigDefaultsSchema, ModelType } from '@/schemas'
import { transformLlmConfig } from '@/plugins/builtin/llamacpp-completion/transform'
import { transformEmbedConfig } from '@/plugins/builtin/llamacpp-embedding/transform'
import { vlaPlugin } from '@/plugins/builtin/ggml-vla/plugin'

const modelTypes = [ModelType.llamacppCompletion, ModelType.llamacppEmbedding, ModelType.ggmlVla]

test('backend arrays survive public options, wire requests, and device defaults', (t) => {
  for (const modelType of modelTypes) {
    for (const backend of [['auto'], ['cuda'], ['vulkan', 'cuda'], ['metal', 'opencl']]) {
      const input = { modelType, modelSrc: 'model.gguf', modelConfig: { backend } }
      const options = loadModelOptionsToRequestSchema.parse(input)
      t.alike((options.modelConfig as { backend?: string[] }).backend, backend)
      const wire = loadModelSrcRequestSchema.parse({ ...input, type: 'loadModel' })
      t.alike((wire.modelConfig as { backend?: string[] }).backend, backend)
      const defaults = deviceConfigDefaultsSchema.parse({ [modelType]: { backend } })
      t.alike(defaults[modelType]?.['backend'], backend)
    }
    for (const backend of [
      'cuda',
      'cuda,vulkan',
      [],
      ['unknown'],
      ['cuda', 'unknown'],
      ['CUDA'],
      [''],
      [1],
      null
    ]) {
      const input = { modelType, modelSrc: 'model.gguf', modelConfig: { backend } }
      t.is(loadModelOptionsToRequestSchema.safeParse(input).success, false)
      t.is(loadModelSrcRequestSchema.safeParse({ ...input, type: 'loadModel' }).success, false)
      t.is(deviceConfigDefaultsSchema.safeParse({ [modelType]: { backend } }).success, false)
    }
  }
})

test('LLM and embedding backend names match their addon allow-list', (t) => {
  for (const schema of [llmConfigSchema, embedConfigSchema]) {
    for (const backend of ['cuda', 'vulkan', 'metal', 'opencl', 'auto']) {
      t.alike(schema.parse({ backend: [backend] }).backend, [backend])
    }
    for (const backend of ['cpu', 'hip', 'rocm', 'sycl', 'unknown']) {
      t.is(schema.safeParse({ backend: [backend] }).success, false)
    }
  }
})

test('LLM and embedding transforms join backend arrays without adding defaults', (t) => {
  for (const backend of [['auto'], ['cuda'], ['vulkan', 'cuda'], ['metal', 'opencl']]) {
    t.is(transformLlmConfig(llmConfigSchema.parse({ backend }))['backend'], backend.join(', '))
    t.is(transformEmbedConfig(embedConfigSchema.parse({ backend })).backend, backend.join(','))
  }
  t.absent(transformLlmConfig(llmConfigSchema.parse({}))['backend'])
  t.absent(transformEmbedConfig(embedConfigSchema.parse({})).backend)
  t.is(
    transformLlmConfig(llmConfigSchema.parse({ device: 'cpu', backend: ['cuda'] }))['device'],
    'cpu'
  )
  t.is(
    transformEmbedConfig(embedConfigSchema.parse({ device: 'cpu', backend: ['cuda'] })).device,
    'cpu'
  )
})

test('VLA plugin joins backend arrays, preserves auto, and propagates load failures', async (t) => {
  const originalLoad = VlaModel.prototype.load
  let received: unknown
  const failure = new Error('native backend selection failed')
  VlaModel.prototype.load = async function (options) {
    received = options
    if (options?.backend === 'sycl') throw failure
  }
  try {
    for (const backend of [
      undefined,
      ['auto'],
      ['cpu'],
      ['vulkan', 'cuda'],
      ['hip', 'rocm'],
      ['sycl']
    ]) {
      const { model } = vlaPlugin.createModel({
        modelId: 'test-vla-backend',
        modelPath: '/tmp/model.gguf',
        modelConfig: backend === undefined ? {} : { backend }
      })
      if (backend?.[0] === 'sycl') {
        await t.exception(() => model.load(), /native backend selection failed/)
      } else {
        await model.load()
      }
      t.alike(received, { backend: backend?.join(',') ?? 'auto' })
    }
  } finally {
    VlaModel.prototype.load = originalLoad
  }
})
