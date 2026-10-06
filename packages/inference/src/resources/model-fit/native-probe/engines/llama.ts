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
import type { FitRequestPlan } from '@/resources/model-fit/native-probe/create-fit-request'

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
  const request = {
    modelPath: params.modelPath,
    ...(params.marginBytes !== undefined && { marginBytes: params.marginBytes })
  }

  if (loadKind === 'completion') {
    const llm: LlmLlamacpp.FitRequest = {
      ...request,
      config: transformLlmConfig(modelConfig as LlmConfig)
    }
    return { supported: true, probe: { engine: 'llm-llamacpp', request: llm } }
  }

  const embed: EmbedFitRequest = {
    ...request,
    config: transformEmbedConfig(modelConfig as EmbedConfig) as unknown as Record<string, string>
  }
  return { supported: true, probe: { engine: 'embed-llamacpp', request: embed } }
}
