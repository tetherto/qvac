import { mossTranscribeBackend, mossTranscribeJobFields, type MossTranscribeRunOptions } from '../engines/moss/driver'
import { validateParakeetBackend } from '../engines/parakeet/options'

interface AsrFitCommon {
  /** Absolute path to the model, or to a weightless copy where one exists. */
  modelPath: string
  /** Longest single transcribe the projection must cover. Defaults to 300. */
  audioSeconds?: number
  /** > 0 requests the GPU stack, with the fallbacks a real load applies. */
  gpuLayers?: number
  /** Free memory that must remain for the projection to count as fitting. */
  marginBytes?: number
  backendsDir?: string
}

export interface ParakeetFitRequest extends AsrFitCommon {
  engine?: 'parakeet'
  /** Native selector, matching parakeetConfig.backend; overrides gpuLayers. */
  backend?: string
  threads?: number
  longFormWindowFrames?: number
  longFormContextFrames?: number
  /**
   * Nemotron only: the streaming operating point whose live session the
   * projection must also cover. 0 projects the largest allowed one.
   */
  nemotronChunkMs?: number
}

export interface WhisperFitRequest extends AsrFitCommon {
  engine: 'whisper'
  /** Projected alongside the model; omitted means no VAD. */
  vadModelPath?: string
  flashAttn?: boolean
  gpuDevice?: number
  /**
   * Worst-case resident decoders, the `best_of` or `beam_size` the run will
   * use. The KV cache and decode graph grow with it.
   */
  decoders?: number
}

export interface MossTranscribeFitRequest extends AsrFitCommon, MossTranscribeRunOptions {
  engine: 'moss-transcribe'
  /** Same selector as mossTranscribeConfig.backend; overrides gpuLayers. */
  backend?: string
  audioSeconds: number
  threads?: number
}

export type AsrFitRequest = ParakeetFitRequest | WhisperFitRequest | MossTranscribeFitRequest

/** `unknown` is a load the fitter cannot size, such as one whose memory it cannot measure. */
export type AsrFitStatus = 'fits' | 'does-not-fit' | 'unknown'

export interface AsrFitDevice {
  /** The PCI bus ID when the backend reports one, the device name otherwise. */
  id: string
  name: string
  /** Memory the host owns: the host CPU, and a GPU that shares the host's memory. */
  unified: boolean
  /** Memory the load takes on this device. */
  usedBytes: number
  freeBytes: number
  totalBytes: number
}

export type AsrFitStats = Record<string, never>

export interface AsrFitResult {
  status: AsrFitStatus
  /**
   * The device the load resolves to, then the host CPU. One CPU row for a load
   * on the CPU. Empty when `unknown`.
   */
  devices: AsrFitDevice[]
  stats: AsrFitStats
}

interface FitBinding {
  assessFit(request: AsrFitRequest): Promise<AsrFitResult>
}

/**
 * Projects one model against the memory free right now, reading model metadata
 * and never weight data. Parakeet is GGUF, so the registry's weightless copy of
 * a parakeet model answers the same as the model itself. Whisper ships as
 * `.bin`, which the registry has no weightless form for.
 *
 * MOSS-Transcribe requires `audioSeconds`; `prompt`, `hotwords`, and
 * `maxNewTokens` use the transcription rules and model defaults. Its
 * projection includes the chunked encoder, prefill/decode, and KV cache.
 *
 * `engine` picks the fitter and defaults to parakeet. With `gpuLayers`
 * omitted, parakeet projects on the CPU and whisper on the GPU, matching what
 * each load does. `marginBytes` defaults to the engine's own headroom, which
 * is 256 MiB for parakeet.
 *
 * A model the fitter cannot read, or an invalid request, rejects.
 *
 * Concurrent calls run one at a time.
 */
export async function assessFit(request: AsrFitRequest): Promise<AsrFitResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the native binding loads on first use.
  const binding = require('../binding.js') as FitBinding

  if (request.engine === 'moss-transcribe') {
    mossTranscribeBackend(request.backend)
    mossTranscribeJobFields({
      prompt: request.prompt,
      hotwords: request.hotwords,
      maxNewTokens: request.maxNewTokens
    })
  } else if (request.engine === 'parakeet' || request.engine === undefined) {
    validateParakeetBackend(request.backend)
  }

  return await binding.assessFit(request)
}
