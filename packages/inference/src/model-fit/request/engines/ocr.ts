import type { OcrFitRequest } from '@qvac/ocr-ggml'

import type { OCRConfig } from '@/schemas/index'
import { ocrParamsFor } from '@/plugins/builtin/ggml-ocr/params'
import type { FitRequestPlan } from '@/model-fit/request/create'

export interface OcrFitRequestParams {
  /** The recognizer, which is the load's primary model. */
  modelPath: string
  modelConfig: unknown
  artifacts?: Record<string, string> | undefined
  marginBytes?: number | undefined
}

export function createOcrFitRequest(params: OcrFitRequestParams): FitRequestPlan {
  const detectorPath = params.artifacts?.['detectorModelPath']
  if (detectorPath === undefined) {
    return { supported: false, detail: 'the ocr detector is not resolved' }
  }

  const config = (params.modelConfig ?? {}) as OCRConfig
  const request: OcrFitRequest = {
    ...ocrParamsFor(detectorPath, params.modelPath, config),
    ...(params.marginBytes !== undefined && { marginBytes: params.marginBytes })
  }

  return { supported: true, probe: { engine: 'ocr-ggml', request } }
}
