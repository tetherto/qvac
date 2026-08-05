import type { WorkletIPC } from './mobile-ipc-duplex.ts'
import { createIpcDuplex } from './mobile-ipc-duplex.ts'
import { SyncClient } from './client.ts'
import { createSyncWorkletArgv } from './react-native-argv.ts'
import type { SyncWorkletOptions } from './react-native-argv.ts'

interface StartedHarness {
  readonly ipc: WorkletIPC & {
    once?(event: 'close', listener: () => void): unknown
    removeListener?(event: 'close', listener: () => void): unknown
    terminate?(): unknown
  }
  readonly worklet?: { terminate(): void | Promise<void> }
}

interface LaunchHarnessFn {
  (
    id: string,
    options?: object,
    args?: readonly string[]
  ): Promise<StartedHarness>
}

interface SyncClientLike {
  ready(): Promise<void>
  close(): Promise<void>
}

export interface ReactNativeSyncLaunchOptions extends SyncWorkletOptions {
  readonly onDisconnect: () => void
}

export interface ReactNativeSyncLauncher {
  launch(options: ReactNativeSyncLaunchOptions): Promise<{
    readonly backend: SyncClientLike
    terminate(): Promise<void>
  }>
}

interface LauncherOptions {
  readonly startHarness: LaunchHarnessFn
  readonly createClient?: (ipc: ReturnType<typeof createIpcDuplex>) => SyncClientLike
}

export function createReactNativeSyncLauncher({
  startHarness,
  createClient = (ipc) => new SyncClient(ipc)
}: LauncherOptions): ReactNativeSyncLauncher {
  return {
    async launch(options: ReactNativeSyncLaunchOptions) {
      const started = await startHarness('Sync', {}, createSyncRuntimeArgs(options))
      const stream = createIpcDuplex(started.ipc)
      const client = createClient(stream)
      let terminated = false
      started.ipc.once?.('close', options.onDisconnect)
      return {
        backend: client,
        async terminate() {
          if (terminated) return
          terminated = true
          started.ipc.removeListener?.('close', options.onDisconnect)
          if (started.worklet) {
            await Promise.resolve(started.worklet.terminate())
            return
          }
          await Promise.resolve(started.ipc.terminate?.())
        }
      }
    }
  }
}

export function createSyncRuntimeArgs({
  storagePath,
  bootstrap,
  meshSeed,
  meshKey,
  pairingInvite,
  config
}: Omit<ReactNativeSyncLaunchOptions, 'onDisconnect'>) {
  return createSyncWorkletArgv({
    storagePath,
    bootstrap,
    meshSeed,
    meshKey,
    pairingInvite,
    config
  })
}
