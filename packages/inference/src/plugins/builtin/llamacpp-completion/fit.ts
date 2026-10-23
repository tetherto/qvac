import type LlmLlamacpp from '@qvac/llm-llamacpp'

import type { LlmConfig } from '@/schemas/index'
import type { FitLoad, FitRequestPlan } from '@/schemas/plugin'
import { transformLlmConfig } from '@/plugins/builtin/llamacpp-completion/transform'
import { isMobile } from '@/runtime/state'
import { stripMultiGpuKeys } from '@/utils/multi-gpu-mobile'

/** The llm-llamacpp fit request for a load, built from the config the load would use. */
export function llmFitRequest(load: FitLoad): FitRequestPlan {
  if (load.isShardedModel) {
    return { unknown: 'the fitter reads one model file, and this model is split' }
  }
  if (load.artifacts?.['projectionModelPath'] !== undefined) {
    return { unknown: 'the fitter does not project a multimodal projector' }
  }

  // The fitter rejects these as unknown arguments, and none changes what it
  // projects: the image limit gates images at inference, and the prompt-cache
  // keys size host-RAM and disk state the fitter does not model.
  const {
    'rpc-servers': rpcServers,
    'image-max-megapixels': _imageMaxMegapixels,
    cache_checkpoints: _cacheCheckpoints,
    cache_checkpoints_max_bytes: _cacheCheckpointsMaxBytes,
    cache_checkpoint_storage: _cacheCheckpointStorage,
    cache_checkpoint_dir: _cacheCheckpointDir,
    cache_ram_mib: _cacheRamMib,
    ...fitConfig
  } = (load.modelConfig ?? {}) as Record<string, unknown>

  if (rpcServers !== undefined) return { unknown: 'an RPC load places layers on remote devices' }

  const config = transformLlmConfig(fitConfig as LlmConfig)
  if (isMobile()) stripMultiGpuKeys(config)
  // The fit reads the draft model (DFlash model or external MTP head) like the load does.
  const draftModelPath = load.artifacts?.['draftModelPath']
  if (draftModelPath) config['spec_draft_model'] = draftModelPath

  const request: LlmLlamacpp.FitRequest = { modelPath: load.modelPath, config }
  return { request }
}
