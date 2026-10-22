import type { EmbedFitRequest } from '@qvac/embed-llamacpp'
import type LlmLlamacpp from '@qvac/llm-llamacpp'

import {
  ModelType,
  type CanonicalModelType,
  type EmbedConfig,
  type LlmConfig
} from '@/schemas/index'
import { transformLlmConfig } from '@/plugins/builtin/llamacpp-completion/transform'
import { transformEmbedConfig } from '@/plugins/builtin/llamacpp-embedding/transform'
import type { FitRequestPlan } from '@/model-fit/request/create'

export type LlamaLoadKind = 'completion' | 'embedding'

export function llamaLoadKindFor(modelType: CanonicalModelType): LlamaLoadKind | undefined {
  if (modelType === ModelType.llamacppCompletion) return 'completion'
  if (modelType === ModelType.llamacppEmbedding) return 'embedding'
  return undefined
}

export interface LlamaFitRequestParams {
  loadKind: LlamaLoadKind
  modelPath: string
  modelConfig: unknown
  artifacts?: Record<string, string> | undefined
  marginBytes?: number | undefined
}

export function createLlamaFitRequest(params: LlamaFitRequestParams): FitRequestPlan {
  const { loadKind } = params

  if (loadKind === 'completion' && params.artifacts?.['projectionModelPath'] !== undefined) {
    return { supported: false, detail: 'multimodal projection loads are not representable' }
  }

  const modelConfig = (params.modelConfig ?? {}) as Record<string, unknown>

  // The assessment budgets against this machine's devices, so a load spread
  // over remote GPUs is refused rather than measured against the wrong ones.
  if (modelConfig['rpc-servers'] !== undefined) {
    return { supported: false, detail: 'unsupported load setting: rpc-servers' }
  }
  const request = {
    modelPath: params.modelPath,
    ...(params.marginBytes !== undefined && { marginBytes: params.marginBytes })
  }

  if (loadKind === 'completion') {
    // The addon's fitter rejects these as unknown arguments, and none changes
    // what it projects: the image limit gates images at inference, and the
    // prompt-cache keys size host-RAM and disk state the fitter does not model.
    const {
      'image-max-megapixels': _imageMaxMegapixels,
      cache_checkpoints: _cacheCheckpoints,
      cache_checkpoints_max_bytes: _cacheCheckpointsMaxBytes,
      cache_checkpoint_storage: _cacheCheckpointStorage,
      cache_checkpoint_dir: _cacheCheckpointDir,
      cache_ram_mib: _cacheRamMib,
      ...fitConfig
    } = modelConfig
    const llm: LlmLlamacpp.FitRequest = {
      ...request,
      config: transformLlmConfig(fitConfig as LlmConfig)
    }
    return { supported: true, probe: { engine: 'llm-llamacpp', request: llm } }
  }

  const embed: EmbedFitRequest = {
    ...request,
    config: transformEmbedConfig(modelConfig as EmbedConfig) as unknown as Record<string, string>
  }
  return { supported: true, probe: { engine: 'embed-llamacpp', request: embed } }
}
