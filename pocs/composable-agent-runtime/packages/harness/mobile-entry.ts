import type { Duplex } from 'streamx'
import { createChildEntry } from './lib/child-entry.ts'
import { harnessCompatibility } from './lib/runtime/compatibility.ts'
import { createWorkerSdkRuntimePort } from './lib/mobile-sdk-transport.ts'
import { createBinaryChannelMultiplexer } from './lib/mobile-multiplex.ts'
import {
  createIpcDuplex,
  type WorkletIPC
} from './lib/mobile-ipc-duplex.ts'

interface MobileHarnessEntryOptions {
  readonly createStream?: (ipc: WorkletIPC) => ReturnType<typeof createIpcDuplex>
  readonly createMultiplexer?: (stream: ReturnType<typeof createIpcDuplex>) => ReturnType<typeof createBinaryChannelMultiplexer>
  readonly createWorkerSdkPort?: (
    stream: Duplex
  ) => ReturnType<typeof createWorkerSdkRuntimePort>
  readonly createChild?: typeof createChildEntry
  readonly readProcessId?: () => Promise<number> | number
}

export function createMobileHarnessEntry({
  createStream = (ipc) => createIpcDuplex(ipc),
  createMultiplexer = (stream) => createBinaryChannelMultiplexer(stream),
  createWorkerSdkPort = (stream) => createWorkerSdkRuntimePort(stream),
  createChild = createChildEntry,
  readProcessId = defaultProcessId
}: MobileHarnessEntryOptions = {}) {
  return async function start(ipc: WorkletIPC, ready?: () => void) {
    const processId = await readProcessId()
    const stream = createStream(ipc)
    const mux = createMultiplexer(stream)
    const harnessChannel = mux.openChannel(1)
    const sdkChannel = mux.openChannel(2)
    const startChild = createChild({
      createSdk: async () => createWorkerSdkPort(sdkChannel),
      // Read from the compatibility contract rather than restated here, which
      // is how this list silently went stale when the contract gained a
      // capability.
      describeRuntime: () => ({
        component: harnessCompatibility.component,
        runtime: 'bare',
        instanceId: `harness-mobile-${processId}`,
        processId,
        contract: harnessCompatibility.contract,
        protocolVersion: harnessCompatibility.protocolVersion,
        capabilities: [...harnessCompatibility.capabilities],
        buildVersion: harnessCompatibility.buildVersion
      })
    })
    const stop = await startChild(harnessChannel)
    ready?.()
    return async function close() {
      await stop()
      mux.close()
    }
  }
}

export default createMobileHarnessEntry()

async function defaultProcessId() {
  if (typeof Reflect.get(globalThis, 'Bare') !== 'undefined') {
    const module = await import('bare-process')
    const pid = Reflect.get(module.default as object, 'pid')
    if (typeof pid === 'number') return pid
  }
  const runtimeProcess = Reflect.get(globalThis, 'process') as
    | { readonly pid?: unknown }
    | undefined
  if (typeof runtimeProcess?.pid === 'number') return runtimeProcess.pid
  return 0
}
