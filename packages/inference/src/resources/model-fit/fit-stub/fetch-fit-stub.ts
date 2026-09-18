import fs, { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import type { AbortSignal } from 'bare-abort-controller'
import type { QVACBlobBinding } from '@qvac/registry-client'

import { getCacheDir } from '@/utils/cache/paths'
import { calculateFileChecksum } from '@/utils/checksum'
import { getEngineLogger } from '@/logging/index'
import type { Logger } from '@/logging/types'

/**
 * A weightless description of an artifact, served by the registry beside the
 * weights: for a GGUF, the tensor list and the settings with the tokenizer
 * tables stripped and no data section — tens of KB against gigabytes. The
 * fitter reads it exactly as it reads the artifact, so a projection can be made
 * before anything is downloaded.
 */
export interface FitStubRef {
  name: string
  sha256Checksum: string
  /** Registry coordinates. A constant that carries neither cannot be resolved. */
  registryPath?: string | undefined
  registrySource?: string | undefined
}

export type FitStubUnavailableReason =
  /** The ref carries no registry coordinates to look up. */
  | 'unresolvable-ref'
  /** The registry has no entry at those coordinates. */
  | 'not-in-registry'
  /** The entry predates fit blobs, or its description could not be built. */
  | 'no-fit-blob'
  | 'download-failed'

export type FitStubOutcome =
  /** `path` is the caller's to remove once the fitter has read it. */
  | { status: 'ready'; path: string; bytes: number }
  | { status: 'unavailable'; reason: FitStubUnavailableReason; message?: string }

export type FitBlobBinding = QVACBlobBinding

export interface FitStubEntry {
  fitBlobBinding?: FitBlobBinding | undefined
}

/**
 * Injection seams. Every field defaults to the real runtime dependency; tests
 * substitute them rather than mocking modules.
 */
export interface FitStubOptions {
  signal?: AbortSignal
  /** Where stubs are staged. Defaults to `fit-stubs` under the QVAC cache root. */
  cacheDir?: string
  logger?: Logger
  getEntry?: (registryPath: string, registrySource: string) => Promise<FitStubEntry | null>
  downloadBlob?: (
    binding: FitBlobBinding,
    outputFile: string,
    signal?: AbortSignal
  ) => Promise<unknown>
}

/**
 * Bounds one blob fetch. The client's own defaults (30s, three attempts, a
 * peer wait between them) suit a weights download; this sits on a call that
 * used to return in milliseconds, so an unreachable registry costs seconds.
 */
const FIT_STUB_DOWNLOAD_TIMEOUT_MS = 10_000

async function defaultGetEntry(
  registryPath: string,
  registrySource: string
): Promise<FitStubEntry | null> {
  const { getRegistryClient } = await import('@/runtime/registry-client')
  const client = await getRegistryClient()
  return client.getModel(registryPath, registrySource)
}

async function defaultDownloadBlob(
  binding: FitBlobBinding,
  outputFile: string,
  signal?: AbortSignal
): Promise<unknown> {
  const { getRegistryClient } = await import('@/runtime/registry-client')
  const client = await getRegistryClient()
  return client.downloadBlob(binding, {
    outputFile,
    timeout: FIT_STUB_DOWNLOAD_TIMEOUT_MS,
    maxRetries: 1,
    ...(signal !== undefined && { signal })
  })
}

/** Removes a fetched stub and the directory it was staged in. Never throws. */
export async function removeStub(stubPath: string): Promise<void> {
  await fsPromises.rm(path.dirname(stubPath), { recursive: true, force: true }).catch(() => {})
}

function unavailable(reason: FitStubUnavailableReason, message?: string): FitStubOutcome {
  return message === undefined
    ? { status: 'unavailable', reason }
    : { status: 'unavailable', reason, message }
}

/**
 * Fetches the fit stub for one artifact into its own staging directory and
 * returns its path. The stub is a per-call payload, not a cache: the caller
 * removes it once the fitter has read it, so nothing accumulates under the
 * QVAC root and no cleanup path has to know about it.
 *
 * Never throws: a missing entry, an entry without a description, and a failed
 * or corrupt download are all `unavailable`, because a pre-download assessment
 * has to survive an offline caller and an older registry record.
 *
 * Only the artifact named by `ref` is fetched. A split model's shards each
 * carry their own binding, and the fitter needs the whole set laid out under
 * llama's shard naming to read any of it — assembling that is not done here.
 */
export async function fetchFitStub(
  ref: FitStubRef,
  options: FitStubOptions = {}
): Promise<FitStubOutcome> {
  const logger = options.logger ?? getEngineLogger()

  try {
    const { registryPath, registrySource } = ref
    if (!registryPath || !registrySource) return unavailable('unresolvable-ref')

    const getEntry = options.getEntry ?? defaultGetEntry
    const entry = await getEntry(registryPath, registrySource)
    if (entry === null || entry === undefined) return unavailable('not-in-registry')

    const binding = entry.fitBlobBinding
    if (binding === undefined || binding === null) return unavailable('no-fit-blob')

    // One directory per fetch, so two assessments of the same model never share
    // a file that one of them is about to remove.
    const root = options.cacheDir ?? getCacheDir('fit-stubs')
    await fsPromises.mkdir(root, { recursive: true })
    const dir = await fsPromises.mkdtemp(path.join(root, 'stub-'))
    const dest = path.join(dir, `${binding.sha256}.gguf`)

    const downloadBlob = options.downloadBlob ?? defaultDownloadBlob
    let verified = false
    try {
      await downloadBlob(binding, dest, options.signal)

      const bytes = fs.statSync(dest).size
      if (bytes !== binding.byteLength) {
        return unavailable(
          'download-failed',
          `fit stub for ${ref.name} is ${bytes} bytes, the record says ${binding.byteLength}`
        )
      }

      // The record binds the description by digest; a stub that reads back
      // differently is not the description the fitter should answer for.
      const digest = await calculateFileChecksum(dest)
      if (digest.toLowerCase() !== binding.sha256.toLowerCase()) {
        return unavailable(
          'download-failed',
          `fit stub for ${ref.name} hashes to ${digest}, the record says ${binding.sha256}`
        )
      }

      verified = true
      return { status: 'ready', path: dest, bytes }
    } catch (error) {
      return unavailable(
        'download-failed',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      )
    } finally {
      // A short, corrupt or half-written stub must not outlive the call.
      if (!verified) await removeStub(dest)
    }
  } catch (error) {
    logger.debug(
      `fit stub for ${ref.name} unavailable: ${error instanceof Error ? error.message : String(error)}`
    )
    return unavailable(
      'download-failed',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    )
  }
}
