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
import {
  getRequestRegistry,
  withRequestContext,
} from "@/server/bare/runtime";
import { generateServerRequestId } from "@/server/bare/runtime/request-id";

export {
  assertMetadataSupported,
  toTranscribeSegment,
  type WhisperAddonSegment,
};

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
  requestId?: string,
): AsyncGenerator<TranscribeSegment, TranscribeReturn, void>;
export function transcribe(
  params: TranscribeParams,
  requestId?: string,
): AsyncGenerator<string, TranscribeReturn, void>;
export async function* transcribe(
  params: TranscribeParams,
  requestId?: string,
): AsyncGenerator<string | TranscribeSegment, TranscribeReturn, void> {
  const { modelId, metadata } = params;

  // Open a request-scoped lifecycle. The registry routes
  // `cancel({ requestId })` and `cancel({ modelId, kind: "transcribe" })`
  // through this context. Falls back to a server-generated id if the
  // client didn't send one.
  await using ctx = getRequestRegistry().begin({
    requestId: requestId ?? generateServerRequestId(),
    kind: "transcribe",
    modelId,
  });
  const requestLogger = withRequestContext(getServerLogger(), ctx);

  const engineType = getEngineModelType(modelId);
  assertMetadataSupported(modelId, engineType, metadata);
  const silenceMarker = SILENCE_MARKERS[engineType] ?? "";
  const audioFormat = getAudioFormat(modelId, engineType);

  const originalConfig = await applyPrompt(modelId, params.prompt, engineType);
  if (originalConfig) {
    // `restorePrompt` runs on every exit path — happy, throw, cancel —
    // via the scope. LIFO unwinding pairs with the addon-cancel detach
    // below.
    ctx.scope.defer(() => restorePrompt(modelId, originalConfig));
  }

  const model = getModel(modelId);

  // Hard-cancel wiring: whisper.cpp / parakeet expose model-wide
  // `addon.cancel()`. The listener forwards an abort so the
  // currently-running transcription stops decoding ASAP. The
  // `if (ctx.signal.aborted) break` guard inside the iterate loop is
  // the soft-cancel safety net for the case where the abort fires
  // between the addon flag flipping and the iterator's next pull.
  const onAbort = () => {
    const addon = model.addon;
    if (addon?.cancel) {
      addon.cancel.call(addon).catch((err: unknown) => {
        requestLogger.warn(
          `[cancel] addon.cancel() rejected during abort for modelId=${modelId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal.aborted) onAbort();
  ctx.scope.defer(() => {
    ctx.signal.removeEventListener("abort", onAbort);
  });

  const audioStream = await createAudioStream(params.audioChunk, audioFormat);

  const modelStart = nowMs();
  const response = (await model.run(audioStream)) as unknown as TranscribeResponse;

  for await (const output of response.iterate()) {
    if (ctx.signal.aborted) break;
    requestLogger.debug("Streaming Transcription Update:", output);

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
  const modelExecutionMs = nowMs() - modelStart;

  const stats: TranscribeStats = {
    ...(response.stats?.audioDurationMs !== undefined && { audioDuration: response.stats.audioDurationMs }),
    ...(response.stats?.realTimeFactor !== undefined && { realTimeFactor: response.stats.realTimeFactor }),
    ...(response.stats?.tokensPerSecond !== undefined && { tokensPerSecond: response.stats.tokensPerSecond }),
    ...(response.stats?.totalTokens !== undefined && { totalTokens: response.stats.totalTokens }),
    ...(response.stats?.totalSegments !== undefined && { totalSegments: response.stats.totalSegments }),
    ...(response.stats?.whisperEncodeMs !== undefined && { whisperEncodeTime: response.stats.whisperEncodeMs }),
    ...(response.stats?.whisperDecodeMs !== undefined && { whisperDecodeTime: response.stats.whisperDecodeMs }),
    ...(response.stats?.encoderMs !== undefined && { encoderTime: response.stats.encoderMs }),
    ...(response.stats?.decoderMs !== undefined && { decoderTime: response.stats.decoderMs }),
    ...(response.stats?.melSpecMs !== undefined && { melSpecTime: response.stats.melSpecMs }),
  };

  return buildStreamResult(modelExecutionMs, stats);
}

export interface TranscribeStreamOpts {
  emitVadEvents?: boolean;
  endOfTurnSilenceMs?: number;
  vadRunIntervalMs?: number;
  parakeetStreamingConfig?: ParakeetStreamingRunConfig;
}

function buildRunStreamingOpts(
  engineType: string,
  opts?: TranscribeStreamOpts,
): RunStreamingOpts | undefined {
  if (engineType === ModelType.parakeetTranscription) {
    return opts?.parakeetStreamingConfig;
  }

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
  requestId?: string,
): AsyncGenerator<TranscribeSegment | TranscribeStreamEvent, void, void>;
export function transcribeStream(
  modelId: string,
  audioInputStream: AsyncIterable<Buffer>,
  prompt?: string,
  metadata?: boolean,
  opts?: TranscribeStreamOpts,
  requestId?: string,
): AsyncGenerator<string | TranscribeStreamEvent, void, void>;
export async function* transcribeStream(
  modelId: string,
  audioInputStream: AsyncIterable<Buffer>,
  prompt?: string,
  metadata?: boolean,
  opts?: TranscribeStreamOpts,
  requestId?: string,
): AsyncGenerator<string | TranscribeSegment | TranscribeStreamEvent, void, void> {
  // Same `kind: "transcribe"` as the unary variant — the registry
  // doesn't distinguish streaming vs non-streaming variants of the same
  // operation, so `cancel({ modelId, kind: "transcribe" })` cancels
  // either shape.
  await using ctx = getRequestRegistry().begin({
    requestId: requestId ?? generateServerRequestId(),
    kind: "transcribe",
    modelId,
  });
  const requestLogger = withRequestContext(getServerLogger(), ctx);

  const engineType = getEngineModelType(modelId);
  assertMetadataSupported(modelId, engineType, metadata);
  const silenceMarker = SILENCE_MARKERS[engineType] ?? "";

  const originalConfig = await applyPrompt(modelId, prompt, engineType);
  if (originalConfig) {
    ctx.scope.defer(() => restorePrompt(modelId, originalConfig));
  }

  const model = getModel(modelId);

  if (!hasRunStreaming(model)) {
    throw new TranscriptionFailedError(
      `Model ${modelId} does not support streaming transcription`,
    );
  }

  const onAbort = () => {
    const addon = model.addon;
    if (addon?.cancel) {
      addon.cancel.call(addon).catch((err: unknown) => {
        requestLogger.warn(
          `[cancel] addon.cancel() rejected during abort for modelId=${modelId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal.aborted) onAbort();
  ctx.scope.defer(() => {
    ctx.signal.removeEventListener("abort", onAbort);
  });

  const runOpts = buildRunStreamingOpts(engineType, opts);
  const response = await model.runStreaming(audioInputStream, runOpts);

  for await (const output of response.iterate()) {
    if (ctx.signal.aborted) break;
    requestLogger.debug("Live Transcription Update:", output);

    if (!Array.isArray(output)) {
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
          yield {
            type: "endOfTurn",
            source: "whisper",
            silenceDurationMs: output.silenceDurationMs,
          };
          continue;
        }
        continue;
      }
      yield* emitSegment(output, metadata, silenceMarker);
      continue;
    }

    for (const segment of output) {
      yield* emitSegment(segment, metadata, silenceMarker);
    }
  }
}

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
