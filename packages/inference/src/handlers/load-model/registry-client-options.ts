import type { AbortSignal } from 'bare-abort-controller'
import type { QvacConfig } from '@/schemas/index'

export const DEFAULT_REGISTRY_STREAM_TIMEOUT_MS = 60_000

export interface RegistryClientDownloadOptions {
  timeout: number
  outputFile: string
  maxRetries?: number
  onProgress?: (progress: { downloaded: number; total: number }) => void
  signal?: AbortSignal
  clearBlocksOnCancel?: () => boolean
}

/**
 * Build the options passed to @qvac/registry-client download methods from the
 * current QVAC config. Pure helper (no bare-* imports) so the mapping can be
 * unit-tested without standing up a real registry client.
 */
export function buildRegistryClientOptions(params: {
  config: Pick<QvacConfig, 'registryStreamTimeoutMs' | 'registryDownloadMaxRetries'>
  outputFile: string
  onProgress?: ((progress: { downloaded: number; total: number }) => void) | undefined
  signal?: AbortSignal | undefined
  shouldClearCache?: (() => boolean) | undefined
}): RegistryClientDownloadOptions {
  const { config, outputFile, onProgress, signal, shouldClearCache } = params
  const timeout = config.registryStreamTimeoutMs ?? DEFAULT_REGISTRY_STREAM_TIMEOUT_MS
  const maxRetries = config.registryDownloadMaxRetries

  return {
    timeout,
    outputFile,
    ...(maxRetries !== undefined && { maxRetries }),
    ...(onProgress && { onProgress }),
    ...(signal && { signal: signal }),
    // Without it the client clears a cancelled download's blocks, so a pause could not resume.
    ...(shouldClearCache && { clearBlocksOnCancel: shouldClearCache })
  }
}
