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
