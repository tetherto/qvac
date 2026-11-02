export interface BciFitRequest {
  /** Absolute path to the BCI model, or to the registry's weightless description of it. */
  modelPath: string
  /**
   * The embedder, or its weightless description. Its host memory is part of
   * the projection. Omitted, `bci-embedder.bin` next to `modelPath` is read,
   * as a load reads it.
   */
  embedderPath?: string
  /** Longest single transcribe the projection must cover. */
  audioSeconds?: number
  /** > 0 requests the GPU stack, with the fallbacks a real load applies. */
  gpuLayers?: number
  gpuDevice?: number
  /**
   * Worst-case resident decoders, the `best_of` or `beam_size` the run will
   * use. The KV cache and decode graph grow with it.
   */
  decoders?: number
  /** Free memory that must remain for the projection to count as fitting. */
  marginBytes?: number
  /** Directory scanned, as given, for the dynamically-loaded ggml backends. */
  backendsDir?: string
}

/** `unknown` is a load the fitter cannot size, such as one whose memory it cannot measure. */
export type BciFitStatus = 'fits' | 'does-not-fit' | 'unknown'

export interface BciFitDevice {
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

export type BciFitStats = Record<string, never>

export interface BciFitResult {
  status: BciFitStatus
  /**
   * The device the load resolves to, then the host CPU, whose row includes the
   * embedder. One CPU row for a load on the CPU. Empty when `unknown`.
   */
  devices: BciFitDevice[]
  stats: BciFitStats
}

interface FitBinding {
  assessFit(request: BciFitRequest): Promise<BciFitResult>
}

/**
 * Projects a BCI load against the memory free right now, reading model
 * metadata and never weight data.
 *
 * Covers the whisper model and the embedder, from the files or from the
 * registry's weightless descriptions of them. A model or embedder the fitter
 * cannot read, a broken request, or a host with no native binding rejects.
 * Concurrent calls run one at a time.
 *
 * Unset, the backend directory is the one a real load uses, next to the loaded
 * module. The native side registers backends once per process, so the
 * directory a fit scans is the one every later load gets too.
 */
export async function assessFit(request: BciFitRequest): Promise<BciFitResult> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the native binding loads on first use.
  const binding = require('../binding.js') as FitBinding

  return await binding.assessFit(request)
}
