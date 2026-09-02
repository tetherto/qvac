// Public schema surface for `@qvac/sdk/schemas`. Stable, end-user-facing names
// (aliased from @qvac/inference's schemas) so consumers such as the CLI can import
// a model's `modelConfig` schema and read its field descriptions without depending
// on internal identifiers.

export {
  llmConfigBaseSchema as llamacppCompletionConfigSchema,
  embedConfigBaseSchema as llamacppEmbeddingConfigSchema,
  modelSrcInputSchema as modelSourceSchema,
  type LlmConfigInput as LlamacppCompletionConfig,
  type EmbedConfigInput as LlamacppEmbeddingConfig,
  type ModelSrcInput as ModelSource
} from '@qvac/inference/surface'

// Resolve any model's `modelConfig` schema by model type (canonical, alias, or
// engine string) and read its field descriptions — the map is the single source
// of truth, so a newly added model type is available here automatically. Lets
// tools such as the CLI's `qvac configure` document every addon's config
// without a hand-maintained per-addon list.
export { configSchemaForModelType, MODEL_CONFIG_SCHEMA_BY_TYPE } from '@qvac/inference/surface'
