import type { AbortSignal } from 'bare-abort-controller'
import { generateShortHash, renameWithCachedChecksum } from '@/utils/index'
import { DownloadCancelledError } from '@/errors/index'
import { browser } from './globals'

interface HeldLock extends AsyncDisposable {
  readonly released: Promise<void>
}

const heldHere = new Map<string, Set<Promise<void>>>()

function lockName(resourceKey: string): string {
  return `qvac-download-${generateShortHash(resourceKey)}`
}

function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DownloadCancelledError()
}

async function requestLock(
  resourceKey: string,
  ifAvailable: boolean,
  signal?: AbortSignal
): Promise<HeldLock | null> {
  cancelled(signal)
  const locks = browser.navigator.locks
  if (!locks) {
    throw new Error('The Web Locks API is required for browser model-cache access')
  }

  let release!: () => void
  let resolveAcquired!: (lock: HeldLock | null) => void
  let rejectAcquired!: (error: unknown) => void
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const acquired = new Promise<HeldLock | null>((resolve, reject) => {
    resolveAcquired = resolve
    rejectAcquired = reject
  })

  const request = locks.request(
    lockName(resourceKey),
    { ifAvailable, ...(signal && { signal: signal as never }) },
    (lock) => {
      if (!lock) {
        resolveAcquired(null)
        return undefined
      }
      const handle: HeldLock = {
        released,
        [Symbol.asyncDispose]: async () => release()
      }
      resolveAcquired(handle)
      return released
    }
  )
  void request.catch((error: unknown) => {
    rejectAcquired(signal?.aborted ? new DownloadCancelledError() : error)
  })
  return acquired
}

function trackHeldHere(resourceKey: string, lock: HeldLock): AsyncDisposable {
  const holders = heldHere.get(resourceKey) ?? new Set<Promise<void>>()
  holders.add(lock.released)
  heldHere.set(resourceKey, holders)
  return {
    [Symbol.asyncDispose]: async () => {
      await lock[Symbol.asyncDispose]()
      holders.delete(lock.released)
      if (holders.size === 0 && heldHere.get(resourceKey) === holders) {
        heldHere.delete(resourceKey)
      }
    }
  }
}

export function holdsDownloadLockHere(resourceKeys: string[]): boolean {
  return resourceKeys.some((key) => heldHere.has(key))
}

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

export async function acquireDownloadLock(
  resourceKey: string,
  signal: AbortSignal
): Promise<AsyncDisposable> {
  const lock = await requestLock(resourceKey, false, signal)
  if (!lock) throw new Error(`Unable to acquire browser download lock for ${resourceKey}`)
  return trackHeldHere(resourceKey, lock)
}

export async function tryAcquireDownloadLocks(
  resourceKeys: string[]
): Promise<AsyncDisposable | null> {
  const held: AsyncDisposable[] = []
  const releaseAll = async () => {
    for (const lock of held.reverse()) await lock[Symbol.asyncDispose]()
  }
  try {
    for (const resourceKey of resourceKeys) {
      const lock = await requestLock(resourceKey, true)
      if (!lock) {
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

export function partialDownloadPath(finalPath: string): string {
  return `${finalPath}.part`
}

export async function publishDownload(finalPath: string): Promise<void> {
  await renameWithCachedChecksum(partialDownloadPath(finalPath), finalPath)
}
