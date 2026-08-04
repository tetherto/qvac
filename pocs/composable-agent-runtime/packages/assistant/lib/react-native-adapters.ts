import type { LoadModelOptions } from '@qvac/sdk'
import type { Duplex } from 'streamx'
import defaultHarnessLauncher from '@qvac/harness/react-native-launcher'
import { createSync, type SyncRuntime } from '@qvac/sync/react-native'
import { argvForLogging } from '@qvac/harness/logger'
import {
  connectHarness,
  type RemoteHarness,
  type HarnessRuntimeInfo
} from '@qvac/harness/connect'
import {
  createHostSdkTransportServer,
  type PublicSdkLike
} from '@qvac/harness/mobile-sdk-transport'
import type { HarnessJsonValue } from '@qvac/harness/types'
import type {
  AssistantComponents,
  AssistantHarnessComponent,
  AssistantInference,
  AssistantSyncComponent
} from './contracts.ts'
import type { CreateAssistantOptions } from './contracts.ts'
import {
  assertRuntimeIdentity,
  expectedHarnessHandshake,
  expectedSyncHandshake,
  handshakeFrom,
  type RuntimeIdentity
} from './handshakes.ts'
import { createRunStateAdapter } from './run-state.ts'

interface ReactNativeHarnessLaunchResult {
  readonly ipc: {
    on(event: 'close' | 'error', listener: () => void): object
    destroy(): void
    removeListener?(event: 'close' | 'error', listener: () => void): object
  }
  readonly sdkIpc: Duplex
  readonly worklet: { terminate(): Promise<void> }
}

interface ReactNativeHarnessLauncher {
  start(
    id: string,
    options?: object,
    args?: readonly string[]
  ): Promise<ReactNativeHarnessLaunchResult>
}

interface SdkBridge {
  close(): Promise<void>
}

type PublicSdkCompletionEvent = ReturnType<PublicSdkLike['completion']> extends {
  readonly events: AsyncIterable<infer T>
}
  ? T
  : never

type SdkEventFrame = {
  readonly type: string
  readonly text?: string
  readonly call?: {
    readonly name: string
    readonly arguments: Readonly<Record<string, unknown>>
  }
  readonly name?: string
  readonly result?: unknown
  readonly stats?: Readonly<Record<string, unknown>>
  readonly stopReason?: string
  readonly error?: { readonly message?: string }
}

function decodeInvite(invite: string) {
  return Buffer.from(invite, 'base64url')
}

interface ReactNativeAssistantAdapterDependencies {
  readonly createSyncRuntime: typeof createSync
  readonly harnessLauncher: ReactNativeHarnessLauncher
  readonly connectHarnessRuntime: typeof connectHarness
  readonly createSdkBridge: (
    sdkIpc: ReactNativeHarnessLaunchResult['sdkIpc'],
    logging?: CreateAssistantOptions['logging']
  ) => Promise<SdkBridge>
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
  const harnessLauncher = dependencies.harnessLauncher ?? defaultHarnessLauncher
  const connectHarnessRuntime =
    dependencies.connectHarnessRuntime ?? connectHarness
  const createSdkBridge = dependencies.createSdkBridge ?? createDefaultSdkBridge

  return {
    async startSync(): Promise<AssistantSyncComponent> {
      let sync: SyncRuntime | null = null
      try {
        sync = createSyncRuntime({
          storagePath: options.storagePath,
          pairingInvite: options.invite ? decodeInvite(options.invite) : undefined
        })
        await sync.ready()
        const identity = await sync.runtime.describe()
        assertRuntimeIdentity(identity, runtimeExpectation('sync'))
        return {
          handshake: handshakeFrom(identity),
          state: sync,
          exited: sync.exited,
          close: () => sync?.close() ?? Promise.resolve(),
          suspend: () => sync?.lifecycle.suspend() ?? Promise.resolve(),
          resume: () => sync?.lifecycle.resume() ?? Promise.resolve(),
          inspect: () => ({ ...identity })
        }
      } catch (error) {
        await sync?.close().catch(() => {})
        throw error
      }
    },
    async startHarness({ state }): Promise<AssistantHarnessComponent> {
      if (options.inference && options.inference.kind !== 'qwen') {
        throw new Error(`unsupported mobile inference: ${options.inference.kind}`)
      }
      const monitor = createExitMonitor()
      let started: ReactNativeHarnessLaunchResult | null = null
      let sdkBridge: SdkBridge | null = null
      let remote: RemoteHarness | null = null
      let identity: HarnessRuntimeInfo | null = null
      const disconnect = monitor.onUnexpectedExit
      const stateAdapter = createRunStateAdapter(state)
      try {
        started = await harnessLauncher.start(
          'Harness',
          {},
          argvForLogging(options.logging)
        )
        started.ipc.on('close', disconnect)
        started.ipc.on('error', disconnect)
        started.sdkIpc.on('close', disconnect)
        started.sdkIpc.on('error', disconnect)
        sdkBridge = await createSdkBridge(started.sdkIpc, options.logging)
        const harnessStream = started.ipc
        remote = connectHarnessRuntime(async () => harnessStream)
        identity = await remote.describeRuntime()
        assertRuntimeIdentity(identity, runtimeExpectation('harness'))
        const close = closeOnce(async () => {
          monitor.markClosing()
          await runCleanupSteps([
            () => stateAdapter.close(),
            () => remote?.close() ?? Promise.resolve(),
            () => sdkBridge?.close() ?? Promise.resolve(),
            async () => {
              started?.ipc.removeListener?.('close', disconnect)
              started?.ipc.removeListener?.('error', disconnect)
              started?.sdkIpc.removeListener?.('close', disconnect)
              started?.sdkIpc.removeListener?.('error', disconnect)
            },
            () => started?.worklet.terminate() ?? Promise.resolve()
          ])
        })
        const harness = {
          async *run(input: Parameters<AssistantHarnessComponent['harness']['run']>[0]) {
            const activeRemote = remote
            if (!activeRemote) throw new Error('harness runtime is not ready')
            let completed = false
            try {
              for await (const event of activeRemote.run(input)) {
                await stateAdapter.append(input.runId, event)
                yield event
              }
              identity = await activeRemote.describeRuntime()
              completed = true
            } finally {
              await stateAdapter.finish(input.runId, completed)
            }
          },
          close
        }
        return {
          handshake: handshakeFrom(identity),
          harness,
          readRun: stateAdapter.read,
          exited: monitor.exited,
          close,
          inspect: () => ({ ...identity })
        }
      } catch (error) {
        if (started) {
          monitor.markClosing()
          await runCleanupSteps(
            [
              () => remote?.close() ?? Promise.resolve(),
              () => sdkBridge?.close() ?? Promise.resolve(),
              async () => {
                started?.ipc.removeListener?.('close', disconnect)
                started?.ipc.removeListener?.('error', disconnect)
                started?.sdkIpc.removeListener?.('close', disconnect)
                started?.sdkIpc.removeListener?.('error', disconnect)
              },
              () => started?.worklet.terminate() ?? Promise.resolve()
            ],
            { suppressError: true }
          )
        }
        throw error
      }
    }
  }
}

export async function createPublicSdkBridge({
  sdkIpc,
  publicSdk
}: {
  readonly sdkIpc: ReactNativeHarnessLaunchResult['sdkIpc']
  readonly publicSdk: PublicSdkLike
}): Promise<SdkBridge> {
  const server = createHostSdkTransportServer(sdkIpc, publicSdk)
  return {
    close: () => server.close()
  }
}

async function createDefaultSdkBridge(
  sdkIpc: ReactNativeHarnessLaunchResult['sdkIpc'],
  _logging?: CreateAssistantOptions['logging']
): Promise<SdkBridge> {
  const sdkModule = await import('@qvac/sdk')
  await sdkModule.heartbeat()
  const sdk: PublicSdkLike = {
    async loadModel({ modelSrc, modelType }) {
      if (modelType !== 'llamacpp-completion') {
        throw new Error(`unsupported mobile model type: ${modelType}`)
      }
      const loadOptions: LoadModelOptions = {
        modelSrc,
        modelType: 'llamacpp-completion'
      }
      return sdkModule.loadModel(loadOptions)
    },
    completion(input) {
      const run = sdkModule.completion({
        ...input,
        history: input.history.map((message) => ({
          role: sdkHistoryRole(message.role),
          content: message.content
        })),
        stream: true
      })
      return {
        requestId: run.requestId,
        events: mapSdkEvents(run.events)
      }
    },
    cancel: ({ requestId }) => sdkModule.cancel({ requestId }),
    async heartbeat() {
      await sdkModule.heartbeat()
      return { ok: true }
    },
    async close() {
      await sdkModule.close()
    }
  }
  return createPublicSdkBridge({ sdkIpc, publicSdk: sdk })
}

function sdkHistoryRole(role: string) {
  if (
    role === 'system' ||
    role === 'user' ||
    role === 'assistant' ||
    role === 'tool'
  ) {
    return role
  }
  throw new Error(`unsupported SDK history role: ${role}`)
}

async function* mapSdkEvents(
  events: AsyncIterable<SdkEventFrame>
): AsyncGenerator<PublicSdkCompletionEvent> {
  for await (const event of events) {
    yield mapPublicSdkCompletionEvent(event)
  }
}

export function mapPublicSdkCompletionEvent(
  event: SdkEventFrame
): PublicSdkCompletionEvent {
  if (event.type === 'thinkingDelta' || event.type === 'contentDelta') {
    return { type: event.type, text: event.text ?? '' }
  }
  if (event.type === 'toolCall') {
    if (!event.call) {
      return completionError('SDK tool call omitted call details')
    }
    return {
      type: 'toolCall',
      call: {
        name: event.call.name,
        arguments: toJsonRecord(event.call.arguments)
      }
    }
  }
  if (event.type === 'toolResult') {
    return {
      type: 'toolResult',
      name: event.name ?? '',
      result: toJsonValue(event.result)
    }
  }
  if (event.type === 'completionStats') {
    const numericStats: Record<string, number> = {}
    for (const [key, value] of Object.entries(event.stats ?? {})) {
      if (typeof value === 'number') numericStats[key] = value
    }
    return {
      type: 'completionStats',
      stats: numericStats
    }
  }
  if (event.type === 'completionDone') {
    if (
      event.stopReason === undefined ||
      event.stopReason === 'eos' ||
      event.stopReason === 'length' ||
      event.stopReason === 'stopSequence'
    ) {
      return { type: 'completionDone', stopReason: 'eos' }
    }
    if (event.stopReason === 'cancelled') {
      return { type: 'completionDone', stopReason: 'cancelled' }
    }
    if (event.stopReason === 'error') {
      return completionError(event.error?.message ?? 'SDK completion error')
    }
    return completionError(`unmapped SDK stop reason: ${event.stopReason ?? 'unknown'}`)
  }
  if (event.type === 'toolError') {
    return completionError(event.error?.message ?? 'SDK tool error')
  }
  return completionError(`unmapped SDK event: ${event.type}`)
}

function completionError(message: string): PublicSdkCompletionEvent {
  return {
    type: 'completionDone',
    stopReason: 'error',
    error: { message }
  }
}

function runCleanupSteps(
  steps: ReadonlyArray<() => Promise<void>>,
  { suppressError = false }: { readonly suppressError?: boolean } = {}
) {
  return (async () => {
    let firstError: unknown = null
    for (const step of steps) {
      try {
        await step()
      } catch (error) {
        if (firstError === null) firstError = error
      }
    }
    if (!suppressError && firstError !== null) throw firstError
  })()
}

function toJsonRecord(input: Readonly<Record<string, unknown>>) {
  const output: Record<string, HarnessJsonValue> = {}
  for (const [key, value] of Object.entries(input)) {
    output[key] = toJsonValue(value)
  }
  return output
}

function toJsonValue(value: unknown): HarnessJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toJsonValue(entry))
  }
  if (typeof value === 'object') {
    const output: Record<string, HarnessJsonValue> = {}
    for (const [key, entry] of Object.entries(value)) {
      output[key] = toJsonValue(entry)
    }
    return output
  }
  return String(value)
}

function runtimeExpectation(component: 'sync' | 'harness') {
  const expected =
    component === 'sync' ? expectedSyncHandshake() : expectedHarnessHandshake()
  return {
    contract: expected.contract,
    protocolVersion: expected.protocolVersion,
    requiredCapabilities: expected.requiredPeerCapabilities
  }
}

function createExitMonitor() {
  let closing = false
  let resolved = false
  let resolveExit: ((value: { code: number | null; signal: string | null }) => void) | null = null
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveExit = resolve
  })
  return {
    exited,
    markClosing() {
      closing = true
    },
    onUnexpectedExit() {
      if (closing || resolved || resolveExit === null) return
      resolved = true
      resolveExit({ code: null, signal: null })
    }
  }
}

function closeOnce(close: () => Promise<void>) {
  let closed: Promise<void> | null = null
  return function closeIdempotent() {
    if (closed) return closed
    closed = close()
    return closed
  }
}
