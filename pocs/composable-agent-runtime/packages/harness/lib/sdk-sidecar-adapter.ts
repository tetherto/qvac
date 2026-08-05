import type { HarnessRuntimeInfo } from './connect.ts'
import { getConfigSnapshot } from '@qvac/config'
import { configArgvForHarness } from './config.ts'
import { spawnHarness, type SpawnedHarness } from './spawn.ts'
import type { SdkRuntimePort } from './sdk-runtime-port.ts'

export interface SpawnSdkSidecarOptions {
  readonly entry: string
  readonly args?: readonly string[]
  readonly onIdentity: (identity: HarnessRuntimeInfo) => void
}

export async function createSdkSidecarAdapter({
  entry,
  args = [],
  onIdentity
}: SpawnSdkSidecarOptions): Promise<SdkRuntimePort> {
  const remote = spawnHarness({
    entry,
    args: [...configArgvForHarness(getConfigSnapshot()), ...args]
  })
  onIdentity(await remote.describeRuntime())
  return fromRemoteHarness(remote)
}

function fromRemoteHarness(remote: SpawnedHarness): SdkRuntimePort {
  return {
    exited: remote.exited,
    async loadModel({ model }) {
      return { modelId: model }
    },
    completion({ requestId, traceId, modelId, messages, signal }) {
      return {
        requestId,
        events: (async function* () {
          for await (const event of remote.run({
            runId: requestId,
            traceId,
            model: modelId,
            messages,
            signal
          })) {
            if (event.type === 'content') {
              yield { type: 'content-delta' as const, text: event.text }
            } else if (event.type === 'error') {
              yield { type: 'error' as const, message: event.message }
            } else if (event.type === 'aborted') {
              yield { type: 'cancelled' as const }
            }
          }
        })()
      }
    },
    async generateImage() {
      throw new Error(
        'image generation must use the shared direct SDK runtime, not an SDK sidecar'
      )
    },
    async cancel() {},
    async heartbeat() {
      await remote.describeRuntime()
      return { ok: true }
    },
    close: () => remote.close()
  }
}
