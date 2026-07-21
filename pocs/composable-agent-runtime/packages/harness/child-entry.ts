import { createChildEntry } from './lib/child-entry.ts'
import { createSdkSidecarAdapter } from './lib/sdk-sidecar-adapter.ts'
import type { HarnessStream } from './lib/transport.ts'
import type { HarnessRuntimeInfo } from './lib/connect.ts'
import process from 'bare-process'

const sdkEntry = argument('--sdk-entry=')
const logging = JSON.parse(argument('--logging=') ?? '{}')
let sdkIdentity: HarnessRuntimeInfo | undefined
const startChild = createChildEntry({
  logging,
  createSdk: async () => {
    if (!sdkEntry) {
      throw new Error('Harness requires --sdk-entry')
    }
    return createSdkSidecarAdapter({
      entry: sdkEntry,
      onIdentity(identity) {
        sdkIdentity = identity
      }
    })
  },
  describeRuntime: () => ({
    component: 'harness',
    runtime: 'bare',
    instanceId: `harness-${process.pid}`,
    processId: process.pid,
    contract: 'qvac.harness',
    protocolVersion: 1,
    capabilities: ['execution.run', 'state.sync'],
    buildVersion: '0.0.0-poc',
    ...(sdkIdentity === undefined
      ? {}
      : {
          sdkIdentity: {
            component: sdkIdentity.component,
            runtime: sdkIdentity.runtime,
            instanceId: sdkIdentity.instanceId,
            processId: sdkIdentity.processId,
            buildVersion: sdkIdentity.buildVersion
          }
        })
  })
})

export default async function start(stream: HarnessStream, ready?: () => void) {
  const stop = await startChild(stream)
  ready?.()
  return stop
}

function argument(prefix: string) {
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)
}
