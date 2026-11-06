import {
  definePlugin,
  defineHandler,
  ModelType,
  ADDON_EMBEDDING,
  decisionConfigSchema,
  decideRequestSchema,
  decideResponseSchema,
  type CreateModelParams
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger, getEngineLogger } from '@/logging/index'
import { isMobile } from '@/runtime/state'
import { stripMultiGpuKeys } from '@/utils/multi-gpu-mobile'
import { getModelShardFiles } from '@/utils/shard-utils'
import { decide } from './ops/decide'
import { transformDecisionConfig } from './helpers'
import { DecisionModel } from './upstream'

// The engine is chosen at load from the GGUF: fabric-format Laya keeps using
// LayaDecisions, upstream llama.cpp decision models use DecisionEngine.
function createDecisionModel(params: CreateModelParams): DecisionModel {
  const validated = decisionConfigSchema.parse(params.modelConfig)
  const layaConfig = { ...transformDecisionConfig(validated) }
  if (isMobile()) {
    const stripped = stripMultiGpuKeys(layaConfig)
    if (stripped.length > 0) {
      getEngineLogger().warn(
        `[${ModelType.llamacppDecision}:${params.modelId}] Multi-GPU parameters (${stripped.join(', ')}) are not supported on mobile. Removing them from config; model will load with single-GPU defaults.`
      )
    }
  }
  const logger = createStreamLogger(params.modelId, ModelType.llamacppDecision)
  registerAddonLogger(params.modelId, ModelType.llamacppDecision, logger)
  return new DecisionModel({
    modelPath: params.modelPath,
    files: getModelShardFiles(params.modelPath),
    layaConfig,
    config: validated,
    logger
  })
}

export const decisionPlugin = definePlugin({
  modelType: ModelType.llamacppDecision,
  displayName: 'Decisions (llama.cpp)',
  addonPackage: ADDON_EMBEDDING,
  loadConfigSchema: decisionConfigSchema,
  createModel: (params) => ({ model: createDecisionModel(params) }),
  handlers: {
    decide: defineHandler({
      requestSchema: decideRequestSchema,
      responseSchema: decideResponseSchema,
      streaming: false,
      cancel: { scope: 'model', hard: true },
      handler: decide
    })
  },
  logging: {
    module: () => import('@qvac/embed-llamacpp/addonLogging'),
    namespace: ModelType.llamacppEmbedding
  }
})
