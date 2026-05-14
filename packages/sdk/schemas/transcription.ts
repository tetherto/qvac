import { z } from "zod";

export const audioInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("base64"),
    value: z.string(),
  }),
  z.object({
    type: z.literal("filePath"),
    value: z.string(),
  }),
]);

const transcribeBaseSchema = z.object({
  modelId: z.string(),
  /**
   * Initial transcription prompt. Whisper engine only — silently
   * ignored by the parakeet engine, which has no equivalent prompting
   * surface in `qvac-parakeet.cpp`.
   */
  prompt: z.string().optional(),
  metadata: z.boolean().optional(),
});

export const transcribeParamsSchema = transcribeBaseSchema.extend({
  audioChunk: audioInputSchema,
});

export const transcribeStatsSchema = z.object({
  audioDuration: z.number().optional(),
  realTimeFactor: z.number().optional(),
  tokensPerSecond: z.number().optional(),
  totalTokens: z.number().optional(),
  totalSegments: z.number().optional(),
  whisperEncodeTime: z.number().optional(),
  whisperDecodeTime: z.number().optional(),
  encoderTime: z.number().optional(),
  decoderTime: z.number().optional(),
  melSpecTime: z.number().optional(),
});

export const transcribeSegmentSchema = z.object({
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  append: z.boolean(),
  id: z.number(),
});

export const vadStateEventSchema = z.object({
  speaking: z.boolean(),
  probability: z.number(),
});

// `endOfTurn` is shaped as a discriminated union on `source` so each
// engine carries the fields it actually owns. Whisper measures a
// trailing silence window (`silenceDurationMs`, REQUIRED) and emits
// the event when that window elapses. Parakeet's EOU is token-driven
// — its EOU model emits an explicit `<EOU>` token, so there is no
// silence window to report and the event carries no payload beyond
// the discriminator.
//
// Modelling these as a union rather than a single shape with an
// optional `silenceDurationMs` keeps the whisper invariant (silence
// window MUST be present) statically checked and prevents accidental
// regressions in either engine from going undetected at the schema
// boundary.
export const whisperEndOfTurnEventSchema = z.object({
  source: z.literal("whisper"),
  /** Trailing silence (in ms) measured by whisper before the EOU event fired. */
  silenceDurationMs: z.number(),
});

export const parakeetEndOfTurnEventSchema = z.object({
  source: z.literal("parakeet"),
});

export const endOfTurnEventSchema = z.discriminatedUnion("source", [
  whisperEndOfTurnEventSchema,
  parakeetEndOfTurnEventSchema,
]);

export const transcribeRequestSchema = transcribeParamsSchema.extend({
  type: z.literal("transcribe"),
});

const transcriptionResultBase = z.object({
  text: z.string().optional(),
  done: z.boolean().optional(),
  stats: transcribeStatsSchema.optional(),
  error: z.string().optional(),
  segment: transcribeSegmentSchema.optional(),
  vad: vadStateEventSchema.optional(),
  endOfTurn: endOfTurnEventSchema.optional(),
});

export const transcribeResponseSchema = transcriptionResultBase.extend({
  type: z.literal("transcribe"),
});

export type AudioInput = z.infer<typeof audioInputSchema>;
export type TranscribeParams = z.infer<typeof transcribeParamsSchema>;
export type TranscribeSegment = z.infer<typeof transcribeSegmentSchema>;
export type TranscribeClientParams = {
  modelId: string;
  audioChunk: string | Buffer;
  prompt?: string;
  metadata?: boolean;
};
export type TranscribeRequest = z.infer<typeof transcribeRequestSchema>;
export type TranscribeResponse = z.infer<typeof transcribeResponseSchema>;

/**
 * Per-call overrides for parakeet's duplex streaming session.
 *
 * Each field maps to its `streaming*`-prefixed counterpart in
 * `parakeetConfig` (see `parakeetRuntimeConfigSchema`). The `streaming`
 * prefix is intentionally dropped here because every field on this
 * object is already namespaced under the `parakeetStreamingConfig`
 * field of `transcribeStream({ ... })`. Any field omitted falls back
 * to the load-time value.
 */
export const parakeetStreamingRunConfigSchema = z.object({
  /** Encoder cadence in ms (overrides `parakeetConfig.streamingChunkMs`). */
  chunkMs: z.number().int().positive().optional(),
  /** Sortformer rolling-history window in ms (overrides `parakeetConfig.streamingHistoryMs`). */
  historyMs: z.number().int().positive().optional(),
  /** ASR encoder left-context window in ms (overrides `parakeetConfig.streamingLeftContextMs`). */
  leftContextMs: z.number().int().nonnegative().optional(),
  /** ASR encoder right-lookahead window in ms (overrides `parakeetConfig.streamingRightLookaheadMs`). */
  rightLookaheadMs: z.number().int().nonnegative().optional(),
  /** Emit partial segments before chunk boundaries (overrides `parakeetConfig.streamingEmitPartials`). */
  emitPartials: z.boolean().optional(),
  /**
   * CTC/TDT-only energy-based voice-activity hint (overrides
   * `parakeetConfig.streamingEnergyVad`). Engine-internal flag
   * forwarded to parakeet-cpp's `StreamingOptions::enable_energy_vad`;
   * it influences how the engine segments speech (affecting segment
   * cadence and what surfaces as a partial vs a finalized segment) but
   * does NOT add new event types to the transcribeStream output. Use
   * the whisper engine if you need standalone VAD `speaking`/`probability`
   * events.
   */
  emitEnergyVad: z.boolean().optional(),
});

export type ParakeetStreamingRunConfig = z.infer<
  typeof parakeetStreamingRunConfigSchema
>;

export const transcribeStreamRequestSchema = transcribeBaseSchema.extend({
  type: z.literal("transcribeStream"),
  // Whisper-only knobs (ignored by other engines).
  emitVadEvents: z.boolean().optional(),
  endOfTurnSilenceMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      "Silence (ms) before an endOfTurn event fires. 0 or unset disables end-of-turn detection entirely. Whisper engine only.",
    ),
  vadRunIntervalMs: z.number().int().positive().optional(),
  // Parakeet-only per-call streaming overrides (ignored by other engines).
  parakeetStreamingConfig: parakeetStreamingRunConfigSchema.optional(),
});

export const transcribeStreamResponseSchema = transcriptionResultBase.extend({
  type: z.literal("transcribeStream"),
});

export type TranscribeStreamRequest = z.infer<
  typeof transcribeStreamRequestSchema
>;
export type TranscribeStreamResponse = z.infer<
  typeof transcribeStreamResponseSchema
>;

export type TranscribeStreamClientParams = {
  modelId: string;
  /**
   * Initial transcription prompt. Whisper engine only — silently
   * ignored by the parakeet engine.
   */
  prompt?: string;
  metadata?: boolean;
  emitVadEvents?: boolean;
  /**
   * Silence (ms) before an `endOfTurn` event fires. `0` or unset disables
   * end-of-turn detection entirely — no `endOfTurn` events will be emitted
   * even when `emitVadEvents` is `true`. Pass a positive value (e.g. `800`)
   * to enable. Whisper engine only.
   */
  endOfTurnSilenceMs?: number;
  vadRunIntervalMs?: number;
  /**
   * Per-call overrides for parakeet's duplex streaming session. Each field
   * defaults to the matching `parakeetConfig.streaming*` value supplied at
   * `loadModel` time. Parakeet engine only.
   */
  parakeetStreamingConfig?: ParakeetStreamingRunConfig;
};

export interface TranscribeStreamSession {
  write(audioChunk: Uint8Array): void;
  end(): void;
  destroy(): void;
  [Symbol.asyncIterator](): AsyncIterator<string>;
}

export interface TranscribeStreamMetadataSession {
  write(audioChunk: Uint8Array): void;
  end(): void;
  destroy(): void;
  [Symbol.asyncIterator](): AsyncIterator<TranscribeSegment>;
}

export type VadStateEvent = z.infer<typeof vadStateEventSchema>;
export type WhisperEndOfTurnEvent = z.infer<typeof whisperEndOfTurnEventSchema>;
export type ParakeetEndOfTurnEvent = z.infer<typeof parakeetEndOfTurnEventSchema>;
export type EndOfTurnEvent = z.infer<typeof endOfTurnEventSchema>;

export type TranscribeStreamEvent =
  | { type: "text"; text: string }
  | { type: "segment"; segment: TranscribeSegment }
  | ({ type: "vad" } & VadStateEvent)
  | ({ type: "endOfTurn" } & EndOfTurnEvent);

export interface TranscribeStreamConversationSession {
  write(audioChunk: Uint8Array): void;
  end(): void;
  destroy(): void;
  [Symbol.asyncIterator](): AsyncIterator<TranscribeStreamEvent>;
}

export type TranscribeStats = z.infer<typeof transcribeStatsSchema>;
