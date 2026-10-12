import test from 'brittle'
import { VlaModel } from '@qvac/vla-ggml'
import { llmConfigSchema, embedConfigSchema } from '@/schemas/llamacpp-config'
import { loadModelOptionsToRequestSchema, loadModelSrcRequestSchema } from '@/schemas/load-model'
import { deviceConfigDefaultsSchema, ModelType } from '@/schemas'
import { transformLlmConfig } from '@/plugins/builtin/llamacpp-completion/transform'
import { transformEmbedConfig } from '@/plugins/builtin/llamacpp-embedding/transform'
import { vlaPlugin } from '@/plugins/builtin/ggml-vla/plugin'

const modelTypes = [ModelType.llamacppCompletion, ModelType.llamacppEmbedding, ModelType.ggmlVla]

test('backend selectors survive public options, wire requests, and device defaults', (t) => {
  for (const modelType of modelTypes) {
    for (const backend of ['auto', 'vulkan', 'cuda,vulkan', ' CUDA , Vulkan ']) {
      const input = { modelType, modelSrc: 'model.gguf', modelConfig: { backend } }
      const options = loadModelOptionsToRequestSchema.parse(input)
      t.is((options.modelConfig as { backend?: string }).backend, backend)
      const wire = loadModelSrcRequestSchema.parse({ ...input, type: 'loadModel' })
      t.is((wire.modelConfig as { backend?: string }).backend, backend)
      const defaults = deviceConfigDefaultsSchema.parse({ [modelType]: { backend } })
      t.is(defaults[modelType]?.['backend'], backend)
    }
    t.is(
      loadModelOptionsToRequestSchema.safeParse({
        modelType,
        modelSrc: 'model.gguf',
        modelConfig: { backend: ['cuda'] }
      }).success,
      false
    )
  }
})

test('LLM and embedding transforms preserve native backend strings without adding defaults', (t) => {
  for (const backend of ['auto', 'cuda,vulkan', ' CUDA , Vulkan ', '', 'unknown']) {
    t.is(transformLlmConfig(llmConfigSchema.parse({ backend }))['backend'], backend)
    t.is(transformEmbedConfig(embedConfigSchema.parse({ backend })).backend, backend)
  }
  t.absent(transformLlmConfig(llmConfigSchema.parse({}))['backend'])
  t.absent(transformEmbedConfig(embedConfigSchema.parse({})).backend)
  t.is(
    transformLlmConfig(llmConfigSchema.parse({ device: 'cpu', backend: 'cuda' }))['device'],
    'cpu'
  )
  t.is(
    transformEmbedConfig(embedConfigSchema.parse({ device: 'cpu', backend: 'cuda' })).device,
    'cpu'
  )
})

test('VLA plugin forwards priority lists, preserves auto, and propagates load failures', async (t) => {
  const originalLoad = VlaModel.prototype.load
  let received: unknown
  const failure = new Error('native backend selection failed')
  VlaModel.prototype.load = async function (options) {
    received = options
    if (options?.backend === 'unknown') throw failure
  }
  try {
    for (const backend of [undefined, 'cpu', 'cuda,vulkan', 'unknown']) {
      const { model } = vlaPlugin.createModel({
        modelId: 'test-vla-backend',
        modelPath: '/tmp/model.gguf',
        modelConfig: backend === undefined ? {} : { backend }
      })
      if (backend === 'unknown') {
        await t.exception(() => model.load(), /native backend selection failed/)
      } else {
        await model.load()
      }
      t.alike(received, { backend: backend ?? 'auto' })
    }
  } finally {
    VlaModel.prototype.load = originalLoad
  }
})
