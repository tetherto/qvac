import harnessHarness from '../generated/harness.js'
import sdkHarness from '../generated/sdk.js'
import crashHarness from '../generated/crash.js'
import { Platform } from 'react-native'
import { androidSdkHarness } from './android-sdk-harness'
import {
  BUILD_VERSION,
  COMPONENTS,
  PROTOCOL_CONTRACT,
  PROTOCOL_VERSION,
  createTraceId,
  encodeMessage,
  isCompatibleHandshake,
  parseMessage,
  type ComponentName,
  type RuntimeCommand,
  type RuntimeEvent,
  type RuntimeState,
  type TraceMetadata
} from './protocol'

const RESPONSE_TIMEOUT_MS = 5_000

type WorkletHarness = typeof harnessHarness | typeof androidSdkHarness
type StartedHarness = Awaited<ReturnType<WorkletHarness['start']>>

export interface RuntimeSnapshot {
  readonly component: ComponentName
  readonly state: RuntimeState
  readonly metadata: TraceMetadata | null
  readonly lastTraceId: string | null
  readonly coldReadyMs: number | null
  readonly resumeMs: number | null
  readonly error: string | null
}

export interface RunnerBroker {
  snapshots(): readonly RuntimeSnapshot[]
  start(component: ComponentName): Promise<void>
  handshake(component: ComponentName): Promise<void>
  terminate(component: ComponentName): Promise<void>
  suspend(component: ComponentName): Promise<void>
  resume(component: ComponentName): Promise<void>
  hardCrashSdk(): void
}

interface PendingResponse {
  readonly resolve: (event: RuntimeEvent) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

interface Runner {
  readonly component: ComponentName
  readonly harness: WorkletHarness
  snapshot: RuntimeSnapshot
  started: StartedHarness | null
  buffered: string
  pending: Map<string, PendingResponse>
  gracefulStop: boolean
}

export function createRunnerBroker(onChange: () => void): RunnerBroker {
  const runners: Record<ComponentName, Runner> = {
    Harness: createRunner('Harness', harnessHarness),
    SDK: createRunner(
      'SDK',
      Platform.OS === 'android' ? androidSdkHarness : sdkHarness
    )
  }

  function snapshots() {
    return COMPONENTS.map((component) => ({ ...runners[component].snapshot }))
  }

  async function start(component: ComponentName) {
    const runner = runners[component]
    if (runner.started !== null) return
    update(runner, { state: 'starting', error: null })
    const startedAt = performance.now()

    try {
      runner.buffered = ''
      runner.started = await runner.harness.start(component)
      runner.gracefulStop = false
      observeIPC(runner)
      update(runner, {
        state: 'ready',
        coldReadyMs: performance.now() - startedAt
      })
    } catch (error) {
      runner.started = null
      update(runner, { state: 'error', error: errorMessage(error) })
      throw error
    }
  }

  async function handshake(component: ComponentName) {
    const runner = activeRunner(runners[component])
    const event = await request(runner, 'handshake')
    const reason = isCompatibleHandshake(hostMetadata, event.source)
    if (event.compatible !== true || reason !== null) {
      const detail = event.reason ?? reason ?? 'runtime rejected handshake'
      update(runner, { state: 'error', error: detail })
      throw new Error(detail)
    }
    update(runner, {
      state: 'ready',
      metadata: runtimeMetadata(runner, event.source),
      lastTraceId: event.traceId,
      error: null
    })
  }

  async function terminate(component: ComponentName) {
    const runner = runners[component]
    if (runner.started === null) return
    const wasSuspended = runner.snapshot.state === 'suspended'
    runner.gracefulStop = true
    update(runner, { state: 'stopping' })
    try {
      if (wasSuspended) {
        runner.started.worklet.resume()
      }
      runner.started.worklet.terminate()
      clearPending(runner, new Error(`${component} stopped`))
      runner.started = null
      update(runner, { state: 'stopped' })
    } catch (error) {
      runner.started = null
      update(runner, { state: 'error', error: errorMessage(error) })
      throw error
    }
  }

  async function suspend(component: ComponentName) {
    const runner = activeRunner(runners[component])
    const event = await request(runner, 'prepare-suspend')
    runner.started?.worklet.suspend()
    update(runner, {
      state: 'suspended',
      lastTraceId: event.traceId
    })
  }

  async function resume(component: ComponentName) {
    const runner = activeRunner(runners[component])
    const startedAt = performance.now()
    runner.started?.worklet.resume()
    const event = await request(runner, 'resume')
    update(runner, {
      state: 'ready',
      lastTraceId: event.traceId,
      resumeMs: performance.now() - startedAt
    })
  }

  function hardCrashSdk() {
    const runner = activeRunner(runners.SDK)
    const message = createCommand('hard-crash')
    update(runner, { lastTraceId: message.traceId })
    if (Platform.OS === 'android') {
      void androidSdkHarness
        .crash('SDK-crash')
        .catch((error) => markDied(runner, toError(error)))
    } else {
      void crashHarness.start('SDK-crash')
    }
  }

  function update(
    runner: Runner,
    change: Partial<Omit<RuntimeSnapshot, 'component'>>
  ) {
    runner.snapshot = { ...runner.snapshot, ...change }
    onChange()
  }

  function observeIPC(runner: Runner) {
    const started = activeRunner(runner).started
    const decoder = new TextDecoder()
    started?.ipc.on('data', (data: unknown) => {
      const bytes = data as Uint8Array
      runner.buffered += decoder.decode(bytes, { stream: true })
      const lines = runner.buffered.split('\n')
      runner.buffered = lines.pop() ?? ''
      for (const line of lines) {
        if (line.length === 0) continue
        try {
          acceptEvent(runner, parseMessage(line))
        } catch (error) {
          update(runner, { state: 'error', error: errorMessage(error) })
        }
      }
    })
    started?.ipc.on('error', (error: Error) => markDied(runner, error))
    started?.ipc.on('close', () => {
      if (!runner.gracefulStop && runner.started !== null) {
        markDied(runner, new Error(`${runner.component} IPC closed unexpectedly`))
      }
    })
  }

  function acceptEvent(
    runner: Runner,
    message: ReturnType<typeof parseMessage>
  ) {
    if (message.type !== 'event') {
      throw new Error('Host only accepts event messages from runtimes')
    }
    if (message.source.component !== runner.component) {
      throw new Error(
        `Expected ${runner.component} metadata, received ${message.source.component}`
      )
    }

    update(runner, {
      metadata: runtimeMetadata(runner, message.source),
      lastTraceId: message.traceId
    })
    if (message.requestId === null) return
    const pending = runner.pending.get(message.requestId)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    runner.pending.delete(message.requestId)
    pending.resolve(message)
  }

  function markDied(runner: Runner, error: Error) {
    clearPending(runner, error)
    runner.started = null
    update(runner, { state: 'died', error: error.message })
  }

  async function request(runner: Runner, command: RuntimeCommand['command']) {
    const message = createCommand(command)
    const response = new Promise<RuntimeEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        runner.pending.delete(message.requestId)
        reject(new Error(`${runner.component} ${command} timed out`))
      }, RESPONSE_TIMEOUT_MS)
      runner.pending.set(message.requestId, { resolve, reject, timer })
    })
    runner.started?.ipc.write(new TextEncoder().encode(encodeMessage(message)))
    return response
  }

  return {
    snapshots,
    start,
    handshake,
    terminate,
    suspend,
    resume,
    hardCrashSdk
  }
}

const hostMetadata: TraceMetadata = {
  component: 'MobileHost',
  contract: PROTOCOL_CONTRACT,
  protocolVersion: PROTOCOL_VERSION,
  capabilities: ['host-runner-broker', 'protocol-handshake', 'trace-metadata'],
  buildVersion: BUILD_VERSION,
  runtimeId: createTraceId('hermes'),
  processId: null,
  runtime: 'hermes'
}

function createRunner(
  component: ComponentName,
  harness: WorkletHarness
): Runner {
  return {
    component,
    harness,
    snapshot: {
      component,
      state: 'idle',
      metadata: null,
      lastTraceId: null,
      coldReadyMs: null,
      resumeMs: null,
      error: null
    },
    started: null,
    buffered: '',
    pending: new Map(),
    gracefulStop: false
  }
}

function activeRunner(runner: Runner) {
  if (runner.started === null) {
    throw new Error(`${runner.component} runtime is not running`)
  }
  return runner
}

function createCommand(command: RuntimeCommand['command']): RuntimeCommand {
  return {
    type: 'command',
    command,
    requestId: createTraceId('request'),
    traceId: createTraceId(),
    timestamp: Date.now(),
    source: hostMetadata
  }
}

function clearPending(runner: Runner, error: Error) {
  for (const pending of runner.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  runner.pending.clear()
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error))
}

function runtimeMetadata(runner: Runner, metadata: TraceMetadata) {
  const worklet = runner.started?.worklet
  if (
    worklet !== undefined &&
    'pid' in worklet &&
    typeof worklet.pid === 'number'
  ) {
    return { ...metadata, processId: worklet.pid }
  }
  return metadata
}
