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

async function openLockFile(resourceKey: string): Promise<LockFile> {
  const lockDir = path.join(getModelsCacheDir(), LOCK_DIR_NAME)
  await fsPromises.mkdir(lockDir, { recursive: true })
  // Not 'a': Windows refuses to lock a handle opened for append only.
  const handle = await fsPromises.open(
    path.join(lockDir, `${generateShortHash(resourceKey)}.lock`),
    'a+'
  )
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
// counts as granted, so work there proceeds without cross-process coordination.
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
 * Hold the cross-process lock for one cached download until disposed.
 *
 * Processes that share a models directory (an app, `qvac sdk serve`, a TUI)
 * each run their own download manager, which only joins downloads inside one
 * process. Each download therefore also holds an OS file lock named after the
 * cache resource it writes. A second holder waits here, then finds the finished
 * file through its normal cache check. The OS releases the lock when the holder
 * exits, so a crashed process never leaves a stale lock.
 *
 * Cancelling while waiting rejects with `DownloadCancelledError` and touches no
 * download files.
 */
export async function acquireDownloadLock(
  resourceKey: string,
  signal: AbortSignal
): Promise<AsyncDisposable> {
  if (signal.aborted) throw new DownloadCancelledError()
  const lock = await openLockFile(resourceKey)
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

/**
 * Take the download locks for every key without waiting, or none of them.
 * Returns `null` while any of them is held, for example by a download in
 * another process.
 */
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

/**
 * Where a download is written until it is complete and verified. Nothing reads
 * this path as a cached model, so an interrupted or in-progress download is
 * never mistaken for a finished one.
 */
export function partialDownloadPath(finalPath: string): string {
  return `${finalPath}.part`
}

/**
 * Move a complete, verified download into place. The rename is atomic within
 * the models directory, so other processes see either no file or the whole file.
 */
export async function publishDownload(finalPath: string): Promise<void> {
  await renameWithCachedChecksum(partialDownloadPath(finalPath), finalPath)
}
