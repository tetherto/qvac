import {
  type AnyModel,
  getModel,
  getModelConfig,
  getModelEntry,
} from "@/server/bare/registry/model-registry";
import {
  ModelType,
  type TranscribeParams,
  type TranscribeSegment,
  type TranscribeStats,
  type TranscribeStreamEvent,
  type WhisperConfig,
  type AudioFormat,
  type ParakeetStreamingRunConfig,
} from "@/schemas";
import { createAudioStream } from "@/server/bare/utils/audio-input";
import { getServerLogger } from "@/logging";
import { TranscriptionFailedError } from "@/utils/errors-server";
import type { TranscribeResponse } from "@/server/bare/types/addon-responses";
import { nowMs } from "@/profiling";
import { buildStreamResult } from "@/profiling/model-execution";
import {
  assertMetadataSupported,
  toTranscribeSegment,
  type WhisperAddonSegment,
} from "@/server/bare/utils/transcribe-metadata";

export {
  assertMetadataSupported,
  toTranscribeSegment,
  type WhisperAddonSegment,
};

const logger = getServerLogger();

// Per-engine output shapes from `runStreaming`'s response iterator.
//
// Whisper emits arrays of segments interleaved with VAD / end-of-turn
// event objects. Parakeet emits an array or a single segment with an
// optional `isEndOfTurn` boundary flag and `startsWord` continuation
// hint. We treat both segment shapes as the same (whisper's extra
// fields are ignored downstream and parakeet's extras are surfaced
// where they matter).
type StreamingSegment = WhisperAddonSegment & {
  isEndOfTurn?: boolean;
  startsWord?: boolean;
};
type StreamingModelOutput =
  | StreamingSegment[]
  | StreamingSegment
  | { type: "vad"; speaking: boolean; probability: number }
  | { type: "endOfTurn"; silenceDurationMs: number };

interface StreamingModelResponse {
  iterate(): AsyncIterable<StreamingModelOutput>;
  await(): Promise<unknown>;
}

interface WhisperRunStreamingOpts {
  emitVadEvents?: boolean;
  endOfTurnSilenceMs?: number;
  vadRunIntervalMs?: number;
}

type ParakeetRunStreamingOpts = ParakeetStreamingRunConfig;

type RunStreamingOpts = WhisperRunStreamingOpts | ParakeetRunStreamingOpts;

interface StreamableModel {
  runStreaming(
    audioStream: AsyncIterable<Buffer>,
    opts?: RunStreamingOpts,
  ): Promise<StreamingModelResponse>;
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
  if (!entry || entry.isDelegated) return "";
  return entry.local.modelType;
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

type TranscribeReturn = { modelExecutionMs: number; stats?: TranscribeStats };

export function transcribe(
  params: TranscribeParams & { metadata: true },
): AsyncGenerator<TranscribeSegment, TranscribeReturn, void>;
export function transcribe(
  params: TranscribeParams,
): AsyncGenerator<string, TranscribeReturn, void>;
export async function* transcribe(
  params: TranscribeParams,
): AsyncGenerator<string | TranscribeSegment, TranscribeReturn, void> {
  const { modelId, metadata } = params;
  const engineType = getEngineModelType(modelId);
  assertMetadataSupported(modelId, engineType, metadata);
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

      const chunks = (Array.isArray(output) ? output : [output]) as WhisperAddonSegment[];

      if (metadata) {
        for (const chunk of chunks) {
          if (!chunk.text) continue;
          if (silenceMarker && chunk.text.includes(silenceMarker)) continue;
          yield toTranscribeSegment(chunk);
        }
        continue;
      }

      const text = chunks
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

export interface TranscribeStreamOpts {
  // Whisper-only knobs (ignored on other engines).
  emitVadEvents?: boolean;
  endOfTurnSilenceMs?: number;
  vadRunIntervalMs?: number;
  // Parakeet-only per-call streaming overrides (ignored on other engines).
  parakeetStreamingConfig?: ParakeetStreamingRunConfig;
}

function buildRunStreamingOpts(
  engineType: string,
  opts?: TranscribeStreamOpts,
): RunStreamingOpts | undefined {
  if (engineType === ModelType.parakeetTranscription) {
    return opts?.parakeetStreamingConfig;
  }

  // Whisper (and any other engine that consumes the legacy whisper opts).
  const runOpts: WhisperRunStreamingOpts = {};
  if (opts?.emitVadEvents) runOpts.emitVadEvents = true;
  if (opts?.endOfTurnSilenceMs !== undefined) {
    runOpts.endOfTurnSilenceMs = opts.endOfTurnSilenceMs;
  }
  if (opts?.vadRunIntervalMs !== undefined) {
    runOpts.vadRunIntervalMs = opts.vadRunIntervalMs;
  }
  return runOpts;
}

export function transcribeStream(
  modelId: string,
  audioInputStream: AsyncIterable<Buffer>,
  prompt: string | undefined,
  metadata: true,
  opts?: TranscribeStreamOpts,
): AsyncGenerator<TranscribeSegment | TranscribeStreamEvent, void, void>;
export function transcribeStream(
  modelId: string,
  audioInputStream: AsyncIterable<Buffer>,
  prompt?: string,
  metadata?: boolean,
  opts?: TranscribeStreamOpts,
): AsyncGenerator<string | TranscribeStreamEvent, void, void>;
export async function* transcribeStream(
  modelId: string,
  audioInputStream: AsyncIterable<Buffer>,
  prompt?: string,
  metadata?: boolean,
  opts?: TranscribeStreamOpts,
): AsyncGenerator<string | TranscribeSegment | TranscribeStreamEvent, void, void> {
  const engineType = getEngineModelType(modelId);
  assertMetadataSupported(modelId, engineType, metadata);
  const silenceMarker = SILENCE_MARKERS[engineType] ?? "";

  const originalConfig = await applyPrompt(modelId, prompt, engineType);

  try {
    const model = getModel(modelId);

    if (!hasRunStreaming(model)) {
      throw new TranscriptionFailedError(
        `Model ${modelId} does not support streaming transcription`,
      );
    }

    const runOpts = buildRunStreamingOpts(engineType, opts);
    const response = await model.runStreaming(audioInputStream, runOpts);

    for await (const output of response.iterate()) {
      logger.debug("Live Transcription Update:", output);

      if (!Array.isArray(output)) {
        // Whisper event objects.
        if ("type" in output) {
          if (output.type === "vad") {
            yield {
              type: "vad",
              speaking: output.speaking,
              probability: output.probability,
            };
            continue;
          }
          if (output.type === "endOfTurn") {
            // `endOfTurn` events that arrive via the typed-event path
            // come exclusively from the whisper engine — whisper
            // measures a trailing silence window and surfaces the
            // boundary as `{ type: "endOfTurn", silenceDurationMs }`.
            // Parakeet's EOU is token-driven and is emitted from
            // `emitSegment` below, tagged `source: "parakeet"`.
            yield {
              type: "endOfTurn",
              source: "whisper",
              silenceDurationMs: output.silenceDurationMs,
            };
            continue;
          }
          continue;
        }
        // Parakeet sometimes emits a single segment instead of an array.
        yield* emitSegment(output, metadata, silenceMarker);
        continue;
      }

      for (const segment of output) {
        yield* emitSegment(segment, metadata, silenceMarker);
      }
    }
  } finally {
    if (originalConfig) {
      await restorePrompt(modelId, originalConfig);
    }
  }
}

/**
 * Emit a single addon segment as either a metadata `TranscribeSegment`
 * (whisper only), a plain text chunk, or a synthetic `endOfTurn` event
 * (parakeet's EOU model surfaces end-of-utterance via the
 * `isEndOfTurn` flag on the same segment that carries the trailing
 * speech tokens).
 *
 * Parakeet's EOU is token-driven, so the synthesized event carries
 * `source: "parakeet"` and no measured silence window. Whisper's own
 * `endOfTurn` events (emitted upstream as `{ type: "endOfTurn",
 * silenceDurationMs }`) are tagged `source: "whisper"` in the typed-
 * event branch above and are not routed through this helper.
 */
function* emitSegment(
  segment: StreamingSegment,
  metadata: boolean | undefined,
  silenceMarker: string,
): Generator<string | TranscribeSegment | TranscribeStreamEvent> {
  if (!segment.text) {
    if (segment.isEndOfTurn) {
      yield { type: "endOfTurn", source: "parakeet" };
    }
    return;
  }
  if (silenceMarker && segment.text.includes(silenceMarker)) {
    if (segment.isEndOfTurn) {
      yield { type: "endOfTurn", source: "parakeet" };
    }
    return;
  }
  if (metadata) {
    yield toTranscribeSegment(segment);
  } else if (segment.text.trim()) {
    yield segment.text;
  }
  if (segment.isEndOfTurn) {
    yield { type: "endOfTurn", source: "parakeet" };
  }
}

