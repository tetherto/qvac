import {
  createHarness,
  type HarnessRuntime
} from '@qvac/harness/react-native'
import {
  createSync,
  type SyncRuntime
} from '@qvac/sync/react-native'
import type {
  AssistantComponents,
  AssistantHarnessComponent,
  AssistantInference,
  AssistantSyncComponent,
  CreateAssistantOptions
} from './contracts.ts'
import { handshakeFrom } from './handshakes.ts'

interface ReactNativeAssistantAdapterDependencies {
  readonly createSyncRuntime: typeof createSync
  readonly createHarnessRuntime: typeof createHarness
}

export interface ReactNativeAssistantAdapterOptions {
  readonly storagePath: string
  readonly invite?: string
  readonly inference?: AssistantInference
  readonly logging?: CreateAssistantOptions['logging']
}

export function createReactNativeAssistantComponents(
  options: ReactNativeAssistantAdapterOptions,
  dependencies: Partial<ReactNativeAssistantAdapterDependencies> = {}
): AssistantComponents {
  const createSyncRuntime = dependencies.createSyncRuntime ?? createSync
  const createHarnessRuntime =
    dependencies.createHarnessRuntime ?? createHarness

  return {
    async startSync(): Promise<AssistantSyncComponent> {
      const sync: SyncRuntime = createSyncRuntime({
        storagePath: options.storagePath,
        pairingInvite: options.invite
          ? Buffer.from(options.invite, 'base64url')
          : undefined
      })
      try {
        await sync.ready()
        const identity = await sync.runtime.describe()
        return {
          handshake: handshakeFrom(identity),
          state: sync,
          exited: sync.exited,
          close: () => sync.close(),
          suspend: () => sync.lifecycle.suspend(),
          resume: () => sync.lifecycle.resume(),
          inspect: () => ({ ...identity })
        }
      } catch (error) {
        await sync.close().catch(() => {})
        throw error
      }
    },
    async startHarness({ state }): Promise<AssistantHarnessComponent> {
      if (options.inference && options.inference.kind !== 'qwen') {
        throw new Error(`unsupported mobile inference: ${options.inference.kind}`)
      }
      const harness: HarnessRuntime = createHarnessRuntime({
        state,
        inference: 'qwen',
        logging: options.logging
      })
      try {
        await harness.ready()
        const identity = await harness.runtime.describe()
        return {
          handshake: handshakeFrom(identity),
          harness,
          exited: harness.exited,
          close: () => harness.close(),
          suspend: () => harness.lifecycle.suspend(),
          resume: () => harness.lifecycle.resume(),
          inspect: () => ({ ...identity })
        }
      } catch (error) {
        await harness.close().catch(() => {})
        throw error
      }
    }
  }
}
