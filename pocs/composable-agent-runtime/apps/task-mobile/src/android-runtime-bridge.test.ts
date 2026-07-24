import { EventEmitter } from 'node:events'
import { describe, expect, mock, test } from 'bun:test'

const events = new EventEmitter()
const writes: string[] = []
const starts: unknown[][] = []
const crashes: unknown[][] = []

const native = {
  async startRuntime(...args: unknown[]) {
    starts.push(args)
    return { pid: 42, generation: 7 }
  },
  write(encoded: string) {
    writes.push(encoded)
  },
  suspendRuntime: mock(),
  resumeRuntime: mock(),
  terminateRuntime: mock(() => Promise.resolve()),
  crashRuntime(...args: unknown[]) {
    crashes.push(args)
  },
  addListener: mock(),
  removeListeners: mock()
}

mock.module('react-native', () => ({
  Platform: { OS: 'android' },
  NativeModules: { QvacRuntimeBridge: native },
  NativeEventEmitter: class {
    addListener(event: string, listener: (...args: unknown[]) => void) {
      events.on(event, listener)
      return { remove: () => events.off(event, listener) }
    }
  }
}))

const {
  crashAndroidRuntime,
  startAndroidRuntime
} = await import('./android-runtime-bridge')

describe('Android runtime bridge', () => {
  test('maps remote bytes and lifecycle onto the Worklet-shaped facade', async () => {
    const started = await startAndroidRuntime({
      uri: 'file:///sdk.bundle',
      filename: '/sdk.bundle',
      args: ['one']
    })

    expect(starts).toEqual([
      ['file:///sdk.bundle', '/sdk.bundle', ['one']]
    ])
    expect(started.worklet.pid).toBe(42)
    expect(started.worklet.generation).toBe(7)

    const received = new Promise<string>((resolve) => {
      started.ipc.once('data', (data: unknown) => {
        resolve(new TextDecoder().decode(data as Uint8Array))
      })
    })
    events.emit(
      'QvacRuntimeData',
      Buffer.from('runtime-ready').toString('base64')
    )
    expect(await received).toBe('runtime-ready')

    started.ipc.write(new TextEncoder().encode('handshake'))
    await Promise.resolve()
    expect(Buffer.from(writes[0]!, 'base64').toString()).toBe('handshake')

    started.worklet.suspend()
    started.worklet.resume()
    expect(native.suspendRuntime).toHaveBeenCalled()
    expect(native.resumeRuntime).toHaveBeenCalled()

    started.worklet.terminate()
    expect(native.terminateRuntime).toHaveBeenCalled()
  })

  test('maps service death to an IPC error and delegates the crash probe', async () => {
    const started = await startAndroidRuntime({
      uri: 'file:///sdk.bundle',
      filename: '/sdk.bundle',
      args: []
    })
    const died = new Promise<string>((resolve) => {
      started.ipc.once('error', (error: Error) => resolve(error.message))
    })

    events.emit('QvacRuntimeDied', { reason: 'SDK process aborted' })
    expect(await died).toBe('SDK process aborted')

    crashAndroidRuntime({
      uri: 'file:///crash.bundle',
      filename: '/crash.bundle',
      args: []
    })
    expect(crashes.at(-1)).toEqual([
      'file:///crash.bundle',
      '/crash.bundle',
      []
    ])
  })
})
