import test from 'brittle'
import {
  llamacppCompletionConfigSchema,
  llamacppEmbeddingConfigSchema,
  llamacppDecisionConfigSchema,
  configSchemaForModelType
} from '@/schemas/public'

test('public polling schemas expose described numeric controls for CLI and SDK users', (t) => {
  for (const [modelType, schema] of [
    ['llamacpp-completion', llamacppCompletionConfigSchema],
    ['llamacpp-embedding', llamacppEmbeddingConfigSchema],
    ['llamacpp-decision', llamacppDecisionConfigSchema]
  ] as const) {
    t.is(configSchemaForModelType(modelType), schema)
    const config = { poll: 100, pollBatch: 0 }
    t.alike(schema.parse(config), config)
    t.alike(schema.parse({}), {})
    for (const key of ['poll', 'pollBatch'] as const) {
      const field = schema.shape[key as keyof typeof schema.shape]
      t.ok(field?.description?.includes('0 to 100'))
      t.absent(schema.safeParse({ [key]: 101 }).success)
      t.absent(schema.safeParse({ [key]: '0' }).success)
    }
  }
})
