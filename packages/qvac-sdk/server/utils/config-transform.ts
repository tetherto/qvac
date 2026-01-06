import type { WhisperConfig, ModelType } from "@/schemas";

export function transformConfigForReload(
  modelType: ModelType,
  config: unknown,
) {
  switch (modelType) {
    case "whisper": {
      const whisperConfig = config as WhisperConfig;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { contextParams, miscConfig, ...whisperParams } = whisperConfig;
      return {
        whisperConfig: whisperParams,
        ...(miscConfig && { miscConfig }),
      };
    }
    case "llm":
    case "embeddings":
    case "nmt":
    case "tts":
      // Return as-is for now
      return config;
    default:
      return config;
  }
}
