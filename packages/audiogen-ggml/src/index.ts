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

import { createJobHandler, type JobHandler, type QvacResponse } from '@qvac/infer-base'
// eslint-disable-next-line @typescript-eslint/no-require-imports -- @qvac/logging exposes a CommonJS export-assignment shape.
import QvacLogger = require('@qvac/logging')
// eslint-disable-next-line @typescript-eslint/no-require-imports -- bare-path is a CommonJS module.
import path = require('bare-path')

import {
  AudioGenInterface,
  type AudioGenBinding,
  type AudioGenConfigurationParams,
  type AudioGenOutputCallback
} from './audiogen'
import { resolveDitModelPath, type DitVariant } from './models'
import { encodePcm, type EncodeOptions, type EncodedAudio, type OutputFormat } from './lib/audio-format'

export const ENGINE_ACESTEP = 'acestep'

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
    throw new Error(`audiogen-ggml: ${name} must be a finite number, got ${value}`)
  }
  if (integer && !Number.isInteger(value)) {
    throw new Error(`audiogen-ggml: ${name} must be an integer, got ${value}`)
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
  private readonly _configuration: AudioGenConfigurationParams
  private readonly _logger: QvacLogger

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
  }

  /** Create the native engine and load every stage GGUF. Idempotent. */
  async load (): Promise<void> {
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
    } catch (error) {
      try {
        await addon.destroyInstance()
      } catch {
        // best-effort teardown; surface the original activation error below.
      }
      if (this.addon === addon) this.addon = null
      throw error
    }
    this._logger.info('audiogen-ggml: engine ready')
  }

  /**
   * Generate music from a text prompt. Returns a `QvacResponse` that streams
   * progress ticks + the PCM chunk and resolves (`await()`) with the run stats.
   */
  async run (caption: string, opts: GenerateOptions = {}): Promise<QvacResponse<AudiogenOutputChunk>> {
    // start() is typed QvacResponse<any>; run()'s explicit return type narrows
    // the public surface to QvacResponse<AudiogenOutputChunk>.
    this._logger.debug(
      `audiogen-ggml: run (caption ${caption.length} chars, lyrics=${opts.lyrics ? 'yes' : 'no'})`
    )
    const response = this._job.start()
    try {
      await this._requireAddon().runJob({
        type: 'text',
        input: caption,
        lyrics: opts.lyrics ?? '[Instrumental]',
        seed: optionalFiniteNumber(opts.seed, 'seed', true),
        vocalLanguage: opts.vocalLanguage,
        bpm: optionalFiniteNumber(opts.bpm, 'bpm', true),
        keyscale: opts.keyscale,
        timesignature: opts.timesignature,
        duration: optionalFiniteNumber(opts.duration, 'duration')
      })
    } catch (error) {
      this._logger.error(
        `audiogen-ggml: run failed: ${error instanceof Error ? error.message : String(error)}`
      )
      this._job.fail(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    return response
  }

  async cancel (): Promise<void> {
    await this.addon?.cancel()
  }

  async unload (): Promise<void> {
    const addon = this.addon
    this.addon = null
    if (addon) {
      await addon.destroyInstance()
      this._logger.debug('audiogen-ggml: engine unloaded')
    }
  }

  async destroy (): Promise<void> {
    await this.unload()
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
    if (typeof error === 'string' && error.length > 0) {
      this._logger.error(`audiogen-ggml: engine error: ${error}`)
      this._job.fail(new Error(error))
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
    if (!this.addon) throw new Error('AudioGen addon is not loaded (call load() first)')
    return this.addon
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

export type {
  AudioGenConfigurationParams,
  AudioGenJobData,
  AudioGenBinding,
  AudioGenOutputCallback
} from './audiogen'
