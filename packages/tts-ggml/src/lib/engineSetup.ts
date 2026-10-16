/**
 * The state the wrapper resolves from its constructor options, grouped by
 * responsibility. Everything that builds native parameters, validates options
 * or applies a reload reads (and, for reloadable fields, writes) one of these
 * groups instead of the wrapper instance itself.
 */
import type { EngineType } from "./engineIds";
import type { NormalizedFiles } from "./modelFiles";
import type { TTSConfigurationParams } from "../tts";

export interface TTSGgmlRuntimeConfig {
  /**
   * Language code; default "en". Chatterbox MTL accepts
   * es/fr/de/pt/it/zh/ja/ko/... CosyVoice3: reserved / not yet effective — the
   * text-normalization frontend is not yet integrated, so it is accepted but
   * not acted on.
   */
  language?: string;
  /**
   * Route inference through a GPU backend (Metal / Vulkan / OpenCL) if
   * available. Defaults to `false`. Audio8 uses Vulkan on Linux and Windows;
   * CosyVoice3 selects Metal on Apple, Vulkan on desktop Linux / Windows, and
   * OpenCL/Adreno on Android (Mali / Xclipse decline to CPU); the other
   * GPU-capable engines select a backend for the host platform.
   */
  useGPU?: boolean;
  /**
   * Desired output sample rate in Hz (8000-192000); omit to keep the engine's
   * native rate. Resamples the native output (24 kHz for Chatterbox and
   * CosyVoice3; 44.1 kHz for Supertonic, Parler, and Audio8), or the 48 kHz
   * LavaSR-enhanced signal, before emitting. `TTSOutputChunk.sampleRate`
   * reports the resulting rate.
   *
   * CosyVoice3 native chunk streaming emits at 24 kHz: a different rate is
   * only accepted there when the LavaSR enhancer is active, because the
   * enhancer's overlap-reprocess window resamples without chunk seams.
   *
   * MOSS emits its native 24 kHz only and rejects any other rate.
   */
  outputSampleRate?: number;
  backendsDir?: string;
  openclCacheDir?: string;
  vulkanCacheDir?: string;
}

export interface ModelPaths {
  voicesDir?: string;
  supertonicModelPath?: string;
  t3ModelPath?: string;
  s3genModelPath?: string;
  cosyvoiceModelDir?: string;
  cosyvoiceLlmModelPath?: string;
  cosyvoiceFlowModelPath?: string;
  cosyvoiceHiftModelPath?: string;
  cosyvoiceS3tokModelPath?: string;
  cosyvoiceCampplusModelPath?: string;
  cosyvoiceVocabPath?: string;
  cosyvoiceMergesPath?: string;
  cosyvoiceVoiceModelPath?: string;
  parlerModelPath?: string;
  audio8LmPath?: string;
  audio8CodecDecoderPath?: string;
  audio8CodecEncoderPath?: string;
  mossBackbonePath?: string;
  mossCodecDecoderPath?: string;
  mossCodecEncoderPath?: string;
  mossSoundEffectPath?: string;
  mossSpeechModelPath?: string;
  mossSpeechCodecPath?: string;
  mecabDictPath?: string;
  cangjieTsvPath?: string;
}

/**
 * Synthesis options as the wrapper keeps them: aliases collapsed, the
 * CosyVoice3 instruct rendered to its string. Reload rewrites the reloadable
 * subset in place and rolls the whole object back when a reload is rejected.
 */
export interface SynthesisSettings {
  referenceAudio?: string;
  referenceText?: string;
  greedy?: boolean;
  voiceDir?: string;
  seed?: number;
  nGpuLayers?: number;
  nCtx?: number;
  kvCacheType?: "f32" | "f16" | "q8_0";
  threads?: number;
  streamChunkTokens?: number;
  streamFirstChunkTokens?: number;
  streamChunkTolerancePct?: number;
  streamMinChunkTokens?: number;
  streamLeftContextTokens?: number;
  cfmSteps?: number;
  cfgRate?: number;
  batchCfmSteps?: number;
  nPredict?: number;
  maxSentenceChars?: number;
  crossfadeMs?: number;
  repeatPenalty?: number;
  exaggeration?: number;
  cfgWeight?: number;
  minP?: number;
  voiceJsonPath?: string;
  prewarmText?: string;
  vulkanDevice?: number;
  flowCutPrompt?: boolean;
  /** CosyVoice3-only: transcript of the reference audio for zero-shot cloning. */
  promptText?: string;
  /** CosyVoice3-only: the structured/raw instruct2 control, rendered to its string. */
  instruct?: string;
  voice?: string;
  steps?: number;
  speed?: number;
  noiseNpyPath?: string;
  /** Parler voice-description surface; the all-defaults render is the models' fallback caption. */
  description?: string;
  emotion?: string;
  pitch?: string;
  pace?: string;
  expressivity?: string;
  noise?: string;
  reverb?: string;
  quality?: string;
  temperature?: number;
  topK?: number;
  topP?: number;
  maxFrames?: number;
  minNewTokens?: number;
  normalizeNumbers?: boolean;
  /** MOSS: fixed for the instance (reload rejects a change). */
  dialogueReferences?: string[];
  durationTokens?: number;
}

export interface BackendPaths {
  enhancerGgufPath?: string;
  denoiserGgufPath?: string;
  backendsDir?: string;
  openclCacheDir?: string;
  vulkanCacheDir?: string;
}

export interface PocketSetup {
  files: NormalizedFiles;
  options: Record<string, unknown>;
  params: TTSConfigurationParams;
}

export interface EngineSetup {
  readonly engineType: EngineType;
  readonly config: TTSGgmlRuntimeConfig;
  /** Validated `config.outputSampleRate`; null keeps the engine's native rate. */
  outputSampleRate: number | null;
  readonly paths: ModelPaths;
  readonly settings: SynthesisSettings;
  readonly backend: BackendPaths;
  pocket: PocketSetup | null;
}
