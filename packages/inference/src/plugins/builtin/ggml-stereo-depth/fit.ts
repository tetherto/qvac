import type { ClassificationFitRequest } from '@qvac/classification-ggml'

import type { StereoDepthConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'

/**
 * The BridgeDepth fit request for a load, with the device, threads and
 * backends directory the load would run with.
 *
 * The request sets no `workload`, so the addon sizes a 1280x720 pair. That is
 * the largest size BridgeDepth runs the model at: a larger pair is downsampled
 * to fit inside it first, so the default already covers the most compute an
 * inference takes. Only the host buffers grow with a larger input, and the API
 * accepts up to 4096 pixels per side, so the host row can undercount a pair
 * larger than 1280x720.
 */
export function stereoDepthFitRequest(load: FitLoad): FitRequestPlan {
  const config = (load.modelConfig ?? {}) as StereoDepthConfig
  const request: ClassificationFitRequest = {
    modelPath: load.modelPath,
    ...(config.backend !== undefined && { backend: config.backend }),
    ...(config.threads !== undefined && { threads: config.threads }),
    ...(config.backendsDir !== undefined && { backendsDir: config.backendsDir })
  }
  return { request }
}
