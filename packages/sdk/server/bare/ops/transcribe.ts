import {
  getModel,
  getModelConfig,
  getModelEntry,
} from "@/server/bare/registry/model-registry";
import {
  ModelType,
  type TranscribeParams,
  type WhisperConfig,
  type AudioFormat,
} from "@/schemas";
import { createAudioStream } from "@/server/bare/utils/audio-input";
import { getServerLogger } from "@/logging";

const logger = getServerLogger();

const SILENCE_MARKERS: Record<string, string> = {
  [ModelType.whispercppTranscription]: "[BLANK_AUDIO]",
  [ModelType.parakeetTranscription]: "[No speech detected]",
};

function getEngineModelType(modelId: string): string {
  const entry = getModelEntry(modelId);
  return entry?.local?.modelType ?? "";
}

function getAudioFormat(modelId: string, engineType: string): AudioFormat {
  if (engineType === ModelType.whispercppTranscription) {
    const config = getModelConfig(modelId) as WhisperConfig;
    return (config.audio_format as AudioFormat) || "s16le";
  }
  return "s16le";
}

async function applyPrompt(
  modelId: string,
  prompt: string | undefined,
  engineType: string,
): Promise<WhisperConfig | null> {
  if (engineType !== ModelType.whispercppTranscription || !prompt) {
    return null;
  }

  const model = getModel(modelId);
  if (typeof model.reload !== "function") return null;

  const originalConfig = getModelConfig(modelId) as WhisperConfig;
  const updatedConfig = { ...originalConfig, initial_prompt: prompt };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { contextParams: _, miscConfig, ...whisperParams } = updatedConfig;

  await model.reload({
    whisperConfig: whisperParams,
    ...(miscConfig && { miscConfig }),
  });

  return originalConfig;
}

async function restorePrompt(
  modelId: string,
  originalConfig: WhisperConfig,
): Promise<void> {
  const model = getModel(modelId);
  if (typeof model.reload !== "function") return;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { contextParams: _, miscConfig, ...whisperParams } = originalConfig;

  await model.reload({
    whisperConfig: { ...whisperParams, initial_prompt: "" },
    ...(miscConfig && { miscConfig }),
  });
}

export async function* transcribe(
  params: TranscribeParams,
): AsyncGenerator<string, void, void> {
  const { modelId } = params;
  const engineType = getEngineModelType(modelId);
  const silenceMarker = SILENCE_MARKERS[engineType] ?? "";
  const audioFormat = getAudioFormat(modelId, engineType);

  const originalConfig = await applyPrompt(modelId, params.prompt, engineType);

  try {
    const model = getModel(modelId);
    const audioStream = await createAudioStream(params.audioChunk, audioFormat);
    const response = await model.run(audioStream);

    for await (const output of response.iterate()) {
      logger.debug("Streaming Transcription Update:", output);

      const text = (output as { text: string }[])
        .filter(
          (chunk) => !silenceMarker || !chunk.text.includes(silenceMarker),
        )
        .map((chunk) => chunk.text)
        .join("");

      if (text.trim()) {
        yield text;
      }
    }
  } finally {
    if (originalConfig) {
      await restorePrompt(modelId, originalConfig);
    }
  }
}
