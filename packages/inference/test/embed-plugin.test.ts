import test from 'brittle'
import { unregisterAddonLogger } from '@/logging/index'
import { handleLoadModel } from '@/handlers/load-model/handler'
import { registerPlugin, unregisterPlugin } from '@/plugins/registry'
import { embeddingsPlugin } from '@/plugins/builtin/llamacpp-embedding/plugin'
import { embedConfigSchema, type ResolveContext } from '@/schemas/index'

const ctx: ResolveContext = {
  resolveModelPath: async (src) => `/cache/${String(src)}`,
  modelSrc: '/model.gguf',
  modelType: 'llamacpp-embedding'
}

test('embedding plugin: rejects invalid load config before resolving models', async (t) => {
  let resolveCalls = 0
  registerPlugin({
    ...embeddingsPlugin,
    async resolveConfig() {
      resolveCalls++
      throw new Error('Projector resolution must not run')
    }
  })
  t.teardown(() => unregisterPlugin(embeddingsPlugin.modelType))

  for (const modelConfig of [
    { projectionModelSrc: '/mmproj.gguf', imageMinTokens: 300, imageMaxTokens: 280 },
    { imageMaxTokens: 280 }
  ]) {
    const response = await handleLoadModel({
      type: 'loadModel',
      modelType: 'llamacpp-embedding',
      modelSrc: '/missing-embedding-model.gguf',
      modelConfig,
      seed: false,
      withProgress: false
    })
    t.absent(response.success)
    t.ok(
      response.error?.includes(
        modelConfig.projectionModelSrc
          ? 'imageMinTokens must not exceed imageMaxTokens.'
          : 'imageMaxTokens requires projectionModelSrc.'
      ),
      'config validation takes precedence over the missing primary model'
    )
  }
  t.is(resolveCalls, 0, 'the projector resolver never runs')
})

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
