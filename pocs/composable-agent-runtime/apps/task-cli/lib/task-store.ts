import type { AssistantStateEndpoint } from '@qvac/assistant'
import type { Task, TaskStatus, TaskStore } from '@qvac-poc/task-shared'
import {
  createReplicatedTaskRepository,
  type ReplicatedTask
} from '@qvac-poc/task-shared/sync-store'

const PROFILE_ID = '@task-cli/profile'
const TASK_PREFIX = 'task-cli/task/'
const MOBILE_TASK_PREFIX = 'phone-'

export interface SeedProfile {
  readonly name: string
  readonly age: number
}

export interface TaskCliStore extends TaskStore {
  seedProfile(profile: SeedProfile): Promise<void>
}

export function createTaskCliStore(
  state: AssistantStateEndpoint
): TaskCliStore {
  const tasks = createReplicatedTaskRepository(state)
  return {
    async seedProfile(profile) {
      if (!(await tasks.get(PROFILE_ID))) {
        await tasks.create({
          id: PROFILE_ID,
          title: profile.name,
          input: JSON.stringify({ age: profile.age })
        })
      }
    },
    async loadCurrentUser() {
      const [profile, identity] = await Promise.all([
        tasks.get(PROFILE_ID),
        state.mesh.identity()
      ])
      if (!profile?.title) throw new Error('Task user profile is not seeded')
      const metadata = parseProfileMetadata(profile.input)
      const deviceId = identity.deviceId.toString('hex')
      return {
        id: `user:${deviceId}`,
        name: profile.title,
        age: metadata.age,
        deviceIds: [deviceId]
      }
    },
    async listTasks() {
      return (await tasks.list())
        .filter(isApplicationTask)
        .map(decodeTask)
        .sort(
          (left, right) =>
            left.order - right.order || left.id.localeCompare(right.id)
        )
    },
    async *watchTasks() {
      for await (const snapshot of tasks.watch()) {
        yield snapshot
          .filter(isApplicationTask)
          .map(decodeTask)
          .sort(
            (left, right) =>
              left.order - right.order || left.id.localeCompare(right.id)
          )
      }
    },
    async saveTask(_userId, task) {
      let id = task.id
      let existing = await tasks.get(id)
      const prefixedId = `${TASK_PREFIX}${task.id}`
      if (!existing) {
        id = prefixedId
        existing = await tasks.get(id)
      }
      if (!existing) {
        existing = await tasks.create({
          id,
          title: task.text,
          input: JSON.stringify({ text: task.text, order: task.order })
        })
      }
      if (
        existing.status !== encodeStatus(task.status) ||
        existing.result !== encodeOutcome(task)
      ) {
        await tasks.update({
          id,
          status: encodeStatus(task.status),
          result: encodeOutcome(task)
        })
      }
    }
  }
}

function isApplicationTask(task: ReplicatedTask) {
  return (
    task.id.startsWith(TASK_PREFIX) ||
    task.id.startsWith(MOBILE_TASK_PREFIX)
  )
}

function decodeTask(task: ReplicatedTask): Task {
  const input = parseTaskInput(task.input, task.createdAt)
  const outcome = task.result ? parseTaskOutcome(task.result) : {}
  return {
    id: task.id.startsWith(TASK_PREFIX)
      ? task.id.slice(TASK_PREFIX.length)
      : task.id,
    text: input.text,
    order: input.order,
    status: decodeStatus(task.status),
    ...outcome
  }
}

function encodeStatus(status: TaskStatus) {
  return status
}

function decodeStatus(status: ReplicatedTask['status']): TaskStatus {
  if (status === 'cancelled') return 'failed'
  return status
}

function encodeOutcome(task: Task) {
  return JSON.stringify({
    result: task.result ?? null,
    error: task.error ?? null
  })
}

function parseProfileMetadata(serialized: string) {
  const value: unknown = JSON.parse(serialized)
  const age =
    typeof value === 'object' && value !== null
      ? Reflect.get(value, 'age')
      : undefined
  if (typeof age !== 'number') throw new Error('Invalid task user metadata')
  return { age }
}

function parseTaskInput(serialized: string, createdAt: number) {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    return { text: serialized, order: createdAt }
  }
  const text =
    typeof value === 'object' && value !== null
      ? Reflect.get(value, 'text')
      : undefined
  const order =
    typeof value === 'object' && value !== null
      ? Reflect.get(value, 'order')
      : undefined
  if (typeof text !== 'string' || typeof order !== 'number') {
    return { text: serialized, order: createdAt }
  }
  return { text, order }
}

function parseTaskOutcome(serialized: string) {
  const value: unknown = JSON.parse(serialized)
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid task outcome')
  }
  const result = Reflect.get(value, 'result')
  const error = Reflect.get(value, 'error')
  if (result !== null && typeof result !== 'string') {
    throw new Error('Invalid task result')
  }
  if (error !== null && typeof error !== 'string') {
    throw new Error('Invalid task error')
  }
  return {
    ...(typeof result === 'string' ? { result } : {}),
    ...(typeof error === 'string' ? { error } : {})
  }
}
