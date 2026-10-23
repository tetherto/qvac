import type { EmbedFitRequest } from '@qvac/embed-llamacpp'

import type { EmbedConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'
import { transformEmbedConfig } from '@/plugins/builtin/llamacpp-embedding/transform'
import { isMobile } from '@/runtime/state'
import { stripMultiGpuKeys } from '@/utils/multi-gpu-mobile'

/** The embed-llamacpp fit request for a load, built from the config the load would use. */
export function embedFitRequest(load: FitLoad): FitRequestPlan {
  if (load.isShardedModel) {
    return { unknown: 'the fitter reads one model file, and this model is split' }
  }

  const modelConfig = (load.modelConfig ?? {}) as Record<string, unknown>
  if (modelConfig['rpc-servers'] !== undefined) {
    return { unknown: 'an RPC load places layers on remote devices' }
  }

  const config = transformEmbedConfig(modelConfig as EmbedConfig)
  if (isMobile()) stripMultiGpuKeys(config)

  const request: EmbedFitRequest = {
    modelPath: load.modelPath,
    config: config as unknown as Record<string, string>
  }
  return { request }
}
