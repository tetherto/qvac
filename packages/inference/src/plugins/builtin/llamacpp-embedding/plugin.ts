import EmbedLlamacpp, { IdMapIndex } from '@qvac/embed-llamacpp'
import embedAddonLogging from '@qvac/embed-llamacpp/addonLogging'
import type { TurboVecIndexProvider } from '@qvac/rag'
import {
  definePlugin,
  defineHandler,
  embedRequestSchema,
  embedResponseSchema,
  ModelType,
  embedConfigBaseSchema,
  ADDON_EMBEDDING,
  type CreateModelParams,
  type PluginModelResult,
  type EmbedConfig
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger, getEngineLogger } from '@/logging/index'
import { getFirstShardPath } from '@/utils/index'
import { embed } from '@/plugins/ops/embed'
import { forwardModelExecution } from '@/profiling/model-execution'
import { isMobile } from '@/runtime/state'
import { stripMultiGpuKeys } from '@/utils/multi-gpu-mobile'
import { transformEmbedConfig } from '@/plugins/builtin/llamacpp-embedding/transform'

const turbovecIndexProvider: TurboVecIndexProvider = {
  create(options) {
    return new IdMapIndex(options)
  },
  load(snapshotPath) {
    return IdMapIndex.load(snapshotPath)
  }
}

function createEmbeddingsModel(modelId: string, modelPath: string, embedConfig: EmbedConfig) {
  const logger = createStreamLogger(modelId, ModelType.llamacppEmbedding)
  registerAddonLogger(modelId, ModelType.llamacppEmbedding, logger)

  const config = transformEmbedConfig(embedConfig)

  if (isMobile()) {
    const stripped = stripMultiGpuKeys(config)
    if (stripped.length > 0) {
      getEngineLogger().warn(
        `[${ModelType.llamacppEmbedding}:${modelId}] Multi-GPU parameters (${stripped.join(', ')}) are not supported on mobile (single-GPU device) — removing from config; model will load with single-GPU defaults`
      )
    }
  }

  const model = new EmbedLlamacpp({
    files: { model: [getFirstShardPath(modelPath)] },
    config,
    logger,
    opts: { stats: true }
  })

  return { model }
}

export const embeddingsPlugin = definePlugin({
  modelType: ModelType.llamacppEmbedding,
  displayName: 'Embeddings (llama.cpp)',
  addonPackage: ADDON_EMBEDDING,
  loadConfigSchema: embedConfigBaseSchema,

  createModel(params: CreateModelParams): PluginModelResult {
    const embedConfig = (params.modelConfig ?? {}) as EmbedConfig

    const { model } = createEmbeddingsModel(params.modelId, params.modelPath, embedConfig)

    return { model }
  },

  handlers: {
    embed: defineHandler({
      requestSchema: embedRequestSchema,
      responseSchema: embedResponseSchema,
      streaming: false,
      // Model-wide hard cancel via `addon.cancel()` on the llama.cpp
      // embedding addon. Compute is interrupted when fired.
      cancel: { scope: 'model', hard: true },

      handler: async function (request) {
        const embedResult = await embed(
          {
            modelId: request.modelId,
            text: request.text
          },
          request.requestId
        )

        return forwardModelExecution(
          {
            type: 'embed' as const,
            success: true,
            embedding: embedResult.embedding,
            ...(embedResult.stats && { stats: embedResult.stats })
          },
          embedResult
        )
      }
    })
  },

  capabilities: {
    turbovecIndexProvider
  },

  logging: {
    module: embedAddonLogging,
    namespace: ModelType.llamacppEmbedding
  }
})
