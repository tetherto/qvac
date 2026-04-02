import {
  type AnyModel,
  getModel,
  getModelConfig,
  getModelEntry,
} from "@/server/bare/registry/model-registry";
import {
  ModelType,
  type TranscribeParams,
  type TranscribeStats,
  type WhisperConfig,
  type AudioFormat,
} from "@/schemas";
import { createAudioStream } from "@/server/bare/utils/audio-input";
import { getServerLogger } from "@/logging";
import { TranscriptionFailedError } from "@/utils/errors-server";
import type { TranscribeResponse } from "@/server/bare/types/addon-responses";
import { nowMs } from "@/profiling";
import { buildStreamResult } from "@/profiling/model-execution";

const logger = getServerLogger();

interface StreamingModelResponse {
  iterate(): AsyncIterable<{ text: string }[]>;
  await(): Promise<{ text: string }[]>;
}

interface StreamableModel {
  runStreaming(audioStream: AsyncIterable<Buffer>): Promise<StreamingModelResponse>;
}

function hasRunStreaming(model: AnyModel): model is AnyModel & StreamableModel {
  return "runStreaming" in model && typeof model.runStreaming === "function";
}

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
): AsyncGenerator<string, { modelExecutionMs: number; stats?: TranscribeStats }, void> {
  const { modelId } = params;
  const engineType = getEngineModelType(modelId);
  const silenceMarker = SILENCE_MARKERS[engineType] ?? "";
  const audioFormat = getAudioFormat(modelId, engineType);

  const originalConfig = await applyPrompt(modelId, params.prompt, engineType);
  let modelExecutionMs = 0;
  let response: TranscribeResponse | undefined;

  try {
    const model = getModel(modelId);
    const audioStream = await createAudioStream(params.audioChunk, audioFormat);

    const modelStart = nowMs();
    response = (await model.run(audioStream)) as unknown as TranscribeResponse;

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
    modelExecutionMs = nowMs() - modelStart;
  } finally {
    if (originalConfig) {
      await restorePrompt(modelId, originalConfig);
    }
  }

  const stats: TranscribeStats = {
    ...(response?.stats?.audioDurationMs !== undefined && { audioDuration: response.stats.audioDurationMs }),
    ...(response?.stats?.realTimeFactor !== undefined && { realTimeFactor: response.stats.realTimeFactor }),
    ...(response?.stats?.tokensPerSecond !== undefined && { tokensPerSecond: response.stats.tokensPerSecond }),
    ...(response?.stats?.totalTokens !== undefined && { totalTokens: response.stats.totalTokens }),
    ...(response?.stats?.totalSegments !== undefined && { totalSegments: response.stats.totalSegments }),
    ...(response?.stats?.whisperEncodeMs !== undefined && { whisperEncodeTime: response.stats.whisperEncodeMs }),
    ...(response?.stats?.whisperDecodeMs !== undefined && { whisperDecodeTime: response.stats.whisperDecodeMs }),
    ...(response?.stats?.encoderMs !== undefined && { encoderTime: response.stats.encoderMs }),
    ...(response?.stats?.decoderMs !== undefined && { decoderTime: response.stats.decoderMs }),
    ...(response?.stats?.melSpecMs !== undefined && { melSpecTime: response.stats.melSpecMs }),
  };

  return buildStreamResult(modelExecutionMs, stats);
}

export async function* transcribeStream(
  modelId: string,
  audioInputStream: AsyncIterable<Buffer>,
  prompt?: string,
): AsyncGenerator<string, void, void> {
  const engineType = getEngineModelType(modelId);
  const silenceMarker = SILENCE_MARKERS[engineType] ?? "";

  const originalConfig = await applyPrompt(modelId, prompt, engineType);

  try {
    const model = getModel(modelId);

    if (!hasRunStreaming(model)) {
      throw new TranscriptionFailedError(
        `Model ${modelId} does not support streaming transcription`,
      );
    }

    const response = await model.runStreaming(audioInputStream);

    for await (const segments of response.iterate()) {
      logger.debug("Live Transcription Update:", segments);

      for (const segment of segments) {
        if (!segment.text) continue;
        if (silenceMarker && segment.text.includes(silenceMarker)) continue;
        if (segment.text.trim()) {
          yield segment.text;
        }
      }
    }
  } finally {
    if (originalConfig) {
      await restorePrompt(modelId, originalConfig);
    }
  }
}

