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
  AssistantSyncComponent
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
          ? decodeBase64Url(options.invite)
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
        inference: 'qwen'
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

/**
 * Hermes has no global Buffer, and the shim applications polyfill it with does
 * not implement the 'base64url' encoding Node added in v15. Translate to plain
 * base64 first so an invite decodes the same on every host.
 */
function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const remainder = padded.length % 4
  return Buffer.from(
    remainder === 0 ? padded : padded.padEnd(padded.length + (4 - remainder), '='),
    'base64'
  )
}
