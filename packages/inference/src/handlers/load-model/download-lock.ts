import fs, { promises as fsPromises } from 'bare-fs'
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

// The OS grants a lock per open handle, so this process's own holders also make
// `tryAcquireDownloadLocks` fail. Tracking them tells them apart from other
// processes. Each entry settles once its lock is released.
const heldHere = new Map<string, Set<Promise<void>>>()

function trackHeldHere(resourceKey: string, lock: LockFile): LockFile {
  let markReleased!: () => void
  const released = new Promise<void>((resolve) => {
    markReleased = resolve
  })
  const holders = heldHere.get(resourceKey) ?? new Set<Promise<void>>()
  holders.add(released)
  heldHere.set(resourceKey, holders)
  return {
    fd: lock.fd,
    [Symbol.asyncDispose]: async () => {
      await lock[Symbol.asyncDispose]()
      holders.delete(released)
      if (holders.size === 0 && heldHere.get(resourceKey) === holders) heldHere.delete(resourceKey)
      markReleased()
    }
  }
}

/** Whether this process holds the lock of any of these keys. */
export function holdsDownloadLockHere(resourceKeys: string[]): boolean {
  return resourceKeys.some((key) => heldHere.has(key))
}

/**
 * Wait until this process holds none of these keys' locks, such as a cancelled
 * download still cleaning up. False if one is still held after `timeoutMs`.
 */
export async function waitForDownloadLocksHere(
  resourceKeys: string[],
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pending = resourceKeys.flatMap((key) => [...(heldHere.get(key) ?? [])])
    if (pending.length === 0) return true
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      Promise.all(pending).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), remaining)
      })
    ])
    clearTimeout(timer)
    if (timedOut) return false
  }
}

// `null` when this process can change nothing in the models directory, such as
// a prefilled read-only cache: it can then only load cached models. Anywhere it
// could write, a lock that cannot be created fails instead of running unlocked.
async function openLockFile(resourceKey: string): Promise<LockFile | null> {
  const modelsDir = getModelsCacheDir()
  const lockDir = path.join(modelsDir, LOCK_DIR_NAME)
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
    if (await canChangeModels(modelsDir)) {
      logger.error(`❌ Cannot lock ${resourceKey}: its lock file in ${lockDir} is not writable`, {
        error
      })
      throw error
    }
    logger.warn(`⚠️ The models directory is read-only; reading ${resourceKey} without a lock`, {
      error
    })
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

// Downloads and deletes only add, rename or remove directory entries and write
// `.part` files, so a process can change a model only through a writable folder
// or `.part` file anywhere under `dir`. Lock files cannot change a model. A link
// counts if its target is writable; it is not entered, so cycles cannot loop.
async function canChangeModels(dir: string, isRoot = true): Promise<boolean> {
  if (await hasAccess(dir, fs.constants.W_OK)) return true
  let entries: Array<{ name: string; isDirectory(): boolean; isSymbolicLink(): boolean }>
  try {
    entries = (await fsPromises.readdir(dir, { withFileTypes: true })) as unknown as typeof entries
  } catch {
    // An unlistable folder's entries are out of reach only if it cannot be searched.
    return hasAccess(dir, fs.constants.X_OK)
  }
  for (const entry of entries) {
    if (isRoot && entry.name === LOCK_DIR_NAME) continue
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (await canChangeModels(entryPath, false)) return true
    } else if (entry.isSymbolicLink() || entry.name.endsWith('.part')) {
      if (await hasAccess(entryPath, fs.constants.W_OK)) return true
    }
  }
  return false
}

function hasAccess(target: string, mode: number): Promise<boolean> {
  return fsPromises.access(target, mode).then(
    () => true,
    () => false
  )
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
    return trackHeldHere(resourceKey, lock)
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
      if (!tryLock(lock, resourceKey)) {
        await lock[Symbol.asyncDispose]()
        await releaseAll()
        return null
      }
      held.push(trackHeldHere(resourceKey, lock))
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
