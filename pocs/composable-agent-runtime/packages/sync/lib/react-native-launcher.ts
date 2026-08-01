import type { WorkletIPC } from './mobile-ipc-duplex.ts'
import { createIpcDuplex } from './mobile-ipc-duplex.ts'
import { SyncClient } from './client.ts'
import { createSyncWorkletArgv } from './react-native-argv.ts'

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
  describeRuntime(): ReturnType<SyncClient['describeRuntime']>
  getIdentity(): ReturnType<SyncClient['getIdentity']>
  getUserProfile(): ReturnType<SyncClient['getUserProfile']>
  setUserProfile(
    profile: Parameters<SyncClient['setUserProfile']>[0]
  ): ReturnType<SyncClient['setUserProfile']>
  createTask(request: Parameters<SyncClient['createTask']>[0]): ReturnType<SyncClient['createTask']>
  updateTask(
    request: Parameters<SyncClient['updateTask']>[0]
  ): ReturnType<SyncClient['updateTask']>
  getTask(request: Parameters<SyncClient['getTask']>[0]): ReturnType<SyncClient['getTask']>
  listTasks(): ReturnType<SyncClient['listTasks']>
  watchTasks(): ReturnType<SyncClient['watchTasks']>
  createPairingInvite(
    request?: Parameters<SyncClient['createPairingInvite']>[0]
  ): ReturnType<SyncClient['createPairingInvite']>
  approvePairingRequest(
    request: Parameters<SyncClient['approvePairingRequest']>[0]
  ): ReturnType<SyncClient['approvePairingRequest']>
  rejectPairingRequest(
    request: Parameters<SyncClient['rejectPairingRequest']>[0]
  ): ReturnType<SyncClient['rejectPairingRequest']>
  watchPairingRequests(): ReturnType<SyncClient['watchPairingRequests']>
}

export interface ReactNativeSyncLaunchOptions {
  readonly storagePath: string
  readonly invite?: string
  readonly onDisconnect: () => void
}

export interface ReactNativeSyncLauncher {
  launch(options: ReactNativeSyncLaunchOptions): Promise<{
    readonly backend: {
      ready(): Promise<void>
      close(): Promise<void>
      describeRuntime(): ReturnType<SyncClient['describeRuntime']>
      getIdentity(): ReturnType<SyncClient['getIdentity']>
      getUserProfile(): ReturnType<SyncClient['getUserProfile']>
      setUserProfile(
        profile: Parameters<SyncClient['setUserProfile']>[0]
      ): ReturnType<SyncClient['setUserProfile']>
      createTask(request: Parameters<SyncClient['createTask']>[0]): ReturnType<SyncClient['createTask']>
      updateTask(
        request: Parameters<SyncClient['updateTask']>[0]
      ): ReturnType<SyncClient['updateTask']>
      getTask(request: Parameters<SyncClient['getTask']>[0]): ReturnType<SyncClient['getTask']>
      listTasks(): ReturnType<SyncClient['listTasks']>
      watchTasks(): ReturnType<SyncClient['watchTasks']>
      createPairingInvite(
        request?: Parameters<SyncClient['createPairingInvite']>[0]
      ): ReturnType<SyncClient['createPairingInvite']>
      approvePairingRequest(
        request: Parameters<SyncClient['approvePairingRequest']>[0]
      ): ReturnType<SyncClient['approvePairingRequest']>
      rejectPairingRequest(
        request: Parameters<SyncClient['rejectPairingRequest']>[0]
      ): ReturnType<SyncClient['rejectPairingRequest']>
      watchPairingRequests(): ReturnType<SyncClient['watchPairingRequests']>
    }
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
        backend: {
          ready: () => client.ready(),
          close: () => client.close(),
          describeRuntime: () => client.describeRuntime(),
          getIdentity: () => client.getIdentity(),
          getUserProfile: () => client.getUserProfile(),
          setUserProfile: (profile) => client.setUserProfile(profile),
          createTask: (request) => client.createTask(request),
          updateTask: (request) => client.updateTask(request),
          getTask: (request) => client.getTask(request),
          listTasks: () => client.listTasks(),
          watchTasks: () => client.watchTasks(),
          createPairingInvite: (request) => client.createPairingInvite(request),
          approvePairingRequest: (request) => client.approvePairingRequest(request),
          rejectPairingRequest: (request) => client.rejectPairingRequest(request),
          watchPairingRequests: () => client.watchPairingRequests()
        },
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
  invite
}: Pick<ReactNativeSyncLaunchOptions, 'storagePath' | 'invite'>) {
  return createSyncWorkletArgv({ storagePath, invite })
}
