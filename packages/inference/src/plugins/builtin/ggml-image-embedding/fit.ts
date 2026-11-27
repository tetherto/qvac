import type { ClassificationFitRequest } from '@qvac/classification-ggml'

import { fitModelPath } from '@/model-fit/model-path'
import type { ImageEmbeddingConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

/**
 * The MegaLoc fit request for a load, with the device, threads and backends
 * directory the load would run with. The fitter takes an absolute path only,
 * while the load also takes one relative to the working directory.
 */
export function imageEmbeddingFitRequest(load: FitLoad): FitRequestPlan {
  const config = (load.modelConfig ?? {}) as ImageEmbeddingConfig
  const request: ClassificationFitRequest = {
    modelPath: load.modelPath && fitModelPath(load.modelPath),
    ...(config.backend !== undefined && { backend: config.backend }),
    ...(config.threads !== undefined && { threads: config.threads }),
    ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir })
  }
  return { request }
}
