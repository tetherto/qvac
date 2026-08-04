import { createChildEntry } from './lib/child-entry.ts'
import { loggingFromArgv } from './lib/logger.ts'
import { createSdkSidecarAdapter } from './lib/sdk-sidecar-adapter.ts'
import type { HarnessStream } from './lib/transport.ts'
import type { HarnessRuntimeInfo } from './lib/connect.ts'
import Buffer from 'bare-buffer'
import {
  createDesktopHarnessConfiguration,
  type HarnessDesktopConfig
} from './lib/runtime/desktop-config.ts'
import process from 'bare-process'

const sdkEntry = argument('--sdk-entry=')
const desktopConfig = parseDesktopConfig(argument('--desktop-config='))
const logging = loggingFromArgv(process.argv)
let sdkIdentity: HarnessRuntimeInfo | undefined
const startChild = createChildEntry({
  logging,
  ...(desktopConfig
    ? {
        configure: (sdk: Parameters<typeof createDesktopHarnessConfiguration>[0]) =>
          createDesktopHarnessConfiguration(sdk, desktopConfig)
      }
    : {}),
  createSdk: async () => {
    if (!sdkEntry) {
      throw new Error('Harness requires --sdk-entry')
    }
    return createSdkSidecarAdapter({
      entry: sdkEntry,
      logging,
      ...(desktopConfig?.image
        ? {
            args: [
              `--diffusion-config=${Buffer.from(
                JSON.stringify(desktopConfig.image)
              ).toString('base64')}`
            ]
          }
        : {}),
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
    protocolVersion: 2,
    capabilities: [
      'agent.register',
      'agent.run',
      'agent.cancel',
      'run.read',
      'work.watch',
      'state.port',
      'tool.approval'
    ],
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

function parseDesktopConfig(
  encoded: string | undefined
): (HarnessDesktopConfig & { readonly childEntry: string }) | undefined {
  if (!encoded) return undefined
  return JSON.parse(Buffer.from(encoded, 'base64').toString()) as HarnessDesktopConfig & {
    readonly childEntry: string
  }
}
