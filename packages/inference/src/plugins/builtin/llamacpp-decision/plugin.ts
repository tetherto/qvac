import {
  definePlugin,
  defineHandler,
  ModelType,
  ADDON_DECISION,
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
import { DecisionModel, isMissingDecisionAddon } from './upstream'

// The engine is chosen at load from the GGUF: fabric-format Laya uses
// LayaDecisions, upstream llama.cpp decision models use DecisionEngine, both
// from @qvac/decision-ggml (Laya falls back to embed-llamacpp without it).
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
  addonPackage: ADDON_DECISION,
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
    // decision-ggml's native logs; embed's when only the Laya fallback is
    // installed.
    module: () =>
      import('@qvac/decision-ggml/addonLogging').catch((error: unknown) => {
        if (isMissingDecisionAddon(error)) return import('@qvac/embed-llamacpp/addonLogging')
        throw error
      }),
    namespace: ModelType.llamacppDecision
  }
})
