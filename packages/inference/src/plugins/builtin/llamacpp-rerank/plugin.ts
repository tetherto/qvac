import { Reranker } from '@qvac/embed-llamacpp'
import {
  definePlugin,
  defineHandler,
  ModelType,
  ADDON_EMBEDDING,
  rerankConfigSchema,
  rerankRequestSchema,
  rerankResponseSchema,
  type CreateModelParams
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger, getEngineLogger } from '@/logging/index'
import { isMobile } from '@/runtime/state'
import { stripMultiGpuKeys } from '@/utils/multi-gpu-mobile'
import { getModelShardFiles } from '@/utils/shard-utils'
import { rerank } from './ops/rerank'
import { transformRerankConfig } from './helpers'

function createRerankModel(params: CreateModelParams): Reranker {
  const config = { ...transformRerankConfig(rerankConfigSchema.parse(params.modelConfig)) }
  if (isMobile()) {
    const stripped = stripMultiGpuKeys(config)
    if (stripped.length > 0) {
      getEngineLogger().warn(
        `[${ModelType.llamacppRerank}:${params.modelId}] Multi-GPU parameters (${stripped.join(', ')}) are not supported on mobile. Removing them from config; model will load with single-GPU defaults.`
      )
    }
  }
  const logger = createStreamLogger(params.modelId, ModelType.llamacppRerank)
  registerAddonLogger(params.modelId, ModelType.llamacppRerank, logger)
  // Reranker streams every shard, as LayaDecisions does.
  return new Reranker({
    files: { model: getModelShardFiles(params.modelPath) },
    config,
    logger
  })
}

export const rerankPlugin = definePlugin({
  modelType: ModelType.llamacppRerank,
  displayName: 'Rerank (llama.cpp)',
  addonPackage: ADDON_EMBEDDING,
  loadConfigSchema: rerankConfigSchema,
  createModel: (params) => ({ model: createRerankModel(params) }),
  handlers: {
    rerank: defineHandler({
      requestSchema: rerankRequestSchema,
      responseSchema: rerankResponseSchema,
      streaming: false,
      cancel: { scope: 'model', hard: true },
      handler: rerank
    })
  },
  logging: {
    module: () => import('@qvac/embed-llamacpp/addonLogging'),
    namespace: ModelType.llamacppEmbedding
  }
})
