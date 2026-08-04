import AbortController from '#abort-controller'
import HarnessRPC, {
  type GeneratedRunStream,
  type WireValue
} from '../spec/hrpc/index.js'
import { createAsyncQueue } from './queue.ts'
import type { HarnessAgentRegistration } from './agent-registration.ts'
import type {
  HarnessAgentRunInput,
  HarnessEvent,
  HarnessRuntime,
  LocalHarnessRuntime
} from './types.ts'
import type { HarnessStream } from './transport.ts'
import type { HarnessRuntimeInfo } from './connect.ts'

interface StartFrame {
  readonly type: 'start'
  readonly runId: string
  readonly traceId: string
  readonly model: string
  readonly messages: ReadonlyArray<{
    readonly role: 'system' | 'user' | 'assistant' | 'tool'
    readonly content: string
  }>
}

export function serveHarness(
  stream: HarnessStream,
  harness: HarnessRuntime,
  describeRuntime: () => HarnessRuntimeInfo = defaultRuntimeInfo,
  attachStatePort?: (stream: GeneratedRunStream) => void
) {
  const rpc = new HarnessRPC(stream)
  rpc.onDescribeRuntime(async () => {
    const identity = describeRuntime()
    return {
      type: 'runtime-info',
      component: identity.component,
      runtime: identity.runtime,
      instanceId: identity.instanceId,
      processId: identity.processId,
      contract: identity.contract,
      protocolVersion: identity.protocolVersion,
      capabilities: [...identity.capabilities],
      buildVersion: identity.buildVersion,
      ...(identity.sdkIdentity === undefined
        ? {}
        : { sdkIdentity: { ...identity.sdkIdentity } })
    }
  })
  rpc.onRun(async (duplex) => {
    for await (const frame of serveRun(duplex, harness)) duplex.write(frame)
    duplex.end?.()
  })
  if (isLocalHarness(harness)) {
    if (attachStatePort) {
      rpc.onStatePort(async (stateStream) => {
        attachStatePort(stateStream)
      })
    }
    rpc.onSuspend(async () => {
      await harness.suspend()
      return { type: 'suspended' }
    })
    rpc.onResume(async () => {
      await harness.resume()
      return { type: 'resumed' }
    })
    rpc.onListSkills(async () => ({
      type: 'skills',
      data: jsonWire(await harness.listSkills())
    }))
    rpc.onRegisterAgent(async (frame) => {
      await harness.registerAgent(parseRegistration(frame.data))
      return { type: 'registered' }
    })
    rpc.onRunAgent(async (duplex) => {
      for await (const frame of serveAgentRun(duplex, harness)) duplex.write(frame)
      duplex.end?.()
    })
    rpc.onCancelAgentRun(async (frame) => {
      await harness.cancelAgentRun(parseRunKey(frame))
      return { type: 'canceled' }
    })
    rpc.onReadRun(async (frame) => ({
      type: 'run-record',
      data: jsonWire(await harness.readRun(parseRunKey(frame)))
    }))
    rpc.onWatchWork(async (duplex) => {
      for await (const frame of serveWorkWatch(duplex, harness)) duplex.write(frame)
      duplex.end?.()
    })
  }
  return rpc
}

function defaultRuntimeInfo(): HarnessRuntimeInfo {
  return {
    component: 'harness',
    runtime: 'bare',
    instanceId: 'harness-unidentified',
    processId: 0,
    contract: 'qvac.harness',
    protocolVersion: 1,
    capabilities: ['execution.run', 'state.sync'],
    buildVersion: '0.0.0-poc'
  }
}

async function* serveAgentRun(
  duplex: GeneratedRunStream,
  harness: LocalHarnessRuntime
) {
  const starts = createAsyncQueue<HarnessAgentRunInput>()
  const controller = new AbortController()
  let started = false
  const gone = () => {
    controller.abort('client gone')
    starts.end()
  }
  duplex.on('close', gone)
  duplex.readStream?.on('close', gone)
  duplex.on('data', (frame) => {
    if (started) return
    const parsed = parseAgentRun(frame, controller.signal)
    if (!parsed) return
    started = true
    starts.push(parsed)
    starts.end()
  })
  for await (const input of starts) {
    for await (const event of harness.runAgent(input)) {
      yield toWire(event, input.runId)
    }
    yield { type: 'complete', traceId: input.runId }
  }
}

async function* serveWorkWatch(
  duplex: GeneratedRunStream,
  harness: LocalHarnessRuntime
) {
  const controller = new AbortController()
  let after: string | undefined
  let started = false
  const gone = () => controller.abort('client gone')
  duplex.on('close', gone)
  duplex.readStream?.on('close', gone)
  duplex.on('data', (frame) => {
    if (started) return
    started = true
    after = typeof frame.data === 'string' ? frame.data : undefined
  })
  while (!started && !controller.signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  if (controller.signal.aborted) return
  for await (const change of harness.watchWork({
    ...(after ? { after } : {}),
    signal: controller.signal
  })) {
    yield { type: 'work-change', data: jsonWire(change) }
  }
}

async function* serveRun(
  duplex: GeneratedRunStream,
  harness: HarnessRuntime
): AsyncGenerator<Record<string, WireValue>> {
  const starts = createAsyncQueue<StartFrame>()
  const controller = new AbortController()
  let started = false
  const gone = () => {
    controller.abort('client gone')
    starts.end()
  }
  duplex.on('close', gone)
  duplex.readStream?.on('close', gone)
  duplex.on('data', (frame) => {
    const parsed = parseStartFrame(frame)
    if (started || !parsed) return
    started = true
    starts.push(parsed)
    starts.end()
  })

  for await (const frame of starts) {
    for await (const event of harness.run({
      runId: frame.runId,
      traceId: frame.traceId,
      model: frame.model,
      messages: frame.messages,
      signal: controller.signal
    })) {
      yield toWire(event, frame.traceId)
    }
    yield { type: 'complete', traceId: frame.traceId }
  }
}

function parseStartFrame(frame: Record<string, WireValue>): StartFrame | null {
  if (
    frame.type !== 'start' ||
    typeof frame.runId !== 'string' ||
    typeof frame.traceId !== 'string' ||
    typeof frame.model !== 'string' ||
    !Array.isArray(frame.messages)
  ) {
    return null
  }
  const messages: Array<StartFrame['messages'][number]> = []
  for (const message of frame.messages) {
    if (
      typeof message !== 'object' ||
      message === null ||
      typeof Reflect.get(message, 'role') !== 'string' ||
      typeof Reflect.get(message, 'content') !== 'string'
    ) {
      return null
    }
    const role = Reflect.get(message, 'role')
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') return null
    messages.push({ role, content: Reflect.get(message, 'content') })
  }
  return {
    type: 'start',
    runId: frame.runId,
    traceId: frame.traceId,
    model: frame.model,
    messages
  }
}

function parseAgentRun(
  frame: Record<string, WireValue>,
  signal: HarnessAgentRunInput['signal']
): HarnessAgentRunInput | null {
  if (
    frame.type !== 'start' ||
    typeof frame.agentId !== 'string' ||
    typeof frame.runId !== 'string' ||
    typeof frame.input !== 'string'
  ) {
    return null
  }
  return {
    agentId: frame.agentId,
    runId: frame.runId,
    input: frame.input,
    signal
  }
}

function parseRunKey(frame: Record<string, WireValue>) {
  if (typeof frame.agentId !== 'string' || typeof frame.runId !== 'string') {
    throw new Error('invalid Harness run identity')
  }
  return {
    agentId: frame.agentId,
    runId: frame.runId,
    ...(typeof frame.reason === 'string' ? { reason: frame.reason } : {})
  }
}

function parseRegistration(value: WireValue | undefined): HarnessAgentRegistration {
  if (!isRecord(value)) throw new Error('invalid Harness agent registration')
  return value as unknown as HarnessAgentRegistration
}

function isRecord(value: WireValue | undefined): value is Record<string, WireValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isLocalHarness(runtime: HarnessRuntime): runtime is LocalHarnessRuntime {
  return 'runAgent' in runtime
}

function jsonWire(value: unknown): WireValue {
  return JSON.parse(JSON.stringify(value)) as WireValue
}

function toWire(
  event: HarnessEvent,
  traceId: string
): Record<string, WireValue> {
  switch (event.type) {
    case 'content':
    case 'thinking':
      return { type: event.type, text: event.text, traceId }
    case 'tool-call':
      return { type: event.type, name: event.name, args: event.args, traceId }
    case 'tool-result':
      return {
        type: event.type,
        name: event.name,
        result: event.result,
        traceId
      }
    case 'tool-progress':
      return {
        type: event.type,
        name: event.name,
        progress: event.progress,
        traceId
      }
    case 'metrics':
      return { type: event.type, metrics: event.metrics, traceId }
    case 'error':
      return {
        type: event.type,
        message: event.message,
        traceId,
        ...(event.error === undefined
          ? {}
          : {
              error: JSON.parse(
                JSON.stringify(event.error)
              ) as WireValue
            })
      }
    case 'aborted':
      return { type: event.type, traceId }
  }
}
