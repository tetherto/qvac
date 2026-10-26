import type TranslationNmtcpp from '@qvac/translation-nmtcpp'

import type { NmtConfig } from '@/schemas/index'
import { nmtConfigFor, nmtFilesFor } from '@/plugins/builtin/nmtcpp-translation/load-files'
import type { FitRequestPlan } from '@/model-fit/request/create'

export interface NmtFitRequestParams {
  modelPath: string
  modelConfig: unknown
  artifacts?: Record<string, string> | undefined
  marginBytes?: number | undefined
}

export function createNmtFitRequest(params: NmtFitRequestParams): FitRequestPlan {
  const config = (params.modelConfig ?? {}) as NmtConfig
  const files = nmtFilesFor(params.modelPath, params.artifacts ?? {})

  const request: TranslationNmtcpp.FitRequest = {
    files,
    config: nmtConfigFor(config, files.pivotModel),
    ...(params.marginBytes !== undefined && { marginBytes: params.marginBytes })
  }

  return { supported: true, probe: { engine: 'translation-nmtcpp', request } }
}
