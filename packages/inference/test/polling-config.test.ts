import test from 'brittle'
import { llmConfigSchema, embedConfigSchema } from '@/schemas/llamacpp-config'
import { decisionConfigSchema } from '@/schemas/decision'
import { loadModelOptionsToRequestSchema, loadModelSrcRequestSchema } from '@/schemas/load-model'
import { ModelType, deviceConfigDefaultsSchema } from '@/schemas'
import { transformLlmConfig } from '@/plugins/builtin/llamacpp-completion/transform'
import { transformEmbedConfig } from '@/plugins/builtin/llamacpp-embedding/transform'
import { transformDecisionConfig } from '@/plugins/builtin/llamacpp-decision/helpers'

const cases = [
  {
    modelType: ModelType.llamacppCompletion,
    transform: (config: Record<string, unknown>) =>
      transformLlmConfig(llmConfigSchema.parse(config))
  },
  {
    modelType: ModelType.llamacppEmbedding,
    transform: (config: Record<string, unknown>) =>
      transformEmbedConfig(embedConfigSchema.parse(config))
  },
  {
    modelType: ModelType.llamacppDecision,
    transform: (config: Record<string, unknown>) =>
      transformDecisionConfig(decisionConfigSchema.parse(config))
  }
]

for (const { modelType, transform } of cases) {
  test(`${modelType}: polling validates through public load and wire schemas`, (t) => {
    const base = { modelType, modelSrc: 'model.gguf' }
    for (const key of ['poll', 'pollBatch']) {
      for (const value of [0, 1, 50, 100]) {
        const modelConfig = { [key]: value }
        const options = loadModelOptionsToRequestSchema.parse({ ...base, modelConfig })
        t.alike(options.modelConfig, modelConfig)
        const wire = loadModelSrcRequestSchema.parse({ type: 'loadModel', ...base, modelConfig })
        t.alike(wire.modelConfig, modelConfig)
        const defaults = deviceConfigDefaultsSchema.parse({ [modelType]: modelConfig })
        t.alike(defaults[modelType], modelConfig)
      }
      for (const value of [-1, 101, 0.5, '50', null, true, NaN, Infinity]) {
        const request = { ...base, modelConfig: { [key]: value } }
        t.absent(loadModelOptionsToRequestSchema.safeParse(request).success)
        t.absent(loadModelSrcRequestSchema.safeParse({ type: 'loadModel', ...request }).success)
      }
    }
  })

  test(`${modelType}: polling reaches the addon without overriding inheritance`, (t) => {
    const omitted = transform({})
    t.absent('poll' in omitted)
    t.absent('poll-batch' in omitted)
    t.is(transform({ poll: 0 }).poll, '0')
    const inherited = transform({ poll: 50 })
    t.is(inherited.poll, '50')
    t.absent('poll-batch' in inherited)
    const explicit = transform({ poll: 100, pollBatch: 0 })
    t.is(explicit.poll, '100')
    t.is(explicit['poll-batch'], '0')
    t.absent('pollBatch' in explicit)
    t.absent('poll_batch' in explicit)
    const batchOnly = transform({ pollBatch: 100 })
    t.absent('poll' in batchOnly)
    t.is(batchOnly['poll-batch'], '100')
    t.absent('pollBatch' in batchOnly)
    t.absent('poll_batch' in batchOnly)
  })
}
