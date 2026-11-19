import type { ClassificationFitRequest } from '@qvac/classification-ggml'

import type { ClassificationConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

/**
 * The classification fit request for a load. A `modelPath` in the config wins
 * over the load's model, as it does when the load runs. MobileNet always runs
 * on the CPU, so the request carries no placement.
 */
export function classificationFitRequest(load: FitLoad): FitRequestPlan {
  const config = (load.modelConfig ?? {}) as ClassificationConfig
  const modelPath = config.modelPath ?? load.modelPath
  if (!modelPath) return { unknown: 'the classification model path is not resolved' }

  const request: ClassificationFitRequest = { modelPath }
  return { request }
}
