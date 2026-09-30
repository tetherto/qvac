/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
import path = require('bare-path')
/* eslint-enable @typescript-eslint/no-require-imports */

import type { DiffusionFiles, SdConfig } from './index'
import type { DiffusionVideoFiles } from './file-paths'
import { assertFilePaths, toFilePaths } from './file-paths'

export interface DiffusionFitWorkload {
  /** Token count drives the text-encoder memory; a default stands in when absent. */
  prompt?: string
  width?: number
  height?: number
  /** <= 1 projects image generation. */
  videoFrames?: number
  /** Tiled decoding trades speed for a much smaller VAE arena. */
  vaeTiling?: boolean
  vaeTileSizeX?: number
  vaeTileSizeY?: number
  vaeTileOverlap?: number
}

export interface DiffusionFitRequest {
  files: DiffusionFiles & DiffusionVideoFiles
  config?: SdConfig
  workload?: DiffusionFitWorkload
}

export type DiffusionFitStatus = 'fits' | 'does-not-fit' | 'error'

export type DiffusionFitReason =
  | 'fits'
  | 'does-not-fit'
  | 'model-unreadable'
  | 'unsupported-config'

export interface DiffusionFitResult {
  status: DiffusionFitStatus
  reason: DiffusionFitReason
  /**
   * The engine placed the load only by altering the backend assignment. The
   * configuration as given does not fit, so `status` is already `does-not-fit`.
   */
  changed: boolean
  vaeTiling: boolean
  streamLayers: boolean
  backend: string
  paramsBackend: string
  /** Per-device, per-module memory table, suitable for logging. */
  report: string
}

interface FitBinding {
  assessFit(request: Record<string, unknown>): DiffusionFitResult
}

/**
 * Projects a load against the memory free right now, reading model metadata
 * and never weight data. A GGUF file set can be a weightless registry copy,
 * so the projection can run before anything is downloaded; a safetensors file
 * still needs its tensor data present.
 *
 * A model the engine cannot read is `status: "error"`; only a broken request
 * throws.
 */
export function assessFit(request: DiffusionFitRequest): DiffusionFitResult {
  assertFilePaths(request.files)

  // eslint-disable-next-line @typescript-eslint/no-require-imports -- native binding is resolved lazily from package prebuilds.
  const binding = require('./binding.js') as Partial<FitBinding>
  if (typeof binding.assessFit !== 'function') {
    throw new Error('the diffusion-cpp prebuild does not expose assessFit')
  }

  // The native side reads the config sub-object as a string map, the same way
  // createInstance does.
  const merged = { ...request.config }
  if (!merged.backendsDir) {
    merged.backendsDir = path.join(__dirname, 'prebuilds')
  }
  const config = Object.fromEntries(
    Object.entries(merged)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)])
  )

  return binding.assessFit({
    ...toFilePaths(request.files),
    config,
    request: request.workload ?? {}
  })
}
