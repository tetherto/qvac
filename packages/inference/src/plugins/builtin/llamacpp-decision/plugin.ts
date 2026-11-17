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
import { createStreamLogger, registerAddonLogger } from '@/logging/index'
import { getFirstShardPath } from '@/utils/index'
import { decide } from './ops/decide'
import { DecisionModel, loadDecisionAddonLogging } from './upstream'

// Decision models run on @qvac/decision-ggml's DecisionEngine: upstream
// llama.cpp decision models, Laya included.
function createDecisionModel(params: CreateModelParams): DecisionModel {
  const config = decisionConfigSchema.parse(params.modelConfig)
  const logger = createStreamLogger(params.modelId, ModelType.llamacppDecision)
  registerAddonLogger(params.modelId, ModelType.llamacppDecision, logger)
  // One disk path, as for the LLM plugin: a sharded GGUF's first shard, which
  // holds the header the load checks; fabric finds the other shards on disk.
  // decision-ggml rejects weight streaming's file lists.
  const modelPath = getFirstShardPath(params.modelPath)
  return new DecisionModel({ modelPath, files: [modelPath], config, logger })
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
    module: loadDecisionAddonLogging,
    namespace: ModelType.llamacppDecision
  }
})
