// Public schema surface for `@qvac/sdk/schemas`. Stable, end-user-facing names
// (aliased from the internal schemas) so consumers such as the CLI can import a
// model's `modelConfig` schema and read its field descriptions without
// depending on internal identifiers.

export {
  llmConfigBaseSchema as llamacppCompletionConfigSchema,
  embedConfigBaseSchema as llamacppEmbeddingConfigSchema,
  type LlmConfigInput as LlamacppCompletionConfig,
  type EmbedConfigInput as LlamacppEmbeddingConfig
} from './llamacpp-config'

export {
  modelSrcInputSchema as modelSourceSchema,
  type ModelSrcInput as ModelSource
} from './model-src-utils'
