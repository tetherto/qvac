// Browser replacement for runtime/cache-lock.ts. The native lock is advisory:
// it warns when another live process holds the cache. Here the holder is
// another tab or worker of the same origin, detected with the Web Locks API.
import { getEngineLogger } from '@/logging/index'
import { browser } from './globals'

const logger = getEngineLogger()

const LOCK_NAME = 'qvac-cache'

// The lock is granted asynchronously, so a release can arrive first.
let state: 'idle' | 'requested' | 'held' = 'idle'
let release: (() => void) | null = null
let generation = 0

export function acquireCacheLock(): void {
  const locks = browser.navigator.locks
  if (state !== 'idle' || !locks) return
  const requestGeneration = ++generation
  state = 'requested'
  void locks
    .request(LOCK_NAME, { ifAvailable: true }, (lock) => {
      if (state !== 'requested' || requestGeneration !== generation) return undefined
      if (!lock) {
        state = 'idle'
        logger.warn('Another tab or worker of this origin is using the model cache')
        return undefined
      }
      state = 'held'
      logger.debug('Cache lock acquired')
      return new Promise<void>((resolve) => {
        release = resolve
      })
    })
    .catch((error: unknown) => {
      if (state !== 'requested' || requestGeneration !== generation) return
      state = 'idle'
      logger.warn(`Unable to acquire the browser model-cache lock: ${String(error)}`)
    })
}

export function releaseCacheLock(): void {
  generation++
  if (state === 'held' && release) {
    release()
    logger.debug('Cache lock released')
  }
  release = null
  state = 'idle'
}
