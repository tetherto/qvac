import type {
  SyncProfileClient
} from '@qvac/sync'
import {
  type DurableWorkCommand,
  type DurableWorkQuery,
  type DurableWorkResult
} from '@qvac/sync/profiles/durable-work'

const TASK_FORMAT = 'application/vnd.qvac.poc.task+json'
const STATUS_ENTRY = 'qvac.poc.task-status'

export type ReplicatedTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ReplicatedTask {
  readonly id: string
  readonly title: string | null
  readonly input: string
  readonly status: ReplicatedTaskStatus
  readonly result: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

export interface ReplicatedTaskRepository {
  create(request: {
    readonly id: string
    readonly title: string | null
    readonly input: string
  }): Promise<ReplicatedTask>
  update(request: {
    readonly id: string
    readonly status: ReplicatedTaskStatus
    readonly result?: string | null
  }): Promise<ReplicatedTask>
  get(id: string): Promise<ReplicatedTask | null>
  list(): Promise<readonly ReplicatedTask[]>
  watch(options?: {
    readonly signal?: AbortSignal
  }): AsyncIterable<readonly ReplicatedTask[]>
}

type Profile = SyncProfileClient<
  DurableWorkCommand,
  DurableWorkQuery,
  DurableWorkResult
>

export function createReplicatedTaskRepository(
  state: { readonly work: Profile }
): ReplicatedTaskRepository {
  const profile = state.work

  return {
    async create(request) {
      await profile.apply(
        {
          type: 'record-work',
          workId: request.id,
          payload: Buffer.from(
            JSON.stringify({
              title: request.title,
              input: request.input
            })
          ),
          payloadFormat: TASK_FORMAT,
          payloadVersion: 1
        },
        { operationId: `task:create:${request.id}` }
      )
      return requireTask(await readTask(profile, request.id), request.id)
    },
    async update(request) {
      const task = requireTask(await readTask(profile, request.id), request.id)
      const nextResult = request.result ?? task.result
      if (task.status === request.status && task.result === nextResult) return task
      if (isTerminal(request.status)) {
        await profile.apply(
          {
            type: 'record-outcome',
            workId: request.id,
            status: request.status,
            result: encodeResult(request.result ?? null)
          },
          {
            operationId: `task:outcome:${request.id}:${request.status}`
          }
        )
      } else {
        await profile.apply(
          {
            type: 'append-journal',
            workId: request.id,
            entryType: STATUS_ENTRY,
            body: Buffer.from(
              JSON.stringify({
                status: request.status,
                result: nextResult
              })
            )
          },
          {
            operationId: [
              'task:status',
              request.id,
              String(task.updatedAt),
              request.status,
              hashText(nextResult ?? '')
            ].join(':')
          }
        )
      }
      return requireTask(await readTask(profile, request.id), request.id)
    },
    get(id) {
      return readTask(profile, id)
    },
    async list() {
      const result = await profile.query({ type: 'list-work' })
      const tasks = await Promise.all(
        result.works
          .filter(({ payloadFormat }) => payloadFormat === TASK_FORMAT)
          .map(({ workId }) => readTask(profile, workId))
      )
      return tasks.filter((task): task is ReplicatedTask => task != null)
    },
    watch(options) {
      return watchTasks(profile, options)
    }
  }
}

async function* watchTasks(
  profile: Profile,
  options?: { readonly signal?: AbortSignal }
) {
  for await (const _frame of profile.watch(
    { type: 'list-work' },
    { signal: options?.signal }
  )) {
    const result = await profile.query({ type: 'list-work' })
    const tasks = await Promise.all(
      result.works
        .filter(({ payloadFormat }) => payloadFormat === TASK_FORMAT)
        .map(({ workId }) => readTask(profile, workId))
    )
    yield tasks.filter((task): task is ReplicatedTask => task != null)
  }
}

async function readTask(profile: Profile, id: string) {
  const [workResult, journalResult] = await Promise.all([
    profile.query({ type: 'get-work', workId: id }),
    profile.query({ type: 'list-journal', workId: id })
  ])
  const work = workResult.work
  if (!work || work.payloadFormat !== TASK_FORMAT) return null
  const payload = decodePayload(work.payload)
  const latest = journalResult.entries
    .filter(({ entryType }) => entryType === STATUS_ENTRY)
    .at(-1)
  const progress = latest ? decodeProgress(latest.body) : null
  return {
    id: work.workId,
    title: payload.title,
    input: payload.input,
    status: work.outcomeStatus ?? progress?.status ?? 'pending',
    result: work.outcomeResult
      ? decodeResult(work.outcomeResult)
      : progress?.result ?? null,
    createdAt: work.createdAt,
    updatedAt: latest?.recordedAt ?? work.createdAt
  } satisfies ReplicatedTask
}

function requireTask(task: ReplicatedTask | null, id: string) {
  if (!task) throw new Error(`Task not found: ${id}`)
  return task
}

/**
 * Bytes reach this code as a Buffer on Bare and Node, but as a plain
 * Uint8Array across the mobile worklet boundary, and Uint8Array.toString()
 * yields comma-joined byte values rather than text. Decode explicitly so the
 * result does not depend on which prototype survived the transport.
 */
function decodeUtf8(bytes: Buffer | Uint8Array | string) {
  if (typeof bytes === 'string') return bytes
  // Buffer.from normalises a plain Uint8Array into a Buffer whose toString
  // decodes text. TextDecoder is not available on Hermes.
  return Buffer.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  ).toString('utf8')
}

function decodePayload(payload: Buffer) {
  const value: unknown = JSON.parse(decodeUtf8(payload))
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid replicated task payload')
  }
  const title = Reflect.get(value, 'title')
  const input = Reflect.get(value, 'input')
  if (
    (title !== null && typeof title !== 'string') ||
    typeof input !== 'string'
  ) {
    throw new Error('Invalid replicated task payload')
  }
  return { title, input } as { title: string | null; input: string }
}

function decodeProgress(body: Buffer) {
  const value: unknown = JSON.parse(decodeUtf8(body))
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid replicated task progress')
  }
  const status = Reflect.get(value, 'status')
  const result = Reflect.get(value, 'result')
  if (
    (status !== 'pending' && status !== 'running') ||
    (result !== null && typeof result !== 'string')
  ) {
    throw new Error('Invalid replicated task progress')
  }
  return { status, result } as {
    status: 'pending' | 'running'
    result: string | null
  }
}

function encodeResult(result: string | null) {
  return Buffer.from(JSON.stringify({ result }))
}

function decodeResult(result: Buffer) {
  const value: unknown = JSON.parse(decodeUtf8(result))
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid replicated task outcome')
  }
  const decoded = Reflect.get(value, 'result')
  if (decoded !== null && typeof decoded !== 'string') {
    throw new Error('Invalid replicated task outcome')
  }
  return decoded as string | null
}

function isTerminal(
  status: ReplicatedTaskStatus
): status is 'completed' | 'failed' | 'cancelled' {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function hashText(value: string) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}
