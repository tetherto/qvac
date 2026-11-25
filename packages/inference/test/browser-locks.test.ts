import test from 'brittle'
import AbortController from 'bare-abort-controller'
import {
  acquireDownloadLock,
  holdsDownloadLockHere,
  tryAcquireDownloadLocks,
  waitForDownloadLocksHere
} from '@/browser/download-lock'
import { acquireCacheLock, releaseCacheLock } from '@/browser/cache-lock'
import { DownloadCancelledError } from '@/errors/index'

type Callback = (lock: { name: string } | null) => Promise<void> | undefined
type Signal = InstanceType<typeof AbortController>['signal']
type Pending = {
  name: string
  callback: Callback
  resolve: () => void
  reject: (error: Error) => void
  signal: Signal | undefined
}

class FakeLockManager {
  private readonly held = new Set<string>()
  private readonly pending: Pending[] = []

  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: Signal },
    callback: Callback
  ): Promise<void> {
    if (options.ifAvailable && this.held.has(name)) {
      return Promise.resolve(callback(null)).then(() => {})
    }
    return new Promise<void>((resolve, reject) => {
      const pending: Pending = { name, callback, resolve, reject, signal: options.signal }
      if (options.signal?.aborted) {
        reject(new Error('AbortError'))
        return
      }
      const abort = () => {
        const index = this.pending.indexOf(pending)
        if (index >= 0) this.pending.splice(index, 1)
        reject(new Error('AbortError'))
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      this.pending.push(pending)
      this.grant()
    })
  }

  private grant(): void {
    const index = this.pending.findIndex((pending) => !this.held.has(pending.name))
    if (index < 0) return
    const pending = this.pending.splice(index, 1)[0]!
    if (pending.signal?.aborted) {
      pending.reject(new Error('AbortError'))
      this.grant()
      return
    }
    this.held.add(pending.name)
    Promise.resolve(pending.callback({ name: pending.name })).then(
      () => {
        this.held.delete(pending.name)
        pending.resolve()
        this.grant()
      },
      (error: Error) => {
        this.held.delete(pending.name)
        pending.reject(error)
        this.grant()
      }
    )
  }
}

const locks = new FakeLockManager()
const testGlobal = globalThis as { navigator?: { locks?: object; storage?: object } }
const testNavigator = (testGlobal.navigator ??= {})
testNavigator.locks = locks

test('browser download locks serialize, cancel, and release in one process', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const key = `model-${iteration}`
    const first = await acquireDownloadLock(key, new AbortController().signal)
    t.ok(holdsDownloadLockHere([key]))
    t.is(await tryAcquireDownloadLocks([key]), null)

    const controller = new AbortController()
    const waiting = acquireDownloadLock(key, controller.signal)
    controller.abort(new Error('cancelled'))
    let error: unknown
    try {
      await waiting
    } catch (caught) {
      error = caught
    }
    t.ok(error instanceof DownloadCancelledError)
    t.absent(await waitForDownloadLocksHere([key], 0))

    await first[Symbol.asyncDispose]()
    t.ok(await waitForDownloadLocksHere([key], 20))
    const reacquired = await tryAcquireDownloadLocks([key])
    t.ok(reacquired)
    await reacquired![Symbol.asyncDispose]()
    t.absent(holdsDownloadLockHere([key]))
  }
})

test('a cache-lock release before grant cannot retain the stale grant', async (t) => {
  let firstCallback: Callback | undefined
  let secondCallback: Callback | undefined
  let calls = 0
  const delayedLocks = {
    request(_name: string, _options: { ifAvailable?: boolean }, callback: Callback) {
      calls++
      if (calls === 1) firstCallback = callback
      else secondCallback = callback
      return Promise.resolve()
    }
  }
  testNavigator.locks = delayedLocks

  acquireCacheLock()
  releaseCacheLock()
  acquireCacheLock()

  t.is(firstCallback!({ name: 'qvac-cache' }), undefined, 'the stale grant is discarded')
  const held = secondCallback!({ name: 'qvac-cache' })
  t.ok(held instanceof Promise, 'the current grant stays held')
  releaseCacheLock()
  await held
})

test('a rejected cache-lock request returns to idle and can be retried', async (t) => {
  let calls = 0
  testNavigator.locks = {
    request(_name: string, _options: { ifAvailable?: boolean }, callback: Callback) {
      calls++
      return calls === 1
        ? Promise.reject(new Error('SecurityError'))
        : Promise.resolve(callback(null)).then(() => {})
    }
  }

  acquireCacheLock()
  await Promise.resolve()
  await Promise.resolve()
  acquireCacheLock()
  await Promise.resolve()
  t.is(calls, 2, 'a failed request does not leave the cache lock stuck as requested')
  releaseCacheLock()
})
