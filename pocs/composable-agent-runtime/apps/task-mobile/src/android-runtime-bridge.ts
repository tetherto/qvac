import b4a from 'b4a'
import {
  NativeEventEmitter,
  NativeModules,
  Platform,
  type EmitterSubscription
} from 'react-native'
import { Duplex } from 'streamx'

const DATA_EVENT = 'QvacRuntimeData'
const DEATH_EVENT = 'QvacRuntimeDied'

interface RuntimeStartResult {
  readonly pid: number
  readonly generation: number
}

interface RuntimeDeathEvent {
  readonly reason: string
  readonly pid?: number
  readonly generation?: number
}

interface QvacRuntimeBridgeNative {
  startRuntime(
    bundlePath: string,
    filename: string,
    args: readonly string[]
  ): Promise<RuntimeStartResult>
  write(encoded: string): void
  suspendRuntime(): void
  resumeRuntime(): void
  terminateRuntime(): Promise<void>
  crashRuntime(
    bundlePath: string,
    filename: string,
    args: readonly string[]
  ): void
  addListener(eventName: string): void
  removeListeners(count: number): void
}

export interface RemoteBundle {
  readonly uri: string
  readonly filename: string
  readonly args: readonly string[]
}

export async function startAndroidRuntime(bundle: RemoteBundle) {
  const native = nativeBridge()
  const ipc = new RemoteRuntimeIPC(native)
  try {
    const runtime = await native.startRuntime(
      bundle.uri,
      bundle.filename,
      bundle.args
    )
    const worklet = new RemoteRuntimeWorklet(native, ipc, runtime)
    return { ipc, worklet }
  } catch (error) {
    ipc.destroy()
    throw error
  }
}

export function crashAndroidRuntime(bundle: RemoteBundle) {
  nativeBridge().crashRuntime(bundle.uri, bundle.filename, bundle.args)
}

class RemoteRuntimeIPC extends Duplex {
  private readonly subscriptions: EmitterSubscription[]

  constructor(private readonly native: QvacRuntimeBridgeNative) {
    super()
    const emitter = new NativeEventEmitter(
      native as unknown as typeof NativeModules.QvacRuntimeBridge
    )
    this.subscriptions = [
      emitter.addListener(DATA_EVENT, (encoded: string) => {
        this.push(b4a.from(encoded, 'base64'))
      }),
      emitter.addListener(DEATH_EVENT, (event: RuntimeDeathEvent) => {
        this.destroy(new Error(event.reason))
      })
    ]
  }

  _read(callback: (error: Error | null) => void) {
    callback(null)
  }

  _write(data: Uint8Array, callback: (error: Error | null) => void) {
    try {
      this.native.write(b4a.toString(data, 'base64'))
      callback(null)
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)))
    }
  }

  _destroy(callback: (error: Error | null) => void) {
    for (const subscription of this.subscriptions) subscription.remove()
    callback(null)
  }
}

class RemoteRuntimeWorklet {
  readonly pid: number
  readonly generation: number

  constructor(
    private readonly native: QvacRuntimeBridgeNative,
    private readonly ipc: RemoteRuntimeIPC,
    runtime: RuntimeStartResult
  ) {
    this.pid = runtime.pid
    this.generation = runtime.generation
  }

  suspend() {
    this.native.suspendRuntime()
  }

  resume() {
    this.native.resumeRuntime()
  }

  terminate() {
    void this.native.terminateRuntime()
    this.ipc.destroy()
  }
}

function nativeBridge() {
  if (Platform.OS !== 'android') {
    throw new Error('Android runtime bridge is only available on Android')
  }
  const native = NativeModules.QvacRuntimeBridge as
    | QvacRuntimeBridgeNative
    | undefined
  if (native === undefined) {
    throw new Error('QvacRuntimeBridge native module is unavailable')
  }
  return native
}
