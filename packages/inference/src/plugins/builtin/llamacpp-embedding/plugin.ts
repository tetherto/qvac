import EmbedLlamacpp, { assessFit as embedAssessFit } from '@qvac/embed-llamacpp'
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
  type EmbedConfig,
  type EmbedConfigInput,
  type ResolveContext
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger, getEngineLogger } from '@/logging/index'
import { getFirstShardPath } from '@/utils/index'
import { embed } from '@/plugins/ops/embed'
import { forwardModelExecution } from '@/profiling/model-execution'
import { isMobile } from '@/runtime/state'
import { stripMultiGpuKeys } from '@/utils/multi-gpu-mobile'
import { transformEmbedConfig } from '@/plugins/builtin/llamacpp-embedding/transform'

async function getIdMapIndex() {
  try {
    return (await import('@qvac/turbovec-ggml')).IdMapIndex
  } catch (err) {
    throw new Error(
      'Vector indexing requires the optional peer dependency @qvac/turbovec-ggml; install it to create or load an index',
      { cause: err }
    )
  }
}

const turbovecIndexProvider: TurboVecIndexProvider = {
  async create(options) {
    const IdMapIndex = await getIdMapIndex()
    return new IdMapIndex(options)
  },
  async load(snapshotPath) {
    const IdMapIndex = await getIdMapIndex()
    return IdMapIndex.load(snapshotPath)
  }
}

function createEmbeddingsModel(
  modelId: string,
  modelPath: string,
  embedConfig: EmbedConfig,
  projectionModelPath?: string
) {
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
    files: {
      model: [getFirstShardPath(modelPath)],
      ...(projectionModelPath && { projectionModel: projectionModelPath })
    },
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
  assessFit: embedAssessFit,

  async resolveConfig(cfg: EmbedConfigInput, ctx: ResolveContext) {
    const { projectionModelSrc, ...config } = cfg
    if (!projectionModelSrc) return { config }
    const projectionModelPath = await ctx.resolveModelPath(projectionModelSrc)
    return { config, artifacts: { projectionModelPath } }
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const embedConfig = (params.modelConfig ?? {}) as EmbedConfig

    const { model } = createEmbeddingsModel(
      params.modelId,
      params.modelPath,
      embedConfig,
      params.artifacts?.['projectionModelPath']
    )

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
          request.inputs !== undefined
            ? { modelId: request.modelId, inputs: request.inputs }
            : { modelId: request.modelId, text: request.text },
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
    module: () => import('@qvac/embed-llamacpp/addonLogging'),
    namespace: ModelType.llamacppEmbedding
  }
})
