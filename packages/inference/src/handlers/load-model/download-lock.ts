import { promises as fsPromises } from 'bare-fs'
import path from 'bare-path'
import fsx from 'fs-native-extensions'
import type { AbortSignal } from 'bare-abort-controller'
import { generateShortHash, getModelsCacheDir, renameWithCachedChecksum } from '@/utils/index'
import { DownloadCancelledError } from '@/errors/index'
import { getEngineLogger } from '@/logging/index'

const logger = getEngineLogger()

const LOCK_DIR_NAME = '.locks'
const LOCK_POLL_MS = 250

interface LockFile extends AsyncDisposable {
  fd: number
}

const NO_WRITE_ACCESS = new Set(['EACCES', 'EPERM', 'EROFS'])

// `null` without write access to the lock directory, for example a prefilled
// read-only models directory: nothing can download there, so nothing to lock.
async function openLockFile(resourceKey: string): Promise<LockFile | null> {
  const lockDir = path.join(getModelsCacheDir(), LOCK_DIR_NAME)
  let handle: Awaited<ReturnType<typeof fsPromises.open>>
  try {
    await fsPromises.mkdir(lockDir, { recursive: true })
    // Not 'a': Windows refuses to lock a handle opened for append only.
    handle = await fsPromises.open(
      path.join(lockDir, `${generateShortHash(resourceKey)}.lock`),
      'a+'
    )
  } catch (error) {
    if (!NO_WRITE_ACCESS.has((error as { code?: string }).code ?? '')) throw error
    logger.warn(
      `⚠️ Cannot create a lock for ${resourceKey} in the models directory; continuing without cross-process coordination`,
      { error }
    )
    return null
  }
  return {
    fd: handle.fd,
    // Closing the descriptor releases its lock.
    [Symbol.asyncDispose]: () =>
      handle.close().catch((error: unknown) => {
        logger.debug('Failed to close download lock', { resourceKey, error })
      })
  }
}

// False while another holder has the lock. A filesystem without lock support
// counts as granted.
function tryLock(lock: LockFile, resourceKey: string): boolean {
  try {
    return fsx.tryLock(lock.fd)
  } catch (error) {
    logger.warn(
      `⚠️ Cannot lock ${resourceKey} in the models directory; continuing without cross-process coordination`,
      { error }
    )
    return true
  }
}

/**
 * Hold the cross-process lock for one cached resource until disposed, waiting
 * while another holder has it. The OS releases it if the holder exits.
 * Cancelling while waiting rejects with `DownloadCancelledError`.
 */
export async function acquireDownloadLock(
  resourceKey: string,
  signal: AbortSignal
): Promise<AsyncDisposable> {
  if (signal.aborted) throw new DownloadCancelledError()
  const lock = await openLockFile(resourceKey)
  if (!lock) return { [Symbol.asyncDispose]: async () => {} }
  try {
    if (!tryLock(lock, resourceKey)) {
      logger.info(`⏳ ${resourceKey} is being downloaded elsewhere; waiting for it to finish`)
      do {
        await delay(LOCK_POLL_MS, signal)
        if (signal.aborted) throw new DownloadCancelledError()
      } while (!tryLock(lock, resourceKey))
      logger.info(`📥 The other download of ${resourceKey} finished; continuing`)
    }
    return lock
  } catch (error) {
    await lock[Symbol.asyncDispose]()
    throw error
  }
}

/** Take every key's lock without waiting, or none; `null` while any is held. */
export async function tryAcquireDownloadLocks(
  resourceKeys: string[]
): Promise<AsyncDisposable | null> {
  const held: LockFile[] = []
  const releaseAll = async () => {
    for (const lock of held) await lock[Symbol.asyncDispose]()
  }
  try {
    for (const resourceKey of resourceKeys) {
      const lock = await openLockFile(resourceKey)
      if (!lock) continue
      held.push(lock)
      if (!tryLock(lock, resourceKey)) {
        await releaseAll()
        return null
      }
    }
  } catch (error) {
    await releaseAll()
    throw error
  }
  return { [Symbol.asyncDispose]: releaseAll }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Where a download is written until it is complete and verified. */
export function partialDownloadPath(finalPath: string): string {
  return `${finalPath}.part`
}

/** Atomically move a verified download into place. */
export async function publishDownload(finalPath: string): Promise<void> {
  await renameWithCachedChecksum(partialDownloadPath(finalPath), finalPath)
}
