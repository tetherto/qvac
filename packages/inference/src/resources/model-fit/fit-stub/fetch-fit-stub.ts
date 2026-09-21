import fs, { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import { AbortController, type AbortSignal } from 'bare-abort-controller'
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
  /** The lookup and the fetch together did not finish within the budget. */
  | 'timed-out'

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
  /** Overall budget for the lookup and the fetch. Defaults to `FIT_STUB_BUDGET_MS`. */
  budgetMs?: number
  logger?: Logger
  getEntry?: (registryPath: string, registrySource: string) => Promise<FitStubEntry | null>
  downloadBlob?: (
    binding: FitBlobBinding,
    outputFile: string,
    signal?: AbortSignal
  ) => Promise<unknown>
}

/**
 * Bounds the registry lookup and the blob fetch together. The client's own
 * defaults — 30s per attempt, three attempts, a peer wait between them, and an
 * uncapped wait for the registry view on first use — suit a weights download.
 * Here an unreachable registry is the whole latency of the call, so it is
 * capped. Work still in flight at expiry is abandoned: the download is
 * aborted, and a lookup that cannot be cancelled settles on its own with
 * nothing waiting for it.
 */
export const FIT_STUB_BUDGET_MS = 10_000

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

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Fetches the fit stub for one artifact into its own staging directory and
 * returns its path. The stub is a per-call payload, not a cache: the caller
 * removes it once the fitter has read it, so nothing accumulates under the
 * QVAC root and no cleanup path has to know about it.
 *
 * Never throws: a missing entry, an entry without a description, a failed or
 * corrupt download and an expired budget are all `unavailable`, because a
 * pre-download assessment has to survive an offline caller and an older
 * registry record.
 *
 * Only the artifact named by `ref` is fetched. A split model's shards each
 * carry their own binding, and the fitter needs the whole set laid out under
 * llama's shard naming to read any of it — assembling that is not done here.
 */
export async function fetchFitStub(
  ref: FitStubRef,
  options: FitStubOptions = {}
): Promise<FitStubOutcome> {
  const budgetMs = options.budgetMs ?? FIT_STUB_BUDGET_MS
  const controller = new AbortController()
  const onAbort = () => controller.abort(new Error('fit stub fetch aborted by the caller'))
  options.signal?.addEventListener('abort', onAbort, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<FitStubOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('fit stub budget expired'))
      resolve(
        unavailable(
          'timed-out',
          `no fit stub for ${ref.name} from the registry within ${budgetMs}ms`
        )
      )
    }, budgetMs)
  })

  try {
    return await Promise.race([fetchWithin(ref, options, controller.signal), expiry])
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

async function fetchWithin(
  ref: FitStubRef,
  options: FitStubOptions,
  signal: AbortSignal
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
    if (signal.aborted) return unavailable('timed-out')

    // One directory per fetch, so two assessments of the same model never share
    // a file that one of them is about to remove.
    const root = options.cacheDir ?? getCacheDir('fit-stubs')
    await fsPromises.mkdir(root, { recursive: true })
    const dir = await fsPromises.mkdtemp(path.join(root, 'stub-'))
    const dest = path.join(dir, `${binding.sha256}.gguf`)

    const downloadBlob = options.downloadBlob ?? defaultDownloadBlob
    let verified = false
    try {
      await downloadBlob(binding, dest, signal)

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

      // Past the budget nobody is waiting for this result, so the stub must
      // not be marked as kept.
      if (signal.aborted) return unavailable('timed-out')

      verified = true
      return { status: 'ready', path: dest, bytes }
    } catch (error) {
      return unavailable('download-failed', describe(error))
    } finally {
      // A short, corrupt, half-written or late stub must not outlive the call.
      if (!verified) await removeStub(dest)
    }
  } catch (error) {
    logger.debug(`fit stub for ${ref.name} unavailable: ${describe(error)}`)
    return unavailable('download-failed', describe(error))
  }
}
