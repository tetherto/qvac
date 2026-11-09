import { mock } from 'node:test'
import { Duplex } from 'node:stream'

/**
 * A worklet IPC as bare-stow-host presents it: `exit` with the code the worker
 * reports once its stop() has run, then `close` when the transport ends.
 */
export class FakeWorklet extends Duplex {
  /** Whether terminate() lets the worker report its exit or kills it first. */
  onTerminate: 'exit' | 'kill' = 'exit'

  override _read() {}

  override _write(_chunk: unknown, _encoding: string, callback: () => void) {
    callback()
  }

  /** The worker stops on its own and reports its exit code. */
  exitCleanly(code = 0) {
    this.emit('exit', code)
    this.destroy()
  }

  /** The worker dies, or is killed, before it reports its exit. */
  die() {
    this.destroy()
  }

  async terminate(): Promise<number | undefined> {
    if (this.onTerminate === 'kill') {
      this.die()
      return undefined
    }
    this.exitCleanly(0)
    return 0
  }
}

/**
 * Replaces the Expo client's harness, config, device and home-folder modules
 * with fakes, then imports the client. Call once per test file, before any test.
 */
export async function loadExpoClient() {
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

  mock.module('@/client/init-hooks', {
    namedExports: { initializeConfig: async () => {} }
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

  const client = await import('@/client/rpc/expo-rpc-client')
  return { client, started }
}

export const tick = () => new Promise((resolve) => setImmediate(resolve))
