import { File, Paths } from 'expo-file-system'
import { SyncClient } from '@qvac/sync/client'
import syncHarness from '../generated/sync.js'
import { createIpcDuplex } from './ipc-duplex.ts'
import {
  createMobileSyncClient,
  type MobileSyncBackend,
  type MobileSyncClientOptions,
  type MobileSyncLaunchOptions,
  type MobileSyncWorklet
} from './mobile-sync-client.ts'
import {
  mobileSyncMarkerUri,
  mobileSyncStoragePath
} from './storage-path.ts'

export function createPersistentMobileSyncClient(
  onState?: MobileSyncClientOptions['onState']
) {
  return createMobileSyncClient({
    storagePath: mobileSyncStoragePath(Paths.document.uri),
    launch: launchSyncWorklet,
    onState
  })
}

export function hasPersistentMobileSyncSession() {
  return new File(mobileSyncMarkerUri(Paths.document.uri)).exists
}

export async function launchSyncWorklet(
  options: MobileSyncLaunchOptions
): Promise<MobileSyncWorklet> {
  const encoded = JSON.stringify({
    storagePath: options.storagePath,
    ...(options.invite ? { invite: options.invite } : {})
  })
  const started = await syncHarness.start('Sync', {}, [
    'react-native-bare-kit',
    'sync.js',
    encoded
  ])
  const stream = createIpcDuplex(started.ipc)
  const client = new SyncClient(stream)
  const backend: MobileSyncBackend = {
    ready: () => client.ready(),
    close: () => client.close(),
    describeRuntime: () => client.describeRuntime(),
    createTask: (request) => client.createTask(request),
    listTasks: () => client.listTasks(),
    watchTasks: () => client.watchTasks()
  }
  let terminated = false
  started.ipc.once('close', options.onDisconnect)

  return {
    backend,
    terminate() {
      if (terminated) return
      terminated = true
      started.ipc.removeListener('close', options.onDisconnect)
      started.worklet.terminate()
    }
  }
}
