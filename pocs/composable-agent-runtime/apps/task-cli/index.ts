import {
  createAssistant,
  type AssistantFacade,
  type AssistantInference
} from '@qvac/assistant'
import {
  processIncompleteTasks,
  type TaskRunner,
  type TaskRunEvent
} from '@qvac-poc/task-shared'
import { createTraceId } from '@qvac/runtime-contracts'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTaskCliStore } from './lib/task-store.ts'

const QWEN_CACHE_FILE =
  '3a65a2a3c6a30a47_Qwen3.5-4B-Q4_K_M.gguf'

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

export function parseTaskCommand(args: readonly string[]): TaskCommand {
  const mode = args[0]
  if (mode !== 'seed' && mode !== 'observe' && mode !== 'execute') {
    throw new Error(
      'Usage: task-cli <seed|observe|execute> [--storage <path>]'
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
  const assistant = createAssistant({
    storagePath: command.storagePath,
    sync: { bootstrap: [] },
    logging: { level: command.trace ? 'debug' : 'off' },
    inference:
      command.mode === 'execute'
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
    if (command.inference.kind === 'qwen') {
      await access(command.model).catch(() => {
        throw new Error(
          `Qwen smoke requires a pre-provisioned model at ${command.model}`
        )
      })
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
  for await (const _tasks of assistant.state.watchTasks()) {
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
  return {
    async *run(input): AsyncIterable<TaskRunEvent> {
      const traceId = createTraceId()
      writeTraceIf(trace, 'task-cli.boundary.request', {
        component: 'harness',
        protocolVersion: 1,
        buildVersion: '0.0.0-poc',
        runtime: 'bare',
        traceId
      })
      for await (const event of assistant.run({
              runId: `task-${input.taskId}`,
              traceId,
        model,
        messages: [
          {
            role: 'system',
            content: `User ${input.user.name}, age ${input.user.age}`
          },
          { role: 'user', content: input.prompt }
        ]
      })) {
        if (event.type === 'content') {
          yield { type: 'content', text: event.text }
        } else if (event.type === 'error') {
          throw new Error(event.message)
        } else {
          yield { type: 'status', text: event.type }
        }
      }
      writeTraceIf(trace, 'task-cli.boundary.response', {
        component: 'harness',
        protocolVersion: 1,
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
      const sdkIdentity = child.details.sdkIdentity
      if (
        typeof sdkIdentity === 'object' &&
        sdkIdentity !== null &&
        !Array.isArray(sdkIdentity)
      ) {
        writeTrace('assistant.runtime.ready', sdkIdentity)
      }
    }
  }
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
