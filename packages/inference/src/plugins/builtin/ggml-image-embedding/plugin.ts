import { MegaLoc } from '@qvac/classification-ggml'
import {
  definePlugin,
  defineHandler,
  ModelType,
  ADDON_CLASSIFICATION,
  imageEmbeddingConfigSchema,
  embedImageRequestSchema,
  embedImageResponseSchema
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger } from '@/logging/index'
import { embedImage } from './ops/embed-image'

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
    embedImage: defineHandler({
      requestSchema: embedImageRequestSchema,
      responseSchema: embedImageResponseSchema,
      streaming: false,
      cancel: { scope: 'none' },
      handler: embedImage
    })
  }
})
