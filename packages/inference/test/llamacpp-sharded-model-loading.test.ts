import test from 'brittle'
import { unregisterAddonLogger } from '@/logging/index'

interface LlamacppDebugModel {
  _files: string[]
}

test('llamacpp completion plugin passes only the first shard path to the addon', async (t) => {
  const { llmPlugin } = await import('@/plugins/builtin/llamacpp-completion/plugin')
  const modelId = 'llamacpp-sharded-model-loading-test'
  const modelPath = '/models/model-00003-of-00005.gguf'
  const firstShardPath = '/models/model-00001-of-00005.gguf'

  t.teardown(() => unregisterAddonLogger(modelId))

  const result = llmPlugin.createModel({
    modelId,
    modelPath,
    modelConfig: {}
  })
  const model = result.model as unknown as LlamacppDebugModel

  t.alike(model._files, [firstShardPath])
})

test('llamacpp embedding plugin passes only the first shard path to the addon', async (t) => {
  const { embeddingsPlugin } = await import('@/plugins/builtin/llamacpp-embedding/plugin')
  const modelId = 'llamacpp-embedding-sharded-model-loading-test'
  const modelPath = '/models/model-00003-of-00005.gguf'
  const firstShardPath = '/models/model-00001-of-00005.gguf'

  t.teardown(() => unregisterAddonLogger(modelId))

  const result = embeddingsPlugin.createModel({
    modelId,
    modelPath,
    modelConfig: {
      device: 'gpu',
      gpuLayers: 99,
      batchSize: 1024
    }
  })
  const model = result.model as unknown as LlamacppDebugModel

  t.alike(model._files, [firstShardPath])
})
