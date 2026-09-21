// Type-level contract for the unified `@qvac/asr-ggml` public surface.
//
// Replaces the per-engine commonjs-api probes the predecessor packages
// shipped: one class (`ASRGgml`, `export =`), one namespace carrying BOTH
// engine vocabularies, and one shared output/stats type set. `npm run
// test:dts` compiles this against the generated index.d.ts, so a dropped
// export or a renamed engine key fails the build.

import ASRGgml = require("../../index");
import DefaultASRGgml, {
  type ASRGgmlFiles,
  type ASRGgmlOptions,
  type EngineType,
  type ParakeetConfig,
  type WhisperConfig,
} from "../../index";

// ── Both constructors resolve to the same class (export = + interop) ─────
const requireConstructor: typeof ASRGgml = ASRGgml;
const defaultConstructor: typeof ASRGgml = DefaultASRGgml;

// ── Engine discriminants ────────────────────────────────────────────────
const whisperEngine: EngineType = ASRGgml.ENGINE_WHISPER;
const parakeetEngine: ASRGgml.EngineType = ASRGgml.ENGINE_PARAKEET;

// ── Both engine config vocabularies survive the merge verbatim ───────────
const whisperConfig: WhisperConfig = {
  language: "en",
  audio_format: "s16le",
  vad_params: { threshold: 0.6 },
};
const parakeetConfig: ParakeetConfig = {
  maxThreads: 4,
  streamingChunkMs: 2000,
};
const namespacedWhisperConfig: ASRGgml.WhisperConfig = whisperConfig;
const namespacedParakeetConfig: ASRGgml.ParakeetConfig = parakeetConfig;
const vadParams: ASRGgml.VadParams = { threshold: 0.6 };

const files: ASRGgmlFiles = {
  model: "/models/ggml-tiny.bin",
  vadModel: "/models/silero.bin",
};

// ── The options union discriminates on config.engine ────────────────────
const whisperOptions: ASRGgmlOptions = {
  files,
  config: { engine: "whisper", whisperConfig: namespacedWhisperConfig },
  enableStats: true,
  exclusiveRun: false,
};
const parakeetOptions: ASRGgml.ASRGgmlOptions = {
  files: { model: "/models/parakeet-tdt.gguf" },
  config: { engine: "parakeet", parakeetConfig: namespacedParakeetConfig },
};
// `engine` is the convenience alias used when `config` is omitted.
const sniffedOptions: ASRGgmlOptions = { files, engine: "whisper" };
const whisperBranch: ASRGgml.WhisperEngineConfig = { engine: "whisper" };
const parakeetBranch: ASRGgml.ParakeetEngineConfig = { engine: "parakeet" };
const configUnion: ASRGgml.ASRGgmlConfig = whisperBranch;

// ── Engine-scoped reload + streaming options stay engine-scoped ──────────
const whisperReload: ASRGgml.ASRGgmlReloadConfig = {
  whisperConfig: { language: "es" },
};
const parakeetReload: ASRGgml.ASRGgmlReloadConfig = {
  parakeetConfig: { maxThreads: 8 },
};
const whisperStreaming: ASRGgml.WhisperStreamingOptions = {
  emitVadEvents: true,
  endOfTurnSilenceMs: 800,
};
const parakeetStreaming: ASRGgml.ParakeetStreamingRunConfig = {
  chunkMs: 1000,
  emitPartials: true,
};
const streamingOptions: ASRGgml.ASRStreamingOptions = whisperStreaming;

// ── Shared output types ─────────────────────────────────────────────────
const segment: ASRGgml.TranscriptionSegment = {
  text: "hello",
  start: 0,
  end: 1,
  isEndOfTurn: true,
};
// Segment payloads stay bare arrays on onUpdate (no {type:'segment'} wrapper).
const runOutput: ASRGgml.ASRRunOutput = [segment];
const vadEvent: ASRGgml.VadEvent = {
  type: "vad",
  speaking: true,
  score: 0.9,
  source: "silero",
};
const endOfTurnEvent: ASRGgml.EndOfTurnEvent = {
  type: "endOfTurn",
  source: "model-eou",
};
const streamOutput: ASRGgml.ASRStreamOutput = vadEvent;
const audioInput: ASRGgml.AudioInput = new Float32Array(16);
const audioChunk: ASRGgml.AudioChunk = new Int16Array(16);

// ── Backend + stats ─────────────────────────────────────────────────────
const backendId: ASRGgml.BackendId = ASRGgml.BackendId.CPU;
const backendInfo: ASRGgml.BackendInfo = {
  backendDevice: "CPU",
  backendId: 0,
  backendName: "CPU",
  backendDescription: "",
  encoderBackend: "CPU",
  encoderOnCoreml: false,
};
const whisperStats: ASRGgml.WhisperRuntimeStats = {
  backendId: 0,
  backendDevice: 0,
  totalTime: 1,
  audioDurationMs: 1000,
  totalSamples: 16000,
  totalTokens: 4,
  processCalls: 1,
  totalWallMs: 1,
  tokensPerSecond: 4,
  realTimeFactor: 0.1,
  totalSegments: 1,
  whisperSampleMs: 1,
  whisperEncodeMs: 1,
  whisperDecodeMs: 1,
  whisperBatchdMs: 1,
  whisperPromptMs: 1,
  gpuMemTotalMb: -1,
  gpuMemFreeMb: -1,
};
const parakeetStats: ASRGgml.ParakeetRuntimeStats = {
  backendId: 0,
  backendDevice: 0,
  totalTime: 1,
  audioDurationMs: 1000,
  totalSamples: 16000,
  totalTokens: 4,
  processCalls: 1,
  totalWallMs: 1,
  totalTranscriptions: 1,
  modelLoadMs: 1,
  melSpecMs: 1,
  encoderMs: 1,
  decoderMs: 1,
  totalEncodedFrames: 1,
  gpuUnsupported: 0,
  encoderOnCoreml: 0,
};
const runtimeStats: ASRGgml.RuntimeStats = whisperStats;
const statsCore: ASRGgml.RuntimeStatsCore = whisperStats;
const clientState: ASRGgml.InferenceClientState = {
  configLoaded: true,
  weightsLoaded: true,
  destroyed: false,
};

// ── Errors reach consumers as class statics (namespaces carry types only) ─
const errCodes: typeof ASRGgml.ERR_CODES = ASRGgml.ERR_CODES;
const notSupported: number = ASRGgml.ERR_CODES.NOT_SUPPORTED;
const streamingActive: number = ASRGgml.ERR_CODES.STREAMING_SESSION_ACTIVE;
const invalidEngine: number = ASRGgml.ERR_CODES.INVALID_ENGINE;
const errorInstance: Error = new ASRGgml.Error({
  code: ASRGgml.ERR_CODES.NOT_SUPPORTED,
});

// ── Inference-manager plumbing the SDK repoint relies on ─────────────────
const managerConfig: typeof ASRGgml.inferenceManagerConfig =
  ASRGgml.inferenceManagerConfig;
const modelKey: string = ASRGgml.getModelKey();

void [
  requireConstructor,
  defaultConstructor,
  whisperEngine,
  parakeetEngine,
  vadParams,
  whisperOptions,
  parakeetOptions,
  sniffedOptions,
  parakeetBranch,
  configUnion,
  whisperReload,
  parakeetReload,
  parakeetStreaming,
  streamingOptions,
  runOutput,
  endOfTurnEvent,
  streamOutput,
  audioInput,
  audioChunk,
  backendId,
  backendInfo,
  parakeetStats,
  runtimeStats,
  statsCore,
  clientState,
  errCodes,
  notSupported,
  streamingActive,
  invalidEngine,
  errorInstance,
  managerConfig,
  modelKey,
];
