// @qvac/audiogen-ggml
//
// Audio generation (music) addon for qvac, ggml backend. Text prompt in ->
// stereo audio out, powered by the ACE-Step engine in audiogen-cpp
// (text-encoder + LM + DiT + VAE), compiled natively per-platform and linked
// via vcpkg — same shape as @qvac/tts-ggml.
//
// The high-level `AudioGen` class implements the shared qvac addon contract:
// `load()` once, then `run()` returns a `@qvac/infer-base` `QvacResponse` that
// streams the engine's output (progress ticks + one interleaved-Int16 PCM
// chunk) and resolves with the run stats.

import {
  createJobHandler,
  exclusiveRunQueue,
  type JobHandler,
  type QvacResponse
} from '@qvac/infer-base'
// eslint-disable-next-line @typescript-eslint/no-require-imports -- @qvac/logging exposes a CommonJS export-assignment shape.
import QvacLogger = require('@qvac/logging')
// eslint-disable-next-line @typescript-eslint/no-require-imports -- bare-path is a CommonJS module.
import path = require('bare-path')
// eslint-disable-next-line @typescript-eslint/no-require-imports -- bare-os is a CommonJS module.
import os = require('bare-os')

import {
  AudioEditOperationType,
  AudioGenInterface,
  RepaintMode,
  type AudioGenBinding,
  type AudioGenConfigurationParams,
  type AudioGenJobData,
  type AudioGenOutputCallback
} from './audiogen'
import { resolveDitModelPath, type DitVariant } from './models'
import {
  encodePcm,
  type EncodeOptions,
  type EncodedAudio,
  type OutputFormat
} from './lib/audio-format'
import { ERR_CODES, QvacErrorAudioGen } from './error'

export const ENGINE_ACESTEP = 'acestep'
export const ENGINE_MINIMAX = 'minimax'
const SUPPORTED_ENGINES: readonly string[] = [ENGINE_ACESTEP, ENGINE_MINIMAX]
export const MINIMAX_FRAMES_PER_SECOND = 25
export const MINIMAX_DEFAULT_MAX_FRAMES = 300
const MINIMAX_MIN_FRAMES = 1
const MINIMAX_MAX_INFERENCE_STEPS = 1000
const INT32_MAX = 2147483647
const FLOAT32_MAX = 3.4028234663852886e38
const FLOAT32_MIN_POSITIVE = 1.401298464324817e-45

export type AudioGenEngine = typeof ENGINE_ACESTEP | typeof ENGINE_MINIMAX

type RunExclusive = <T>(callback: () => Promise<T>) => Promise<T>

/** Model file paths for ACE-Step or MiniMax-Music3. */
export interface AudioGenFiles {
  /** Directory holding the four ACE-Step GGUFs (engine auto-classifies them). */
  modelDir?: string
  /** Explicit text-encoder GGUF path. */
  textEncModel?: string
  /** Explicit LM GGUF path. */
  lmModel?: string
  /** Explicit MiniMax synthesis GGUF path. */
  synthModel?: string
  /** Explicit DiT GGUF path (wins over `ditVariant`). */
  ditModel?: string
  /** Selects the DiT GGUF from `modelDir` when `ditModel` is not given. */
  ditVariant?: DitVariant
  /** Explicit VAE GGUF path. */
  vaeModel?: string
}

/** Runtime knobs handed to the native engine. */
export interface AudioGenRuntimeConfig {
  /** 0 = engine auto-picks per DiT architecture (turbo 8 / sft 50). */
  inferenceSteps?: number
  /** MiniMax flow classifier-free guidance scale; 0 uses the model default. */
  cfgScale?: number
  /** 0 = engine auto-picks per DiT architecture (turbo 3.0 / sft 1.0). */
  shift?: number
  /**
   * Run on a GPU backend (CUDA, Vulkan, Metal, ...) when one is usable; falls
   * back to CPU otherwise — `stats.backendDevice` reports the backend actually
   * in use. MiniMax puts the whole model pair on the device (~22 GB for f16).
   */
  useGPU?: boolean
  /** ACE-Step only: GPU layers to offload when `useGPU` is set (99 = all). */
  nGpuLayers?: number
  /** 0 = engine auto-picks. */
  threads?: number
  /**
   * Override the prebuilds root the native engine scans for dlopen'd ggml
   * backend modules. Defaults to `<addon>/prebuilds` (correct for the shipped
   * package); only set this for a non-standard prebuilds layout. Needed on
   * arm64, where the CPU backend is a set of per-microarch MODULE .so files.
   */
  backendsDir?: string
}

export interface AudioGenOptions {
  /** Music engine. Inferred as MiniMax when `synthModel` is present. */
  engine?: AudioGenEngine
  /** Local GGUF paths for the selected engine. */
  files?: AudioGenFiles
  /** Runtime knobs (steps, shift, GPU, threads). */
  config?: AudioGenRuntimeConfig
  /** Underlying logger; wrapped by a level-gated QvacLogger (defaults to off). */
  logger?: QvacLogger.LoggerInterface
}

export interface GenerateOptions {
  lyrics?: string
  seed?: number
  vocalLanguage?: string
  /** Beats per minute; 0/undefined lets the LM infer it. */
  bpm?: number
  /** Key + scale, e.g. "C minor". */
  keyscale?: string
  /** Time signature, e.g. "4/4". */
  timesignature?: string
  /** Append BPM/tempo, time signature and key to the internal conditioning caption. */
  augmentCaptionWithMetadata?: boolean
  /** Target length in seconds; MiniMax converts it to 25 semantic frames per second. */
  duration?: number
  /** MiniMax semantic-frame cap. Cannot be combined with `duration`. */
  maxFrames?: number
  /** MiniMax flow steps for this generation; 0 uses the model default. */
  inferenceSteps?: number
  /** MiniMax flow classifier-free guidance scale for this generation. */
  cfgScale?: number
  /** LM sampling temperature (ACE-Step default: 0.85). */
  lmTemperature?: number
  /** LM nucleus-sampling probability (ACE-Step default: 0.9). */
  lmTopP?: number
  /** LM top-k cutoff; 0 disables top-k filtering. */
  lmTopK?: number
  /** Classifier-free guidance scale used by the LM. */
  lmCfgScale?: number
  /** Allow the LM to infer missing metadata before semantic-code generation. */
  lmPhase1?: boolean
  /**
   * Simple Mode: treat the caption as a short natural-language query and let
   * the LM compose the full request before synthesis — a detailed caption,
   * lyrics, and any metadata left unset (bpm, keyscale, timesignature,
   * vocalLanguage, and duration when 0). Options you set are kept. Requires
   * `text2music` with no `audioCodes`; leave `lyrics` unset for LM-written
   * vocals or pass `'[Instrumental]'` for an instrumental song.
   */
  simpleMode?: boolean
  /**
   * Percentile loudness normalization on the generated audio (default true):
   * the 99.999th-percentile sample scales to full scale and the tiny tail
   * above it clips, matching the reference loudness. Set false for the raw
   * engine output. Audio edits are never normalized.
   */
  normalizeLoudness?: boolean
  /**
   * Teacher-forced LM quality scoring of the generated audio codes against
   * the request: `stats.qualityScore` reports a weighted [0, 1] score
   * (caption/lyrics PMI plus metadata recall) at the cost of extra LM
   * forwards after code generation — made for ranking a batch of takes.
   * Requires the LM code path, so `taskType` must be `'text2music'`.
   */
  computeQualityScore?: boolean
  /** Apply official ACE-Step Haar DCW correction during DiT sampling (default: true). */
  dcwEnabled?: boolean
  /** DCW low-frequency correction strength (official default: 0.05). */
  dcwScaler?: number
  /** DCW high-frequency correction strength (official default: 0.02). */
  dcwHighScaler?: number
  /** Frozen ACE-Step semantic codes; when present, skips the LM stage. */
  audioCodes?: Int32Array
  /**
   * Optional timbre reference: interleaved stereo float PCM at 48 kHz.
   * Empty / omitted keeps the engine's canonical silence reference.
   */
  referenceAudio?: Float32Array
  /**
   * Source / cover audio (same layout as `referenceAudio`). Required when
   * `taskType` is `"cover"`, `"cover-nofsq"`, or `"lego"`.
   */
  sourceAudio?: Float32Array
  /**
   * Task discriminator. Supported today: `"text2music"` (default) |
   * `"cover-nofsq"` | `"lego"`. `"cover"` (FSQ roundtrip) is accepted but not
   * implemented in the engine yet. `"lego"` generates a new instrument layer
   * that follows `sourceAudio` and returns only that layer; it requires the
   * base DiT variant (turbo and sft are rejected by the engine).
   */
  taskType?: 'text2music' | 'cover' | 'cover-nofsq' | 'lego'
  /**
   * Lego target layer. Required when `taskType` is `"lego"`; one of
   * vocals|backing_vocals|drums|bass|guitar|keyboard|percussion|strings|
   * synth|fx|brass|woodwinds.
   */
  track?: string
  /**
   * DiT classifier-free guidance scale. 0 (default) resolves automatically:
   * 1.0 on turbo variants (CFG disabled), 7.0 on base/sft. Values > 1 run
   * CFG via APG and double the DiT cost per step.
   */
  guidanceScale?: number
  /**
   * Fraction of DiT steps that keep the source context (0..1). Default 1.0.
   * Below 1 the engine follows the source for that fraction of the run, then
   * finishes freely on a silence context.
   */
  audioCoverStrength?: number
  /**
   * Blend initial DiT noise toward clean source latents (0..1). 0 = pure noise;
   * 1 ≈ source latent. Default 0.
   */
  coverNoiseStrength?: number
}

/** PCM accepted by the source-driven editing API. */
export interface AudioEditSource {
  /**
   * Interleaved stereo PCM. Float32 samples must be finite and in `[-1, 1]`.
   * Int16 output chunks can be reused directly.
   */
  pcm: Float32Array | Int16Array
  sampleRate: number
  channels: number
}

export interface AudioEditPrompt {
  caption: string
  lyrics?: string
}

/** v1 Flow-Edit. Supported on turbo DiT only (`turbo-q4`, `turbo-q8`). */
export interface FlowEditOptions {
  /** Description of the unedited source audio. */
  from: AudioEditPrompt
  /** Description of the desired audio. */
  to: AudioEditPrompt
  /** Start of the flow-edit diffusion window, in [0, 1]. */
  nMin?: number
  /** End of the flow-edit diffusion window, in [0, 1]. */
  nMax?: number
  /** Number of forward-noise samples averaged per active step. */
  nAvg?: number
}

export interface RepaintOptions extends AudioEditPrompt {
  /**
   * Repaint region start in seconds. Must lie inside the source duration and
   * leave at least one latent frame (`1/25` s) before `end`.
   */
  start: number
  /**
   * Repaint region end in seconds. Omit to repaint through the source end.
   * Must not exceed the source duration.
   */
  end?: number
  mode?: RepaintMode
  /** Balanced-mode preservation strength in [0, 1]. */
  strength?: number
}

export interface AudioEditRunOptions {
  /** Seeds the first operation; each following operation uses seed + its index. */
  seed?: number
}

interface NativeFlowEditOperation {
  type: AudioEditOperationType.FlowEdit
  sourceCaption: string
  sourceLyrics: string
  targetCaption: string
  targetLyrics: string
  nMin: number
  nMax: number
  nAvg: number
}

interface NativeRepaintOperation {
  type: AudioEditOperationType.Repaint
  caption: string
  lyrics: string
  start: number
  end: number
  mode: RepaintMode
  strength: number
}

export type AudioEditOperationData = NativeFlowEditOperation | NativeRepaintOperation

/** A per-step progress tick from the selected engine. */
export interface AudiogenProgress {
  stage: string
  step: number
  total: number
}

/** One interleaved-Int16 PCM chunk emitted by the engine. */
export interface AudiogenPcmChunk {
  outputArray: Int16Array
  sampleRate: number
  channels: number
}

/** A progress tick delivered through the run's output stream. */
export interface AudiogenProgressChunk {
  progress: AudiogenProgress
}

/** Items streamed by the `QvacResponse` returned from `run()`. */
export type AudiogenOutputChunk = AudiogenPcmChunk | AudiogenProgressChunk

/**
 * Terminal run stats, resolved by `QvacResponse.await()`. These mirror exactly
 * what the native model emits — `totalTimeMs`,
 * `realTimeFactor`, `audioDurationMs` and the resolved backend. Sample rate and
 * channel count are NOT here: they ride on each PCM chunk instead (see
 * `AudiogenPcmChunk`).
 *
 * `backendDevice` / `backendId` describe the backend the engine actually ran
 * on, not the one requested, so a `useGPU: true` run that fell back to the CPU
 * is detectable. Codes match @qvac/tts-ggml.
 */
export interface AudiogenStats {
  audioDurationMs?: number
  totalTimeMs?: number
  realTimeFactor?: number
  /** 0 = CPU, 1 = GPU. */
  backendDevice?: number
  /** 0 = CPU, 1 = Metal, 2 = CUDA, 3 = Vulkan, 4 = OpenCL, 99 = other. */
  backendId?: number
  /** 0 = none, 1 = not requested, 2 = no devices, 3 = init failed. */
  gpuFallbackReason?: number
  /**
   * Weighted quality of the generated codes against the request, in [0, 1]
   * (caption/lyrics PMI plus metadata recall). Present only when the run set
   * `computeQualityScore`; made for ranking a batch of takes.
   */
  qualityScore?: number
}

/** Name of a backend `AudiogenStats.backendId` can resolve to. */
export type AudiogenBackendName = 'cpu' | 'metal' | 'cuda' | 'vulkan' | 'opencl' | 'other'

/** `AudiogenStats.backendId` codes, named. Codes match @qvac/tts-ggml. */
export const AUDIOGEN_BACKEND_NAMES: Readonly<Record<number, AudiogenBackendName>> = {
  0: 'cpu',
  1: 'metal',
  2: 'cuda',
  3: 'vulkan',
  4: 'opencl',
  99: 'other'
}

/** `undefined` for an unset or unrecognised id, never a guessed name. */
export function audiogenBackendName(
  backendId: number | undefined
): AudiogenBackendName | undefined {
  if (backendId === undefined) return undefined
  return AUDIOGEN_BACKEND_NAMES[backendId]
}

/** Why a GPU-requested run resolved to the CPU. */
export type AudiogenGpuFallbackReason = 'none' | 'not-requested' | 'no-devices' | 'init-failed'

/**
 * `AudiogenStats.gpuFallbackReason` codes, named. Codes match
 * `tts_cpp::GpuFallbackReason` in the engine.
 */
export const AUDIOGEN_GPU_FALLBACK_REASONS: Readonly<Record<number, AudiogenGpuFallbackReason>> = {
  0: 'none',
  1: 'not-requested',
  2: 'no-devices',
  3: 'init-failed'
}

/** `undefined` for an unset or unrecognised code, never a guessed reason. */
export function audiogenGpuFallbackReason(
  code: number | undefined
): AudiogenGpuFallbackReason | undefined {
  if (code === undefined) return undefined
  return AUDIOGEN_GPU_FALLBACK_REASONS[code]
}

/** Raw shape of the native output-callback payload. */
interface NativeAudiogenData {
  outputArray?: Int16Array
  // sampleRate/channels are attached to the PCM chunk, not the stats frame.
  sampleRate?: number
  channels?: number
  audioDurationMs?: number
  totalTimeMs?: number
  realTimeFactor?: number
  backendDevice?: number
  backendId?: number
  gpuFallbackReason?: number
  qualityScore?: number
  progressStage?: string
  progressStep?: number
  progressTotal?: number
}

function asNativeData(data: unknown): NativeAudiogenData | null {
  if (typeof data !== 'object' || data === null) return null
  // `object` is assignable to NativeAudiogenData (every field is optional); the
  // per-field `typeof` guards below do the real runtime narrowing.
  return data
}

// The native config parser `static_cast<int>`s these numbers, and casting
// NaN/Infinity to an integer is undefined behavior. Reject non-finite (and
// non-integer, where required) values on the JS side with a clear error before
// they ever reach C++.
function requireFiniteNumber(value: number, name: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidInput(`${name} must be a finite number, got ${value}`)
  }
  if (integer && !Number.isInteger(value)) {
    throw invalidInput(`${name} must be an integer, got ${value}`)
  }
  return value
}

function optionalFiniteNumber(
  value: number | undefined,
  name: string,
  integer = false
): number | undefined {
  return value === undefined ? undefined : requireFiniteNumber(value, name, integer)
}

function requireSafeInteger(value: number, name: string): number {
  requireFiniteNumber(value, name, true)
  if (!Number.isSafeInteger(value)) {
    throw invalidInput(`${name} must be a safe integer, got ${value}`)
  }
  return value
}

function requireMinimaxInferenceSteps(value: number): number {
  const steps = requireSafeInteger(value, 'inferenceSteps')
  if (steps < 0 || steps > MINIMAX_MAX_INFERENCE_STEPS) {
    throw invalidInput(`inferenceSteps must be between 0 and ${MINIMAX_MAX_INFERENCE_STEPS}`)
  }
  return steps
}

function requireNonNegativeInt32(value: number, name: string): number {
  const integer = requireSafeInteger(value, name)
  if (integer < 0 || integer > INT32_MAX) {
    throw invalidInput(`${name} must be between 0 and ${INT32_MAX}`)
  }
  return integer
}

function requireMinimaxCfgScale(value: number): number {
  const scale = requireFiniteNumber(value, 'cfgScale')
  if (scale < 0 || scale > FLOAT32_MAX || (scale > 0 && scale < FLOAT32_MIN_POSITIVE)) {
    throw invalidInput('cfgScale must be 0 or a positive float32 value')
  }
  return scale
}

const GENERATE_TASK_TYPES = new Set(['text2music', 'cover', 'cover-nofsq', 'lego'])
const LEGO_TRACKS = new Set([
  'vocals',
  'backing_vocals',
  'drums',
  'bass',
  'guitar',
  'keyboard',
  'percussion',
  'strings',
  'synth',
  'fx',
  'brass',
  'woodwinds'
])
const AUDIO_LATENT_RATE = 25
const LATENT_FRAME_SECONDS = 1 / AUDIO_LATENT_RATE
const REPAINT_RANGE_EPSILON_SECONDS = 1e-5
const FLOW_EDIT_TURBO_VARIANTS = 'turbo-q4, turbo-q8'

function optionalTaskType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !GENERATE_TASK_TYPES.has(value)) {
    throw invalidInput('taskType must be one of text2music|cover|cover-nofsq|lego')
  }
  return value
}

function requireFinitePcm(value: Float32Array, name: string): void {
  for (const sample of value) {
    if (!Number.isFinite(sample)) {
      throw invalidInput(`${name} must contain only finite samples`)
    }
  }
}

function requireNormalizedPcm(value: Float32Array, name: string): void {
  for (const sample of value) {
    if (!Number.isFinite(sample) || sample < -1 || sample > 1) {
      throw invalidInput(`${name} must contain finite samples in [-1, 1]`)
    }
  }
}

function int16ToNormalizedFloat32(pcm: Int16Array): Float32Array {
  const converted = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; ++i) {
    const sample = pcm[i]
    converted[i] = sample < 0 ? sample / 32768 : sample / 32767
  }
  return converted
}

function isSftDit(ditVariant: DitVariant | undefined, ditModelPath: string | undefined): boolean {
  if (ditVariant === 'sft') return true
  if (ditModelPath === undefined) return false
  const file = ditModelPath.split(/[/\\]/).pop() ?? ''
  return /(?:^|[^a-z])sft(?:[^a-z]|$)/i.test(file.replace(/\.gguf$/i, ''))
}

function sourceDurationSeconds(source: AudioEditSource): number {
  return source.pcm.length / source.channels / source.sampleRate
}

function requireRepaintRange(source: AudioEditSource, start: number, end: number): void {
  const duration = sourceDurationSeconds(source)
  const resolvedEnd = end === -1 ? duration : end
  if (start > duration + REPAINT_RANGE_EPSILON_SECONDS) {
    throw invalidInput('repaint.start must be within the source duration')
  }
  if (end !== -1 && end > duration + REPAINT_RANGE_EPSILON_SECONDS) {
    throw invalidInput('repaint.end must be within the source duration')
  }
  if (resolvedEnd - start < LATENT_FRAME_SECONDS - REPAINT_RANGE_EPSILON_SECONDS) {
    throw invalidInput('repaint range must span at least one latent frame')
  }
}

function optionalStereoPcm(
  value: Float32Array | undefined,
  name: string
): Float32Array | undefined {
  if (value === undefined) return undefined
  if (!(value instanceof Float32Array)) {
    throw invalidInput(`${name} must be a Float32Array`)
  }
  if ((value.length & 1) !== 0) {
    throw invalidInput(`${name} must be interleaved stereo`)
  }
  requireFinitePcm(value, name)
  return value
}

function requireEditSource(source: AudioEditSource): Float32Array {
  if (typeof source !== 'object' || source === null) {
    throw invalidInput('edit source must be an audio source object')
  }
  if (source.sampleRate !== 48000) {
    throw invalidInput(`edit source sampleRate must be 48000, got ${source.sampleRate}`)
  }
  if (source.channels !== 2) {
    throw invalidInput(`edit source channels must be 2, got ${source.channels}`)
  }
  if (!(source.pcm instanceof Float32Array) && !(source.pcm instanceof Int16Array)) {
    throw invalidInput('edit source pcm must be a Float32Array or Int16Array')
  }
  if (source.pcm.length === 0) {
    throw invalidInput('edit source pcm must not be empty')
  }
  if ((source.pcm.length & 1) !== 0) {
    throw invalidInput('edit source pcm must be interleaved stereo')
  }
  if (source.pcm instanceof Float32Array) {
    requireNormalizedPcm(source.pcm, 'edit source pcm')
    return source.pcm
  }
  return int16ToNormalizedFloat32(source.pcm)
}

function requirePrompt(prompt: AudioEditPrompt, name: string): AudioEditPrompt {
  if (typeof prompt !== 'object' || prompt === null) {
    throw invalidInput(`${name} must be an object`)
  }
  if (typeof prompt.caption !== 'string' || prompt.caption.trim().length === 0) {
    throw invalidInput(`${name}.caption must be a non-empty string`)
  }
  if (prompt.lyrics !== undefined && typeof prompt.lyrics !== 'string') {
    throw invalidInput(`${name}.lyrics must be a string`)
  }
  return prompt
}

function isCoverTask(taskType: string | undefined): boolean {
  return taskType === 'cover' || taskType === 'cover-nofsq'
}

function taskRequiresSourceAudio(taskType: string | undefined): boolean {
  return isCoverTask(taskType) || taskType === 'lego'
}

function invalidInput(message: string): QvacErrorAudioGen {
  return new QvacErrorAudioGen({ code: ERR_CODES.INVALID_INPUT, adds: message })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const ACESTEP_FILE_KEYS: Array<keyof AudioGenFiles> = [
  'textEncModel',
  'ditModel',
  'ditVariant',
  'vaeModel'
]

const ACESTEP_GENERATE_KEYS: Array<keyof GenerateOptions> = [
  'vocalLanguage',
  'bpm',
  'keyscale',
  'timesignature',
  'augmentCaptionWithMetadata',
  'lmTemperature',
  'lmTopP',
  'lmTopK',
  'lmCfgScale',
  'lmPhase1',
  'dcwEnabled',
  'dcwScaler',
  'dcwHighScaler',
  'audioCodes',
  'referenceAudio',
  'sourceAudio',
  'taskType',
  'track',
  'guidanceScale',
  'audioCoverStrength',
  'coverNoiseStrength',
  'computeQualityScore'
]

function hasAnyFile(files: AudioGenFiles, keys: Array<keyof AudioGenFiles>): boolean {
  return keys.some((key) => files[key] !== undefined)
}

function quoteEngine(engine: string): string {
  return `'${engine}'`
}

function supportedEnginesMessage(): string {
  return SUPPORTED_ENGINES.map(quoteEngine).join(' or ')
}

function validateEngineType(engine: string | undefined): void {
  if (engine !== undefined && !SUPPORTED_ENGINES.includes(engine)) {
    throw invalidInput(`engine must be ${supportedEnginesMessage()}`)
  }
}

export function detectEngineType(
  files: AudioGenFiles = {},
  explicitEngine?: AudioGenEngine
): AudioGenEngine {
  validateEngineType(explicitEngine)
  if (explicitEngine !== undefined) return explicitEngine
  if (files.synthModel !== undefined) return ENGINE_MINIMAX
  return ENGINE_ACESTEP
}

function validateMinimaxFiles(files: AudioGenFiles): void {
  if (hasAnyFile(files, ACESTEP_FILE_KEYS)) {
    throw invalidInput('MiniMax does not accept ACE-Step text encoder, DiT, or VAE files')
  }
  const hasDirectory = typeof files.modelDir === 'string' && files.modelDir.length > 0
  const hasPair =
    typeof files.lmModel === 'string' &&
    files.lmModel.length > 0 &&
    typeof files.synthModel === 'string' &&
    files.synthModel.length > 0
  if (!hasDirectory && !hasPair) {
    throw invalidInput('MiniMax requires modelDir or both lmModel and synthModel')
  }
}

function validateAcestepOptions(files: AudioGenFiles, config: AudioGenRuntimeConfig): void {
  if (files.synthModel !== undefined) {
    throw invalidInput('ACE-Step does not accept synthModel')
  }
  if (config.cfgScale !== undefined) {
    throw invalidInput('ACE-Step does not accept cfgScale')
  }
}

function validateMinimaxConfig(config: AudioGenRuntimeConfig): void {
  if (config.useGPU !== undefined && typeof config.useGPU !== 'boolean') {
    throw invalidInput('useGPU must be a boolean')
  }
  if (config.shift !== undefined || config.nGpuLayers !== undefined) {
    throw invalidInput('MiniMax does not accept shift or nGpuLayers')
  }
}

function assertNoAcestepGenerateOptions(options: GenerateOptions): void {
  for (const key of ACESTEP_GENERATE_KEYS) {
    if (options[key] !== undefined) {
      throw invalidInput(`MiniMax does not accept ${key}`)
    }
  }
}

function assertNoMinimaxGenerateOptions(options: GenerateOptions): void {
  if (
    options.maxFrames !== undefined ||
    options.inferenceSteps !== undefined ||
    options.cfgScale !== undefined
  ) {
    throw invalidInput('ACE-Step does not accept maxFrames, inferenceSteps, or cfgScale per run')
  }
}

function resolveMinimaxMaxFrames(options: GenerateOptions): number {
  if (options.maxFrames !== undefined && options.duration !== undefined) {
    throw invalidInput('MiniMax accepts either maxFrames or duration, not both')
  }
  if (options.maxFrames !== undefined) {
    const frames = requireSafeInteger(options.maxFrames, 'maxFrames')
    if (frames < MINIMAX_MIN_FRAMES) throw invalidInput('maxFrames must be at least 1')
    return frames
  }
  if (options.duration !== undefined) {
    const duration = requireFiniteNumber(options.duration, 'duration')
    if (duration <= 0) throw invalidInput('duration must be greater than 0')
    const frames = Math.max(MINIMAX_MIN_FRAMES, Math.round(duration * MINIMAX_FRAMES_PER_SECOND))
    return requireSafeInteger(frames, 'duration-derived maxFrames')
  }
  return MINIMAX_DEFAULT_MAX_FRAMES
}

function isMobilePlatform(): boolean {
  const platform = os.platform()
  return platform === 'android' || platform === 'ios'
}

type EditRunner = (
  source: AudioEditSource,
  operations: readonly AudioEditOperationData[],
  options: AudioEditRunOptions
) => Promise<QvacResponse<AudiogenOutputChunk>>

/**
 * Fluent, ordered edit pipeline. Every call appends one operation; operations
 * may be repeated in any order before the session is submitted with `run()`.
 */
export class AudioEditSession {
  private readonly _operations: AudioEditOperationData[] = []
  private _started = false

  constructor(
    private readonly _source: AudioEditSource,
    private readonly _runner: EditRunner,
    private readonly _allowFlowEdit: boolean
  ) {}

  /** Append a Flow-Edit operation. v1 supports turbo DiT only. */
  flowEdit(options: FlowEditOptions): this {
    if (this._started) throw invalidInput('cannot modify an edit session after run()')
    if (!this._allowFlowEdit) {
      throw invalidInput(
        `flowEdit is supported on turbo DiT variants only (${FLOW_EDIT_TURBO_VARIANTS})`
      )
    }
    if (typeof options !== 'object' || options === null) {
      throw invalidInput('flowEdit options must be an object')
    }
    const from = requirePrompt(options.from, 'flowEdit.from')
    const to = requirePrompt(options.to, 'flowEdit.to')
    const nMin = requireFiniteNumber(options.nMin ?? 0, 'flowEdit.nMin')
    const nMax = requireFiniteNumber(options.nMax ?? 1, 'flowEdit.nMax')
    const nAvg = requireFiniteNumber(options.nAvg ?? 1, 'flowEdit.nAvg', true)
    if (nMin < 0 || nMax > 1 || nMin > nMax) {
      throw invalidInput('flowEdit requires 0 <= nMin <= nMax <= 1')
    }
    if (nAvg < 1) throw invalidInput('flowEdit.nAvg must be at least 1')
    this._operations.push({
      type: AudioEditOperationType.FlowEdit,
      sourceCaption: from.caption,
      sourceLyrics: from.lyrics ?? '[Instrumental]',
      targetCaption: to.caption,
      targetLyrics: to.lyrics ?? '[Instrumental]',
      nMin,
      nMax,
      nAvg
    })
    return this
  }

  /** Alias for `flowEdit()` so `.edit().repaint().edit()` reads naturally. */
  edit(options: FlowEditOptions): this {
    return this.flowEdit(options)
  }

  /** Append a timeline Repaint operation. */
  repaint(options: RepaintOptions): this {
    if (this._started) throw invalidInput('cannot modify an edit session after run()')
    const prompt = requirePrompt(options, 'repaint')
    const start = requireFiniteNumber(options.start, 'repaint.start')
    const end = optionalFiniteNumber(options.end, 'repaint.end') ?? -1
    const mode = options.mode ?? RepaintMode.Balanced
    const strength = requireFiniteNumber(options.strength ?? 0.5, 'repaint.strength')
    if (start < 0) throw invalidInput('repaint.start must be non-negative')
    if (end !== -1 && end <= start) {
      throw invalidInput('repaint.end must be greater than repaint.start')
    }
    requireRepaintRange(this._source, start, end)
    if (!Object.values(RepaintMode).includes(mode)) {
      throw invalidInput('repaint.mode must be conservative|balanced|aggressive')
    }
    if (strength < 0 || strength > 1) {
      throw invalidInput('repaint.strength must be between 0 and 1')
    }
    this._operations.push({
      type: AudioEditOperationType.Repaint,
      caption: prompt.caption,
      lyrics: prompt.lyrics ?? '[Instrumental]',
      start,
      end,
      mode,
      strength
    })
    return this
  }

  async run(options: AudioEditRunOptions = {}): Promise<QvacResponse<AudiogenOutputChunk>> {
    if (this._started) throw invalidInput('edit session run() may only be called once')
    if (this._operations.length === 0) {
      throw invalidInput('edit session requires at least one edit or repaint operation')
    }
    if (typeof options !== 'object' || options === null) {
      throw invalidInput('edit session run options must be an object')
    }
    const seed = optionalFiniteNumber(options.seed, 'edit.seed', true)
    this._started = true
    return this._runner(this._source, this._operations, { seed })
  }
}

/**
 * GGML-backed music generation via the ACE-Step engine. Owns a persistent
 * native engine: the four model stages are loaded once by `load()` and reused
 * by every `run()`.
 */
export class AudioGen {
  static readonly inferenceManagerConfig = {
    noAdditionalDownload: true
  }

  static readonly ENGINE_ACESTEP = ENGINE_ACESTEP
  static readonly ENGINE_MINIMAX = ENGINE_MINIMAX

  addon: AudioGenInterface | null
  private readonly _job: JobHandler
  private readonly _runExclusive: RunExclusive
  private readonly _configuration: AudioGenConfigurationParams
  private readonly _logger: QvacLogger
  private readonly _engineType: AudioGenEngine
  private readonly _defaultInferenceSteps: number
  private readonly _defaultCfgScale: number
  private readonly _ditVariant: DitVariant | undefined
  private _lifecycleRevision: number
  private _destroyed: boolean
  private _cancelPromise: Promise<void> | null
  private _cancellingResponse: QvacResponse<AudiogenOutputChunk> | null
  private _cancelTerminalResolve: (() => void) | null

  constructor(options: AudioGenOptions = {}) {
    this._logger = new QvacLogger(options.logger)
    const files = options.files ?? {}
    const config = options.config ?? {}
    this._engineType = detectEngineType(files, options.engine)
    const backendsDir = config.backendsDir ?? path.join(__dirname, 'prebuilds')
    const threads = requireNonNegativeInt32(config.threads ?? 0, 'threads')
    this._ditVariant = files.ditVariant

    if (this._engineType === ENGINE_MINIMAX) {
      if (isMobilePlatform()) {
        throw invalidInput('MiniMax-Music3 is available on desktop only')
      }
      validateMinimaxFiles(files)
      validateMinimaxConfig(config)
      this._defaultInferenceSteps = requireMinimaxInferenceSteps(config.inferenceSteps ?? 0)
      this._defaultCfgScale = requireMinimaxCfgScale(config.cfgScale ?? 0)
      this._configuration = {
        engineType: ENGINE_MINIMAX,
        modelDir: files.modelDir,
        lmModelPath: files.lmModel,
        synthModelPath: files.synthModel,
        threads,
        useGPU: config.useGPU ?? false,
        backendsDir
      }
    } else {
      validateAcestepOptions(files, config)
      this._defaultInferenceSteps = requireFiniteNumber(
        config.inferenceSteps ?? 0,
        'inferenceSteps',
        true
      )
      this._defaultCfgScale = 0
      const ditModelPath = resolveDitModelPath({
        modelDir: files.modelDir,
        ditModel: files.ditModel,
        ditVariant: files.ditVariant
      })
      this._configuration = {
        engineType: ENGINE_ACESTEP,
        modelDir: files.modelDir,
        textEncModelPath: files.textEncModel,
        lmModelPath: files.lmModel,
        ditModelPath,
        vaeModelPath: files.vaeModel,
        inferenceSteps: this._defaultInferenceSteps,
        shift: requireFiniteNumber(config.shift ?? 0, 'shift'),
        useGPU: config.useGPU ?? false,
        nGpuLayers: requireFiniteNumber(config.nGpuLayers ?? 99, 'nGpuLayers', true),
        threads,
        backendsDir
      }
    }

    this.addon = null
    this._job = createJobHandler({
      cancel: () => this.addon?.cancel() ?? Promise.resolve()
    })
    this._runExclusive = exclusiveRunQueue() as RunExclusive
    this._lifecycleRevision = 0
    this._destroyed = false
    this._cancelPromise = null
    this._cancellingResponse = null
    this._cancelTerminalResolve = null
  }

  /** Create the native engine and load its GGUF files. Idempotent. */
  async load(): Promise<void> {
    const revision = this._lifecycleRevision
    return this._runExclusive(() => this._load(revision))
  }

  private async _load(revision: number): Promise<void> {
    if (revision !== this._lifecycleRevision || this._destroyed) {
      throw this._lifecycleError()
    }
    if (this.addon) return
    this._logger.info(`audiogen-ggml: loading ${this._engineType} engine`)
    const addon = this._createAddon(this._configuration, this._addonOutputCallback.bind(this))
    this.addon = addon
    // If activation fails, tear down the half-initialized native handle and
    // clear `this.addon` so a later load() can retry instead of no-op'ing on a
    // dead instance. Mirrors the cleanup pattern in tts-ggml._load().
    try {
      await addon.activate()
      if (revision !== this._lifecycleRevision || this._destroyed) {
        throw this._lifecycleError()
      }
    } catch (error) {
      if (this.addon === addon) {
        this.addon = null
        try {
          await addon.destroyInstance()
        } catch {}
      }
      if (error instanceof QvacErrorAudioGen) throw error
      throw new QvacErrorAudioGen({
        code: ERR_CODES.FAILED_TO_LOAD,
        adds: errorMessage(error),
        cause: error instanceof Error ? error : undefined
      })
    }
    this._logger.info('audiogen-ggml: engine ready')
  }

  /**
   * Generate music from a text prompt. Returns a `QvacResponse` that streams
   * progress ticks + the PCM chunk and resolves (`await()`) with the run stats.
   */
  async run(
    caption: string,
    opts: GenerateOptions = {}
  ): Promise<QvacResponse<AudiogenOutputChunk>> {
    const jobData = this._createJobData(caption, opts)
    const revision = this._lifecycleRevision
    return new Promise((resolve, reject) => {
      const queued = this._runExclusive(() =>
        this._admitAndWait(jobData, revision, resolve, reject)
      )
      void queued.catch(reject)
    })
  }

  /**
   * Start a source-driven edit pipeline. Flow-Edit and Repaint operations may
   * be repeated and are executed in the exact order in which they are chained.
   * Flow-Edit is turbo DiT only (`turbo-q4`, `turbo-q8`).
   */
  edit(source: AudioEditSource): AudioEditSession {
    if (this._engineType === ENGINE_MINIMAX) {
      throw invalidInput('MiniMax-Music3 does not support audio editing')
    }
    return new AudioEditSession(
      source,
      async (audio, operations, options) => this._runEdit(audio, operations, options),
      !isSftDit(this._ditVariant, this._configuration.ditModelPath)
    )
  }

  private async _runEdit(
    source: AudioEditSource,
    operations: readonly AudioEditOperationData[],
    options: AudioEditRunOptions
  ): Promise<QvacResponse<AudiogenOutputChunk>> {
    const sourceAudio = requireEditSource(source)
    const jobData: AudioGenJobData = {
      type: 'edit',
      input: '',
      sourceAudio,
      editOperations: [...operations],
      seed: options.seed
    }
    const revision = this._lifecycleRevision
    return new Promise((resolve, reject) => {
      const queued = this._runExclusive(() =>
        this._admitAndWait(jobData, revision, resolve, reject)
      )
      void queued.catch(reject)
    })
  }

  private async _admitAndWait(
    jobData: AudioGenJobData,
    revision: number,
    resolve: (response: QvacResponse<AudiogenOutputChunk>) => void,
    reject: (error: unknown) => void
  ): Promise<void> {
    if (revision !== this._lifecycleRevision) {
      throw this._lifecycleError()
    }
    const addon = this._requireAddon()
    const response = this._job.start() as QvacResponse<AudiogenOutputChunk>
    let accepted: boolean
    try {
      accepted = await addon.runJob(jobData)
    } catch (error) {
      const runError = new QvacErrorAudioGen({
        code: ERR_CODES.FAILED_TO_START_JOB,
        adds: errorMessage(error),
        cause: error instanceof Error ? error : undefined
      })
      response.failed(runError)
      reject(runError)
      return
    }
    if (accepted !== true) {
      const admissionError = new QvacErrorAudioGen({ code: ERR_CODES.JOB_ALREADY_RUNNING })
      response.failed(admissionError)
      reject(admissionError)
      return
    }
    resolve(response)
    try {
      await response.await()
    } catch {}
  }

  private _createJobData(caption: string, opts: GenerateOptions): AudioGenJobData {
    if (typeof caption !== 'string' || caption.trim().length === 0) {
      throw invalidInput('caption must be a non-empty string')
    }
    this._logger.debug(
      `audiogen-ggml: run (caption ${caption.length} chars, lyrics=${opts.lyrics ? 'yes' : 'no'})`
    )
    if (this._engineType === ENGINE_MINIMAX) {
      return this._createMinimaxJobData(caption, opts)
    }
    return this._createAcestepJobData(caption, opts)
  }

  private _createMinimaxJobData(caption: string, opts: GenerateOptions): AudioGenJobData {
    assertNoAcestepGenerateOptions(opts)
    return {
      type: 'text',
      input: caption,
      lyrics: opts.lyrics ?? '[Instrumental]',
      seed: opts.seed === undefined ? undefined : requireSafeInteger(opts.seed, 'seed'),
      maxFrames: resolveMinimaxMaxFrames(opts),
      inferenceSteps:
        opts.inferenceSteps === undefined
          ? this._defaultInferenceSteps
          : requireMinimaxInferenceSteps(opts.inferenceSteps),
      cfgScale:
        opts.cfgScale === undefined ? this._defaultCfgScale : requireMinimaxCfgScale(opts.cfgScale)
    }
  }

  private _createAcestepJobData(caption: string, opts: GenerateOptions): AudioGenJobData {
    assertNoMinimaxGenerateOptions(opts)
    if (opts.lmPhase1 !== undefined && typeof opts.lmPhase1 !== 'boolean') {
      throw invalidInput('lmPhase1 must be a boolean')
    }
    if (
      opts.augmentCaptionWithMetadata !== undefined &&
      typeof opts.augmentCaptionWithMetadata !== 'boolean'
    ) {
      throw invalidInput('augmentCaptionWithMetadata must be a boolean')
    }
    if (opts.dcwEnabled !== undefined && typeof opts.dcwEnabled !== 'boolean') {
      throw invalidInput('dcwEnabled must be a boolean')
    }
    if (opts.audioCodes !== undefined && !(opts.audioCodes instanceof Int32Array)) {
      throw invalidInput('audioCodes must be an Int32Array')
    }
    const taskType = optionalTaskType(opts.taskType)
    const referenceAudio = optionalStereoPcm(opts.referenceAudio, 'referenceAudio')
    const sourceAudio = optionalStereoPcm(opts.sourceAudio, 'sourceAudio')
    if (
      taskRequiresSourceAudio(taskType) &&
      (sourceAudio === undefined || sourceAudio.length === 0)
    ) {
      throw invalidInput(`taskType '${taskType}' requires sourceAudio`)
    }
    if (opts.simpleMode !== undefined && typeof opts.simpleMode !== 'boolean') {
      throw invalidInput('simpleMode must be a boolean')
    }
    if (opts.normalizeLoudness !== undefined && typeof opts.normalizeLoudness !== 'boolean') {
      throw invalidInput('normalizeLoudness must be a boolean')
    }
    if (opts.computeQualityScore !== undefined && typeof opts.computeQualityScore !== 'boolean') {
      throw invalidInput('computeQualityScore must be a boolean')
    }
    if (opts.computeQualityScore === true && taskType !== undefined && taskType !== 'text2music') {
      throw invalidInput("computeQualityScore requires taskType 'text2music' (the LM code path)")
    }
    if (opts.simpleMode === true) {
      if (taskType !== undefined && taskType !== 'text2music') {
        throw invalidInput("simpleMode supports only taskType 'text2music'")
      }
      if (opts.audioCodes !== undefined) {
        throw invalidInput('simpleMode cannot take pre-supplied audioCodes')
      }
      if (opts.lyrics !== undefined && opts.lyrics !== '' && opts.lyrics !== '[Instrumental]') {
        throw invalidInput("simpleMode lyrics must be omitted (the LM writes them) or '[Instrumental]'")
      }
      if (opts.lmPhase1 === false) {
        throw invalidInput('simpleMode requires lmPhase1')
      }
    }
    if (taskType === 'lego' && (opts.track === undefined || !LEGO_TRACKS.has(opts.track))) {
      throw invalidInput(`taskType 'lego' requires track: one of ${[...LEGO_TRACKS].join('|')}`)
    }
    if (opts.track !== undefined && taskType !== 'lego') {
      throw invalidInput("track is only valid with taskType 'lego'")
    }
    const guidanceScale = optionalFiniteNumber(opts.guidanceScale, 'guidanceScale')
    if (guidanceScale !== undefined && guidanceScale < 0) {
      throw invalidInput('guidanceScale must be >= 0 (0 = engine default)')
    }
    return {
      type: 'text',
      input: caption,
      lyrics: opts.lyrics ?? (opts.simpleMode === true ? '' : '[Instrumental]'),
      simpleMode: opts.simpleMode,
      normalizeLoudness: opts.normalizeLoudness,
      computeQualityScore: opts.computeQualityScore,
      seed: optionalFiniteNumber(opts.seed, 'seed', true),
      vocalLanguage: opts.vocalLanguage,
      bpm: optionalFiniteNumber(opts.bpm, 'bpm', true),
      keyscale: opts.keyscale,
      timesignature: opts.timesignature,
      augmentCaptionWithMetadata: opts.augmentCaptionWithMetadata,
      duration: optionalFiniteNumber(opts.duration, 'duration'),
      lmTemperature: optionalFiniteNumber(opts.lmTemperature, 'lmTemperature'),
      lmTopP: optionalFiniteNumber(opts.lmTopP, 'lmTopP'),
      lmTopK: optionalFiniteNumber(opts.lmTopK, 'lmTopK', true),
      lmCfgScale: optionalFiniteNumber(opts.lmCfgScale, 'lmCfgScale'),
      lmPhase1: opts.lmPhase1,
      dcwEnabled: opts.dcwEnabled,
      dcwScaler: optionalFiniteNumber(opts.dcwScaler, 'dcwScaler'),
      dcwHighScaler: optionalFiniteNumber(opts.dcwHighScaler, 'dcwHighScaler'),
      audioCodes: opts.audioCodes,
      referenceAudio,
      sourceAudio,
      taskType,
      track: opts.track,
      guidanceScale,
      audioCoverStrength: optionalFiniteNumber(opts.audioCoverStrength, 'audioCoverStrength'),
      coverNoiseStrength: optionalFiniteNumber(opts.coverNoiseStrength, 'coverNoiseStrength')
    }
  }

  async cancel(): Promise<void> {
    const response = this._job.active
    if (!response) return
    if (this._cancelPromise) return this._cancelPromise
    const cancellation = this._cancelActiveResponse(response as QvacResponse<AudiogenOutputChunk>)
    this._cancelPromise = cancellation
    const cancellationError = new QvacErrorAudioGen({ code: ERR_CODES.CANCELLED })
    try {
      await cancellation
      response.failed(cancellationError)
    } finally {
      if (this._cancelPromise === cancellation) this._cancelPromise = null
      if (this._cancellingResponse === response) this._cancellingResponse = null
      this._cancelTerminalResolve = null
    }
  }

  private async _cancelActiveResponse(response: QvacResponse<AudiogenOutputChunk>): Promise<void> {
    this._cancellingResponse = response
    const terminal = new Promise<void>((resolve) => {
      this._cancelTerminalResolve = resolve
    })
    // A job that never reached the native engine emits no terminal event —
    // runJob can reject or be refused, and unload/destroy settles the active
    // response directly. Racing the response's own settlement keeps cancel()
    // from waiting forever on a terminal event that cannot arrive.
    const settled = response.await().then(
      () => undefined,
      () => undefined
    )
    try {
      await (this.addon?.cancel() ?? Promise.resolve())
      await Promise.race([terminal, settled])
    } catch (error) {
      const failedError = this._failedCancelError(error)
      response.failed(failedError)
      throw failedError
    }
  }

  async unload(): Promise<void> {
    await this._stop(new QvacErrorAudioGen({ code: ERR_CODES.MODEL_UNLOADED }))
  }

  async destroy(): Promise<void> {
    if (this._destroyed) return
    this._destroyed = true
    await this._stop(new QvacErrorAudioGen({ code: ERR_CODES.INSTANCE_DESTROYED }))
  }

  private async _stop(settlementError: QvacErrorAudioGen): Promise<void> {
    this._lifecycleRevision++
    const addon = this.addon
    this.addon = null
    let cancellation = Promise.resolve()
    let cancellationFailure: QvacErrorAudioGen | null = null
    if (addon && this._job.active) {
      try {
        cancellation = addon.cancel()
      } catch (error) {
        cancellationFailure = this._failedCancelError(error)
      }
    }
    this._job.active?.failed(settlementError)
    await this._runExclusive(async () => {
      try {
        await cancellation
      } catch (error) {
        cancellationFailure = this._failedCancelError(error)
      }
      if (!addon) {
        if (cancellationFailure) throw cancellationFailure
        return
      }
      let destructionFailure: QvacErrorAudioGen | null = null
      try {
        await addon.destroyInstance()
      } catch (error) {
        destructionFailure = new QvacErrorAudioGen({
          code: ERR_CODES.FAILED_TO_DESTROY,
          adds: errorMessage(error),
          cause: error instanceof Error ? error : undefined
        })
      }
      if (cancellationFailure) throw cancellationFailure
      if (destructionFailure) throw destructionFailure
      this._logger.debug('audiogen-ggml: engine unloaded')
    })
  }

  /**
   * Encode interleaved Int16 PCM into one or more output formats. Pass a single
   * format for one file, or an array to produce several at once (input order).
   * See {@link OUTPUT_FORMATS} for the allowed values.
   */
  static encode(pcm: Uint8Array, format?: OutputFormat, opts?: EncodeOptions): EncodedAudio
  static encode(pcm: Uint8Array, formats: OutputFormat[], opts?: EncodeOptions): EncodedAudio[]
  static encode(
    pcm: Uint8Array,
    formats?: OutputFormat | OutputFormat[],
    opts?: EncodeOptions
  ): EncodedAudio | EncodedAudio[] {
    return encodePcm(pcm, formats, opts)
  }

  static getModelKey(_params?: unknown): string {
    void _params
    return 'audiogen-ggml'
  }

  private _createAddon(
    configuration: AudioGenConfigurationParams,
    outputCallback: AudioGenOutputCallback
  ): AudioGenInterface {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
    const binding = require('./binding') as AudioGenBinding
    return new AudioGenInterface(binding, configuration, outputCallback)
  }

  private _addonOutputCallback(
    _handle: unknown,
    _event: unknown,
    data: unknown,
    error: unknown
  ): void {
    if (this._cancellingResponse) {
      const cancelledData = asNativeData(data)
      const terminalError = typeof error === 'string' && error.length > 0
      const terminalStats =
        cancelledData !== null &&
        (typeof cancelledData.audioDurationMs === 'number' ||
          typeof cancelledData.totalTimeMs === 'number')
      if (terminalError || terminalStats) {
        this._cancelTerminalResolve?.()
      }
      return
    }
    if (typeof error === 'string' && error.length > 0) {
      this._logger.error(`audiogen-ggml: engine error: ${error}`)
      this._job.fail(
        new QvacErrorAudioGen({
          code: ERR_CODES.INFERENCE_FAILED,
          adds: error
        })
      )
      return
    }
    const d = asNativeData(data)
    if (!d) return

    if (typeof d.progressTotal === 'number') {
      this._job.output({
        progress: {
          stage: d.progressStage ?? '',
          step: d.progressStep ?? 0,
          total: d.progressTotal
        }
      })
      return
    }

    if (d.outputArray) {
      this._job.output({
        outputArray: d.outputArray,
        sampleRate: d.sampleRate ?? 0,
        channels: d.channels ?? 0
      })
      return
    }

    if (typeof d.audioDurationMs === 'number' || typeof d.totalTimeMs === 'number') {
      const stats: AudiogenStats = {
        ...(typeof d.audioDurationMs === 'number' ? { audioDurationMs: d.audioDurationMs } : {}),
        ...(typeof d.totalTimeMs === 'number' ? { totalTimeMs: d.totalTimeMs } : {}),
        ...(typeof d.realTimeFactor === 'number' ? { realTimeFactor: d.realTimeFactor } : {}),
        ...(typeof d.backendDevice === 'number' ? { backendDevice: d.backendDevice } : {}),
        ...(typeof d.backendId === 'number' ? { backendId: d.backendId } : {}),
        ...(typeof d.gpuFallbackReason === 'number'
          ? { gpuFallbackReason: d.gpuFallbackReason }
          : {}),
        ...(typeof d.qualityScore === 'number' ? { qualityScore: d.qualityScore } : {})
      }
      this._job.end(stats, stats)
    }
  }

  private _requireAddon(): AudioGenInterface {
    if (!this.addon) throw this._lifecycleError()
    return this.addon
  }

  private _lifecycleError(): QvacErrorAudioGen {
    return new QvacErrorAudioGen({
      code: this._destroyed ? ERR_CODES.INSTANCE_DESTROYED : ERR_CODES.NOT_LOADED
    })
  }

  private _failedCancelError(error: unknown): QvacErrorAudioGen {
    return new QvacErrorAudioGen({
      code: ERR_CODES.FAILED_TO_CANCEL,
      adds: errorMessage(error),
      cause: error instanceof Error ? error : undefined
    })
  }
}

export {
  REGISTRY_SOURCE,
  REGISTRY_PREFIX,
  FIXED_MODELS,
  DIT_VARIANTS,
  DEFAULT_DIT_VARIANT,
  ditVariants,
  ditFilename,
  registryPath,
  modelFilenames,
  modelManifest,
  modelSources,
  resolveDitModelPath,
  allRegistryPaths
} from './models'
export type { DitVariant, ModelManifest, ModelSources, ResolveDitModelPathOptions } from './models'

export { encodePcm, pcmToWav, SUPPORTED_FORMATS as OUTPUT_FORMATS } from './lib/audio-format'
export type { OutputFormat, EncodeOptions, EncodedAudio } from './lib/audio-format'
export { ERR_CODE_RANGE, ERR_CODES, QvacErrorAudioGen } from './error'
export { AudioEditOperationType, RepaintMode } from './audiogen'

export type {
  AudioGenConfigurationParams,
  AudioGenJobData,
  AudioGenBinding,
  AudioGenOutputCallback
} from './audiogen'
