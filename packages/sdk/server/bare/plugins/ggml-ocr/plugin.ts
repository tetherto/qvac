import {
  definePlugin,
  defineHandler,
  ocrStreamRequestSchema,
  ocrStreamResponseSchema,
  ModelType,
  ocrConfigSchema,
  ADDON_OCR,
  type CreateModelParams,
  type PluginModelResult,
  type OCRConfig,
  type ResolveContext,
  type ResolveResult
} from '@/schemas'
import { ModelLoadFailedError } from '@/utils/errors-server'
import { createStreamLogger, registerAddonLogger } from '@/logging'
import ocrAddonLogging from '@qvac/ocr-ggml/addonLogging'
import { OcrGgml } from '@qvac/ocr-ggml'
import { ocr } from '@/server/bare/plugins/ggml-ocr/ops/ocr-stream'
import { attachModelExecutionMs } from '@/profiling/model-execution'
import { resolveOcrConfig } from '@/server/bare/plugins/ggml-ocr/resolve-config'

function createOCRModel(
  modelId: string,
  detectorPath: string,
  recognizerPath: string,
  ocrConfig: OCRConfig
) {
  const logger = createStreamLogger(modelId, ModelType.ggmlOcr)
  registerAddonLogger(modelId, ModelType.ggmlOcr, logger)

  const params = {
    pathDetector: detectorPath,
    pathRecognizer: recognizerPath,
    langList: ocrConfig.langList || ['en'],
    ...(ocrConfig.pipelineType !== undefined && {
      pipelineType: ocrConfig.pipelineType
    }),
    ...(ocrConfig.magRatio !== undefined && { magRatio: ocrConfig.magRatio }),
    ...(ocrConfig.canvasSize !== undefined && {
      canvasSize: ocrConfig.canvasSize
    }),
    ...(ocrConfig.defaultRotationAngles !== undefined && {
      defaultRotationAngles: ocrConfig.defaultRotationAngles
    }),
    ...(ocrConfig.contrastRetry !== undefined && {
      contrastRetry: ocrConfig.contrastRetry
    }),
    ...(ocrConfig.lowConfidenceThreshold !== undefined && {
      lowConfidenceThreshold: ocrConfig.lowConfidenceThreshold
    }),
    ...(ocrConfig.recognizerBatchSize !== undefined && {
      recognizerBatchSize: ocrConfig.recognizerBatchSize
    }),
    ...(ocrConfig.nThreads !== undefined && { nThreads: ocrConfig.nThreads }),
    ...(ocrConfig.backendDevice !== undefined && {
      backendDevice: ocrConfig.backendDevice
    }),
    ...(ocrConfig.gpuDevice !== undefined && {
      gpuDevice: ocrConfig.gpuDevice
    })
  }

  const args = {
    logger,
    params,
    opts: { stats: true }
  }

  const model = new OcrGgml(args)

  return model
}

export const ocrPlugin = definePlugin({
  modelType: ModelType.ggmlOcr,
  displayName: 'OCR (GGML)',
  addonPackage: ADDON_OCR,
  loadConfigSchema: ocrConfigSchema,

  async resolveConfig(
    cfg: OCRConfig,
    ctx: ResolveContext
  ): Promise<ResolveResult<Record<string, unknown>, 'detectorModelPath'>> {
    return resolveOcrConfig(cfg, ctx)
  },

  createModel(params: CreateModelParams): PluginModelResult {
    const ocrConfig = (params.modelConfig ?? {}) as OCRConfig
    const detectorModelPath = params.artifacts?.['detectorModelPath']

    if (!detectorModelPath) {
      throw new ModelLoadFailedError(
        'Detector model path missing. Ensure detectorModelSrc is provided in modelConfig.'
      )
    }

    const model = createOCRModel(
      params.modelId,
      detectorModelPath,
      params.modelPath, // recognizerPath
      ocrConfig
    )

    return { model }
  },

  handlers: {
    ocrStream: defineHandler({
      requestSchema: ocrStreamRequestSchema,
      responseSchema: ocrStreamResponseSchema,
      streaming: true,
      // GGML OCR does not expose a cancel surface — SDK falls back
      // to soft-cancel.
      cancel: { scope: 'none' },

      handler: async function* (request) {
        const stream = ocr({
          modelId: request.modelId,
          image: request.image,
          options: request.options
        })
        try {
          let result = await stream.next()

          while (!result.done) {
            yield {
              type: 'ocrStream' as const,
              blocks: result.value.blocks
            }
            result = await stream.next()
          }

          const { modelExecutionMs, stats } = result.value
          yield attachModelExecutionMs(
            {
              type: 'ocrStream' as const,
              blocks: [],
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
    module: ocrAddonLogging,
    namespace: ModelType.ggmlOcr
  }
})
