import { ModelType, type CanonicalModelType } from '@/schemas/index'
import type { FitProbeRequest } from '@/resources/model-fit/native-probe/engine-fit'
import {
  createBciFitRequest,
  createParakeetFitRequest,
  createWhisperFitRequest
} from '@/resources/model-fit/native-probe/engines/asr'
import { createAudiogenFitRequest } from '@/resources/model-fit/native-probe/engines/audiogen'
import { createDiffusionFitRequest } from '@/resources/model-fit/native-probe/engines/diffusion'
import {
  createLlamaFitRequest,
  llamaLoadKindFor
} from '@/resources/model-fit/native-probe/engines/llama'
import { createTtsFitRequest } from '@/resources/model-fit/native-probe/engines/tts'

export type FitRequestPlan =
  { supported: true; probe: FitProbeRequest } | { supported: false; detail: string }

export interface CreateFitRequestParams {
  modelType: CanonicalModelType
  modelPath: string
  modelConfig: unknown
  artifacts?: Record<string, string> | undefined
  isShardedModel: boolean
  /** Free memory that must remain for the projection to count as fitting. */
  marginBytes?: number | undefined
}

/**
 * Builds a fit request from the same resolved config and artifacts the real
 * load is about to use, or explains why this load cannot be answered for.
 *
 * Structural shapes the SDK owns — a load with no fitter behind it, a companion
 * set that did not resolve, a setting whose effect on the projection is unknown
 * — are refused here so no engine is asked a question it cannot answer.
 * Value-level policy stays inside each engine's own fitter.
 */
export function createFitRequest(params: CreateFitRequestParams): FitRequestPlan {
  const { modelType, modelPath, modelConfig, artifacts, marginBytes } = params

  const loadKind = llamaLoadKindFor(modelType)
  if (loadKind !== undefined) {
    return createLlamaFitRequest({
      loadKind,
      modelPath,
      modelConfig,
      artifacts,
      isShardedModel: params.isShardedModel,
      marginBytes
    })
  }

  // Every engine below reads whole files rather than a shard set, so a split
  // model is not a shape any of them can be pointed at.
  if (params.isShardedModel) {
    return { supported: false, detail: 'sharded models are not representable' }
  }

  const common = { modelPath, modelConfig, artifacts, marginBytes }

  switch (modelType) {
    case ModelType.whispercppTranscription:
      return createWhisperFitRequest(common)
    case ModelType.parakeetTranscription:
      return createParakeetFitRequest(common)
    case ModelType.bciWhispercppTranscription:
      return createBciFitRequest(common)
    case ModelType.ttsGgml:
      return createTtsFitRequest(common)
    case ModelType.audiogenGgml:
      return createAudiogenFitRequest(common)
    case ModelType.sdcppGeneration:
      return createDiffusionFitRequest({ modelPath, modelConfig, artifacts })
    default:
      return { supported: false, detail: `no fitter for model type: ${modelType}` }
  }
}
