import HarnessRPC, { type GeneratedRunStream, type WireValue } from '../spec/hrpc/index.js'
import type {
  HarnessAgentRunInput,
  HarnessAgentRunKey,
  HarnessErrorEnvelope,
  HarnessEvent,
  HarnessRunInput,
  HarnessRuntime,
  HarnessSkillInfo
} from './types.ts'
import type { HarnessAgentRegistration } from './agent-registration.ts'
import type {
  HarnessRunStore,
  HarnessRunRecord,
  HarnessWorkChange,
  WatchHarnessWork
} from './run-store.ts'
import { serveHarnessRunStore } from './state-port.ts'
import {
  createHarnessApprovalHost,
  type HarnessApprovalDecision,
  type HarnessApprovalRequest
} from './approval-port.ts'
import type { HarnessStream, HarnessTransport } from './transport.ts'

export interface HarnessClient extends HarnessRuntime {
  readonly lives: number
  suspend(): Promise<void>
  resume(): Promise<void>
  describeRuntime(): Promise<HarnessRuntimeInfo>
  listSkills(): Promise<readonly HarnessSkillInfo[]>
  registerAgent(registration: HarnessAgentRegistration): Promise<void>
  runAgent(input: HarnessAgentRunInput): AsyncIterable<HarnessEvent>
  cancelAgentRun(input: HarnessAgentRunKey): Promise<void>
  readRun(input: HarnessAgentRunKey): Promise<HarnessRunRecord | null>
  watchWork(input?: WatchHarnessWork): AsyncIterable<HarnessWorkChange>
  watchApprovals(): AsyncIterable<HarnessApprovalRequest>
  resolveApproval(decision: HarnessApprovalDecision): Promise<void>
}

export type RemoteHarness = HarnessClient

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

export interface ConnectHarnessOptions {
  readonly runStore?: HarnessRunStore
}

export function connectHarness(
  transport: HarnessTransport,
  { runStore }: ConnectHarnessOptions = {}
): RemoteHarness {
  let session: { readonly rpc: HarnessRPC; readonly stream: HarnessStream } | null = null
  let opening: Promise<{ readonly rpc: HarnessRPC; readonly stream: HarnessStream }> | null = null
  let closed = false
  let lives = 0
  const approvals = createHarnessApprovalHost()
  // Opened only when the application actually handles approvals. An always-open
  // stream would keep an otherwise idle session alive, and a caller that never
  // watches should see approval-required tools denied, not queued.
  let approvalsAttached = false

  function attachApprovalsIfOpen() {
    if (approvalsAttached || !session) return
    approvalsAttached = true
    approvals.attach(session.rpc.approvals())
  }

  async function openApprovals() {
    await open()
    attachApprovalsIfOpen()
  }

  async function open() {
    if (closed) throw died('harness closed')
    if (session) return session
    opening ??= Promise.resolve(transport()).then((stream) => {
      if (closed) {
        stream.destroy()
        throw died('harness closed')
      }
      const next = { rpc: new HarnessRPC(stream), stream }
      if (runStore) {
        serveHarnessRunStore(next.rpc.statePort(), runStore)
      }
      stream.on('close', () => {
        session = null
        approvalsAttached = false
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

  async function* runAgent(
    input: HarnessAgentRunInput
  ): AsyncGenerator<HarnessEvent> {
    const { rpc } = await open()
    const duplex = rpc.runAgent()
    let completed = false
    const abort = () => duplex.destroy()
    duplex.write({
      type: 'start',
      agentId: input.agentId,
      runId: input.runId,
      input: input.input
    })
    if (input.signal?.aborted) {
      duplex.destroy()
      yield { type: 'aborted' }
      return
    }
    input.signal?.addEventListener('abort', abort, { once: true })
    try {
      for await (const frame of frames(duplex)) {
        if (frame.type === 'complete') {
          completed = true
          duplex.end()
          continue
        }
        yield fromWire(frame)
      }
    } finally {
      input.signal?.removeEventListener('abort', abort)
      duplex.destroy()
    }
    if (!completed && input.signal?.aborted) yield { type: 'aborted' }
  }

  async function* watchWork(
    input: WatchHarnessWork = {}
  ): AsyncGenerator<HarnessWorkChange> {
    const { rpc } = await open()
    const duplex = rpc.watchWork()
    const abort = () => duplex.destroy()
    duplex.write({ type: 'start', ...(input.after ? { data: input.after } : {}) })
    input.signal?.addEventListener('abort', abort, { once: true })
    try {
      for await (const frame of frames(duplex)) {
        if (frame.type !== 'work-change') continue
        yield frame.data as unknown as HarnessWorkChange
      }
    } finally {
      input.signal?.removeEventListener('abort', abort)
      duplex.destroy()
    }
  }

  return {
    run,
    runAgent,
    watchWork,
    watchApprovals() {
      // Attach at call time, not on first iteration, so a caller that starts
      // watching before a run cannot miss the first approval.
      attachApprovalsIfOpen()
      const opening = openApprovals()
      return (async function* () {
        await opening
        yield* approvals.watch()
      })()
    },
    async resolveApproval(decision) {
      await openApprovals()
      await approvals.resolve(decision)
    },
    async suspend() {
      const { rpc } = await open()
      await rpc.suspend({ type: 'suspend' })
    },
    async resume() {
      const { rpc } = await open()
      await rpc.resume({ type: 'resume' })
    },
    async listSkills() {
      const { rpc } = await open()
      const frame = await rpc.listSkills({ type: 'list' })
      return (frame.data ?? []) as unknown as HarnessSkillInfo[]
    },
    async registerAgent(registration) {
      const { rpc } = await open()
      await rpc.registerAgent({
        type: 'register',
        data: jsonWire(registration)
      })
    },
    async cancelAgentRun(input) {
      const { rpc } = await open()
      await rpc.cancelAgentRun({
        type: 'cancel',
        agentId: input.agentId,
        runId: input.runId,
        ...(input.reason ? { reason: input.reason } : {})
      })
    },
    async readRun(input) {
      const { rpc } = await open()
      const frame = await rpc.readRun({
        type: 'read',
        agentId: input.agentId,
        runId: input.runId
      })
      return (frame.data ?? null) as unknown as HarnessRunRecord | null
    },
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
      await runStore?.close()
    }
  }
}

function jsonWire(value: unknown): WireValue {
  return JSON.parse(JSON.stringify(value)) as WireValue
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
    case 'tool-progress':
      return {
        type,
        name: typeof frame.name === 'string' ? frame.name : '',
        progress: progressValue(frame.progress)
      }
    case 'metrics':
      return { type, metrics: numericRecord(frame.metrics) }
    case 'error':
      return {
        type,
        message:
          typeof frame.message === 'string' ? frame.message : 'harness error',
        ...(isHarnessErrorEnvelope(frame.error)
          ? { error: frame.error as unknown as HarnessErrorEnvelope }
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

function progressValue(value: WireValue | undefined) {
  if (!isRecord(value)) {
    return { step: 0, totalSteps: 0, elapsedMs: 0 }
  }
  return {
    step: typeof value.step === 'number' ? value.step : 0,
    totalSteps: typeof value.totalSteps === 'number' ? value.totalSteps : 0,
    elapsedMs: typeof value.elapsedMs === 'number' ? value.elapsedMs : 0
  }
}

function isHarnessErrorEnvelope(
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
