import {
  getModel,
  getModelConfig,
} from "@/server/bare/registry/model-registry";
import type { TranscribeParams, WhisperConfig, AudioFormat } from "@/schemas";
import { createAudioStream } from "@/server/bare/utils/audio-input";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

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
    const audioStream = await createAudioStream(params.audioChunk, audioFormat);

    // Run transcription with streaming enabled
    const response = await model.run(audioStream);

    for await (const output of response.iterate()) {
      logger.debug("Streaming Transcription Update:", output);
      // Filter out blank audio chunks and process the text
      const text = (output as { text: string }[])
        .filter((chunk) => !chunk.text.includes("[BLANK_AUDIO]"))
        .map((chunk) => chunk.text)
        .join("");

      if (text.trim()) {
        yield text;
      }
    }
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
