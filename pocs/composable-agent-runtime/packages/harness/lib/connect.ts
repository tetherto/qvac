import HarnessRPC, { type GeneratedRunStream, type WireValue } from '../spec/hrpc/index.js'
import type { HarnessEvent, HarnessRunInput, HarnessRuntime } from './types.ts'
import type { HarnessStream, HarnessTransport } from './transport.ts'
import type { RuntimeErrorEnvelope } from '@qvac/runtime-contracts'

export interface RemoteHarness extends HarnessRuntime {
  readonly lives: number
  describeRuntime(): Promise<HarnessRuntimeInfo>
}

export interface HarnessRuntimeInfo {
  readonly component: string
  readonly runtime: string
  readonly instanceId: string
  readonly processId: number
  readonly contract: string
  readonly protocolVersion: number
  readonly capabilities: readonly string[]
  readonly buildVersion: string
  readonly sdkIdentity?: {
    readonly component: string
    readonly runtime: string
    readonly instanceId: string
    readonly processId: number
    readonly buildVersion: string
  }
}

export function connectHarness(transport: HarnessTransport): RemoteHarness {
  let session: { readonly rpc: HarnessRPC; readonly stream: HarnessStream } | null = null
  let opening: Promise<{ readonly rpc: HarnessRPC; readonly stream: HarnessStream }> | null = null
  let closed = false
  let lives = 0

  async function open() {
    if (closed) throw died('harness closed')
    if (session) return session
    opening ??= Promise.resolve(transport()).then((stream) => {
      if (closed) {
        stream.destroy()
        throw died('harness closed')
      }
      const next = { rpc: new HarnessRPC(stream), stream }
      stream.on('close', () => {
        session = null
      })
      session = next
      lives++
      return next
    })
    return opening
  }

  async function* run(input: HarnessRunInput): AsyncGenerator<HarnessEvent> {
    const { rpc } = await open()
    const duplex = rpc.run()
    const traceId = input.traceId ?? input.runId
    let emittedAborted = false
    const abort = () => duplex.destroy()
    duplex.write({
      type: 'start',
      runId: input.runId,
      traceId,
      model: input.model,
      messages: input.messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    })
    if (input.signal.aborted) {
      duplex.destroy()
      yield { type: 'aborted' }
      return
    }
    input.signal.addEventListener('abort', abort, { once: true })
    try {
      for await (const frame of frames(duplex)) {
        if (frame.traceId !== traceId) {
          throw died('harness response trace ID mismatch')
        }
        if (frame.type === 'complete') {
          duplex.end()
          continue
        }
        const event = fromWire(frame)
        if (event.type === 'aborted') emittedAborted = true
        yield event
      }
    } catch (cause) {
      if (!input.signal.aborted) {
        const message = cause instanceof Error ? cause.message : String(cause)
        throw died(`harness died mid-run: ${message}`)
      }
    } finally {
      input.signal.removeEventListener('abort', abort)
      duplex.destroy()
    }
    if (input.signal.aborted && !emittedAborted) yield { type: 'aborted' }
  }

  return {
    run,
    async describeRuntime() {
      const { rpc } = await open()
      return parseRuntimeInfo(await rpc.describeRuntime({ type: 'describe' }))
    },
    get lives() {
      return lives
    },
    async close() {
      closed = true
      session?.stream.destroy()
      session = null
    }
  }
}

function parseRuntimeInfo(frame: Record<string, WireValue>): HarnessRuntimeInfo {
  const capabilities: string[] = []
  if (Array.isArray(frame.capabilities)) {
    for (const value of frame.capabilities) {
      if (typeof value === 'string') capabilities.push(value)
    }
  }
  const sdkIdentity = isRecord(frame.sdkIdentity)
    ? parseIdentity(frame.sdkIdentity)
    : undefined
  if (
    typeof frame.component !== 'string' ||
    typeof frame.runtime !== 'string' ||
    typeof frame.instanceId !== 'string' ||
    typeof frame.processId !== 'number' ||
    typeof frame.contract !== 'string' ||
    typeof frame.protocolVersion !== 'number' ||
    typeof frame.buildVersion !== 'string'
  ) {
    throw new Error('Harness returned an invalid runtime identity')
  }
  return {
    component: frame.component,
    runtime: frame.runtime,
    instanceId: frame.instanceId,
    processId: frame.processId,
    contract: frame.contract,
    protocolVersion: frame.protocolVersion,
    capabilities,
    buildVersion: frame.buildVersion,
    ...(sdkIdentity === undefined ? {} : { sdkIdentity })
  }
}

function parseIdentity(value: Record<string, WireValue>) {
  if (
    typeof value.component !== 'string' ||
    typeof value.runtime !== 'string' ||
    typeof value.instanceId !== 'string' ||
    typeof value.processId !== 'number' ||
    typeof value.buildVersion !== 'string'
  ) {
    return undefined
  }
  return {
    component: value.component,
    runtime: value.runtime,
    instanceId: value.instanceId,
    processId: value.processId,
    buildVersion: value.buildVersion
  }
}

function fromWire(frame: Record<string, WireValue>): HarnessEvent {
  const type = frame.type
  switch (type) {
    case 'content':
    case 'thinking':
      return { type, text: typeof frame.text === 'string' ? frame.text : '' }
    case 'tool-call':
      return {
        type,
        name: typeof frame.name === 'string' ? frame.name : '',
        args: isRecord(frame.args) ? frame.args : {}
      }
    case 'tool-result':
      return {
        type,
        name: typeof frame.name === 'string' ? frame.name : '',
        result: wireValue(frame.result)
      }
    case 'metrics':
      return { type, metrics: numericRecord(frame.metrics) }
    case 'error':
      return {
        type,
        message:
          typeof frame.message === 'string' ? frame.message : 'harness error',
        ...(isRuntimeErrorEnvelope(frame.error)
          ? { error: frame.error as unknown as RuntimeErrorEnvelope }
          : {})
      }
    case 'aborted':
      return { type }
    default:
      return { type: 'error', message: `unmapped harness event: ${String(type)}` }
  }
}

function isRecord(value: WireValue | undefined): value is Record<string, WireValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function wireValue(value: WireValue | undefined) {
  return value ?? null
}

function numericRecord(value: WireValue | undefined) {
  if (!isRecord(value)) return {}
  const metrics: Record<string, number> = {}
  for (const [key, metric] of Object.entries(value)) {
    if (typeof metric === 'number') metrics[key] = metric
  }
  return metrics
}

function isRuntimeErrorEnvelope(
  value: WireValue | undefined
): boolean {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    typeof value.message === 'string' &&
    typeof value.recoverable === 'boolean'
  )
}

function died(message: string) {
  const error = new Error(message)
  Reflect.set(error, 'code', 'HARNESS_DIED')
  return error
}

async function* frames(stream: GeneratedRunStream) {
  for await (const frame of stream) yield frame
}
