import path from 'bare-path'

/** Where the CMake build stages the per-arch backends, as `index.ts` resolves it. */
const PREBUILDS_DIR = path.join(__dirname, '..', 'prebuilds')

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
  /** Where the dynamically-loaded ggml backends live. */
  backendsDir?: string
}

export type BciFitStatus = 'fits' | 'does-not-fit' | 'error'

export interface BciFitResult {
  status: BciFitStatus
  /** Whisper's own wording, e.g. `model-unreadable`, `no-backend-device`, or `embedder-unreadable`. */
  reason: string
  /** `tiny` | `base` | ... | `large v3`. */
  modelType: string
  deviceName: string
  deviceIsCpu: boolean
  /** The device pool is system RAM, so host bytes compete with device bytes. */
  deviceSharesHostMemory: boolean
  deviceFreeBytes: number
  deviceTotalBytes: number
  deviceBytes: number
  weightsBytes: number
  kvBytes: number
  computeBytes: number
  /** Device-component bytes the runtime places in host RAM instead. */
  hostOverflowBytes: number
  /** Host RAM the load needs beside the device projection, the embedder included. */
  hostBytes: number
  /**
   * Host RAM the embedder keeps: its day and month projections, its session
   * map and the dense projection it caches per day, 0 when it could not be
   * read. Counted in `hostBytes`.
   */
  embedderBytes: number
  report: string
}

interface FitBinding {
  assessFit(request: BciFitRequest): BciFitResult
}

/**
 * Projects a BCI load against the memory free right now, reading model
 * metadata and never weight data.
 *
 * Covers the whisper model and the embedder, from the files or from the
 * registry's weightless descriptions of them. A model or embedder the fitter
 * cannot read comes back as `status: "error"`; a broken request, or a host
 * with no native binding, throws.
 *
 * The backend directory defaults to the one a real load uses. The native side
 * registers backends once per process, so a fit that let it fall back to the
 * default search path would fix that path for every later load too.
 */
export function assessFit(request: BciFitRequest): BciFitResult {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
  const binding = require('../binding.js') as FitBinding

  return binding.assessFit({
    ...request,
    backendsDir:
      typeof request.backendsDir === 'string' && request.backendsDir.length > 0
        ? request.backendsDir
        : PREBUILDS_DIR
  })
}
