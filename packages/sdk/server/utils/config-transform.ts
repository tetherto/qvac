import {
  type ParakeetConfig,
  type WhisperConfig,
  type ModelTypeInput,
  normalizeModelType,
  ModelType
} from '@/schemas'
import {
  buildParakeetReloadConfig,
  buildWhisperReloadConfig
} from '@/server/bare/plugins/asr-ggml/config'

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
