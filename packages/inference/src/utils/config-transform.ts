import {
  type ParakeetConfig,
  type WhisperConfig,
  type ModelTypeInput,
  normalizeModelType,
  ModelType
} from '@/schemas/index'
import {
  buildParakeetReloadConfig,
  buildWhisperReloadConfig
} from '@/plugins/builtin/asr-ggml/config'

// The model's concurrent sequence slots. Missing / 0 / NaN all mean single-slot;
// floor a fractional value so it can't over-admit.
export function getModelParallel(config: { parallel?: number | undefined }) {
  const n = Math.floor(Number(config.parallel))
  return Number.isFinite(n) && n >= 1 ? n : 1
}

export function transformConfigForReload(modelType: ModelTypeInput, config: unknown) {
  const canonicalType = normalizeModelType(modelType)

  switch (canonicalType) {
    case ModelType.whispercppTranscription: {
      return buildWhisperReloadConfig(config as WhisperConfig)
    }
    case ModelType.parakeetTranscription: {
      return buildParakeetReloadConfig(config as ParakeetConfig)
    }
    case ModelType.llamacppCompletion:
    case ModelType.llamacppEmbedding:
    case ModelType.nmtcppTranslation:
    case ModelType.ttsGgml:
      // Return as-is for now
      return config
    default:
      return config
  }
}
