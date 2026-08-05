import type { LoadModelOptions } from '@qvac/sdk'
import type { SyncRuntime } from '@qvac/sync'
import defaultLauncher from '../../react-native-launcher.ts'
import { connectHarness, type HarnessClient } from '../connect.ts'
import { createInMemoryHarnessRunStore } from '../in-memory-harness-run-store.ts'
import {
  createHostSdkTransportServer,
  type PublicSdkCompletionEvent,
  type PublicSdkLike
} from '../mobile-sdk-transport.ts'
import { createSyncHarnessRunStore } from '../sync-harness-run-store.ts'
import type { HarnessRunStore } from '../run-store.ts'
import type { HarnessLoggingConfig } from '../types.ts'
import { assertCompatibleHarness } from './compatibility.ts'
import type {
  HarnessRuntime,
  HarnessRuntimeExit
} from './create-harness.ts'
import {
  configArgvForHarness,
  configForHarnessRuntime
} from '../config.ts'

export interface CreateMobileHarnessOptions {
  readonly inference?: 'qwen'
  readonly logging?: HarnessLoggingConfig
  readonly state?: SyncRuntime
}

export function createMobileHarness({
  inference = 'qwen',
  logging,
  state
}: CreateMobileHarnessOptions = {}): HarnessRuntime {
  if (inference !== 'qwen') {
    throw new Error(`unsupported mobile Harness inference: ${String(inference)}`)
  }
  const runStore: HarnessRunStore = state
    ? createSyncHarnessRunStore(state)
    : createInMemoryHarnessRunStore()
  const config = configForHarnessRuntime(logging)
  let started: Awaited<ReturnType<typeof defaultLauncher.start>> | null = null
  let client: HarnessClient | null = null
  let sdkBridge: { close(): Promise<void> } | null = null
  let readyPromise: Promise<void> | null = null
  let closePromise: Promise<void> | null = null
  let terminalError: Error | null = null
  let resolveExit!: (exit: HarnessRuntimeExit) => void
  const exited = new Promise<HarnessRuntimeExit>((resolve) => {
    resolveExit = resolve
  })

  async function ready() {
    if (closePromise) throw new Error('Harness runtime is closed')
    if (terminalError) throw terminalError
    if (client) return
    readyPromise ??= open()
    await readyPromise
  }

  async function open() {
    const next = await defaultLauncher.start(
      'Harness',
      {},
      configArgvForHarness(config)
    )
    started = next
    const onExit = () => {
      const deliberate = closePromise !== null
      if (!deliberate) terminalError = new Error('Harness worker crashed')
      resolveExit({
        kind: deliberate ? 'closed' : 'crashed',
        code: null,
        signal: null
      })
    }
    next.ipc.on('close', onExit)
    next.ipc.on('error', onExit)
    next.sdkIpc.on('close', onExit)
    next.sdkIpc.on('error', onExit)
    try {
      sdkBridge = await createDefaultSdkBridge(next.sdkIpc)
      client = connectHarness(async () => next.ipc, { runStore })
      assertCompatibleHarness(await client.describeRuntime())
    } catch (error) {
      await closeResources()
      throw error
    }
  }

  function requireClient() {
    if (closePromise) throw new Error('Harness runtime is closed')
    if (terminalError) throw terminalError
    if (!client) throw new Error('Harness runtime is not ready')
    return client
  }

  async function closeResources() {
    const activeClient = client
    const activeBridge = sdkBridge
    const active = started
    client = null
    sdkBridge = null
    started = null
    await activeClient?.close().catch(() => {})
    await activeBridge?.close().catch(() => {})
    await active?.worklet.terminate().catch(() => {})
  }

  async function close() {
    closePromise ??= (async () => {
      if (readyPromise) await readyPromise.catch(() => {})
      await closeResources()
      if (!readyPromise) await runStore.close()
    })()
    await closePromise
  }

  return {
    exited,
    ready,
    lifecycle: {
      async suspend() {
        await ready()
        await requireClient().suspend()
      },
      async resume() {
        await ready()
        await requireClient().resume()
      }
    },
    runtime: {
      async describe() {
        await ready()
        return requireClient().describeRuntime()
      }
    },
    async listSkills() {
      await ready()
      return requireClient().listSkills()
    },
    async registerAgent(registration) {
      await ready()
      await requireClient().registerAgent(registration)
    },
    async *runAgent(input) {
      await ready()
      yield* requireClient().runAgent(input)
    },
    async cancelAgentRun(input) {
      await ready()
      await requireClient().cancelAgentRun(input)
    },
    async readRun(input) {
      await ready()
      return requireClient().readRun(input)
    },
    async *watchWork(input) {
      await ready()
      yield* requireClient().watchWork(input)
    },
    async *watchApprovals() {
      await ready()
      yield* requireClient().watchApprovals()
    },
    async resolveApproval(decision) {
      await ready()
      await requireClient().resolveApproval(decision)
    },
    close
  }
}

async function createDefaultSdkBridge(
  sdkIpc: Parameters<typeof createHostSdkTransportServer>[0]
) {
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
  return 'user'
}

async function* mapSdkEvents(
  events: AsyncIterable<{
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
  }>
): AsyncIterable<PublicSdkCompletionEvent> {
  for await (const event of events) yield mapPublicSdkCompletionEvent(event)
}

export function mapPublicSdkCompletionEvent(
  event: Parameters<typeof mapSdkEvents>[0] extends AsyncIterable<infer Event>
    ? Event
    : never
): PublicSdkCompletionEvent {
  if (event.type === 'thinkingDelta' || event.type === 'contentDelta') {
    return { type: event.type, text: event.text ?? '' }
  }
  if (event.type === 'toolCall') {
    if (event.call) {
      return {
        type: 'toolCall',
        call: {
          name: event.call.name,
          arguments: JSON.parse(JSON.stringify(event.call.arguments))
        }
      }
    }
    return completionError('SDK tool call omitted call details')
  }
  if (event.type === 'toolResult') {
    return {
      type: 'toolResult',
      name: event.name ?? '',
      result: JSON.parse(JSON.stringify(event.result ?? null))
    }
  }
  if (event.type === 'completionStats') {
    const stats: Record<string, number> = {}
    for (const [name, value] of Object.entries(event.stats ?? {})) {
      if (typeof value === 'number') stats[name] = value
    }
    return { type: 'completionStats', stats }
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
    return completionError(
      `unmapped SDK stop reason: ${event.stopReason ?? 'unknown'}`
    )
  }
  return completionError(
    event.type === 'toolError'
      ? event.error?.message ?? 'SDK tool error'
      : `unmapped SDK event: ${event.type}`
  )
}

function completionError(message: string): PublicSdkCompletionEvent {
  return {
    type: 'completionDone',
    stopReason: 'error',
    error: { message }
  }
}

export function createPublicSdkBridge({
  sdkIpc,
  publicSdk
}: {
  readonly sdkIpc: Parameters<typeof createHostSdkTransportServer>[0]
  readonly publicSdk: PublicSdkLike
}) {
  const server = createHostSdkTransportServer(sdkIpc, publicSdk)
  return Promise.resolve({ close: () => server.close() })
}
