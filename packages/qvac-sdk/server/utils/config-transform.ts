import {
  type WhisperConfig,
  type ModelTypeInput,
  normalizeModelType,
  ModelType,
} from "@/schemas";

export function transformConfigForReload(
  modelType: ModelTypeInput,
  config: unknown,
) {
  const canonicalType = normalizeModelType(modelType);

  switch (canonicalType) {
    case ModelType.whispercppTranscription: {
      const whisperConfig = config as WhisperConfig;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { contextParams, miscConfig, ...whisperParams } = whisperConfig;
      return {
        whisperConfig: whisperParams,
        ...(miscConfig && { miscConfig }),
      };
    }
    case ModelType.llamacppCompletion:
    case ModelType.llamacppEmbedding:
    case ModelType.nmtcppTranslation:
    case ModelType.onnxTts:
      // Return as-is for now
      return config;
    default:
      return config;
  }
}
