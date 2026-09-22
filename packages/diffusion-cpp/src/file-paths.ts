/* eslint-disable @typescript-eslint/no-require-imports -- bare-path exposes a CommonJS export shape. */
import path = require('bare-path')
/* eslint-enable @typescript-eslint/no-require-imports */

import type { DiffusionFiles } from './index'

const COMPANION_FILE_KEYS = [
  'clipL',
  'clipG',
  't5Xxl',
  'llm',
  'vae',
  'esrgan',
  'highNoiseDiffusionModel',
  'uncondModel'
] as const

function assertAbsolute(key: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`files.${key} must be an absolute path string`)
  }
  if (!path.isAbsolute(value)) {
    throw new TypeError(`files.${key} must be an absolute path (got: ${value})`)
  }
}

/**
 * Rejects a file set the engine could only report as an opaque error. Shared
 * so a fit refuses the same paths a load refuses.
 */
export function assertFilePaths(files: DiffusionFiles): void {
  assertAbsolute('model', files.model)
  for (const key of COMPANION_FILE_KEYS) {
    if (files[key] !== undefined) {
      assertAbsolute(key, files[key])
    }
  }
}

/** The file-path half of `SdConfigurationParams`, without `config`. */
export interface DiffusionFilePaths {
  path: string
  diffusionModelPath: string
  highNoiseDiffusionModelPath: string
  uncondDiffusionModelPath: string
  clipLPath: string
  clipGPath: string
  t5XxlPath: string
  llmPath: string
  vaePath: string
  clipVisionPath: string
  esrganPath: string
  audioVaePath: string
  embeddingsConnectorsPath: string
}

/**
 * Maps a file set onto the keys the engine reads. A split layout carries the
 * diffusion weights under their own key and leaves `path` empty, which is how
 * the engine tells the two layouts apart.
 *
 * Shared so a load and a fit of the same files always describe them the same
 * way.
 */
export function toFilePaths(
  files: DiffusionFiles & { clipVision?: string }
): DiffusionFilePaths {
  const isSplitLayout = !!files.llm || !!files.t5Xxl || !!files.clipL || !!files.clipG

  return {
    path: isSplitLayout ? '' : files.model,
    diffusionModelPath: isSplitLayout ? files.model : '',
    highNoiseDiffusionModelPath: files.highNoiseDiffusionModel || '',
    uncondDiffusionModelPath: files.uncondModel || '',
    clipLPath: files.clipL || '',
    clipGPath: files.clipG || '',
    t5XxlPath: files.t5Xxl || '',
    llmPath: files.llm || '',
    vaePath: files.vae || '',
    clipVisionPath: files.clipVision || '',
    esrganPath: files.esrgan || '',
    audioVaePath: '',
    embeddingsConnectorsPath: ''
  }
}
