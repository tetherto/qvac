/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules and @qvac/logging expose CommonJS export shapes. */
import bareOs = require("bare-os");
import path = require("bare-path");
import fs = require("bare-fs");
import QvacLogger = require("@qvac/logging");
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  createJobHandler,
  exclusiveRunQueue,
  getApiDefinition as inferGetApiDefinition,
  type JobHandler,
  type QvacResponse,
} from "@qvac/infer-base";

import {
  TTSInterface,
  type TTSBinding,
  type TTSConfigurationParams,
  type TTSOutputCallback,
} from "./tts";
import {
  ERR_CODES,
  QvacErrorAddonTTSGgml,
} from "./lib/error";
import { splitTtsText } from "./lib/textChunker";
import {
  accumulateTextStream,
  DEFAULT_FLUSH_AFTER_MS,
  type SentenceDelimiterPreset,
} from "./lib/textStreamAccumulator";

const { platform } = bareOs;

const ENGINE_CHATTERBOX = "chatterbox";
const ENGINE_SUPERTONIC = "supertonic";
const MIN_OUTPUT_SAMPLE_RATE = 8000;
const MAX_OUTPUT_SAMPLE_RATE = 192000;
const CHATTERBOX_T3_TURBO = "chatterbox-t3-turbo.gguf";
const CHATTERBOX_T3_MTL = "chatterbox-t3-mtl.gguf";
const CHATTERBOX_S3GEN_DEFAULT = "chatterbox-s3gen.gguf";
const CHATTERBOX_S3GEN_MTL = "chatterbox-s3gen-mtl.gguf";
const SUPERTONIC_DEFAULT = "supertonic.gguf";
const SUPERTONIC_MTL = "supertonic2.gguf";
const SUPERTONIC_V3_RE = /^supertonic3(-[a-z0-9_]+)?\.gguf$/i;
const SUPERTONIC_V3_QUANT_ORDER = [
  "f16",
  "f32",
  "q8_0",
  "q4_0",
];

type EngineType =
  | typeof ENGINE_CHATTERBOX
  | typeof ENGINE_SUPERTONIC;

/**
 * Model file paths for the GGML TTS backend. Engine is auto-detected
 * from these fields (Chatterbox vs Supertonic) unless overridden via
 * `TTSGgmlOptions.engine`. All paths must be absolute and are passed
 * through to the native layer as-is.
 */
interface TTSGgmlFiles {
  /**
   * Bundle root. For Chatterbox, expected to contain
   * `chatterbox-t3-turbo.gguf` + `chatterbox-s3gen.gguf` (turbo) or
   * `chatterbox-t3-mtl.gguf` + `chatterbox-s3gen-mtl.gguf` (multilingual).
   * For Supertonic, expected to contain `supertonic.gguf`.
   */
  modelDir?: string;
  /** Chatterbox T3 (text to speech tokens) GGUF path. Overrides `modelDir`. */
  t3Model?: string;
  t3ModelPath?: string;
  t3?: string;
  /** Chatterbox S3Gen + HiFT (speech tokens to 24 kHz wav) GGUF path. Overrides `modelDir`. */
  s3genModel?: string;
  s3genModelPath?: string;
  s3gen?: string;
  /** Supertonic single-file GGUF path. Overrides `modelDir`. */
  supertonicModel?: string;
  supertonicModelPath?: string;
  supertonic?: string;
  /**
   * LavaSR enhancer GGUF: single-file Vocos bandwidth extension produced by
   * tts-cpp/scripts/convert-lavasr-enhancer-to-gguf.py. When supplied, output
   * is neurally upsampled to 48 kHz (the canonical way to enable enhancement;
   * `enhancer.enhancerPath` is the only alternative).
   */
  lavasrEnhancer?: string;
  /**
   * LavaSR denoiser GGUF: UL-UNAS speech denoiser produced by
   * tts-cpp/scripts/convert-lavasr-denoiser-to-gguf.py. Runs before the
   * enhancer and is rate-preserving (the canonical way to enable denoising;
   * `denoiser.denoiserPath` is the only alternative).
   *
   * The tts-cpp UL-UNAS forward is implemented in qvac-ext-lib-whisper.cpp
   * PR #78 (scalar CPU port, validated bit-close to the ONNX reference).
   */
  lavasrDenoiser?: string;
  /** Optional directory containing baked Chatterbox voice profiles. */
  voicesDir?: string;
  /**
   * Chatterbox MTL only: directory holding the compiled MeCab/IPAdic
   * dictionary used for Japanese morphological segmentation. Forwarded to
   * tts-cpp's `EngineOptions::mecab_dict_path`. Alias: top-level
   * `mecabDictPath`.
   */
  mecabDictDir?: string;
  mecabDictPath?: string;
  /**
   * Chatterbox MTL only: path to the Cangjie TSV used for Chinese
   * romanisation. Forwarded to tts-cpp's `EngineOptions::cangjie_tsv_path`.
   */
  cangjieTsvPath?: string;
  cangjieTsv?: string;
}

interface TTSGgmlRuntimeConfig {
  /** Language code; default "en". Chatterbox MTL accepts es/fr/de/pt/it/zh/ja/ko/... */
  language?: string;
  /**
   * Route inference through a GPU backend (Metal / Vulkan / OpenCL) if
   * available. Defaults to `false` for both engines. Honored on Apple,
   * desktop, and Android, where tts-cpp selects the backend using its
   * per-vendor allowlist.
   */
  useGPU?: boolean;
  /**
   * Desired output sample rate in Hz (8000-192000); omit to keep the engine's
   * native rate. Resamples the native output (24 kHz Chatterbox, 44.1 kHz
   * Supertonic), or the 48 kHz LavaSR-enhanced signal, before emitting.
   * `TTSOutputChunk.sampleRate` reports the resulting rate.
   */
  outputSampleRate?: number;
  backendsDir?: string;
  openclCacheDir?: string;
  vulkanCacheDir?: string;
}

/**
 * LavaSR enhancer config. The discriminated `type` leaves room for future
 * enhancer kinds; v1 ships `lavasr`. Enhancement is enabled by providing a
 * GGUF path here or via `files.lavasrEnhancer`.
 */
interface LavaSREnhancerOptions {
  type: "lavasr";
  /** Enhancer GGUF path (alternative to `files.lavasrEnhancer`). */
  enhancerPath?: string;
}

/**
 * LavaSR denoiser config. V1 ships the `lavasr` UL-UNAS denoiser. Denoising
 * is enabled by providing a GGUF path here or via `files.lavasrDenoiser`.
 * It runs before the enhancer and preserves the sample rate.
 */
interface LavaSRDenoiserOptions {
  type: "lavasr";
  /** Denoiser GGUF path (alternative to `files.lavasrDenoiser`). */
  denoiserPath?: string;
}

interface TTSGgmlOptions {
  files?: TTSGgmlFiles;
  config?: TTSGgmlRuntimeConfig;
  logger?: object;
  lazySessionLoading?: boolean;
  /** Explicit engine selection. Auto-detected from `files` when omitted. */
  engine?: EngineType;
  /** Chatterbox: voice-cloning reference audio path (wav). */
  referenceAudio?: string;
  /** Chatterbox: directory of baked voice-conditioning tensors. */
  voiceDir?: string;
  /** RNG seed for Chatterbox CFM/SineGen or Supertonic latent generation. */
  seed?: number;
  /**
   * Move N layers to the GPU backend. Chatterbox: pass 99 to move everything.
   * Supertonic: pass 99 to offload on GPU-capable hosts, including Android.
   */
  nGpuLayers?: number;
  /**
   * Chatterbox-only cap on the T3 context length (prompt + generated speech
   * tokens, 25 tokens ~= 1 second of audio). The KV cache is allocated up
   * front at this length, so the cap directly bounds memory. Pass 0 to use
   * the GGUF's full context; negative values are rejected.
   */
  nCtx?: number;
  /**
   * Chatterbox-only T3 KV-cache storage dtype: `f32` | `f16` | `q8_0`.
   * `f16` is the safe cross-backend default. `q8_0` is smaller and faster on
   * supported backends, but is opt-in because not every backend implements
   * its required operations.
   */
  kvCacheType?: "f32" | "f16" | "q8_0";
  /** Override `std::thread::hardware_concurrency()`. */
  threads?: number;
  /** Chatterbox-only speech tokens per native streaming chunk. 0 disables. */
  streamChunkTokens?: number;
  /** Chatterbox-only smaller first chunk for low first-audio-out latency. */
  streamFirstChunkTokens?: number;
  /** Chatterbox-only CFM Euler step count. */
  cfmSteps?: number;
  /**
   * Chatterbox-only S3Gen classifier-free-guidance rate. The diffusion loop
   * normally runs a batched conditioned + unconditioned pass combined by this
   * rate. `0` skips the unconditioned pass; a positive value overrides the
   * model's baked rate. Omit it to retain the baked rate.
   */
  cfgRate?: number;
  /** Supertonic voice id baked into the GGUF, such as `F1` or `M1`. */
  voice?: string;
  /** Alias for `voice` for compatibility with `@qvac/tts-onnx`. */
  voiceName?: string;
  /** Supertonic vector-estimator CFM steps. 0 uses the GGUF default. */
  steps?: number;
  /** Alias for `steps` for compatibility with `@qvac/tts-onnx`. */
  numInferenceSteps?: number;
  /**
   * Speech-rate / duration multiplier (1.0 = unchanged, less than 1 slower,
   * greater than 1 faster). Supertonic scales its native duration predictor.
   * Chatterbox applies pitch-preserving WSOLA time-stretch, bounded to
   * [0.25, 4.0].
   */
  speed?: number;
  /** Supertonic optional `.npy` initial-noise tensor path. */
  noiseNpyPath?: string;
  /**
   * LavaSR neural speech enhancement. Opt-in CPU/GGML bandwidth extension to
   * 48 kHz, enabled by a GGUF path here or through `files.lavasrEnhancer`.
   * Works for both engines, including Chatterbox native chunk streaming.
   */
  enhancer?: LavaSREnhancerOptions;
  /**
   * LavaSR neural speech denoiser (UL-UNAS). Opt-in preprocessing that runs
   * before the enhancer and preserves the sample rate. Enabled by a GGUF path
   * here or through `files.lavasrDenoiser`; rejected with Chatterbox native
   * chunk streaming.
   */
  denoiser?: LavaSRDenoiserOptions;
  /** Directory the addon scans for dynamically loaded ggml backends. */
  backendsDir?: string;
  /** Directory where ggml-opencl persists its compiled program binary. */
  openclCacheDir?: string;
  /**
   * Supertonic + `useGPU: true` only: directory where the Vulkan backend
   * persists its compiled pipeline cache (`GGML_VK_PIPELINE_CACHE_DIR`).
   * Unset means no cross-process cache or load-time pre-warm.
   */
  vulkanCacheDir?: string;
  /** Chatterbox MTL MeCab/IPAdic dictionary directory for Japanese. */
  mecabDictPath?: string;
  mecabDictDir?: string;
  /** Chatterbox MTL Cangjie TSV path for Chinese. */
  cangjieTsvPath?: string;
  opts?: object;
  exclusiveRun?: boolean;
}

interface NormalizedFiles {
  modelDir?: string;
  t3Model?: string;
  s3genModel?: string;
  supertonicModel?: string;
  voicesDir?: string;
  lavasrEnhancer?: string;
  lavasrDenoiser?: string;
  mecabDictDir?: string;
  cangjieTsvPath?: string;
}

interface InferenceState {
  configLoaded: boolean;
  weightsLoaded: boolean;
  destroyed: boolean;
}

interface TTSOutputChunk {
  /** PCM audio payload. Kept as `ArrayBuffer` for public API compatibility. */
  outputArray: ArrayBuffer;
  /**
   * Output sample rate. The native engine rate (24000 for Chatterbox,
   * 44100 for Supertonic), or 48000 when the LavaSR enhancer is active.
   */
  sampleRate?: number;
}

interface NativeOutputChunk {
  outputArray: Int16Array;
  sampleRate?: number;
}

interface RuntimeStats {
  totalTime: number;
  tokensPerSecond: number;
  realTimeFactor: number;
  audioDurationMs: number;
  totalSamples: number;
  /** Active compute device after load-time backend selection. 0 = CPU, 1 = GPU. */
  backendDevice?: number;
  /** Stable backend code: 0=CPU, 1=Metal, 2=CUDA, 3=Vulkan, 4=OpenCL, 99=other GPU. */
  backendId?: number;
  /** 1 when a present GPU is unsupported by engine policy; 0 otherwise. */
  gpuUnsupported?: number;
}

interface NativeStats {
  totalTime?: number;
  audioDurationMs?: number;
  totalSamples?: number;
  [key: string]: unknown;
}

interface SentenceStreamChunkMeta {
  chunkIndex?: number;
  sentenceChunk?: string;
  /**
   * True on the final pre-chunked synthesis output. Undefined for async
   * iterator streaming where the final chunk is not known up front.
   */
  isLast?: boolean;
}

interface SentenceStreamOptions {
  /** BCP-47 locale for `Intl.Segmenter` when available. */
  locale?: string;
  /** Maximum graphemes per chunk; defaults to 300, or 120 for Korean. */
  maxChunkScalars?: number;
}

interface RunStreamingOptions {
  accumulateSentences?: boolean;
  sentenceDelimiter?: RegExp;
  sentenceDelimiterPreset?: SentenceDelimiterPreset;
  maxBufferScalars?: number;
  flushAfterMs?: number;
}

/** Input accepted by `runStreaming`. */
type TextStreamInput =
  | string
  | string[]
  | Iterable<string>
  | AsyncIterable<string>;

interface TTSRunInput {
  type?: string;
  input: string;
  streamOutput?: boolean;
  locale?: string;
  maxChunkScalars?: number;
  outputSampleRate?: number;
  /**
   * Cancels non-streaming `run()`. An already-aborted signal rejects without
   * native dispatch. Ignored by all streaming paths.
   */
  signal?: AbortSignal;
}

interface ChunkResolver {
  resolve(): void;
  reject(error: unknown): void;
}

interface StreamAccumulator {
  totalTime: number;
  audioDurationMs: number;
  totalSamples: number;
}

interface SentenceStreamContext {
  textStreamMode?: boolean;
  asyncTextSource?: AsyncIterable<string>;
  chunks: string[];
  chunkIdx: number;
  acc: StreamAccumulator;
  chunkResolver: ChunkResolver | null;
}

type ExclusiveRunner = <T>(fn: () => Promise<T>) => Promise<T>;

function normalizeError(error: unknown): string | Error {
  return typeof error === "string"
    ? error
    : error instanceof Error
      ? error
      : new Error("Unknown TTS error");
}

function firstNonEmpty<T>(
  ...candidates: Array<T | "" | null | undefined>
): T | undefined {
  for (const value of candidates) {
    if (value != null && value !== "") return value;
  }
  return undefined;
}

function fileExistsSafe(filePath?: string): boolean {
  if (!filePath) return false;
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function findSupertonicV3InDir(
  modelDir?: string,
): string | undefined {
  if (!modelDir) return undefined;
  let entries: string[];
  try {
    entries = fs.readdirSync(modelDir);
  } catch {
    return undefined;
  }
  const matches = entries.filter((name) =>
    SUPERTONIC_V3_RE.test(name),
  );
  if (matches.length === 0) return undefined;
  function rank(name: string): number {
    if (/^supertonic3\.gguf$/i.test(name)) return 0;
    const match = name.match(/^supertonic3-(.+)\.gguf$/i);
    const index = match
      ? SUPERTONIC_V3_QUANT_ORDER.indexOf(match[1].toLowerCase())
      : -1;
    return index === -1
      ? SUPERTONIC_V3_QUANT_ORDER.length + 1
      : index + 1;
  }
  matches.sort((left, right) => rank(left) - rank(right));
  return path.join(modelDir, matches[0]);
}

function normalizeGgmlFiles(
  files: TTSGgmlFiles | null | undefined,
): NormalizedFiles {
  if (files == null || typeof files !== "object") return {};
  return {
    modelDir: firstNonEmpty(files.modelDir),
    t3Model: firstNonEmpty(
      files.t3Model,
      files.t3ModelPath,
      files.t3,
    ),
    s3genModel: firstNonEmpty(
      files.s3genModel,
      files.s3genModelPath,
      files.s3gen,
    ),
    supertonicModel: firstNonEmpty(
      files.supertonicModel,
      files.supertonicModelPath,
      files.supertonic,
    ),
    voicesDir: firstNonEmpty(files.voicesDir),
    lavasrEnhancer: firstNonEmpty(files.lavasrEnhancer),
    lavasrDenoiser: firstNonEmpty(files.lavasrDenoiser),
    mecabDictDir: firstNonEmpty(
      files.mecabDictDir,
      files.mecabDictPath,
    ),
    cangjieTsvPath: firstNonEmpty(
      files.cangjieTsvPath,
      files.cangjieTsv,
    ),
  };
}

function detectEngineType(
  engine: EngineType | undefined,
  files: NormalizedFiles,
): EngineType {
  if (engine === ENGINE_CHATTERBOX || engine === ENGINE_SUPERTONIC) {
    return engine;
  }
  if (engine != null && engine !== "") {
    throw new Error(
      "tts-ggml: 'engine' option must be 'chatterbox' or 'supertonic' " +
        `(got '${String(engine)}')`,
    );
  }
  if (files.t3Model || files.s3genModel) return ENGINE_CHATTERBOX;
  if (files.supertonicModel) return ENGINE_SUPERTONIC;
  if (files.modelDir) {
    const hasChatterbox =
      fileExistsSafe(path.join(files.modelDir, CHATTERBOX_T3_TURBO)) ||
      fileExistsSafe(path.join(files.modelDir, CHATTERBOX_T3_MTL));
    const hasSupertonic =
      fileExistsSafe(path.join(files.modelDir, SUPERTONIC_DEFAULT)) ||
      fileExistsSafe(path.join(files.modelDir, SUPERTONIC_MTL)) ||
      !!findSupertonicV3InDir(files.modelDir);
    if (hasChatterbox) return ENGINE_CHATTERBOX;
    if (hasSupertonic) return ENGINE_SUPERTONIC;
  }
  return ENGINE_CHATTERBOX;
}

function resolveSupertonicModelDirPath(modelDir: string): string {
  const english = path.join(modelDir, SUPERTONIC_DEFAULT);
  const multilingual = path.join(modelDir, SUPERTONIC_MTL);
  const versionThree = findSupertonicV3InDir(modelDir);
  if (fileExistsSafe(english)) return english;
  if (fileExistsSafe(multilingual)) return multilingual;
  if (versionThree) return versionThree;
  return english;
}

function resolveChatterboxModelDirPaths(
  modelDir: string,
): { t3: string; s3: string } {
  const turboT3 = path.join(modelDir, CHATTERBOX_T3_TURBO);
  const multilingualT3 = path.join(modelDir, CHATTERBOX_T3_MTL);
  const defaultS3 = path.join(modelDir, CHATTERBOX_S3GEN_DEFAULT);
  const multilingualS3 = path.join(
    modelDir,
    CHATTERBOX_S3GEN_MTL,
  );
  if (
    fileExistsSafe(multilingualT3) &&
    !fileExistsSafe(turboT3)
  ) {
    return {
      t3: multilingualT3,
      s3: fileExistsSafe(multilingualS3)
        ? multilingualS3
        : defaultS3,
    };
  }
  return { t3: turboT3, s3: defaultS3 };
}

function defaultAccumulateSentencesForStreamInput(
  textStream: TextStreamInput | null | undefined,
): boolean {
  if (
    textStream == null ||
    typeof textStream === "string" ||
    Array.isArray(textStream)
  ) {
    return false;
  }
  return (
    typeof (
      textStream as {
        [Symbol.asyncIterator]?: unknown;
      }
    )[Symbol.asyncIterator] === "function"
  );
}

function ttsOutputDebugString(data: unknown): string {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (
    typeof data === "number" ||
    typeof data === "boolean" ||
    typeof data === "bigint"
  ) {
    return data.toString();
  }
  if (typeof data === "symbol") return data.description || "";
  if (typeof data === "function") return data.name;
  const value = data as {
    sampleRate?: unknown;
    chunkIndex?: unknown;
    isLast?: unknown;
    sentenceChunk?: unknown;
    outputArray?: { length?: unknown };
  };
  const summary: Record<string, unknown> = {};
  if (value.sampleRate != null) summary.sampleRate = value.sampleRate;
  if (value.chunkIndex != null) summary.chunkIndex = value.chunkIndex;
  if (value.isLast != null) summary.isLast = value.isLast;
  if (value.sentenceChunk != null) {
    summary.sentenceChunk = value.sentenceChunk;
  }
  if (
    value.outputArray &&
    typeof value.outputArray.length === "number"
  ) {
    summary.outputArrayLen = value.outputArray.length;
  }
  return JSON.stringify(summary);
}

function resolveDefaultLazySessionLoading(
  lazySessionLoading?: boolean,
): boolean {
  if (lazySessionLoading != null) return lazySessionLoading;
  return platform() === "ios" || platform() === "android";
}

function validateOutputSampleRate(
  outputSampleRate?: number,
): number | null {
  if (outputSampleRate == null) return null;
  if (
    outputSampleRate < MIN_OUTPUT_SAMPLE_RATE ||
    outputSampleRate > MAX_OUTPUT_SAMPLE_RATE
  ) {
    throw new Error(
      `outputSampleRate must be between ${MIN_OUTPUT_SAMPLE_RATE} and ` +
        `${MAX_OUTPUT_SAMPLE_RATE}, got ${outputSampleRate}`,
    );
  }
  return outputSampleRate;
}

function resolveEnhancerGgufPath(
  files: NormalizedFiles,
  enhancer?: LavaSREnhancerOptions,
): string | undefined {
  if (enhancer != null && enhancer.type !== "lavasr") {
    throw new Error(
      `tts-ggml: unknown enhancer.type '${String(enhancer.type)}', expected 'lavasr'.`,
    );
  }
  return firstNonEmpty(
    files.lavasrEnhancer,
    enhancer?.enhancerPath,
  );
}

function resolveDenoiserGgufPath(
  files: NormalizedFiles,
  denoiser?: LavaSRDenoiserOptions,
): string | undefined {
  if (denoiser != null && denoiser.type !== "lavasr") {
    throw new Error(
      `tts-ggml: unknown denoiser.type '${String(denoiser.type)}', expected 'lavasr'.`,
    );
  }
  return firstNonEmpty(files.lavasrDenoiser, denoiser?.denoiserPath);
}

function assertGpuIntentConsistent(
  useGPU?: boolean,
  nGpuLayers?: number,
): void {
  if (typeof useGPU !== "boolean" || nGpuLayers == null) return;
  if (useGPU === (nGpuLayers !== 0)) return;
  throw new Error(
    `tts-ggml: useGPU=${String(useGPU)} conflicts with ` +
      `nGpuLayers=${nGpuLayers}. Either drop one of the two, or make ` +
      "them agree (useGPU:true + nGpuLayers!=0, or " +
      "useGPU:false + nGpuLayers=0).",
  );
}

function isAudioOutputEvent(data: unknown): data is NativeOutputChunk {
  return (
    data != null &&
    typeof data === "object" &&
    "outputArray" in data &&
    data.outputArray != null
  );
}

function isStatsEvent(data: unknown): data is NativeStats {
  return (
    data != null &&
    typeof data === "object" &&
    ("totalTime" in data ||
      "audioDurationMs" in data ||
      "totalSamples" in data)
  );
}

function computeSentenceStreamStats(
  chunks: string[],
  accumulator: StreamAccumulator,
): RuntimeStats {
  const totalCharacters = chunks.join("").length;
  return {
    ...accumulator,
    tokensPerSecond:
      accumulator.totalTime > 0
        ? totalCharacters / accumulator.totalTime
        : 0,
    realTimeFactor:
      accumulator.audioDurationMs > 0
        ? (accumulator.totalTime * 1000) /
          accumulator.audioDurationMs
        : 0,
  };
}

/**
 * GGML-backed TTS via the `tts-cpp` library. Wraps both
 * `tts_cpp::chatterbox::Engine` and `tts_cpp::supertonic::Engine` behind a
 * single engine-agnostic JavaScript surface. Engine type is auto-detected
 * from `files` or selected explicitly with `engine`.
 *
 * Owns a persistent native engine: model weights and voice-conditioning
 * tensors are loaded once by `load()` and reused by `run()`, `runStream()`,
 * and `runStreaming()`.
 */
class TTSGgml {
  static readonly inferenceManagerConfig = {
    noAdditionalDownload: true,
  };
  static readonly ENGINE_CHATTERBOX = ENGINE_CHATTERBOX;
  static readonly ENGINE_SUPERTONIC = ENGINE_SUPERTONIC;

  opts: object;
  exclusiveRun: boolean;
  logger: object;
  state: InferenceState;
  addon: unknown;

  private readonly _job: JobHandler;
  private readonly _runExclusive: ExclusiveRunner;
  private _ttsInferenceQueueWaiter: Promise<void>;
  private _sentenceStreamCtx: SentenceStreamContext | null;
  private _config: TTSGgmlRuntimeConfig;
  private _lazySessionLoading: boolean;
  private _outputSampleRate: number | null;
  private _engineType: EngineType;
  private _voicesDir?: string;
  private _supertonicModelPath?: string;
  private _t3ModelPath?: string;
  private _s3genModelPath?: string;
  private _mecabDictPath?: string;
  private _cangjieTsvPath?: string;
  private _referenceAudio?: string;
  private _voiceDir?: string;
  private _seed?: number;
  private _nGpuLayers?: number;
  private _nCtx?: number;
  private _kvCacheType?: "f32" | "f16" | "q8_0";
  private _threads?: number;
  private _streamChunkTokens?: number;
  private _streamFirstChunkTokens?: number;
  private _cfmSteps?: number;
  private _cfgRate?: number;
  private _voice?: string;
  private _steps?: number;
  private _speed?: number;
  private _noiseNpyPath?: string;
  private _enhancerGgufPath?: string;
  private _denoiserGgufPath?: string;
  private _backendsDir?: string;
  private _openclCacheDir?: string;
  private _vulkanCacheDir?: string;

  constructor(options: TTSGgmlOptions = {}) {
    this.opts = options.opts || {};
    this.exclusiveRun = !!options.exclusiveRun;
    this.logger = new QvacLogger(
      options.logger as QvacLogger.LoggerInterface | undefined,
    );
    this.state = {
      configLoaded: false,
      weightsLoaded: false,
      destroyed: false,
    };
    this.addon = null;
    this._sentenceStreamCtx = null;
    this._ttsInferenceQueueWaiter = Promise.resolve();
    this._job = createJobHandler({
      cancel: () => this._optionalAddon()?.cancel(),
    });
    this._runExclusive = this.exclusiveRun
      ? exclusiveRunQueue()
      : async function runNow<T>(
          callback: () => Promise<T>,
        ): Promise<T> {
          return callback();
        };

    const normalizedFiles = normalizeGgmlFiles(options.files || {});
    this._config = { ...(options.config || {}) };
    this._lazySessionLoading = resolveDefaultLazySessionLoading(
      options.lazySessionLoading,
    );
    this._outputSampleRate = validateOutputSampleRate(
      this._config.outputSampleRate,
    );
    this._engineType = detectEngineType(
      options.engine,
      normalizedFiles,
    );
    this._resolveEngineAndModelPaths(normalizedFiles);
    this._mecabDictPath = firstNonEmpty(
      options.mecabDictPath,
      options.mecabDictDir,
      normalizedFiles.mecabDictDir,
    );
    this._cangjieTsvPath = firstNonEmpty(
      options.cangjieTsvPath,
      normalizedFiles.cangjieTsvPath,
    );
    this._assignSynthesisOptions(options);
    this._enhancerGgufPath = resolveEnhancerGgufPath(
      normalizedFiles,
      options.enhancer,
    );
    this._denoiserGgufPath = resolveDenoiserGgufPath(
      normalizedFiles,
      options.denoiser,
    );
    this._backendsDir = firstNonEmpty(
      options.backendsDir,
      this._config.backendsDir,
      path.join(__dirname, "prebuilds"),
    );
    this._openclCacheDir = firstNonEmpty(
      options.openclCacheDir,
      this._config.openclCacheDir,
    );
    this._vulkanCacheDir = firstNonEmpty(
      options.vulkanCacheDir,
      this._config.vulkanCacheDir,
    );
    assertGpuIntentConsistent(
      this._config.useGPU,
      this._nGpuLayers,
    );
    this._assertEngineStreamingSupport();
    if (
      this._config.useGPU === undefined &&
      this._nGpuLayers == null
    ) {
      this._config.useGPU = false;
    }
  }

  private _resolveEngineAndModelPaths(files: NormalizedFiles): void {
    this._voicesDir = files.voicesDir;
    if (this._engineType === ENGINE_SUPERTONIC) {
      this._supertonicModelPath = firstNonEmpty(
        files.supertonicModel,
        files.modelDir
          ? resolveSupertonicModelDirPath(files.modelDir)
          : undefined,
      );
      return;
    }
    if (files.modelDir) {
      const resolved = resolveChatterboxModelDirPaths(files.modelDir);
      this._t3ModelPath = firstNonEmpty(files.t3Model, resolved.t3);
      this._s3genModelPath = firstNonEmpty(
        files.s3genModel,
        resolved.s3,
      );
    } else {
      this._t3ModelPath = files.t3Model;
      this._s3genModelPath = files.s3genModel;
    }
  }

  private _assignSynthesisOptions(options: TTSGgmlOptions): void {
    this._referenceAudio = options.referenceAudio;
    this._voiceDir = options.voiceDir;
    this._seed = options.seed;
    this._nGpuLayers = options.nGpuLayers;
    this._nCtx = options.nCtx;
    this._kvCacheType = options.kvCacheType;
    this._threads = options.threads;
    this._streamChunkTokens = options.streamChunkTokens;
    this._streamFirstChunkTokens = options.streamFirstChunkTokens;
    this._cfmSteps = options.cfmSteps;
    this._cfgRate = options.cfgRate;
    this._voice = firstNonEmpty(options.voice, options.voiceName);
    this._steps = firstNonEmpty(
      options.steps,
      options.numInferenceSteps,
    );
    this._speed = options.speed;
    this._noiseNpyPath = options.noiseNpyPath;
  }

  private _assertEngineStreamingSupport(): void {
    if (
      this._engineType === ENGINE_SUPERTONIC &&
      (this._streamChunkTokens != null ||
        this._streamFirstChunkTokens != null)
    ) {
      throw new Error(
        "tts-ggml: streamChunkTokens / streamFirstChunkTokens are " +
          "Chatterbox-only options (sub-sentence native streaming via " +
          "the chatterbox::Engine streaming chunked S3Gen+HiFT loop). " +
          "Supertonic does not support sub-sentence native streaming; " +
          "use sentence-level streaming via the engine-agnostic " +
          "runStream() / runStreaming() / run({ streamOutput: true }) APIs.",
      );
    }
    if (
      this._denoiserGgufPath &&
      (this._streamChunkTokens != null ||
        this._streamFirstChunkTokens != null)
    ) {
      throw new Error(
        "tts-ggml: the LavaSR denoiser is not yet supported with " +
          "Chatterbox native chunk streaming (streamChunkTokens / " +
          "streamFirstChunkTokens). Use batch synthesis, or drop the " +
          "denoiser for streaming. Streaming denoise is a planned " +
          "follow-up (needs a stateful streaming denoiser).",
      );
    }
  }

  getEngineType(): EngineType {
    return this._engineType;
  }

  getApiDefinition(): string {
    const api = inferGetApiDefinition();
    this._getLogger().debug(
      `Using API definition: ${api} for platform: ${platform()}`,
    );
    return api;
  }

  getState(): InferenceState {
    return this.state;
  }

  async load(..._args: unknown[]): Promise<void> {
    void _args;
    if (this.state.destroyed) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_LOAD,
        adds: "instance was destroyed",
      });
    }
    if (this.state.configLoaded || this.state.weightsLoaded) {
      this._getLogger().info(
        "Reload requested - unloading existing model first",
      );
      await this.unload();
    }
    await this._load();
    this.state.configLoaded = true;
    this.state.weightsLoaded = true;
  }

  /**
   * Run text-to-speech. With `{ streamOutput: true }`, splits `input` into
   * chunks and emits PCM through `response.onUpdate` for each chunk.
   */
  async run(
    input: TTSRunInput & { streamOutput: true },
  ): Promise<
    QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>
  >;
  async run(input: TTSRunInput): Promise<QvacResponse<TTSOutputChunk>>;
  async run(
    input: TTSRunInput,
  ): Promise<
    QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>
  > {
    if (input?.streamOutput === true) {
      if (
        typeof input.input !== "string" ||
        input.input.trim().length === 0
      ) {
        throw new QvacErrorAddonTTSGgml({
          code: ERR_CODES.FAILED_TO_APPEND,
          adds:
            "run with streamOutput: non-empty string `input` is required",
        });
      }
      const runStream = () =>
        this._runStreamOrchestrator(input.input, {
          locale: input.locale,
          maxChunkScalars: input.maxChunkScalars,
        });
      return this.exclusiveRun
        ? this._enqueueExclusiveTtsResponse(runStream)
        : runStream();
    }
    return this._runExclusive(() => this._runInternal(input));
  }

  /**
   * Chunked streaming synthesis. Equivalent to
   * `run({ input: text, streamOutput: true, ...options })`.
   */
  async runStream(
    text: string,
    options: SentenceStreamOptions = {},
  ): Promise<
    QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>
  > {
    const normalized =
      options == null || typeof options !== "object" ? {} : options;
    return this.run({
      input: text,
      streamOutput: true,
      locale: normalized.locale,
      maxChunkScalars: normalized.maxChunkScalars,
    });
  }

  /**
   * Streaming text in and streaming audio out. Each flushed string is one
   * native job and emits PCM through `response.onUpdate`.
   *
   * For `AsyncIterable` inputs, `accumulateSentences` defaults to `true` so
   * small streamed fragments are coalesced.
   */
  async runStreaming(
    textStream: TextStreamInput,
    options: RunStreamingOptions = {},
  ): Promise<
    QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>
  > {
    const streamOptions = this._resolveRunStreamingOptions(
      textStream,
      options,
    );
    let normalized = this._normalizeTextStream(textStream);
    if (streamOptions.accumulateSentences) {
      normalized = accumulateTextStream(normalized, {
        sentenceDelimiterPreset:
          streamOptions.sentenceDelimiterPreset,
        maxBufferScalars: streamOptions.maxBufferScalars,
        flushAfterMs: streamOptions.flushAfterMs,
        sentenceDelimiter: streamOptions.sentenceDelimiter,
        language: this._config.language,
      });
    }
    const runStream = () =>
      this._runTextStreamOrchestrator(normalized);
    return this.exclusiveRun
      ? this._enqueueExclusiveTtsResponse(runStream)
      : runStream();
  }

  private async _enqueueExclusiveTtsResponse(
    run: () => QvacResponse<
      TTSOutputChunk & SentenceStreamChunkMeta
    >,
  ): Promise<
    QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta>
  > {
    const previous = this._ttsInferenceQueueWaiter;
    let releaseSlot: () => void = () => {};
    this._ttsInferenceQueueWaiter = new Promise<void>((resolve) => {
      releaseSlot = resolve;
    });
    await previous;
    let response: QvacResponse<
      TTSOutputChunk & SentenceStreamChunkMeta
    >;
    try {
      response = run();
    } catch (error) {
      releaseSlot();
      throw error;
    }
    void response
      .await()
      .finally(releaseSlot)
      .catch(() => {});
    return response;
  }

  private _resolveRunStreamingOptions(
    textStream: TextStreamInput,
    options: RunStreamingOptions,
  ): Required<
    Pick<
      RunStreamingOptions,
      | "accumulateSentences"
      | "sentenceDelimiterPreset"
      | "flushAfterMs"
    >
  > &
    Pick<
      RunStreamingOptions,
      "maxBufferScalars" | "sentenceDelimiter"
    > {
    const normalized =
      options == null || typeof options !== "object" ? {} : options;
    let accumulateSentences = normalized.accumulateSentences;
    if (accumulateSentences === undefined) {
      accumulateSentences =
        defaultAccumulateSentencesForStreamInput(textStream);
    }
    return {
      accumulateSentences: !!accumulateSentences,
      sentenceDelimiterPreset:
        normalized.sentenceDelimiterPreset === "latin" ||
        normalized.sentenceDelimiterPreset === "cjk" ||
        normalized.sentenceDelimiterPreset === "multilingual"
          ? normalized.sentenceDelimiterPreset
          : "multilingual",
      maxBufferScalars: normalized.maxBufferScalars,
      flushAfterMs:
        normalized.flushAfterMs ?? DEFAULT_FLUSH_AFTER_MS,
      sentenceDelimiter:
        normalized.sentenceDelimiter instanceof RegExp
          ? normalized.sentenceDelimiter
          : undefined,
    };
  }

  private _normalizeTextStream(
    textStream: TextStreamInput,
  ): AsyncIterable<string> {
    if (textStream == null) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: "runStreaming: text stream is required",
      });
    }
    if (typeof textStream === "string") {
      // eslint-disable-next-line @typescript-eslint/require-await -- async iterable shape is required by the public API.
      return (async function* oneString() {
        yield textStream;
      })();
    }
    if (
      typeof (
        textStream as {
          [Symbol.asyncIterator]?: unknown;
        }
      )[Symbol.asyncIterator] === "function"
    ) {
      return textStream as AsyncIterable<string>;
    }
    if (
      Array.isArray(textStream) ||
      typeof (
        textStream as {
          [Symbol.iterator]?: unknown;
        }
      )[Symbol.iterator] === "function"
    ) {
      // eslint-disable-next-line @typescript-eslint/require-await -- adapts synchronous iterables to the async iterable contract.
      return (async function* fromIterable() {
        for (const value of textStream as Iterable<string>) {
          yield value;
        }
      })();
    }
    throw new QvacErrorAddonTTSGgml({
      code: ERR_CODES.FAILED_TO_APPEND,
      adds:
        "runStreaming: expected string, array of strings, Iterable, or AsyncIterable",
    });
  }

  private _runTextStreamOrchestrator(
    source: AsyncIterable<string>,
  ): QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta> {
    const response = this._job.start() as QvacResponse<
      TTSOutputChunk & SentenceStreamChunkMeta
    >;
    this._sentenceStreamCtx = {
      textStreamMode: true,
      asyncTextSource: source,
      chunks: [],
      chunkIdx: 0,
      acc: { totalTime: 0, audioDurationMs: 0, totalSamples: 0 },
      chunkResolver: null,
    };
    void this._sentenceStreamTextIterableDrive().catch(
      (error: unknown) => {
        this._rejectActiveChunk(error);
        this._sentenceStreamCtx = null;
        this._job.fail(normalizeError(error));
      },
    );
    return response;
  }

  private async _sentenceStreamTextIterableDrive(): Promise<void> {
    const context = this._sentenceStreamCtx;
    if (
      !context ||
      !context.textStreamMode ||
      !context.asyncTextSource
    ) {
      return;
    }
    try {
      for await (const piece of context.asyncTextSource) {
        const text = String(piece).trim();
        if (text.length === 0) continue;
        context.chunks.push(text);
        context.chunkIdx = context.chunks.length - 1;
        const done = new Promise<void>((resolve, reject) => {
          context.chunkResolver = { resolve, reject };
        });
        await this._requireAddon().runJob({
          type: "text",
          input: text,
        });
        await done;
      }
    } catch (error) {
      this._rejectActiveChunk(error);
      this._sentenceStreamCtx = null;
      this._job.fail(normalizeError(error));
      return;
    }
    const current = this._sentenceStreamCtx;
    const chunks = current?.chunks || [];
    const accumulator = current?.acc || {
      totalTime: 0,
      audioDurationMs: 0,
      totalSamples: 0,
    };
    this._sentenceStreamCtx = null;
    this._endJobWithStats(
      chunks.length === 0
        ? {
            totalTime: 0,
            tokensPerSecond: 0,
            realTimeFactor: 0,
            audioDurationMs: 0,
            totalSamples: 0,
          }
        : computeSentenceStreamStats(chunks, accumulator),
    );
  }

  private _runStreamOrchestrator(
    text: string,
    options: SentenceStreamOptions,
  ): QvacResponse<TTSOutputChunk & SentenceStreamChunkMeta> {
    const chunks = splitTtsText(String(text), {
      language: this._config.language,
      locale: options.locale,
      maxScalars: options.maxChunkScalars,
    });
    if (chunks.length === 0) {
      throw new QvacErrorAddonTTSGgml({
        code: ERR_CODES.FAILED_TO_APPEND,
        adds: "chunked synthesis: text produced no chunks after split",
      });
    }
    const response = this._job.start() as QvacResponse<
      TTSOutputChunk & SentenceStreamChunkMeta
    >;
    this._sentenceStreamCtx = {
      chunks,
      chunkIdx: 0,
      acc: { totalTime: 0, audioDurationMs: 0, totalSamples: 0 },
      chunkResolver: null,
    };
    void this._sentenceStreamDriveBody().catch((error: unknown) => {
      this._rejectActiveChunk(error);
      this._sentenceStreamCtx = null;
      this._job.fail(normalizeError(error));
    });
    return response;
  }

  private async _sentenceStreamDriveBody(): Promise<void> {
    const context = this._sentenceStreamCtx;
    if (!context || context.textStreamMode) return;
    for (let index = 0; index < context.chunks.length; index++) {
      context.chunkIdx = index;
      const done = new Promise<void>((resolve, reject) => {
        context.chunkResolver = { resolve, reject };
      });
      await this._requireAddon().runJob({
        type: "text",
        input: context.chunks[index],
      });
      await done;
    }
    this._sentenceStreamCtx = null;
  }

  private async _load(): Promise<void> {
    this._getLogger().info(
      "[TTSGgml] Language:",
      this._config.language || "en",
    );
    const addon = this._createAddon(
      this._buildTtsParams(),
      this._addonOutputCallback.bind(this),
    );
    this.addon = addon;
    try {
      await addon.activate();
    } catch (error) {
      try {
        await addon.destroyInstance();
      } catch {}
      if (this.addon === addon) this.addon = null;
      throw error;
    }
  }

  private _buildTtsParams(): TTSConfigurationParams {
    return this._engineType === ENGINE_SUPERTONIC
      ? this._buildSupertonicParams()
      : this._buildChatterboxParams();
  }

  private _buildChatterboxParams(): TTSConfigurationParams {
    const parameters: TTSConfigurationParams = {
      engineType: ENGINE_CHATTERBOX,
      t3ModelPath: this._t3ModelPath || "",
      s3genModelPath: this._s3genModelPath || "",
      language: this._config.language || "en",
    };
    this._assignCommonNativeParams(parameters);
    if (this._referenceAudio != null) {
      parameters.referenceAudio = this._referenceAudio;
    }
    if (this._voiceDir != null) parameters.voiceDir = this._voiceDir;
    if (this._nCtx != null) parameters.nCtx = this._nCtx | 0;
    if (this._kvCacheType != null) {
      parameters.kvCacheType = String(this._kvCacheType);
    }
    if (this._streamChunkTokens != null) {
      parameters.streamChunkTokens = this._streamChunkTokens | 0;
    }
    if (this._streamFirstChunkTokens != null) {
      parameters.streamFirstChunkTokens =
        this._streamFirstChunkTokens | 0;
    }
    if (this._cfmSteps != null) {
      parameters.cfmSteps = this._cfmSteps | 0;
    }
    if (this._cfgRate != null) {
      parameters.cfgRate = Number(this._cfgRate);
    }
    if (this._speed != null) parameters.speed = Number(this._speed);
    if (this._mecabDictPath) {
      parameters.mecabDictPath = this._mecabDictPath;
    }
    if (this._cangjieTsvPath) {
      parameters.cangjieTsvPath = this._cangjieTsvPath;
    }
    return parameters;
  }

  private _buildSupertonicParams(): TTSConfigurationParams {
    const parameters: TTSConfigurationParams = {
      engineType: ENGINE_SUPERTONIC,
      supertonicModelPath: this._supertonicModelPath || "",
      language: this._config.language || "en",
    };
    this._assignCommonNativeParams(parameters);
    if (this._voice) parameters.voice = this._voice;
    if (this._steps != null) parameters.steps = this._steps | 0;
    if (this._speed != null) parameters.speed = Number(this._speed);
    if (this._noiseNpyPath) {
      parameters.noiseNpyPath = this._noiseNpyPath;
    }
    if (this._vulkanCacheDir) {
      parameters.vulkanCacheDir = this._vulkanCacheDir;
    }
    return parameters;
  }

  private _assignCommonNativeParams(
    parameters: TTSConfigurationParams,
  ): void {
    if (this._seed != null) parameters.seed = this._seed | 0;
    if (this._threads != null) parameters.threads = this._threads | 0;
    if (this._nGpuLayers != null) {
      parameters.nGpuLayers = this._nGpuLayers | 0;
    }
    if (this._outputSampleRate != null) {
      parameters.outputSampleRate = this._outputSampleRate | 0;
    }
    if (this._config.useGPU != null) {
      parameters.useGPU = !!this._config.useGPU;
    }
    if (this._enhancerGgufPath) {
      parameters.lavasrEnhancerPath = this._enhancerGgufPath;
    }
    if (this._denoiserGgufPath) {
      parameters.lavasrDenoiserPath = this._denoiserGgufPath;
    }
    if (this._backendsDir) {
      parameters.backendsDir = this._backendsDir;
    }
    if (this._openclCacheDir) {
      parameters.openclCacheDir = this._openclCacheDir;
    }
  }

  private _createAddon(
    configuration: TTSConfigurationParams,
    outputCallback: TTSOutputCallback,
  ): TTSInterface {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
    const binding = require("./binding") as TTSBinding;
    return new TTSInterface(binding, configuration, outputCallback);
  }

  async unload(): Promise<void> {
    await this.cancel();
    this._failAndClearActiveResponse("Model was unloaded");
    const addon = this._optionalAddon();
    if (addon) await addon.destroyInstance();
    this.state.configLoaded = false;
    this.state.weightsLoaded = false;
  }

  async destroy(): Promise<void> {
    await this.unload();
    this.state.destroyed = true;
  }

  private async _runInternal(
    input: TTSRunInput,
  ): Promise<QvacResponse<TTSOutputChunk>> {
    const response = this._job.start({
      signal: input?.signal,
    }) as QvacResponse<TTSOutputChunk>;
    if (input?.signal?.aborted) return response;
    try {
      await this._requireAddon().runJob({
        type: input.type || "text",
        input: input.input,
      });
    } catch (error) {
      this._job.fail(normalizeError(error));
      throw error;
    }
    return response;
  }

  private _mergeSentenceStreamStats(
    accumulator: StreamAccumulator,
    data: NativeStats,
  ): void {
    accumulator.totalTime +=
      typeof data.totalTime === "number" ? data.totalTime : 0;
    accumulator.audioDurationMs +=
      typeof data.audioDurationMs === "number"
        ? data.audioDurationMs
        : 0;
    accumulator.totalSamples +=
      typeof data.totalSamples === "number" ? data.totalSamples : 0;
  }

  private _rejectActiveChunk(error: unknown): void {
    const resolver = this._sentenceStreamCtx?.chunkResolver;
    if (!resolver) return;
    this._sentenceStreamCtx!.chunkResolver = null;
    resolver.reject(error);
  }

  private _endJobWithStats(stats: RuntimeStats | NativeStats): void {
    if ((this.opts as { stats?: boolean }).stats) this._job.end(stats);
    else this._job.end();
  }

  private _addonOutputCallback(
    _addon: unknown,
    event: unknown,
    data: unknown,
    error: unknown,
  ): void {
    if (typeof error === "string" && error.length > 0) {
      this._handleAddonError(error);
    } else if (isAudioOutputEvent(data)) {
      this._handleAddonOutput(data);
    } else if (isStatsEvent(data)) {
      this._handleAddonStats(data);
    } else {
      this._getLogger().debug(
        `Received TTS event: ${String(event)}`,
      );
    }
  }

  private _handleAddonError(error: string): void {
    this._getLogger().error(`TTS job failed with error: ${error}`);
    this._rejectActiveChunk(new Error(error));
    this._job.fail(error);
  }

  private _handleAddonOutput(data: NativeOutputChunk): void {
    try {
      this._getLogger().debug(
        `TTS job produced output: ${ttsOutputDebugString(data)}`,
      );
    } catch (error) {
      if (error instanceof RangeError) {
        this._getLogger().debug(
          "TTS job produced output: [data too large]",
        );
      } else {
        throw error;
      }
    }
    this._job.output(
      this._sentenceStreamCtx
        ? this._enrichStreamChunk(data)
        : data,
    );
  }

  private _enrichStreamChunk(
    data: NativeOutputChunk,
  ): TTSOutputChunk & SentenceStreamChunkMeta {
    const context = this._sentenceStreamCtx;
    if (!context) {
      // Preserve the historical ArrayBuffer declaration without changing the
      // native Int16Array payload or allocating a compatibility copy.
      return data as unknown as TTSOutputChunk &
        SentenceStreamChunkMeta;
    }
    const index = context.chunkIdx;
    const enriched: TTSOutputChunk & SentenceStreamChunkMeta = {
      // Public declarations historically expose ArrayBuffer; native output is
      // the more precise Int16Array representation at runtime.
      outputArray: data.outputArray as unknown as ArrayBuffer,
      chunkIndex: index,
      sentenceChunk: context.chunks[index] || "",
    };
    if (data.sampleRate != null) {
      enriched.sampleRate = data.sampleRate;
    }
    if (!context.textStreamMode) {
      enriched.isLast = index >= context.chunks.length - 1;
    }
    return enriched;
  }

  private _handleAddonStats(data: NativeStats): void {
    this._getLogger().info(
      `TTS job completed. Stats: ${JSON.stringify(data)}`,
    );
    const context = this._sentenceStreamCtx;
    if (!context) {
      this._endJobWithStats(data);
      return;
    }
    this._mergeSentenceStreamStats(context.acc, data);
    if (context.chunkResolver) {
      context.chunkResolver.resolve();
      context.chunkResolver = null;
    }
    if (
      !context.textStreamMode &&
      context.chunkIdx >= context.chunks.length - 1
    ) {
      this._endJobWithStats(
        computeSentenceStreamStats(context.chunks, context.acc),
      );
    }
  }

  async cancel(): Promise<void> {
    const addon = this._optionalAddon();
    if (addon?.cancel) await addon.cancel();
  }

  private _failAndClearActiveResponse(
    reason: string | Error,
  ): void {
    this._rejectActiveChunk(
      reason instanceof Error ? reason : new Error(reason),
    );
    this._sentenceStreamCtx = null;
    this._job.fail(reason);
  }

  async reload(
    newConfig: Record<string, unknown> = {},
  ): Promise<void> {
    this._getLogger().debug(
      "Reloading addon with new configuration",
      newConfig,
    );
    const runtimeConfig =
      newConfig as Partial<TTSGgmlRuntimeConfig>;
    if (runtimeConfig.language !== undefined) {
      this._config.language = runtimeConfig.language;
    }
    if (runtimeConfig.useGPU !== undefined) {
      this._config.useGPU = runtimeConfig.useGPU;
    }
    if (runtimeConfig.outputSampleRate !== undefined) {
      this._outputSampleRate = runtimeConfig.outputSampleRate;
    }
    const parameters = this._buildTtsParams();
    await this.cancel();
    this._failAndClearActiveResponse("Model was reloaded");
    const existingAddon = this._optionalAddon();
    if (existingAddon) await existingAddon.destroyInstance();
    this.addon = this._createAddon(
      parameters,
      this._addonOutputCallback.bind(this),
    );
    await this._requireAddon().activate();
  }

  static getModelKey(_params?: unknown): string {
    void _params;
    return "tts-ggml";
  }

  private _requireAddon(): TTSInterface {
    const addon = this._optionalAddon();
    if (!addon) throw new Error("TTS addon is not loaded");
    return addon;
  }

  private _optionalAddon(): TTSInterface | null {
    return (this.addon as TTSInterface | null | undefined) || null;
  }

  private _getLogger(): QvacLogger {
    return this.logger as QvacLogger;
  }
}

type NamespaceFiles = TTSGgmlFiles;
type NamespaceRuntimeConfig = TTSGgmlRuntimeConfig;
type NamespaceOptions = TTSGgmlOptions;
type NamespaceEnhancerOptions = LavaSREnhancerOptions;
type NamespaceDenoiserOptions = LavaSRDenoiserOptions;
type NamespaceRuntimeStats = RuntimeStats;
type NamespaceOutputChunk = TTSOutputChunk;
type NamespaceSentenceStreamChunkMeta = SentenceStreamChunkMeta;
type NamespaceSentenceStreamOptions = SentenceStreamOptions;
type NamespaceRunStreamingOptions = RunStreamingOptions;
type NamespaceTextStreamInput = TextStreamInput;
type NamespaceRunInput = TTSRunInput;
type NamespaceInferenceState = InferenceState;

// eslint-disable-next-line @typescript-eslint/no-namespace -- declaration merging preserves the established class namespace API.
namespace TTSGgml {
  export type TTSGgmlFiles = NamespaceFiles;
  export type TTSGgmlRuntimeConfig = NamespaceRuntimeConfig;
  export type TTSGgmlOptions = NamespaceOptions;
  export type LavaSREnhancerOptions = NamespaceEnhancerOptions;
  export type LavaSRDenoiserOptions = NamespaceDenoiserOptions;
  export type RuntimeStats = NamespaceRuntimeStats;
  export type TTSOutputChunk = NamespaceOutputChunk;
  export type SentenceStreamChunkMeta =
    NamespaceSentenceStreamChunkMeta;
  export type SentenceStreamOptions = NamespaceSentenceStreamOptions;
  export type RunStreamingOptions = NamespaceRunStreamingOptions;
  export type TextStreamInput = NamespaceTextStreamInput;
  export type TTSRunInput = NamespaceRunInput;
  export type InferenceState = NamespaceInferenceState;
}

export = TTSGgml;
