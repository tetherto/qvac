import type {
  HarnessAgentRegistration,
  HarnessApprovalDecision,
  HarnessApprovalRequest,
  HarnessEvent,
  HarnessRunRecord
} from '@qvac/harness'
import QvacLogger from '@qvac/logging'
import Supervisor from '@qvac/supervisor'
import type {
  SyncProfileClient,
  SyncProfileContract,
  SyncRuntime
} from '@qvac/sync'
import { SyncGenerationEndedError } from '@qvac/sync'
import { durableWorkProfile } from '@qvac/sync/profiles/durable-work'
import {
  checkCompatibility,
  type CompatibilityResult,
  type ComponentHandshake
} from './compatibility.ts'
import {
  AssistantCompatibilityError,
  AssistantComponentExitedError,
  AssistantComponentStartError
} from './errors.ts'
import { createTraceId } from './trace.ts'
import {
  expectedHarnessHandshake,
  expectedSyncHandshake
} from './handshakes.ts'
import type {
  AssistantComponents,
  AssistantHarnessComponent,
  AssistantInspection,
  AssistantLifecycleEvent,
  AssistantRun,
  AssistantRunInput,
  AssistantStateEndpoint,
  AssistantSyncComponent,
  CreateAssistantOptions
} from './contracts.ts'
import { getOptionalConfigSnapshot } from '@qvac/config'
import {
  assistantLogLevel,
  resolveAssistantConfig
} from './config.ts'

export interface AssistantFacade {
  readonly state: AssistantStateEndpoint
  ready(): Promise<void>
  registerAgent(registration: HarnessAgentRegistration): Promise<void>
  run(input: AssistantRunInput): AssistantRun
  cancelRun(input: { readonly agentId: string; readonly runId: string; readonly reason?: string }): Promise<void>
  readRun(input: { readonly agentId: string; readonly runId: string }): Promise<HarnessRunRecord | null>
  readonly approvals: {
    pending(): AsyncIterable<HarnessApprovalRequest>
    resolve(decision: HarnessApprovalDecision): Promise<void>
  }
  suspend(): Promise<void>
  resume(): Promise<void>
  close(): Promise<void>
  inspect(): AssistantInspection
  onLifecycle(listener: (event: AssistantLifecycleEvent) => void): () => void
}

export const DEFAULT_ASSISTANT_STORAGE_PATH = '.assistant'
export const DEFAULT_ASSISTANT_INFERENCE = Object.freeze({ kind: 'qwen' } as const)
export function createAssistantFacade(
  options: CreateAssistantOptions,
  components: AssistantComponents
): AssistantFacade {
  const supervisor = new Supervisor()
  const writeInfo = isReactNativeRuntime()
    ? (...values: unknown[]) => console.info(...values)
    : (...values: unknown[]) => console.error(...values)
  const logger = new QvacLogger({
    error: (...values: unknown[]) => console.error(...values),
    warn: (...values: unknown[]) => console.warn(...values),
    info: writeInfo,
    debug: writeInfo
  })
  const config =
    getOptionalConfigSnapshot() ?? resolveAssistantConfig(options.logging)
  logger.setLevel(assistantLogLevel(config))
  const lifecycle = createLifecycleEvents(supervisor, logger)

  supervisor.add<AssistantSyncComponent>('sync', {
    restart: 'always',
    async start(context) {
      const component = await startComponent('sync', components.startSync)
      await negotiate('sync', expectedSyncHandshake(), component.handshake, component.close)
      observeExit('sync', component, context.onDeath, logger)
      return component
    },
    stop: (component) => component.close(),
    suspend: (component) => component.suspend?.(),
    resume: (component) => component.resume?.(),
    inspect: (component) => component.inspect?.() ?? {}
  })
  supervisor.add<AssistantHarnessComponent>('harness', {
    deps: ['sync'],
    restart: 'always',
    async start(context) {
      const sync = context.get<AssistantSyncComponent>('sync')
      const component = await startComponent('harness', () =>
        components.startHarness({ state: sync.state })
      )
      await negotiate(
        'harness',
        expectedHarnessHandshake(),
        component.handshake,
        component.close
      )
      observeExit('harness', component, context.onDeath, logger)
      return component
    },
    stop: (component) => component.close(),
    suspend: (component) => component.suspend?.(),
    resume: (component) => component.resume?.(),
    inspect: (component) => component.inspect?.() ?? {}
  })

  function run(input: AssistantRunInput): AssistantRun {
    const runId = input.runId ?? createRunId()
    const events = runEvents(input, runId)
    return {
      id: runId,
      [Symbol.asyncIterator]() {
        return events
      }
    }
  }

  async function* runEvents(
    input: AssistantRunInput,
    runId: string
  ) {
    await supervisor.ready()
    const harness = supervisor.get<AssistantHarnessComponent>('harness')
    const controller = input.signal ? null : new AbortController()
    logger.info('[assistant]', 'run started', { runId, agentId: input.agentId })
    yield* harness.harness.runAgent({
      agentId: input.agentId,
      runId,
      input: input.input,
      signal: input.signal ?? controller?.signal
    })
    logger.info('[assistant]', 'run completed', { runId, agentId: input.agentId })
  }

  const state = createStateFacade(supervisor)

  return {
    state,
    ready: () => supervisor.ready(),
    async registerAgent(registration) {
      await supervisor.ready()
      await supervisor
        .get<AssistantHarnessComponent>('harness')
        .harness.registerAgent(registration)
    },
    run,
    async cancelRun(input) {
      await supervisor.ready()
      await supervisor
        .get<AssistantHarnessComponent>('harness')
        .harness.cancelAgentRun(input)
    },
    async readRun(input) {
      await supervisor.ready()
      return supervisor
        .get<AssistantHarnessComponent>('harness')
        .harness.readRun(input)
    },
    approvals: {
      pending() {
        // Terminates rather than silently reconnecting across a harness
        // replacement: in-flight approvals are denied by the child when its
        // stream closes, so a resubscription is a caller decision.
        return (async function* () {
          await supervisor.ready()
          yield* supervisor
            .get<AssistantHarnessComponent>('harness')
            .harness.watchApprovals()
        })()
      },
      async resolve(decision) {
        await supervisor.ready()
        await supervisor
          .get<AssistantHarnessComponent>('harness')
          .harness.resolveApproval(decision)
      }
    },
    suspend: () => supervisor.suspend(),
    resume: () => supervisor.resume(),
    close: () => supervisor.close(),
    inspect() {
      return {
        children: supervisor.inspect().map((child) => ({
          name: child.name,
          state: child.state,
          deps: child.deps,
          lives: child.lives,
          ...(isRecord(child.info) ? { details: child.info } : {})
        }))
      }
    },
    onLifecycle: (listener) => lifecycle.on(listener)
  }
}

function createStateFacade(supervisor: Supervisor): AssistantStateEndpoint {
  let generation = 0
  const generationWaiters = new Set<() => void>()
  const changeGeneration = ({ name }: { readonly name: string }) => {
    if (name !== 'sync') return
    generation++
    for (const resolve of generationWaiters) resolve()
    generationWaiters.clear()
  }
  supervisor.on('child-ready', changeGeneration)
  supervisor.on('child-died', changeGeneration)
  supervisor.on('child-reloaded', changeGeneration)

  async function current() {
    await supervisor.ready()
    return supervisor.get<AssistantSyncComponent>('sync').state
  }

  async function suspend() {
    await (await current()).lifecycle.suspend()
  }

  async function resume() {
    await (await current()).lifecycle.resume()
  }

  function watchCurrent<T>(
    select: (sync: SyncRuntime) => AsyncIterable<T>
  ): AsyncIterable<T> {
    return (async function* () {
      const sync = await current()
      const boundGeneration = generation
      const iterator = select(sync)[Symbol.asyncIterator]()
      try {
        while (true) {
          let wake: (() => void) | undefined
          const changed = new Promise<IteratorResult<T>>((resolve) => {
            wake = () => resolve({ value: undefined, done: true })
            generationWaiters.add(wake)
          })
          const result = await Promise.race([iterator.next(), changed])
          if (wake) generationWaiters.delete(wake)
          if (generation !== boundGeneration) {
            throw new SyncGenerationEndedError()
          }
          if (result.done) return
          yield result.value
        }
      } finally {
        await iterator.return?.()
      }
    })()
  }

  return {
    work: createLazyProfile(current, durableWorkProfile),
    ready: () => supervisor.ready(),
    suspend,
    resume,
    lifecycle: { suspend, resume },
    runtime: {
      async describe() {
        return (await current()).runtime.describe()
      },
      async status() {
        return (await current()).runtime.status()
      },
      async diagnostics() {
        return (await current()).runtime.diagnostics()
      }
    },
    mesh: {
      async identity() {
        return (await current()).mesh.identity()
      },
      async status() {
        return (await current()).mesh.status()
      },
      watchStatus(options) {
        return watchCurrent((sync) => sync.mesh.watchStatus(options))
      },
      async createInvite(options) {
        return (await current()).mesh.createInvite(options)
      },
      watchPairingRequests() {
        return watchCurrent((sync) => sync.mesh.watchPairingRequests())
      },
      async approvePairingRequest(id) {
        return (await current()).mesh.approvePairingRequest(id)
      },
      async rejectPairingRequest(id) {
        return (await current()).mesh.rejectPairingRequest(id)
      },
      async join(invite) {
        await (await current()).mesh.join(invite)
      },
      async cancelJoin() {
        await (await current()).mesh.cancelJoin()
      },
      async leave() {
        await (await current()).mesh.leave()
      },
      async listDevices() {
        return (await current()).mesh.listDevices()
      },
      watchDevices() {
        return watchCurrent((sync) => sync.mesh.watchDevices())
      },
      async renameDevice(name) {
        return (await current()).mesh.renameDevice(name)
      },
      async removeDevice(id) {
        await (await current()).mesh.removeDevice(id)
      }
    }
  }
}

function createLazyProfile<Command, Query, Result, Change>(
  current: () => Promise<SyncRuntime>,
  profile: SyncProfileContract<Command, Query, Result, Change>
): SyncProfileClient<Command, Query, Result, Change> {
  return {
    async apply(command, options) {
      return (await current()).openProfile(profile).apply(command, options)
    },
    async query(query) {
      return (await current()).openProfile(profile).query(query)
    },
    watch(query, options) {
      return (async function* () {
        const sync = await current()
        yield* sync.openProfile(profile).watch(query, options)
      })()
    }
  }
}

function isReactNativeRuntime() {
  const navigator = Reflect.get(globalThis, 'navigator')
  return (
    typeof navigator === 'object' &&
    navigator !== null &&
    Reflect.get(navigator, 'product') === 'ReactNative'
  )
}

function createLifecycleEvents(supervisor: Supervisor, logger: QvacLogger) {
  const listeners = new Set<(event: AssistantLifecycleEvent) => void>()

  function publish(event: AssistantLifecycleEvent) {
    logger.info('[assistant]', 'lifecycle', event)
    for (const listener of listeners) listener(event)
  }

  supervisor.on('child-ready', ({ name, lives }) => {
    publish({ type: 'child-ready', timestamp: Date.now(), name, lives })
  })
  supervisor.on('child-died', ({ name, error }) => {
    publish({
      type: 'child-died',
      timestamp: Date.now(),
      name,
      error: errorEnvelope(error)
    })
  })
  supervisor.on('child-restarting', ({ name, delay }) => {
    publish({
      type: 'child-restarting',
      timestamp: Date.now(),
      name,
      delay
    })
  })
  supervisor.on('child-stopped', ({ name }) => {
    publish({ type: 'child-stopped', timestamp: Date.now(), name })
  })
  supervisor.on('child-reloaded', ({ name }) => {
    publish({ type: 'child-reloaded', timestamp: Date.now(), name })
  })
  supervisor.on('gave-up', ({ name, error }) => {
    publish({
      type: 'gave-up',
      timestamp: Date.now(),
      name,
      error: errorEnvelope(error)
    })
  })
  supervisor.on('suspend-coalesced', () => {
    publish({ type: 'suspend-coalesced', timestamp: Date.now() })
  })
  supervisor.on('stall', ({ name }) => {
    publish({ type: 'stall', timestamp: Date.now(), name })
  })

  return {
    on(listener: (event: AssistantLifecycleEvent) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

function errorEnvelope(error: Error) {
  return {
    name: error.name || 'Error',
    message: error.message || 'Unknown supervisor error'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createRunId() {
  return createTraceId().replace(/^trc_/, 'run_')
}

async function negotiate(
  name: string,
  local: ComponentHandshake,
  remote: ComponentHandshake,
  close: () => Promise<void>
) {
  const result = checkCompatibility(local, remote)
  if (result.compatible) return
  await close()
  throw handshakeError(name, result)
}

function handshakeError(name: string, result: CompatibilityResult) {
  const missing = [
    ...result.missingLocalCapabilities,
    ...result.missingRemoteCapabilities
  ]
  const suffix = missing.length > 0 ? ` (${missing.join(', ')})` : ''
  return new AssistantCompatibilityError(
    name,
    `${result.reason ?? 'incompatible'}${suffix}`
  )
}

async function startComponent<T>(
  name: string,
  start: () => Promise<T>
): Promise<T> {
  try {
    return await start()
  } catch (cause) {
    if (cause instanceof AssistantCompatibilityError) throw cause
    throw new AssistantComponentStartError(name, cause)
  }
}

function observeExit(
  name: string,
  component: AssistantSyncComponent | AssistantHarnessComponent,
  onDeath: (error?: Error) => void,
  logger: QvacLogger
) {
  component.exited?.then(
    (exit) => {
      const error = new AssistantComponentExitedError(name, exit)
      logger.warn('[assistant]', 'runtime exited', {
        component: name,
        code: exit.code,
        signal: exit.signal
      })
      onDeath(error)
    },
    (cause) =>
      onDeath(
        new AssistantComponentExitedError(
          name,
          {
            code: null,
            signal: null
          },
          cause
        )
      )
  )
}
