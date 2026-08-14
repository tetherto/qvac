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

import {
  AudioGenInterface,
  type AudioGenBinding,
  type AudioGenConfigurationParams,
  type AudioGenJobData,
  type AudioGenOutputCallback
} from './audiogen'
import { resolveDitModelPath, type DitVariant } from './models'
import { encodePcm, type EncodeOptions, type EncodedAudio, type OutputFormat } from './lib/audio-format'
import { ERR_CODES, QvacErrorAudioGen } from './error'

export const ENGINE_ACESTEP = 'acestep'

type RunExclusive = <T>(callback: () => Promise<T>) => Promise<T>

/** Model file paths for the four ACE-Step stages. */
export interface AudioGenFiles {
  /** Directory holding the four ACE-Step GGUFs (engine auto-classifies them). */
  modelDir?: string
  /** Explicit text-encoder GGUF path. */
  textEncModel?: string
  /** Explicit LM GGUF path. */
  lmModel?: string
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
  /** 0 = engine auto-picks per DiT architecture (turbo 3.0 / sft 1.0). */
  shift?: number
  useGPU?: boolean
  /** GPU layers to offload when `useGPU` is set (99 = all). Ignored when off. */
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
  /** Model file paths for the four stages. */
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
  /** Target length in seconds; undefined lets the LM decide the full length. */
  duration?: number
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
   * `taskType` is `"cover"` or `"cover-nofsq"`.
   */
  sourceAudio?: Float32Array
  /**
   * Task discriminator. Supported today: `"text2music"` (default) |
   * `"cover-nofsq"`. `"cover"` (FSQ roundtrip) is accepted but not implemented
   * in the engine yet.
   */
  taskType?: 'text2music' | 'cover' | 'cover-nofsq'
  /**
   * Fraction of DiT steps that keep the source context (0..1). Default 1.0.
   * Values < 1 are rejected by the engine until context switching lands.
   */
  audioCoverStrength?: number
  /**
   * Blend initial DiT noise toward clean source latents (0..1). 0 = pure noise;
   * 1 ≈ source latent. Default 0.
   */
  coverNoiseStrength?: number
}

/** A per-step progress tick from the engine (stage = "lm" | "dit" | "vae"). */
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
 * what the native `AcestepModel::runtimeStats()` emits — `totalTimeMs`,
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
  progressStage?: string
  progressStep?: number
  progressTotal?: number
}

function asNativeData (data: unknown): NativeAudiogenData | null {
  if (typeof data !== 'object' || data === null) return null
  // `object` is assignable to NativeAudiogenData (every field is optional); the
  // per-field `typeof` guards below do the real runtime narrowing.
  return data
}

// The native config parser `static_cast<int>`s these numbers, and casting
// NaN/Infinity to an integer is undefined behavior. Reject non-finite (and
// non-integer, where required) values on the JS side with a clear error before
// they ever reach C++.
function requireFiniteNumber (value: number, name: string, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidInput(`${name} must be a finite number, got ${value}`)
  }
  if (integer && !Number.isInteger(value)) {
    throw invalidInput(`${name} must be an integer, got ${value}`)
  }
  return value
}

function optionalFiniteNumber (
  value: number | undefined,
  name: string,
  integer = false
): number | undefined {
  return value === undefined ? undefined : requireFiniteNumber(value, name, integer)
}

const GENERATE_TASK_TYPES = new Set(['text2music', 'cover', 'cover-nofsq'])

function optionalTaskType (value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !GENERATE_TASK_TYPES.has(value)) {
    throw invalidInput('taskType must be one of text2music|cover|cover-nofsq')
  }
  return value
}

function requireFinitePcm (value: Float32Array, name: string): void {
  for (const sample of value) {
    if (!Number.isFinite(sample)) {
      throw invalidInput(`${name} must contain only finite samples`)
    }
  }
}

function optionalStereoPcm (
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

function isCoverTask (taskType: string | undefined): boolean {
  return taskType === 'cover' || taskType === 'cover-nofsq'
}

function invalidInput (message: string): QvacErrorAudioGen {
  return new QvacErrorAudioGen({ code: ERR_CODES.INVALID_INPUT, adds: message })
}

function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

  addon: AudioGenInterface | null
  private readonly _job: JobHandler
  private readonly _runExclusive: RunExclusive
  private readonly _configuration: AudioGenConfigurationParams
  private readonly _logger: QvacLogger
  private _lifecycleRevision: number
  private _destroyed: boolean
  private _cancelPromise: Promise<void> | null
  private _cancellingResponse: QvacResponse<AudiogenOutputChunk> | null

  constructor (options: AudioGenOptions = {}) {
    this._logger = new QvacLogger(options.logger)
    const files = options.files ?? {}
    const config = options.config ?? {}

    // DiT selection: an explicit `ditModel` path always wins; otherwise a
    // `ditVariant` enum picks which DiT GGUF to load from `modelDir` (the three
    // other stages are fixed, so the variant is the only real choice).
    const ditModelPath = resolveDitModelPath({
      modelDir: files.modelDir,
      ditModel: files.ditModel,
      ditVariant: files.ditVariant
    })

    // The native side carries NO defaults: it requires every numeric/bool field
    // and throws if one is missing. JS is the single place that decides defaults.
    // 0 for inferenceSteps/shift/threads means "auto"; nGpuLayers 99 = all layers
    // (only applied by the engine when useGPU is true).
    const useGpu = config.useGPU ?? false
    this._configuration = {
      engineType: ENGINE_ACESTEP,
      modelDir: files.modelDir,
      textEncModelPath: files.textEncModel,
      lmModelPath: files.lmModel,
      ditModelPath,
      vaeModelPath: files.vaeModel,
      inferenceSteps: requireFiniteNumber(config.inferenceSteps ?? 0, 'inferenceSteps', true),
      shift: requireFiniteNumber(config.shift ?? 0, 'shift'),
      useGPU: useGpu,
      nGpuLayers: requireFiniteNumber(config.nGpuLayers ?? 99, 'nGpuLayers', true),
      threads: requireFiniteNumber(config.threads ?? 0, 'threads', true),
      // Where the native engine dlopens the ggml backend modules staged next to
      // the `.bare`. Default to the package's own prebuilds dir; the C++ side
      // appends the per-target BACKENDS_SUBDIR. Required on arm64 (per-microarch
      // MODULE CPU backends); harmless on static desktop / Apple builds.
      backendsDir: config.backendsDir ?? path.join(__dirname, 'prebuilds')
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
  }

  /** Create the native engine and load every stage GGUF. Idempotent. */
  async load (): Promise<void> {
    const revision = this._lifecycleRevision
    return this._runExclusive(() => this._load(revision))
  }

  private async _load (revision: number): Promise<void> {
    if (revision !== this._lifecycleRevision || this._destroyed) {
      throw this._lifecycleError()
    }
    if (this.addon) return
    this._logger.info('audiogen-ggml: loading ACE-Step engine')
    const addon = this._createAddon(
      this._configuration,
      this._addonOutputCallback.bind(this)
    )
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
  async run (caption: string, opts: GenerateOptions = {}): Promise<QvacResponse<AudiogenOutputChunk>> {
    const jobData = this._createJobData(caption, opts)
    const revision = this._lifecycleRevision
    return new Promise((resolve, reject) => {
      const queued = this._runExclusive(() =>
        this._admitAndWait(jobData, revision, resolve, reject)
      )
      void queued.catch(reject)
    })
  }

  private async _admitAndWait (
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

  private _createJobData (caption: string, opts: GenerateOptions): AudioGenJobData {
    if (typeof caption !== 'string' || caption.trim().length === 0) {
      throw invalidInput('caption must be a non-empty string')
    }
    this._logger.debug(
      `audiogen-ggml: run (caption ${caption.length} chars, lyrics=${opts.lyrics ? 'yes' : 'no'})`
    )
    if (opts.lmPhase1 !== undefined && typeof opts.lmPhase1 !== 'boolean') {
      throw invalidInput('lmPhase1 must be a boolean')
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
    if (isCoverTask(taskType) && (sourceAudio === undefined || sourceAudio.length === 0)) {
      throw invalidInput(`taskType '${taskType}' requires sourceAudio`)
    }
    return {
      type: 'text',
      input: caption,
      lyrics: opts.lyrics ?? '[Instrumental]',
      seed: optionalFiniteNumber(opts.seed, 'seed', true),
      vocalLanguage: opts.vocalLanguage,
      bpm: optionalFiniteNumber(opts.bpm, 'bpm', true),
      keyscale: opts.keyscale,
      timesignature: opts.timesignature,
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
      audioCoverStrength: optionalFiniteNumber(opts.audioCoverStrength, 'audioCoverStrength'),
      coverNoiseStrength: optionalFiniteNumber(opts.coverNoiseStrength, 'coverNoiseStrength')
    }
  }

  async cancel (): Promise<void> {
    const response = this._job.active
    if (!response) return
    if (this._cancelPromise) return this._cancelPromise
    const cancellation = this._cancelActiveResponse(
      response as QvacResponse<AudiogenOutputChunk>
    )
    this._cancelPromise = cancellation
    const cancellationError = new QvacErrorAudioGen({ code: ERR_CODES.CANCELLED })
    try {
      await cancellation
      response.failed(cancellationError)
    } finally {
      if (this._cancelPromise === cancellation) this._cancelPromise = null
      if (this._cancellingResponse === response) this._cancellingResponse = null
    }
  }

  private async _cancelActiveResponse (
    response: QvacResponse<AudiogenOutputChunk>
  ): Promise<void> {
    this._cancellingResponse = response
    try {
      await (this.addon?.cancel() ?? Promise.resolve())
    } catch (error) {
      const failedError = this._failedCancelError(error)
      response.failed(failedError)
      throw failedError
    }
  }

  async unload (): Promise<void> {
    await this._stop(new QvacErrorAudioGen({ code: ERR_CODES.MODEL_UNLOADED }))
  }

  async destroy (): Promise<void> {
    if (this._destroyed) return
    this._destroyed = true
    await this._stop(new QvacErrorAudioGen({ code: ERR_CODES.INSTANCE_DESTROYED }))
  }

  private async _stop (settlementError: QvacErrorAudioGen): Promise<void> {
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
  static encode (pcm: Uint8Array, format?: OutputFormat, opts?: EncodeOptions): EncodedAudio
  static encode (pcm: Uint8Array, formats: OutputFormat[], opts?: EncodeOptions): EncodedAudio[]
  static encode (
    pcm: Uint8Array,
    formats?: OutputFormat | OutputFormat[],
    opts?: EncodeOptions
  ): EncodedAudio | EncodedAudio[] {
    return encodePcm(pcm, formats, opts)
  }

  static getModelKey (_params?: unknown): string {
    void _params
    return 'audiogen-ggml'
  }

  private _createAddon (
    configuration: AudioGenConfigurationParams,
    outputCallback: AudioGenOutputCallback
  ): AudioGenInterface {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved from package prebuilds.
    const binding = require('./binding') as AudioGenBinding
    return new AudioGenInterface(binding, configuration, outputCallback)
  }

  private _addonOutputCallback (
    _handle: unknown,
    _event: unknown,
    data: unknown,
    error: unknown
  ): void {
    if (this._cancellingResponse) return
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
        ...(typeof d.backendId === 'number' ? { backendId: d.backendId } : {})
      }
      this._job.end(stats, stats)
    }
  }

  private _requireAddon (): AudioGenInterface {
    if (!this.addon) throw this._lifecycleError()
    return this.addon
  }

  private _lifecycleError (): QvacErrorAudioGen {
    return new QvacErrorAudioGen({
      code: this._destroyed ? ERR_CODES.INSTANCE_DESTROYED : ERR_CODES.NOT_LOADED
    })
  }

  private _failedCancelError (error: unknown): QvacErrorAudioGen {
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

export type {
  AudioGenConfigurationParams,
  AudioGenJobData,
  AudioGenBinding,
  AudioGenOutputCallback
} from './audiogen'
