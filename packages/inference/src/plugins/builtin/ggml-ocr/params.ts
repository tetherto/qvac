import type { OCRConfig } from '@/schemas/index'

/** The addon params for one OCR load, shared by the load and its fit request. */
export function ocrParamsFor(detectorPath: string, recognizerPath: string, ocrConfig: OCRConfig) {
  return {
    pathDetector: detectorPath,
    pathRecognizer: recognizerPath,
    ...(ocrConfig.langList !== undefined
      ? { langList: ocrConfig.langList }
      : ocrConfig.pipelineType !== 'doctr' && { langList: ['en'] }),
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
    }),
    ...(ocrConfig.mainGpu !== undefined && { 'main-gpu': ocrConfig.mainGpu })
  }
}
