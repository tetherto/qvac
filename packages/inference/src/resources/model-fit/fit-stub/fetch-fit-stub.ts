import fs, { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import type { AbortSignal } from 'bare-abort-controller'
import type { QVACBlobBinding } from '@qvac/registry-client'

import { getCacheDir } from '@/utils/cache/paths'
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
  | { status: 'ready'; path: string; bytes: number; cached: boolean }
  | { status: 'unavailable'; reason: FitStubUnavailableReason; message?: string }

/**
 * The part of a registry blob binding this module reads. The record's own
 * binding, which carries the core coordinates as well, is what reaches the
 * download.
 */
export interface FitBlobBinding {
  sha256: string
  byteLength: number
}

export interface FitStubEntry {
  fitBlobBinding?: FitBlobBinding | undefined
}

/**
 * Injection seams. Every field defaults to the real runtime dependency; tests
 * substitute them rather than mocking modules.
 */
export interface FitStubOptions {
  signal?: AbortSignal
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
  return client.downloadBlob(binding as QVACBlobBinding, {
    outputFile,
    timeout: FIT_STUB_DOWNLOAD_TIMEOUT_MS,
    maxRetries: 1,
    ...(signal !== undefined && { signal })
  })
}

function unavailable(reason: FitStubUnavailableReason, message?: string): FitStubOutcome {
  return message === undefined
    ? { status: 'unavailable', reason }
    : { status: 'unavailable', reason, message }
}

/**
 * Fetches the fit stub for one artifact into the cache and returns its path.
 *
 * Never throws: a missing entry, an entry without a description, and a failed
 * download are all `unavailable`, because a pre-download assessment has to
 * survive an offline caller and an older registry record.
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

    // Keyed by the description's own digest, so a re-ingested artifact lands on
    // a different path instead of reading a stale stub.
    const dir = options.cacheDir ?? getCacheDir('fit-stubs')
    const dest = path.join(dir, `${binding.sha256}.gguf`)

    if (fs.existsSync(dest) && fs.statSync(dest).size === binding.byteLength) {
      return { status: 'ready', path: dest, bytes: binding.byteLength, cached: true }
    }

    await fsPromises.mkdir(dir, { recursive: true })

    // Downloaded aside and renamed, so an interrupted fetch cannot leave a
    // truncated stub that the size check above would later accept.
    const part = `${dest}.part`
    const downloadBlob = options.downloadBlob ?? defaultDownloadBlob
    try {
      await downloadBlob(binding, part, options.signal)
      const bytes = fs.statSync(part).size
      if (bytes !== binding.byteLength) {
        await fsPromises.rm(part, { force: true })
        return unavailable(
          'download-failed',
          `fit stub for ${ref.name} is ${bytes} bytes, the record says ${binding.byteLength}`
        )
      }
      await fsPromises.rename(part, dest)
      return { status: 'ready', path: dest, bytes, cached: false }
    } catch (error) {
      await fsPromises.rm(part, { force: true }).catch(() => {})
      return unavailable(
        'download-failed',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      )
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
