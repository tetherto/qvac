import { defineAgent, type AgentEvent } from '@qvac/agents'
import {
  agentDefinitionFromRegistration,
  copyAgentRegistration,
  type HarnessAgentRegistration
} from './agent-registration.ts'
import { createBrokeredModelAdapter } from './brokered-model-adapter.ts'
import {
  HarnessExecutionError,
  serializeHarnessError
} from './errors.ts'
import { createHarnessLogger } from './logger.ts'
import { createInMemoryHarnessRunStore } from './in-memory-harness-run-store.ts'
import { createMemoryStateAdapter } from './memory-state.ts'
import { createAsyncQueue } from './queue.ts'
import { encodeRunIdentity } from './run-identity.ts'
import { createRunRegistry } from './run-registry.ts'
import type { HarnessRunStore } from './run-store.ts'
import type { SdkRuntimeEvent, SdkRuntimePort } from './sdk-runtime-port.ts'
import type {
  SkillCatalogEntry,
  SkillCatalogSource
} from './skills/catalog.ts'
import {
  grantsFor,
  validateSelectedSkills,
  type HarnessTool,
  type HarnessToolApprovalPort,
  type HarnessToolBrokerPort
} from './tool-broker.ts'
import type {
  HarnessAgentRunInput,
  HarnessAgentRunKey,
  HarnessEvent,
  HarnessLoggingConfig,
  HarnessRunInput,
  LocalHarnessRuntime,
  HarnessStateAdapter
} from './types.ts'

export interface CreateHarnessServiceOptions {
  readonly sdk: SdkRuntimePort
  readonly state?: HarnessStateAdapter
  readonly runStore?: HarnessRunStore
  readonly logging?: HarnessLoggingConfig
  readonly skills?: SkillCatalogSource
  readonly tools?: readonly HarnessTool[]
  readonly toolBroker?: HarnessToolBrokerPort
  readonly toolApproval?: HarnessToolApprovalPort
  /**
   * Tools that always require approval, whatever an agent's own policy says.
   * A remotely-submitted registration must not be able to opt itself out.
   */
  readonly mandatoryApproval?: readonly string[]
  readonly onRegistration?: (registration: HarnessAgentRegistration) => void
}

export function createHarnessService({
  sdk,
  state = createMemoryStateAdapter(),
  runStore = createInMemoryHarnessRunStore(),
  logging,
  skills,
  tools = [],
  toolBroker = unavailableToolBroker(),
  toolApproval,
  mandatoryApproval,
  onRegistration
}: CreateHarnessServiceOptions): LocalHarnessRuntime {
  let closed = false
  let suspended = false
  const logger = createHarnessLogger(logging)
  const logPrefix = '[harness]'
  let catalogPromise: Promise<readonly SkillCatalogEntry[]> | undefined
  const registrations = new Map<string, HarnessAgentRegistration>()
  const runs = createRunRegistry()

  // Skills are supplied by the application. A harness with no configured
  // source has an empty catalog, so validateSelectedSkills rejects every named
  // skill rather than silently exposing skills it cannot execute.
  function loadCatalog() {
    catalogPromise ??= import('./skills/catalog.ts').then((catalogModule) =>
      catalogModule.resolveSkillCatalog(skills)
    )
    return catalogPromise
  }

  async function* run(input: HarnessRunInput): AsyncGenerator<HarnessEvent> {
    if (closed) throw new Error('harness is closed')
    if (suspended) throw new Error('harness is suspended')
    const traceId = input.traceId ?? input.runId
    logger.info(logPrefix, 'run started', { runId: input.runId, traceId })
    if (input.signal.aborted) {
      yield await persist(state, input.runId, { type: 'aborted' })
      return
    }

    const loaded = await sdk.loadModel({
      model: input.model,
      traceId,
      signal: input.signal
    })
    if (input.signal.aborted) {
      yield await persist(state, input.runId, { type: 'aborted' })
      return
    }

    const completion = sdk.completion({
      requestId: input.runId,
      traceId,
      modelId: loaded.modelId,
      messages: input.messages,
      signal: input.signal
    })
    let cancelled = false
    let emittedAborted = false
    const cancel = () => {
      if (cancelled) return
      cancelled = true
      void sdk.cancel({ requestId: completion.requestId }).catch(() => {})
    }
    input.signal.addEventListener('abort', cancel, { once: true })

    try {
      for await (const sdkEvent of completion.events) {
        if (input.signal.aborted) {
          if (!emittedAborted) {
            emittedAborted = true
            yield await persist(state, input.runId, { type: 'aborted' })
          }
          return
        }
        const mapped = mapSdkEvent(sdkEvent)
        if (mapped === null) continue
        const event =
          mapped.type === 'error' && mapped.error === undefined
            ? {
                ...mapped,
                error: serializeHarnessError(
                  new HarnessExecutionError(
                    'harness->sdk',
                    new Error(mapped.message)
                  ),
                  { traceId, boundary: 'harness->sdk' }
                )
              }
            : mapped
        if (event.type === 'aborted') emittedAborted = true
        yield await persist(state, input.runId, event)
      }
    } catch (cause) {
      if (input.signal.aborted) {
        if (!emittedAborted) yield await persist(state, input.runId, { type: 'aborted' })
        return
      }
      const message = cause instanceof Error ? cause.message : String(cause)
      const error = new HarnessExecutionError('harness->sdk', cause)
      logger.error(logPrefix, 'run failed', {
        runId: input.runId,
        traceId,
        error: message
      })
      yield await persist(state, input.runId, {
        type: 'error',
        message,
        error: serializeHarnessError(error, {
          traceId,
          boundary: 'harness->sdk'
        })
      })
    } finally {
      input.signal.removeEventListener('abort', cancel)
    }

    if (input.signal.aborted && !emittedAborted) {
      yield await persist(state, input.runId, { type: 'aborted' })
    }
    logger.info(logPrefix, 'run completed', { runId: input.runId, traceId })
  }

  async function registerAgent(registration: HarnessAgentRegistration) {
    if (closed) throw new Error('harness is closed')
    if (suspended) throw new Error('harness is suspended')
    if (registrations.has(registration.id)) {
      throw new Error(`agent is already registered: ${registration.id}`)
    }
    const registrationCatalog = await loadCatalog()
    validateSelectedSkills(registration, registrationCatalog)
    defineAgent(agentDefinitionFromRegistration(registration, registrationCatalog))
    registrations.set(registration.id, copyAgentRegistration(registration))
    onRegistration?.(registration)
  }

  async function* runAgent(input: HarnessAgentRunInput): AsyncGenerator<HarnessEvent> {
    if (closed) throw new Error('harness is closed')
    if (suspended) throw new Error('harness is suspended')
    const registration = registrations.get(input.agentId)
    if (!registration) throw new Error(`agent is not registered: ${input.agentId}`)
    const key = { agentId: input.agentId, runId: input.runId }
    const stateKey = encodeRunIdentity(key)
    const previous = await runStore.loadRun(key)
    if (previous?.outcome?.status === 'completed') {
      throw new Error(`agent run is already completed: ${stateKey}`)
    }
    if (hasIndeterminateToolCall(previous?.events ?? [])) {
      await runStore.finish({
        ...key,
        operationId: `${stateKey}:indeterminate`,
        outcome: {
          status: 'indeterminate',
          reason: 'a side-effecting tool call has no confirmed result'
        }
      })
      throw new Error(`agent run requires explicit retry after an indeterminate tool call: ${stateKey}`)
    }
    let eventIndex = previous?.events.length ?? 0
    const queue = createAsyncQueue<HarnessEvent>()
    const catalog = await loadCatalog()
    const adapter = createBrokeredModelAdapter({ registration, sdk })
    const agent = defineAgent(agentDefinitionFromRegistration(registration, catalog))
    const agentRun = agent.run({
      runId: input.runId,
      input: input.input,
      adapter,
      tooling: {
        tools,
        grants: grantsFor(registration.skills, catalog),
        broker: toolBroker,
        ...(toolApproval ? { approval: toolApproval } : {}),
        ...(mandatoryApproval?.length
          ? { mandatoryApproval: new Set(mandatoryApproval) }
          : {})
      },
      ...(previous?.checkpoint ? { checkpoint: previous.checkpoint } : {})
    })
    runs.add(key, agentRun)

    const onAbort = () => {
      void agentRun.cancel(abortReason(input.signal))
    }
    if (input.signal?.aborted) void agentRun.cancel(abortReason(input.signal))
    else input.signal?.addEventListener('abort', onAbort, { once: true })

    void (async () => {
      try {
        for await (const event of agentRun.events) {
          await runStore.appendEvents({
            ...key,
            operationId: `${stateKey}:event:${++eventIndex}`,
            events: [{ kind: 'agent', event }]
          })
          if (event.type === 'checkpoint') {
            await runStore.saveCheckpoint({
              ...key,
              operationId: `${stateKey}:checkpoint:${event.checkpoint.nextOperationIndex}`,
              checkpoint: event.checkpoint
            })
          }
          const projected = harnessEventFor(event)
          if (projected) queue.push(projected)
          if (event.type === 'run-completed') {
            await runStore.finish({
              ...key,
              operationId: `${stateKey}:outcome`,
              outcome: { status: 'completed', output: event.output }
            })
          } else if (event.type === 'run-canceled') {
            await runStore.finish({
              ...key,
              operationId: `${stateKey}:outcome`,
              outcome: { status: 'canceled', reason: event.reason }
            })
          }
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        const error: HarnessEvent = {
          type: 'error',
          message,
          error: serializeHarnessError(
            new HarnessExecutionError('harness->agent', cause),
            { boundary: 'harness->agent' }
          )
        }
        await runStore.appendEvents({
          ...key,
          operationId: `${stateKey}:event:${++eventIndex}`,
          events: [{ kind: 'execution', event: error }]
        })
        await runStore.finish({
          ...key,
          operationId: `${stateKey}:outcome`,
          outcome: { status: 'failed', error: message }
        })
        queue.push(error)
      } finally {
        input.signal?.removeEventListener('abort', onAbort)
        runs.remove(key, agentRun)
        queue.end()
      }
    })()

    yield* queue
  }

  function cancelAgentRun(input: HarnessAgentRunKey) {
    return runs.cancel(input, input.reason)
  }

  return {
    run,
    async suspend() {
      if (closed) throw new Error('harness is closed')
      if (suspended) return
      suspended = true
      await runs.cancelAll()
    },
    async resume() {
      if (closed) throw new Error('harness is closed')
      suspended = false
    },
    async listSkills() {
      return (await loadCatalog()).map(({ name, description }) => ({
        name,
        description
      }))
    },
    registerAgent,
    runAgent,
    cancelAgentRun,
    readRun(input) {
      return runStore.loadRun(input)
    },
    watchWork(input) {
      return runStore.watchAvailableWork(input)
    },
    async close() {
      if (closed) return
      closed = true
      await runs.close()
      await Promise.all([
        sdk.close(),
        state.close(),
        runStore.close(),
        toolBroker.close()
      ])
    }
  }
}

/**
 * Projects an agent event onto the application-facing harness event stream.
 * Returns null for events that are run bookkeeping rather than output.
 */
function harnessEventFor(event: AgentEvent): HarnessEvent | null {
  switch (event.type) {
    case 'content':
      return { type: 'content', text: event.text }
    case 'tool-call':
      return { type: 'tool-call', name: event.call.name, args: event.call.arguments }
    case 'tool-result':
      return { type: 'tool-result', name: event.name, result: event.result }
    case 'tool-progress':
      return { type: 'tool-progress', name: event.name, progress: event.progress }
    case 'run-canceled':
      return { type: 'aborted' }
    default:
      return null
  }
}

/**
 * A tool call with no matching result may or may not have taken effect. The
 * tool loop now lives in @qvac/agents, so these arrive as agent events.
 */
function hasIndeterminateToolCall(
  events: readonly import('./run-store.ts').HarnessStoredRunEvent[]
) {
  const pending = new Map<string, number>()
  const started = (name: string) => pending.set(name, (pending.get(name) ?? 0) + 1)
  const settled = (name: string) => {
    const count = pending.get(name) ?? 0
    if (count <= 1) pending.delete(name)
    else pending.set(name, count - 1)
  }
  for (const entry of events) {
    if (entry.kind === 'agent') {
      if (entry.event.type === 'tool-call') started(entry.event.call.name)
      else if (entry.event.type === 'tool-result') settled(entry.event.name)
      continue
    }
    if (entry.event.type === 'tool-call') started(entry.event.name)
    else if (entry.event.type === 'tool-result') settled(entry.event.name)
  }
  return pending.size > 0
}

async function persist(state: HarnessStateAdapter, runId: string, event: HarnessEvent) {
  await state.append(runId, event)
  return event
}

export function mapSdkEvent(event: SdkRuntimeEvent): HarnessEvent | null {
  switch (event.type) {
    case 'content-delta':
    case 'contentDelta':
      return { type: 'content', text: event.text }
    case 'thinking-delta':
    case 'thinkingDelta':
      return { type: 'thinking', text: event.text }
    case 'tool-call':
    case 'toolCall':
      return { type: 'tool-call', name: event.name, args: event.arguments }
    case 'tool-result':
    case 'toolResult':
      return { type: 'tool-result', name: event.name, result: event.result }
    case 'completion-done':
    case 'completionDone':
      return null
    case 'metrics':
      return { type: 'metrics', metrics: event.metrics }
    case 'error':
      return { type: 'error', message: event.message }
    case 'cancelled':
    case 'aborted':
      return { type: 'aborted' }
    default:
      return { type: 'error', message: `unmapped SDK event: ${Reflect.get(event, 'type')}` }
  }
}

function abortReason(signal: HarnessAgentRunInput['signal']) {
  return typeof signal?.reason === 'string' ? signal.reason : 'aborted'
}

function unavailableToolBroker(): HarnessToolBrokerPort {
  return {
    async execute(input) {
      throw new Error(`no tool broker configured for ${input.call.name}`)
    },
    async cancel() {},
    async close() {}
  }
}
