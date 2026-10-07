import { LayaDecisions } from '@qvac/embed-llamacpp'
import {
  definePlugin,
  defineHandler,
  ModelType,
  ADDON_EMBEDDING,
  decisionsConfigSchema,
  decideRequestSchema,
  decideResponseSchema,
  type CreateModelParams
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger, getEngineLogger } from '@/logging/index'
import { isMobile } from '@/runtime/state'
import { stripMultiGpuKeys } from '@/utils/multi-gpu-mobile'
import { decide } from './ops/decide'
import { transformDecisionsConfig, decisionsModelFiles } from './helpers'

function createDecisionsModel(params: CreateModelParams): LayaDecisions {
  const config = { ...transformDecisionsConfig(decisionsConfigSchema.parse(params.modelConfig)) }
  if (isMobile()) {
    const stripped = stripMultiGpuKeys(config)
    if (stripped.length > 0) {
      getEngineLogger().warn(
        `[${ModelType.llamacppDecisions}:${params.modelId}] Multi-GPU parameters (${stripped.join(', ')}) are not supported on mobile. Removing them from config; model will load with single-GPU defaults.`
      )
    }
  }
  const logger = createStreamLogger(params.modelId, ModelType.llamacppDecisions)
  registerAddonLogger(params.modelId, ModelType.llamacppDecisions, logger)
  return new LayaDecisions({
    files: { model: decisionsModelFiles(params.modelPath) },
    config,
    logger
  })
}

export const decisionsPlugin = definePlugin({
  modelType: ModelType.llamacppDecisions,
  displayName: 'Laya decisions (llama.cpp)',
  addonPackage: ADDON_EMBEDDING,
  loadConfigSchema: decisionsConfigSchema,
  createModel: (params) => ({ model: createDecisionsModel(params) }),
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
