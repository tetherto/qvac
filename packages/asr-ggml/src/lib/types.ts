/**
 * Shared engine-agnostic types for the unified `@qvac/asr-ggml` surface.
 */

/**
 * A single transcription segment. Core fields are shared by both engines;
 * engine-specific extras pass through untouched via the index signature.
 */
export interface TranscriptionSegment {
  text: string;
  /** Segment start time in seconds. */
  start?: number;
  /** Segment end time in seconds. */
  end?: number;
  id?: number;
  /** Parakeet: segment continues the previous one instead of replacing it. */
  toAppend?: boolean;
  /** Parakeet: segment ends on a recognized end-of-utterance boundary. */
  isEndOfTurn?: boolean;
  /** Parakeet: segment begins a new SentencePiece word. */
  startsWord?: boolean;
  [key: string]: unknown;
}

/**
 * Typed voice-activity event. Whisper-only at launch (`source: "silero"`);
 * `"energy"` is reserved for parakeet's Phase-2 native plumbing.
 */
export interface VadEvent {
  type: "vad";
  speaking: boolean;
  score: number;
  source: "silero" | "energy";
}

/** Typed end-of-turn event. */
export interface EndOfTurnEvent {
  type: "endOfTurn";
  /** Present for `source: "vad-silence"` only. */
  silenceDurationMs?: number;
  source: "vad-silence" | "model-eou";
}

export type ASRRunOutput = TranscriptionSegment[] | TranscriptionSegment;

export type ASRStreamOutput =
  | TranscriptionSegment[]
  | TranscriptionSegment
  | VadEvent
  | EndOfTurnEvent;

/** Numeric code identifying the compute backend selected by the engine. */
export enum BackendId {
  CPU = 0,
  Metal = 1,
  CUDA = 2,
  Vulkan = 3,
  OpenCL = 4,
  Other = 99,
}

/**
 * Backend information reported by the native engine. Six core keys are
 * shared cross-engine; the `gpuMem*` extras are whisper-only.
 */
export interface BackendInfo {
  backendDevice: string;
  backendId: number;
  backendName: string;
  backendDescription: string;
  encoderBackend: string;
  encoderOnCoreml: boolean;
  gpuMemTotalMb?: number;
  gpuMemFreeMb?: number;
}

/** Runtime-statistics fields shared by both engines. */
export interface RuntimeStatsCore {
  backendId: number;
  backendDevice: number;
  totalTime: number;
  audioDurationMs: number;
  totalSamples: number;
  totalTokens: number;
  processCalls: number;
  totalWallMs: number;
}

/** Runtime statistics returned by the native Whisper model. */
export interface WhisperRuntimeStats extends RuntimeStatsCore {
  tokensPerSecond: number;
  realTimeFactor: number;
  totalSegments: number;
  whisperSampleMs: number;
  whisperEncodeMs: number;
  whisperDecodeMs: number;
  whisperBatchdMs: number;
  whisperPromptMs: number;
  gpuMemTotalMb: number;
  gpuMemFreeMb: number;
}

/** Runtime statistics returned by the native Parakeet model. */
export interface ParakeetRuntimeStats extends RuntimeStatsCore {
  totalTranscriptions: number;
  modelLoadMs: number;
  melSpecMs: number;
  encoderMs: number;
  decoderMs: number;
  totalEncodedFrames: number;
  gpuUnsupported: number;
  encoderOnCoreml: number;
}

export type RuntimeStats = WhisperRuntimeStats | ParakeetRuntimeStats;

export interface InferenceClientState {
  configLoaded: boolean;
  weightsLoaded: boolean;
  destroyed: boolean;
}

/**
 * A single audio chunk at the public boundary. The chunk's class decides
 * its interpretation: `Float32Array` = f32 samples in [-1, 1];
 * `Int16Array` = s16 samples; `Uint8Array` = raw bytes whose encoding is
 * `s16le` by default (whisper's `audio_format` config key can switch the
 * byte interpretation to `f32le`). 16 kHz mono always.
 */
export type AudioChunk = Float32Array | Int16Array | Uint8Array;

export type AudioInput =
  | AudioChunk
  | AudioChunk[]
  | Iterable<AudioChunk>
  | AsyncIterable<AudioChunk>
  | Iterable<number>;
