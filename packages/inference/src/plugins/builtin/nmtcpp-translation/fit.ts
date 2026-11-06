import type TranslationNmtcpp from '@qvac/translation-nmtcpp'

import { nmtConfigFor, nmtFilesFor } from '@/plugins/builtin/nmtcpp-translation/load-files'
import type { NmtConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

/** The translation fit request for a load: the files and config the load reads. */
export function nmtFitRequest(load: FitLoad): FitRequestPlan {
  const config = (load.modelConfig ?? {}) as NmtConfig
  const files = nmtFilesFor(load.modelPath, load.artifacts ?? {})

  const request: TranslationNmtcpp.FitRequest = {
    files,
    config: nmtConfigFor(config, files.pivotModel)
  }
  return { request }
}
