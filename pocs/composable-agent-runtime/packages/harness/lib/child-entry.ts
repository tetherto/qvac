import { createHarness } from './harness.ts'
import { serveHarness } from './serve.ts'
import type { SdkRuntimePort } from './sdk-runtime-port.ts'
import type { HarnessStream } from './transport.ts'
import { createSupervisedSdkPort } from './supervised-sdk-port.ts'
import type { HarnessRuntimeInfo } from './connect.ts'
import type { HarnessLoggingConfig } from './types.ts'

export interface ChildEntryOptions {
  readonly createSdk: () => Promise<SdkRuntimePort>
  readonly logging?: HarnessLoggingConfig
  readonly describeRuntime?: () => HarnessRuntimeInfo
  readonly serve?: (
    stream: HarnessStream,
    harness: ReturnType<typeof createHarness>,
    describeRuntime: () => HarnessRuntimeInfo
  ) => object | void
}

export function createChildEntry({
  createSdk,
  logging,
  describeRuntime = missingRuntimeInfo,
  serve = serveHarness
}: ChildEntryOptions) {
  return async function start(stream: HarnessStream) {
    const sdk = createSupervisedSdkPort(createSdk)
    const harness = createHarness({ sdk, logging })
    serve(stream, harness, describeRuntime)
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
