import test from 'brittle'
import { unregisterAddonLogger } from '@/logging/index'
import type { ResolveContext } from '@/schemas/index'

// Private fields on LlmLlamacpp, read to check what the plugin handed the
// addon without loading a model.
interface LlamacppDebugModel {
  _projectionModelPath: string
  _config: Record<string, string>
}

const ctx: ResolveContext = {
  resolveModelPath: async (src: unknown) => `/cache/${String(src)}`,
  modelSrc: 'registry://hf/model.gguf',
  modelType: 'llamacpp-completion'
}

test('llm plugin resolveConfig: no companion source resolves nothing', async (t) => {
  const { llmPlugin } = await import('@/plugins/builtin/llamacpp-completion/plugin')

  const resolved = await llmPlugin.resolveConfig!({ ctx_size: 2048 }, ctx)

  t.is(resolved.artifacts, undefined)
  t.alike(resolved.config, { ctx_size: 2048 })
})

test('llm plugin resolveConfig: projection only', async (t) => {
  const { llmPlugin } = await import('@/plugins/builtin/llamacpp-completion/plugin')

  const resolved = await llmPlugin.resolveConfig!({ projectionModelSrc: 'mmproj.gguf' }, ctx)

  t.alike(resolved.artifacts, { projectionModelPath: '/cache/mmproj.gguf' })
  t.is('projectionModelSrc' in resolved.config, false)
})

test('llm plugin resolveConfig: draft model only', async (t) => {
  const { llmPlugin } = await import('@/plugins/builtin/llamacpp-completion/plugin')

  const resolved = await llmPlugin.resolveConfig!(
    { spec_type: 'draft-dflash', draftModelSrc: 'dflash.gguf' },
    ctx
  )

  t.alike(resolved.artifacts, { draftModelPath: '/cache/dflash.gguf' })
  t.is('draftModelSrc' in resolved.config, false)
  t.is((resolved.config as { spec_type?: string }).spec_type, 'draft-dflash')
})

test('llm plugin resolveConfig: projection and draft model together', async (t) => {
  const { llmPlugin } = await import('@/plugins/builtin/llamacpp-completion/plugin')

  const resolved = await llmPlugin.resolveConfig!(
    { projectionModelSrc: 'mmproj.gguf', draftModelSrc: 'dflash.gguf' },
    ctx
  )

  t.alike(resolved.artifacts, {
    projectionModelPath: '/cache/mmproj.gguf',
    draftModelPath: '/cache/dflash.gguf'
  })
  t.is('projectionModelSrc' in resolved.config, false)
  t.is('draftModelSrc' in resolved.config, false)
})

test('llm plugin createModel: the draft model path reaches the addon as spec_draft_model', async (t) => {
  const { llmPlugin } = await import('@/plugins/builtin/llamacpp-completion/plugin')
  const modelId = 'llm-plugin-draft-model-test'
  t.teardown(() => unregisterAddonLogger(modelId))

  const result = llmPlugin.createModel({
    modelId,
    modelPath: '/models/model.gguf',
    modelConfig: { spec_type: 'draft-dflash', spec_draft_n_max: 7 },
    artifacts: { projectionModelPath: '/models/mmproj.gguf', draftModelPath: '/models/dflash.gguf' }
  })
  const model = result.model as unknown as LlamacppDebugModel

  t.is(model._config['spec_draft_model'], '/models/dflash.gguf')
  t.is(model._config['spec_type'], 'draft-dflash')
  t.is(model._config['spec_draft_n_max'], '7')
  t.is(model._projectionModelPath, '/models/mmproj.gguf')
})

test('llm plugin createModel: an external MTP head reaches the addon as spec_draft_model', async (t) => {
  const { llmPlugin } = await import('@/plugins/builtin/llamacpp-completion/plugin')
  const modelId = 'llm-plugin-mtp-head-test'
  t.teardown(() => unregisterAddonLogger(modelId))

  const result = llmPlugin.createModel({
    modelId,
    modelPath: '/models/model.gguf',
    modelConfig: { spec_type: 'draft-mtp' },
    artifacts: { draftModelPath: '/models/mtp-head.gguf' }
  })
  const model = result.model as unknown as LlamacppDebugModel

  t.is(model._config['spec_draft_model'], '/models/mtp-head.gguf')
  t.is(model._config['spec_type'], 'draft-mtp')
})

test('llm plugin createModel: no draft model path sends no spec_draft_model', async (t) => {
  const { llmPlugin } = await import('@/plugins/builtin/llamacpp-completion/plugin')
  const modelId = 'llm-plugin-no-draft-model-test'
  t.teardown(() => unregisterAddonLogger(modelId))

  const result = llmPlugin.createModel({
    modelId,
    modelPath: '/models/model.gguf',
    modelConfig: { spec_type: 'draft-mtp' }
  })
  const model = result.model as unknown as LlamacppDebugModel

  t.absent('spec_draft_model' in model._config)
  t.is(model._config['spec_type'], 'draft-mtp')
})
