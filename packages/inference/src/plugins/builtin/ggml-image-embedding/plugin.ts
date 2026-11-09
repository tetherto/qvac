import { MegaLoc } from '@qvac/classification-ggml'
import {
  definePlugin,
  defineHandler,
  ModelType,
  ADDON_CLASSIFICATION,
  imageEmbeddingConfigSchema,
  embedRequestSchema,
  embedResponseSchema,
  embedBatchRequestSchema,
  embedBatchResponseSchema
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger } from '@/logging/index'
import { embed, embedBatch } from './ops/embed'

export const imageEmbeddingPlugin = definePlugin({
  modelType: ModelType.ggmlImageEmbedding,
  displayName: 'Image embeddings (MegaLoc)',
  addonPackage: ADDON_CLASSIFICATION,
  loadConfigSchema: imageEmbeddingConfigSchema,
  createModel(params) {
    const config = imageEmbeddingConfigSchema.parse(params.modelConfig ?? {})
    const logger = createStreamLogger(params.modelId, ModelType.ggmlImageEmbedding)
    registerAddonLogger(params.modelId, ModelType.ggmlImageEmbedding, logger)
    const model = new MegaLoc({
      modelPath: params.modelPath,
      ...(config.backend !== undefined && { backend: config.backend }),
      ...(config.threads !== undefined && { threads: config.threads }),
      ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir }),
      logger
    })
    return { model }
  },
  handlers: {
    embed: defineHandler({
      requestSchema: embedRequestSchema,
      responseSchema: embedResponseSchema,
      streaming: false,
      cancel: { scope: 'none' },
      handler: embed
    }),
    embedBatch: defineHandler({
      requestSchema: embedBatchRequestSchema,
      responseSchema: embedBatchResponseSchema,
      streaming: false,
      cancel: { scope: 'none' },
      handler: embedBatch
    })
  }
})
