import test from 'brittle'
import { unregisterAddonLogger } from '@/logging/index'
import { embeddingsPlugin } from '@/plugins/builtin/llamacpp-embedding/plugin'
import type { ResolveContext } from '@/schemas/index'

const ctx: ResolveContext = {
  resolveModelPath: async (src) => `/cache/${String(src)}`,
  modelSrc: '/model.gguf',
  modelType: 'llamacpp-embedding'
}

test('embedding plugin: resolves the projector through the model lifecycle', async (t) => {
  const resolved = await embeddingsPlugin.resolveConfig!(
    { projectionModelSrc: 'mmproj.gguf', ctxSize: 2048 },
    ctx
  )
  t.alike(resolved.config, { ctxSize: 2048 })
  t.alike(resolved.artifacts, { projectionModelPath: '/cache/mmproj.gguf' })
  const plain = await embeddingsPlugin.resolveConfig!({ ctxSize: 2048 }, ctx)
  t.is(plain.artifacts, undefined)
})

test('embedding plugin: passes the resolved projector and options to the addon', (t) => {
  const modelId = 'embedding-plugin-projector'
  t.teardown(() => unregisterAddonLogger(modelId))
  const result = embeddingsPlugin.createModel({
    modelId,
    modelPath: '/model.gguf',
    modelConfig: { ctxSize: 2048, mmprojUseGpu: false, imageMaxTokens: 280 },
    artifacts: { projectionModelPath: '/mmproj.gguf' }
  })
  const model = result.model as unknown as {
    _projectionModelPath: string
    _config: Record<string, string>
  }
  t.is(model._projectionModelPath, '/mmproj.gguf')
  t.is(model._config['ctx_size'], '2048')
  t.is(model._config['mmproj-use-gpu'], '0')
  t.is(model._config['image-max-tokens'], '280')
})
