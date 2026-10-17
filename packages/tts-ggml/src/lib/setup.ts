/**
 * Turns constructor options into an `EngineSetup`: normalized files, the
 * detected engine and its model paths, synthesis settings, backend paths, and
 * (for Pocket) the native parameters, validated in the order the wrapper has
 * always reported them.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- Bare modules expose CommonJS export shapes. */
import bareOs = require("bare-os");
/* eslint-enable @typescript-eslint/no-require-imports */
import { detectEngineType, resolveModelPaths } from "./engineDetection";
import { ENGINE_POCKET } from "./engineIds";
import type {
  BackendPaths,
  EngineSetup,
  PocketSetup,
  SynthesisSettings,
  TTSGgmlRuntimeConfig,
} from "./engineSetup";
import { renderCosyvoiceInstruct } from "./engines/cosyvoice";
import { mossVoiceSettings } from "./engines/moss";
import {
  firstNonEmpty,
  normalizeGgmlFiles,
  type NormalizedFiles,
} from "./modelFiles";
import { validateEngineOptions } from "./optionValidation";
import { buildPocketParams } from "./pocketConfig";
import type {
  LavaSRDenoiserOptions,
  LavaSREnhancerOptions,
  TTSGgmlOptions,
} from "./types";

const { platform } = bareOs;
const MIN_OUTPUT_SAMPLE_RATE = 8000;
const MAX_OUTPUT_SAMPLE_RATE = 192000;

export function resolveDefaultLazySessionLoading(
  lazySessionLoading?: boolean,
): boolean {
  if (lazySessionLoading != null) return lazySessionLoading;
  return platform() === "ios" || platform() === "android";
}

export function validateOutputSampleRate(
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

export function assertGpuIntentConsistent(
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

/** Synthesis options with their aliases collapsed; may throw on a malformed `instruct`. */
function settingsFromOptions(options: TTSGgmlOptions): SynthesisSettings {
  return {
    referenceAudio: options.referenceAudio,
    referenceText: options.referenceText,
    greedy: options.greedy,
    voiceDir: options.voiceDir,
    seed: options.seed,
    nGpuLayers: options.nGpuLayers,
    nCtx: options.nCtx,
    kvCacheType: options.kvCacheType,
    threads: options.threads,
    streamChunkTokens: options.streamChunkTokens,
    streamFirstChunkTokens: options.streamFirstChunkTokens,
    streamChunkTolerancePct: options.streamChunkTolerancePct,
    streamMinChunkTokens: options.streamMinChunkTokens,
    streamLeftContextTokens: options.streamLeftContextTokens,
    cfmSteps: options.cfmSteps,
    cfgRate: options.cfgRate,
    batchCfmSteps: options.batchCfmSteps,
    nPredict: options.nPredict,
    maxSentenceChars: options.maxSentenceChars,
    crossfadeMs: options.crossfadeMs,
    repeatPenalty: options.repeatPenalty,
    exaggeration: options.exaggeration,
    cfgWeight: options.cfgWeight,
    minP: options.minP,
    voiceJsonPath: options.voiceJsonPath,
    prewarmText: options.prewarmText,
    vulkanDevice: options.vulkanDevice,
    flowCutPrompt: options.flowCutPrompt,
    promptText: options.promptText,
    instruct: renderCosyvoiceInstruct(options.instruct) || undefined,
    voice: firstNonEmpty(options.voice, options.voiceName),
    steps: firstNonEmpty(options.steps, options.numInferenceSteps),
    speed: options.speed,
    noiseNpyPath: options.noiseNpyPath,
    description: firstNonEmpty(options.description, options.voiceDescription),
    emotion: options.emotion,
    pitch: options.pitch,
    pace: options.pace,
    expressivity: options.expressivity,
    noise: options.noise,
    reverb: options.reverb,
    quality: options.quality,
    temperature: options.temperature,
    topK: options.topK,
    topP: options.topP,
    maxFrames: options.maxFrames,
    minNewTokens: options.minNewTokens,
    normalizeNumbers: options.normalizeNumbers,
    ...mossVoiceSettings(options),
  };
}

function resolveBackendPaths(
  files: NormalizedFiles,
  options: TTSGgmlOptions,
  config: TTSGgmlRuntimeConfig,
): BackendPaths {
  return {
    enhancerGgufPath: resolveEnhancerGgufPath(files, options.enhancer),
    denoiserGgufPath: resolveDenoiserGgufPath(files, options.denoiser),
    backendsDir: firstNonEmpty(options.backendsDir, config.backendsDir),
    openclCacheDir: firstNonEmpty(options.openclCacheDir, config.openclCacheDir),
    vulkanCacheDir: firstNonEmpty(options.vulkanCacheDir, config.vulkanCacheDir),
  };
}

function resolvePocketSetup(
  files: NormalizedFiles,
  options: TTSGgmlOptions,
  config: TTSGgmlRuntimeConfig,
): PocketSetup {
  if (files.lavasrEnhancer || files.lavasrDenoiser) {
    throw new Error("Pocket does not support LavaSR enhancement or denoising");
  }
  return {
    files,
    options: { ...options },
    params: buildPocketParams(files, options, config),
  };
}

/** Resolve and validate everything the constructor derives from `options`. */
export function resolveEngineSetup(options: TTSGgmlOptions): EngineSetup {
  const files = normalizeGgmlFiles(options.files || {});
  const config: TTSGgmlRuntimeConfig = { ...(options.config || {}) };
  const outputSampleRate = validateOutputSampleRate(config.outputSampleRate);
  const engineType = detectEngineType(options.engine, files);
  const mossVoice = mossVoiceSettings(options);
  const pocket =
    engineType === ENGINE_POCKET
      ? resolvePocketSetup(files, options, config)
      : null;
  const paths = resolveModelPaths(engineType, files, {
    mecabDictPath: options.mecabDictPath,
    mecabDictDir: options.mecabDictDir,
    cangjieTsvPath: options.cangjieTsvPath,
    dialogue: mossVoice.dialogueReferences !== undefined,
  });
  const settings = settingsFromOptions(options);
  const backend = resolveBackendPaths(files, options, config);
  const setup: EngineSetup = {
    engineType,
    config,
    outputSampleRate,
    paths,
    settings,
    backend,
    pocket,
  };
  assertGpuIntentConsistent(config.useGPU, settings.nGpuLayers);
  validateEngineOptions(setup);
  if (config.useGPU === undefined && settings.nGpuLayers == null) {
    config.useGPU = false;
  }
  return setup;
}
