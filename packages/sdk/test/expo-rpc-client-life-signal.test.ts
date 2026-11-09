import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'

class FakeWorklet extends Duplex {
  override _read() {}

  override _write(_chunk: unknown, _encoding: string, callback: () => void) {
    callback()
  }

  /** The worker stops and reports its exit, as bare-stow-runtime does once stop() has run. */
  exit(code: number) {
    this.emit('exit', code)
    this.destroy()
  }

  async terminate() {
    await terminateGate
    this.exit(0)
    return 0
  }
}

let terminateGate: Promise<void> = Promise.resolve()

const started: FakeWorklet[] = []

;(globalThis as { require?: (id: string) => unknown }).require = (id: string) => {
  if (id !== '@qvac/sdk/worker.mobile') throw new Error(`unexpected require: ${id}`)
  return {
    default: {
      async start() {
        const ipc = new FakeWorklet()
        started.push(ipc)
        return { ipc }
      }
    }
  }
}

let initializeGate: Promise<void> = Promise.resolve()
let initializeCalls = 0

mock.module('@/client/init-hooks', {
  namedExports: {
    initializeConfig: async () => {
      initializeCalls++
      await initializeGate
    }
  }
})
mock.module('@/client/config-loader/resolve-config.expo', {
  namedExports: { resolveConfig: async () => undefined }
})
mock.module('@/client/rpc/expo-device-info', {
  namedExports: { getDeviceInfo: async () => ({ platform: 'android' }) }
})
mock.module('@/client/rpc/expo-home-dir', {
  namedExports: { getHomeDir: async () => '/documents' }
})

const { close, getRPC, getWorkerLifeSignal } = await import('@/client/rpc/expo-rpc-client')

/** Starts a worklet and holds `initializeConfig` open until the returned controls settle it. */
async function startHeld() {
  let release = () => {}
  let fail: (error: Error) => void = () => {}
  initializeGate = new Promise((resolve, reject) => {
    release = resolve
    fail = reject
  })
  const calls = initializeCalls
  const starting = getRPC()
  while (initializeCalls === calls) await new Promise((resolve) => setImmediate(resolve))
  initializeGate = Promise.resolve()
  return { starting, release, fail }
}

const CHANNEL_CLOSED = new Error('channel closed')

test('a worklet that exits unexpectedly aborts the life signal and the next call starts a new one', async () => {
  await getRPC()
  const signal = getWorkerLifeSignal()
  assert.ok(signal)
  assert.equal(signal.aborted, false)

  started[0]!.exit(1)
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(signal.aborted, true)
  assert.equal((signal.reason as { name?: string }).name, 'WORKER_CRASHED')
  assert.equal(getWorkerLifeSignal(), null)

  await getRPC()
  assert.equal(started.length, 2)
  await close()
})

test('calls made while close runs share one new worklet', async () => {
  await getRPC()
  const before = started.length

  const closing = close()
  const [first, second] = await Promise.all([getRPC(), getRPC()])
  await closing

  assert.equal(started.length, before + 1)
  assert.equal(first, second)
  await close()
})

test('a call made while close stops a starting worklet gets a new worklet', async () => {
  const before = started.length
  const { starting, release } = await startHeld()

  const closing = close()
  const next = getRPC()
  release()

  await assert.rejects(starting, (error: { name?: string }) => error.name === 'WORKER_SHUTDOWN')
  await next
  await closing
  assert.equal(started.length, before + 2)
  await close()
})

test('close during initialization rejects the start as a shutdown', async () => {
  const { starting, fail } = await startHeld()
  const rejected = assert.rejects(
    starting,
    (error: { name?: string }) => error.name === 'WORKER_SHUTDOWN'
  )

  const closing = close()
  fail(CHANNEL_CLOSED)

  await rejected
  await closing
})

test('a worklet that exits during initialization rejects the start as a crash', async () => {
  const { starting, fail } = await startHeld()
  const rejected = assert.rejects(
    starting,
    (error: { name?: string }) => error.name === 'WORKER_CRASHED'
  )

  started.at(-1)!.exit(1)
  await new Promise((resolve) => setImmediate(resolve))
  fail(CHANNEL_CLOSED)

  await rejected
  await close()
})

test('a start after a failed one waits for the failed worklet to stop', async () => {
  let finishStopping = () => {}
  terminateGate = new Promise((resolve) => {
    finishStopping = resolve
  })
  const { starting, fail } = await startHeld()
  fail(new Error('initialize failed'))
  await assert.rejects(starting)
  const count = started.length

  const next = getRPC()
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(started.length, count, 'a worklet started while the failed one was stopping')

  terminateGate = Promise.resolve()
  finishStopping()
  await next
  assert.equal(started.length, count + 1)
  await close()
})

test('close aborts the life signal as a shutdown', async () => {
  await getRPC()
  const signal = getWorkerLifeSignal()
  assert.ok(signal)

  await close()

  assert.equal(signal.aborted, true)
  assert.equal((signal.reason as { name?: string }).name, 'WORKER_SHUTDOWN')
  assert.equal(getWorkerLifeSignal(), null)
})
