import {
  createHarnessService,
  type CreateHarnessServiceOptions
} from './harness.ts'
import { serveHarness } from './serve.ts'
import type { SdkRuntimePort } from './sdk-runtime-port.ts'
import type { HarnessStream } from './transport.ts'
import { createSupervisedSdkPort } from './supervised-sdk-port.ts'
import type { HarnessRuntimeInfo } from './connect.ts'
import { createRemoteHarnessRunStore } from './state-port.ts'
import { createRemoteToolApprovalPort } from './approval-port.ts'
import type { HarnessLoggingConfig } from './types.ts'

export interface ChildEntryOptions {
  readonly createSdk: () => Promise<SdkRuntimePort>
  readonly logging?: HarnessLoggingConfig
  readonly describeRuntime?: () => HarnessRuntimeInfo
  readonly configure?: (
    sdk: SdkRuntimePort
  ) => Promise<Omit<CreateHarnessServiceOptions, 'sdk' | 'logging' | 'runStore'>> | Omit<CreateHarnessServiceOptions, 'sdk' | 'logging' | 'runStore'>
  readonly serve?: (
    stream: HarnessStream,
    harness: ReturnType<typeof createHarnessService>,
    describeRuntime: () => HarnessRuntimeInfo
  ) => object | void
}

export function createChildEntry({
  createSdk,
  logging,
  configure,
  describeRuntime = missingRuntimeInfo,
  serve = serveHarness
}: ChildEntryOptions) {
  return async function start(stream: HarnessStream) {
    const sdk = createSupervisedSdkPort(createSdk)
    const statePort = createRemoteHarnessRunStore()
    const approvalPort = createRemoteToolApprovalPort()
    const configured = await configure?.(sdk)
    const harness = createHarnessService({
      sdk,
      logging,
      runStore: statePort.store,
      ...configured,
      // A host that answers approvals wins over any static configuration; the
      // configured port remains the fallback while no client is listening.
      toolApproval: {
        approve: async (invocation) => {
          if (await approvalPort.port.approve(invocation)) return true
          return configured?.toolApproval?.approve(invocation) ?? false
        }
      }
    })
    if (serve === serveHarness) {
      serveHarness(stream, harness, describeRuntime, statePort.attach, approvalPort.attach)
    } else {
      serve(stream, harness, describeRuntime)
    }
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await harness.close()
    }
    stream.on('close', () => {
      void close()
    })
    return close
  }
}

function missingRuntimeInfo(): HarnessRuntimeInfo {
  throw new Error('Harness child runtime identity is not configured')
}
