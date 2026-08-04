import { defineAgent } from '@qvac/agents'
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
import type { SkillCatalogEntry } from './skills/catalog.ts'
import {
  createToolGate,
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
  readonly tools?: readonly HarnessTool[]
  readonly toolBroker?: HarnessToolBrokerPort
  readonly toolApproval?: HarnessToolApprovalPort
  readonly onRegistration?: (registration: HarnessAgentRegistration) => void
}

export function createHarnessService({
  sdk,
  state = createMemoryStateAdapter(),
  runStore = createInMemoryHarnessRunStore(),
  logging,
  tools = [],
  toolBroker = unavailableToolBroker(),
  toolApproval,
  onRegistration
}: CreateHarnessServiceOptions): LocalHarnessRuntime {
  let closed = false
  let suspended = false
  const logger = createHarnessLogger(logging)
  const logPrefix = '[harness]'
  let catalogPromise: Promise<readonly SkillCatalogEntry[]> | undefined
  const registrations = new Map<string, HarnessAgentRegistration>()
  const runs = createRunRegistry()

  function loadCatalog() {
    catalogPromise ??= Promise.all([
      import('./skills/catalog.ts'),
      import('./skills/bundled-skills.ts')
    ]).then(([catalogModule, bundle]) =>
      catalogModule.createSkillCatalogFromBundle(
        {
          files: bundle.BUNDLED_SKILLS,
          hash: bundle.BUNDLED_SKILLS_HASH
        },
        { platform: 'darwin' }
      )
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
    validateSelectedSkills(registration, await loadCatalog())
    defineAgent(agentDefinitionFromRegistration(registration))
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
    const gate = createToolGate({
      registration,
      catalog: await loadCatalog(),
      tools,
      broker: toolBroker,
      ...(toolApproval ? { approval: toolApproval } : {})
    })
    const adapter = createBrokeredModelAdapter({
      registration,
      sdk,
      tools: gate,
      async onEvent(event) {
        await runStore.appendEvents({
          ...key,
          operationId: `${stateKey}:event:${++eventIndex}`,
          events: [{ kind: 'execution', event }]
        })
        queue.push(event)
      }
    })
    const agent = defineAgent(agentDefinitionFromRegistration(registration))
    const agentRun = agent.run({
      runId: input.runId,
      input: input.input,
      adapter,
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
          if (event.type === 'content') {
            const content: HarnessEvent = { type: 'content', text: event.text }
            queue.push(content)
          } else if (event.type === 'run-canceled') {
            const aborted: HarnessEvent = { type: 'aborted' }
            queue.push(aborted)
          }
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

function hasIndeterminateToolCall(
  events: readonly import('./run-store.ts').HarnessStoredRunEvent[]
) {
  const pending = new Map<string, number>()
  for (const entry of events) {
    if (entry.kind !== 'execution') continue
    if (entry.event.type === 'tool-call') {
      pending.set(entry.event.name, (pending.get(entry.event.name) ?? 0) + 1)
    } else if (entry.event.type === 'tool-result') {
      const count = pending.get(entry.event.name) ?? 0
      if (count <= 1) pending.delete(entry.event.name)
      else pending.set(entry.event.name, count - 1)
    }
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
