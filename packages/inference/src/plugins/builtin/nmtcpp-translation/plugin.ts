import TranslationNmtcpp, { type TranslationNmtcppFiles } from '@qvac/translation-nmtcpp'
import {
  definePlugin,
  defineHandler,
  translateRequestSchema,
  translateResponseSchema,
  ModelType,
  nmtConfigBaseSchema,
  ADDON_NMT,
  type ModelSrcInput,
  type CreateModelParams,
  type PluginModelResult,
  type NmtConfig,
  type ResolveContext,
  type ResolveResult
} from '@/schemas/index'
import { createStreamLogger, registerAddonLogger } from '@/logging/index'
import { translate } from '@/plugins/ops/translate'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import { nmtConfigFor, nmtFilesFor } from '@/plugins/builtin/nmtcpp-translation/load-files'
import {
  resolveBergamotVocab,
  type PivotModelConfig
} from '@/plugins/builtin/nmtcpp-translation/resolve-vocab'

function createNmtModel(modelId: string, files: TranslationNmtcppFiles, nmtConfig: NmtConfig) {
  const logger = createStreamLogger(modelId, ModelType.nmtcppTranslation)
  registerAddonLogger(modelId, ModelType.nmtcppTranslation, logger)

  const model = new TranslationNmtcpp({
    files,
    params: { srcLang: nmtConfig.from, dstLang: nmtConfig.to },
    config: nmtConfigFor(nmtConfig, files.pivotModel),
    logger,
    opts: { stats: true }
  })

  return { model }
}

export const nmtPlugin = definePlugin({
  modelType: ModelType.nmtcppTranslation,
  displayName: 'NMT (nmtcpp)',
  addonPackage: ADDON_NMT,
  loadConfigSchema: nmtConfigBaseSchema,
  assessFit: TranslationNmtcpp.assessFit,

  async resolveConfig(
    cfg: Record<string, unknown>,
    ctx: ResolveContext
  ): Promise<ResolveResult<Record<string, unknown>>> {
    const { srcVocabSrc, dstVocabSrc, pivotModel, ...nmtConfig } = cfg as {
      srcVocabSrc?: ModelSrcInput
      dstVocabSrc?: ModelSrcInput
      pivotModel?: PivotModelConfig
    } & NmtConfig

    if (nmtConfig.engine !== 'Bergamot') {
      return { config: nmtConfig }
    }

    const bergamotConfig = { ...nmtConfig, ...(pivotModel && { pivotModel }) }

    return resolveBergamotVocab(bergamotConfig, ctx, srcVocabSrc, dstVocabSrc, pivotModel)
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const nmtConfig = (params.modelConfig ?? {}) as NmtConfig
    const files = nmtFilesFor(params.modelPath, params.artifacts ?? {})

    const { model } = createNmtModel(params.modelId, files, nmtConfig)

    return { model }
  },

  handlers: {
    translate: defineHandler({
      requestSchema: translateRequestSchema,
      responseSchema: translateResponseSchema,
      streaming: true,
      // nmtcpp 0.7.0 exposes response.cancel(), but the translate op is not
      // wired for addon-level cancellation yet — we keep soft-cancel (stop
      // yielding, drop result, skip post-processing; the C++ work may run to
      // completion).
      cancel: { scope: 'none' },

      handler: async function* (request) {
        const stream = translate(request, request.requestId)
        try {
          let result = await stream.next()

          while (!result.done) {
            yield {
              type: 'translate' as const,
              token: result.value
            }
            result = await stream.next()
          }

          const { modelExecutionMs, stats } = result.value
          yield attachModelExecutionMs(
            {
              type: 'translate' as const,
              token: '',
              done: true,
              ...(stats && { stats })
            },
            modelExecutionMs
          )
        } finally {
          await stream.return?.(undefined as never)
        }
      }
    })
  },

  logging: {
    module: () => import('@qvac/translation-nmtcpp/addonLogging'),
    namespace: ModelType.nmtcppTranslation
  }
})
