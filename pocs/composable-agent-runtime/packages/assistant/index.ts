import type { HarnessEvent } from '@qvac/harness'
import {
  checkCompatibility,
  createRuntimeLogger,
  createTraceId,
  RuntimeCompatibilityError,
  RuntimeComponentExitedError,
  RuntimeComponentStartError,
  type CompatibilityResult,
  type RuntimeLogger,
  type RuntimeHandshake
} from '@qvac/runtime-contracts'
import { Supervisor, type SupervisorEvent } from '@qvac/supervisor'
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
  onLifecycle(listener: (event: SupervisorEvent) => void): () => void
}

export const DEFAULT_ASSISTANT_STORAGE_PATH = '.assistant'
export const DEFAULT_ASSISTANT_INFERENCE = Object.freeze({ kind: 'qwen' } as const)
export const DEFAULT_ASSISTANT_MODEL =
  'registry://hf/unsloth/Qwen3.5-4B-GGUF/resolve/e87f176479d0855a907a41277aca2f8ee7a09523/Qwen3.5-4B-Q4_K_M.gguf'

export function createAssistant(
  options: CreateAssistantOptions = {}
): AssistantFacade {
  const supervisor = new Supervisor()
  const logger = createRuntimeLogger('assistant', options.logging)
  let sdkStarts = 0
  const components =
    options.components ??
    defaultComponents(options, () => {
      sdkStarts++
    })

  supervisor.onEvent((event) => {
    logger.info('lifecycle', event)
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
    logger.info('run started', { runId, traceId })
    yield* harness.harness.run({
      runId,
      traceId,
      model: input.model ?? DEFAULT_ASSISTANT_MODEL,
      messages: input.messages,
      signal: input.signal ?? controller?.signal ?? abortedSignal()
    })
    logger.info('run completed', { runId, traceId })
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
          ...(child.details === undefined ? {} : { details: child.details })
        }))
      }
    },
    onLifecycle: (listener) => supervisor.onEvent(listener)
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

function createRunId() {
  return createTraceId().replace(/^trc_/, 'run_')
}

async function negotiate(
  name: string,
  local: RuntimeHandshake,
  remote: RuntimeHandshake,
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
  return new RuntimeCompatibilityError(
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
    if (cause instanceof RuntimeCompatibilityError) throw cause
    throw new RuntimeComponentStartError(name, cause)
  }
}

function observeExit(
  name: string,
  component: AssistantSyncComponent | AssistantHarnessComponent,
  onDeath: (error?: Error) => void,
  logger: RuntimeLogger
) {
  component.exited?.then(
    (exit) => {
      const error = new RuntimeComponentExitedError(name, exit)
      logger.warn('runtime exited', {
        component: name,
        code: exit.code,
        signal: exit.signal
      })
      onDeath(error)
    },
    (cause) => onDeath(new RuntimeComponentExitedError(name, {
      code: null,
      signal: null
    }, cause))
  )
}
