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
  AssistantRunInput,
  AssistantStateEndpoint,
  AssistantSyncComponent,
  CreateAssistantOptions
} from './lib/contracts.ts'

export interface AssistantFacade {
  readonly state: AssistantStateEndpoint
  ready(): Promise<void>
  run(input: AssistantRunInput): AsyncIterable<HarnessEvent>
  readRun(runId: string): Promise<readonly HarnessEvent[]>
  suspend(): Promise<void>
  resume(): Promise<void>
  close(): Promise<void>
  inspect(): AssistantInspection
  onLifecycle(listener: (event: SupervisorEvent) => void): () => void
}

export const DEFAULT_ASSISTANT_STORAGE_PATH = '.assistant'

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

  async function* run(input: AssistantRunInput) {
    await supervisor.ready()
    const harness = supervisor.get<AssistantHarnessComponent>('harness')
    const controller = input.signal ? null : new AbortController()
    const traceId = input.traceId ?? createTraceId()
    logger.info('run started', { runId: input.runId, traceId })
    yield* harness.harness.run({
      runId: input.runId,
      traceId,
      model: input.model,
      messages: input.messages,
      signal: input.signal ?? controller?.signal ?? abortedSignal()
    })
    logger.info('run completed', { runId: input.runId, traceId })
  }

  return {
    get state() {
      return supervisor.get<AssistantSyncComponent>('sync').state
    },
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

function defaultComponents(
  options: CreateAssistantOptions,
  onSdkStart: () => void
): AssistantComponents {
  const storagePath = options.storagePath ?? DEFAULT_ASSISTANT_STORAGE_PATH
  const inference = options.inference ?? { kind: 'deterministic' }
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
