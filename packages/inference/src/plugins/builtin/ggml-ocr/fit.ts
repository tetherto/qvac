import type { OcrFitRequest } from '@qvac/ocr-ggml'

import { ocrParamsFor } from '@/plugins/builtin/ggml-ocr/params'
import { isMobile } from '@/runtime/state'
import type { OCRConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'
import { stripMultiGpuKeys } from '@/utils/multi-gpu-mobile'

/**
 * The ocr fit request for a load: the parameters the load builds from its
 * detector and recognizer, which is the load's primary model.
 */
export function ocrFitRequest(load: FitLoad): FitRequestPlan {
  const detectorPath = load.artifacts?.['detectorModelPath']
  if (detectorPath === undefined) return { unknown: 'the ocr detector is not resolved' }

  const config = (load.modelConfig ?? {}) as OCRConfig
  const params = ocrParamsFor(detectorPath, load.modelPath, config)
  // A mobile load drops the multi-GPU keys before it runs.
  if (isMobile()) stripMultiGpuKeys(params)
  const request: OcrFitRequest = params
  return { request }
}
