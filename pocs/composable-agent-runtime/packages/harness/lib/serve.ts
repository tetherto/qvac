import AbortController from '#abort-controller'
import HarnessRPC, {
  type GeneratedRunStream,
  type WireValue
} from '../spec/hrpc/index.js'
import { createAsyncQueue } from './queue.ts'
import type { HarnessEvent, HarnessRuntime } from './types.ts'
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
  describeRuntime: () => HarnessRuntimeInfo = defaultRuntimeInfo
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
