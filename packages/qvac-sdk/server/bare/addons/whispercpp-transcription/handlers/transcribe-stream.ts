import {
  getModel,
  getModelConfig,
} from "@/server/bare/registry/model-registry";
import {
  type TranscribeParams,
  type WhisperConfig,
  type AudioFormat,
} from "@/schemas";
import { transcribeFromStream } from "@/server/bare/utils/transcribe-from-stream";

export async function* transcribe(
  params: TranscribeParams,
): AsyncGenerator<string, void, void> {
  const model = getModel(params.modelId);
  const modelConfig = getModelConfig(params.modelId) as WhisperConfig;
  let originalConfig: WhisperConfig | null = null;
  const audioFormat = (modelConfig.audio_format as AudioFormat) || "s16le";

  if (params.prompt && typeof model.reload === "function") {
    originalConfig = modelConfig;
    const updatedConfig = {
      ...originalConfig,
      initial_prompt: params.prompt,
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { contextParams: _, miscConfig, ...whisperParams } = updatedConfig;

    await model.reload({
      whisperConfig: whisperParams,
      ...(miscConfig && { miscConfig }),
    });
  }

  try {
    yield* transcribeFromStream({
      model,
      params,
      audioFormat,
      filterOutput: (chunks) =>
        chunks.filter((chunk) => !chunk.text.includes("[BLANK_AUDIO]")),
    });
  } finally {
    if (originalConfig && typeof model.reload === "function") {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { contextParams: _, miscConfig, ...whisperParams } = originalConfig;

      await model.reload({
        whisperConfig: {
          ...whisperParams,
          initial_prompt: "",
        },
        ...(miscConfig && { miscConfig }),
      });
    }
  }
}
