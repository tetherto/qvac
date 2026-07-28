import type { HarnessEvent } from '@qvac/harness'
import QvacLogger from '@qvac/logging'
import Supervisor from '@qvac/supervisor'
import {
  checkCompatibility,
  type CompatibilityResult,
  type ComponentHandshake
} from './lib/compatibility.ts'
import {
  AssistantCompatibilityError,
  AssistantComponentExitedError,
  AssistantComponentStartError
} from './lib/errors.ts'
import { createTraceId } from './lib/trace.ts'
import {
  expectedHarnessHandshake,
  expectedSyncHandshake,
  startHarnessComponent,
  startSyncComponent
} from './lib/adapters.ts'
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
} from './lib/contracts.ts'

export type {
  AssistantComponent,
  AssistantComponents,
  AssistantHarnessComponent,
  AssistantInference,
  AssistantInspection,
  AssistantLifecycleEvent,
  AssistantLifecycleEventType,
  AssistantRun,
  AssistantRunInput,
  AssistantStateEndpoint,
  AssistantSyncComponent,
  CreateAssistantOptions
} from './lib/contracts.ts'

export interface AssistantFacade {
  readonly state: AssistantStateEndpoint
  ready(): Promise<void>
  run(input: AssistantRunInput): AssistantRun
  readRun(runId: string): Promise<readonly HarnessEvent[]>
  suspend(): Promise<void>
  resume(): Promise<void>
  close(): Promise<void>
  inspect(): AssistantInspection
  onLifecycle(listener: (event: AssistantLifecycleEvent) => void): () => void
}

export const DEFAULT_ASSISTANT_STORAGE_PATH = '.assistant'
export const DEFAULT_ASSISTANT_INFERENCE = Object.freeze({ kind: 'qwen' } as const)
export const DEFAULT_ASSISTANT_MODEL =
  'registry://hf/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf'

export function createAssistant(
  options: CreateAssistantOptions = {}
): AssistantFacade {
  const supervisor = new Supervisor()
  const write = (...values: unknown[]) => console.error(...values)
  const logger = new QvacLogger({
    error: write,
    warn: write,
    info: write,
    debug: write
  })
  logger.setLevel(options.logging?.level ?? 'info')
  const lifecycle = createLifecycleEvents(supervisor, logger)
  let sdkStarts = 0
  const components =
    options.components ??
    defaultComponents(options, () => {
      sdkStarts++
    })

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
    const traceId = input.traceId ?? createTraceId()
    const events = runEvents(input, runId, traceId)
    return {
      id: runId,
      traceId,
      [Symbol.asyncIterator]() {
        return events
      }
    }
  }

  async function* runEvents(
    input: AssistantRunInput,
    runId: string,
    traceId: string
  ) {
    await supervisor.ready()
    const harness = supervisor.get<AssistantHarnessComponent>('harness')
    const controller = input.signal ? null : new AbortController()
    logger.info('[assistant]', 'run started', { runId, traceId })
    yield* harness.harness.run({
      runId,
      traceId,
      model: input.model ?? DEFAULT_ASSISTANT_MODEL,
      messages: input.messages,
      signal: input.signal ?? controller?.signal ?? abortedSignal()
    })
    logger.info('[assistant]', 'run completed', { runId, traceId })
  }

  const state = createStateFacade(supervisor)

  return {
    state,
    ready: () => supervisor.ready(),
    run,
    async readRun(runId) {
      await supervisor.ready()
      return supervisor
        .get<AssistantHarnessComponent>('harness')
        .readRun(runId)
    },
    suspend: () => supervisor.suspend(),
    resume: () => supervisor.resume(),
    close: () => supervisor.close(),
    inspect() {
      return {
        sdkStarts,
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
  async function current() {
    await supervisor.ready()
    return supervisor.get<AssistantSyncComponent>('sync').state
  }

  return {
    async getIdentity() {
      return (await current()).getIdentity()
    },
    async getUserProfile() {
      return (await current()).getUserProfile()
    },
    async setUserProfile(profile) {
      return (await current()).setUserProfile(profile)
    },
    async createTask(request) {
      return (await current()).createTask(request)
    },
    async updateTask(request) {
      return (await current()).updateTask(request)
    },
    async getTask(request) {
      return (await current()).getTask(request)
    },
    async listTasks() {
      return (await current()).listTasks()
    },
    async *watchTasks() {
      yield* (await current()).watchTasks()
    },
    async createPairingInvite(request) {
      return (await current()).createPairingInvite(request)
    },
    async approvePairingRequest(request) {
      return (await current()).approvePairingRequest(request)
    },
    async rejectPairingRequest(request) {
      return (await current()).rejectPairingRequest(request)
    },
    async *watchPairingRequests() {
      yield* (await current()).watchPairingRequests()
    }
  }
}

function defaultComponents(
  options: CreateAssistantOptions,
  onSdkStart: () => void
): AssistantComponents {
  const storagePath = options.storagePath ?? DEFAULT_ASSISTANT_STORAGE_PATH
  const inference = options.inference ?? DEFAULT_ASSISTANT_INFERENCE
  return {
    startSync: () =>
      startSyncComponent({
        ...options.sync,
        storagePath,
        logging: options.logging
      }),
    startHarness: ({ state }) =>
      startHarnessComponent(state, inference, onSdkStart, options.logging)
  }
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

function abortedSignal() {
  const controller = new AbortController()
  controller.abort('Assistant run has no usable signal')
  return controller.signal
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
    (cause) => onDeath(new AssistantComponentExitedError(name, {
      code: null,
      signal: null
    }, cause))
  )
}
