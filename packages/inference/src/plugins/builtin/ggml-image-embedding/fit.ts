import type { ClassificationFitRequest } from '@qvac/classification-ggml'

import type { ImageEmbeddingConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

/**
 * The MegaLoc fit request for a load, with the device, threads and backends
 * directory the load would run with.
 */
export function imageEmbeddingFitRequest(load: FitLoad): FitRequestPlan {
  const config = (load.modelConfig ?? {}) as ImageEmbeddingConfig
  const request: ClassificationFitRequest = {
    modelPath: load.modelPath,
    ...(config.backend !== undefined && { backend: config.backend }),
    ...(config.threads !== undefined && { threads: config.threads }),
    ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir })
  }
  return { request }
}
