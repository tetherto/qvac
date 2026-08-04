import {
  createAssistant,
  type AssistantFacade,
  type AssistantInference
} from '@qvac/assistant'
import {
  processIncompleteTasks,
  watchIncompleteTasks,
  type TaskStore,
  type TaskRunner,
  type TaskRunEvent,
  type WatchTaskOptions
} from '@qvac-poc/task-shared'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { createTaskCliStore } from './lib/task-store.ts'

const QWEN_CACHE_FILE =
  '3a65a2a3c6a30a47_Qwen3.5-4B-Q4_K_M.gguf'
let traceSequence = 0

type TaskCommand =
  | {
      readonly mode: 'seed'
      readonly storagePath: string
      readonly name: string
      readonly age: number
      readonly trace: boolean
    }
  | {
      readonly mode: 'observe'
      readonly storagePath: string
      readonly once: boolean
      readonly trace: boolean
    }
  | {
      readonly mode: 'execute'
      readonly storagePath: string
      readonly inference: AssistantInference
      readonly model: string
      readonly trace: boolean
    }
  | {
      readonly mode: 'serve'
      readonly storagePath: string
      readonly inference: { readonly kind: 'qwen' }
      readonly model: string
      readonly trace: boolean
    }

export function parseTaskCommand(args: readonly string[]): TaskCommand {
  const mode = args[0]
  if (
    mode !== 'seed' &&
    mode !== 'observe' &&
    mode !== 'execute' &&
    mode !== 'serve'
  ) {
    throw new Error(
      'Usage: task-cli <seed|observe|execute|serve> [--storage <path>]'
    )
  }
  const storagePath = option(args, '--storage') ?? '.assistant'
  const trace = args.includes('--trace')
  if (mode === 'seed') {
    const ageText = option(args, '--age') ?? '30'
    const age = Number.parseInt(ageText, 10)
    if (Number.isNaN(age) || age < 0) {
      throw new Error('--age must be a non-negative integer')
    }
    return {
      mode,
      storagePath,
      name: option(args, '--name') ?? 'Local User',
      age,
      trace
    }
  }
  if (mode === 'observe') {
    return { mode, storagePath, once: args.includes('--once'), trace }
  }
  const qwen = args.includes('--qwen')
  if (mode === 'serve' && !qwen) {
    throw new Error('serve requires --qwen')
  }
  if (mode === 'serve') {
    return {
      mode,
      storagePath,
      inference: { kind: 'qwen' },
      model: option(args, '--model') ?? defaultQwenModelPath(),
      trace
    }
  }
  return {
    mode,
    storagePath,
    inference: qwen ? { kind: 'qwen' } : { kind: 'deterministic' },
    model: qwen
      ? option(args, '--model') ?? defaultQwenModelPath()
      : 'deterministic',
    trace
  }
}

export async function runTaskCommand(command: TaskCommand): Promise<void> {
  if (
    (command.mode === 'execute' || command.mode === 'serve') &&
    command.inference.kind === 'qwen'
  ) {
    await access(command.model).catch(() => {
      throw new Error(
        `Qwen service requires a pre-provisioned model at ${command.model}`
      )
    })
  }
  const assistant = createAssistant({
    storagePath: command.storagePath,
    sync: command.mode === 'serve' ? {} : { bootstrap: [] },
    logging: { level: command.trace ? 'debug' : 'off' },
    inference:
      command.mode === 'execute' || command.mode === 'serve'
        ? command.inference
        : { kind: 'deterministic' }
  })
  const stopTracing = command.trace
    ? assistant.onLifecycle((event) => writeTrace(`assistant.${event.type}`, event))
    : () => {}
  try {
    await assistant.ready()
    writeRuntimeIdentities(command.trace, assistant)
    const store = createTaskCliStore(assistant.state)
    if (command.mode === 'seed') {
      await seed(store, command)
      writeOutput({ mode: 'seed', seeded: true })
      return
    }
    if (command.mode === 'observe') {
      await observe(assistant, store, command.once)
      return
    }
    if (command.mode === 'serve') {
      await serve(assistant, store, command)
      return
    }

    writeTraceIf(command.trace, 'task-cli.execute.started', {
      model: command.model
    })
    const outcomes = await processIncompleteTasks(
      store,
      createRunner(assistant, command.model, command.trace)
    )
    writeRuntimeIdentities(command.trace, assistant)
    writeTraceIf(command.trace, 'task-cli.execute.completed', {
      outcomes: outcomes.length
    })
    writeOutput({ mode: 'executor', outcomes })
    const failed = outcomes.filter((outcome) => outcome.status === 'failed')
    if (failed.length > 0) {
      throw new Error(`${failed.length} task execution(s) failed`)
    }
  } finally {
    stopTracing()
    await assistant.close()
  }
}

export function runTaskService(
  store: TaskStore,
  runner: TaskRunner,
  options: WatchTaskOptions
) {
  return watchIncompleteTasks(store, runner, options)
}

export function formatPairingUri(invite: {
  readonly invite: Buffer
  readonly expiresAt: number
}) {
  const encoded = invite.invite.toString('base64url')
  return `qvac-poc://pair?invite=${encoded}&expiresAt=${invite.expiresAt}`
}

async function serve(
  assistant: AssistantFacade,
  store: ReturnType<typeof createTaskCliStore>,
  command: Extract<TaskCommand, { mode: 'serve' }>
) {
  const controller = new AbortController()
  const removeSignalHandlers = installShutdownHandlers(controller)
  const invite = await assistant.state.mesh.createInvite({
    expiresInMs: 30 * 60_000
  })
  console.log(formatPairingUri(invite))
  writeOutput({
    mode: 'service',
    event: 'ready',
    expiresAt: invite.expiresAt
  })
  try {
    await Promise.all([
      approvePairingCandidates(assistant, controller.signal),
      runTaskService(
        store,
        createRunner(assistant, command.model, command.trace),
        {
          signal: controller.signal,
          onStaleTasks(tasks) {
            writeOutput({
              mode: 'service',
              event: 'stale-running-tasks',
              tasks: tasks.map((task) => ({
                id: task.id,
                result: task.result ?? null
              }))
            })
          }
        }
      )
    ])
  } finally {
    controller.abort('Task service stopped')
    removeSignalHandlers()
  }
}

async function approvePairingCandidates(
  assistant: AssistantFacade,
  signal: AbortSignal
) {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout
  })
  const handled = new Set<string>()
  const iterator =
    assistant.state.mesh.watchPairingRequests()[Symbol.asyncIterator]()
  try {
    while (!signal.aborted) {
      const next = await nextUntilAbort(iterator, signal)
      if (next.done) return
      for (const request of next.value.requests) {
        const id = request.id.toString('hex')
        if (request.status !== 'pending' || handled.has(id)) continue
        handled.add(id)
        writeOutput({
          mode: 'service',
          event: 'pairing-candidate',
          fingerprint: request.fingerprint
        })
        const approved = await confirmPairing(
          terminal,
          request.fingerprint,
          signal
        )
        if (signal.aborted) return
        if (approved) {
          await assistant.state.mesh.approvePairingRequest(request.id)
        } else {
          await assistant.state.mesh.rejectPairingRequest(request.id)
        }
        writeOutput({
          mode: 'service',
          event: approved ? 'pairing-approved' : 'pairing-rejected',
          fingerprint: request.fingerprint
        })
      }
    }
  } finally {
    terminal.close()
    // A pending HRPC iterator.next() cannot be cancelled by iterator.return().
    // Assistant shutdown closes the transport after the abort.
    if (!signal.aborted) await iterator.return?.()
  }
}

async function confirmPairing(
  terminal: ReturnType<typeof createInterface>,
  fingerprint: string,
  signal: AbortSignal
) {
  while (!signal.aborted) {
    let answer: string
    try {
      answer = await terminal.question(
        `Pair writer ${fingerprint}? [y/n] `,
        { signal }
      )
    } catch (error) {
      if (signal.aborted) return false
      throw error
    }
    const normalized = answer.trim().toLowerCase()
    if (normalized === 'y') return true
    if (normalized === 'n') return false
    console.log('Please answer y or n.')
  }
  return false
}

function installShutdownHandlers(controller: AbortController) {
  function stop(signal: 'SIGINT' | 'SIGTERM') {
    controller.abort(`Task service stopped by ${signal}`)
  }
  function onSigint() {
    stop('SIGINT')
  }
  function onSigterm() {
    stop('SIGTERM')
  }
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  return function removeSignalHandlers() {
    process.removeListener('SIGINT', onSigint)
    process.removeListener('SIGTERM', onSigterm)
  }
}

async function nextUntilAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal
): Promise<IteratorResult<T>> {
  if (signal.aborted) return { done: true, value: undefined }
  let onAbort = () => {}
  const aborted = new Promise<IteratorResult<T>>((resolve) => {
    onAbort = () => resolve({ done: true, value: undefined })
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([iterator.next(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

async function seed(
  store: ReturnType<typeof createTaskCliStore>,
  command: Extract<TaskCommand, { mode: 'seed' }>
) {
  await store.seedProfile({ name: command.name, age: command.age })
  await store.saveTask('seed', {
    id: 'task-1',
    text: 'Reply with exactly SECOND.',
    order: 2,
    status: 'pending'
  })
  await store.saveTask('seed', {
    id: 'task-2',
    text: 'Reply with exactly FIRST.',
    order: 1,
    status: 'pending'
  })
}

async function observe(
  assistant: AssistantFacade,
  store: ReturnType<typeof createTaskCliStore>,
  once: boolean
) {
  await writeSnapshot(store)
  if (once) return
  for await (const _tasks of store.watchTasks?.() ?? []) {
    await writeSnapshot(store)
  }
}

async function writeSnapshot(store: ReturnType<typeof createTaskCliStore>) {
  const [user, tasks] = await Promise.all([
    store.loadCurrentUser(),
    store.listTasks('current')
  ])
  writeOutput({ mode: 'observer', user, tasks })
}

function createRunner(
  assistant: AssistantFacade,
  model: string,
  trace: boolean
): TaskRunner {
  const agentId = 'task-cli-runner'
  const registered = assistant.registerAgent({
    id: agentId,
    model,
    skills: [],
    toolPolicy: { allow: [], requireApproval: [] }
  })
  return {
    async *run(input): AsyncIterable<TaskRunEvent> {
      await registered
      const traceId = createTraceId()
      writeTraceIf(trace, 'task-cli.boundary.request', {
        component: 'harness',
        protocolVersion: 2,
        buildVersion: '0.0.0-poc',
        runtime: 'bare',
        traceId
      })
      for await (const event of assistant.run({
        agentId,
        runId: `task-${input.taskId}`,
        signal: input.signal,
        input: input.prompt
      })) {
        if (event.type === 'content') {
          yield { type: 'content', text: event.text }
        } else if (event.type === 'error') {
          throw new Error(event.message)
        } else if (event.type === 'aborted') {
          throw new Error(
            typeof input.signal?.reason === 'string'
              ? input.signal.reason
              : 'Task execution aborted'
          )
        } else {
          yield { type: 'status', text: event.type }
        }
      }
      writeTraceIf(trace, 'task-cli.boundary.response', {
        component: 'harness',
        protocolVersion: 2,
        buildVersion: '0.0.0-poc',
        runtime: 'bare',
        traceId
      })
    }
  }
}

function option(args: readonly string[], name: string) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`)
  }
  return value
}

function defaultQwenModelPath() {
  const storageRoot = process.env.QVAC_SDK_STORAGE_ROOT ?? join(homedir(), '.qvac')
  return join(storageRoot, 'models', QWEN_CACHE_FILE)
}

function writeOutput(value: object) {
  console.log(JSON.stringify(value))
}

function writeTraceIf(enabled: boolean, type: string, details: object) {
  if (enabled) writeTrace(type, details)
}

function writeTrace(type: string, details: object) {
  console.error(
    JSON.stringify({
      type,
      timestamp: Date.now(),
      details
    })
  )
}

function writeRuntimeIdentities(enabled: boolean, assistant: AssistantFacade) {
  if (!enabled) return
  for (const child of assistant.inspect().children) {
    if (child.details) {
      writeTrace('assistant.runtime.ready', child.details)
    }
  }
}

function createTraceId() {
  traceSequence = (traceSequence + 1) % Number.MAX_SAFE_INTEGER
  return `trc_${Date.now().toString(36)}_${traceSequence.toString(36)}_${Math.floor(
    Math.random() * 0x1_0000_0000
  )
    .toString(36)
    .padStart(7, '0')}`
}

const isMain =
  import.meta.main === true ||
  process.argv[1] === fileURLToPath(import.meta.url)

if (isMain) {
  try {
    await runTaskCommand(parseTaskCommand(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
