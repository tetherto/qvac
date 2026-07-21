import type { AssistantStateEndpoint } from '@qvac/assistant'
import type {
  Task,
  TaskStatus,
  TaskStore
} from '@qvac-poc/task-shared'

const PROFILE_ID = '@task-cli/profile'
const TASK_PREFIX = 'task-cli/task/'

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
  return {
    async seedProfile(profile) {
      await state.setUserProfile({ name: profile.name })
      const existing = await state.getTask({ id: PROFILE_ID })
      if (!existing.task) {
        await state.createTask({
          id: PROFILE_ID,
          title: 'Task CLI user profile',
          input: JSON.stringify({ age: profile.age })
        })
      }
      await state.updateTask({
        id: PROFILE_ID,
        title: 'Task CLI user profile',
        status: 'completed',
        result: JSON.stringify({ age: profile.age })
      })
    },
    async loadCurrentUser() {
      const [profileResult, identity, metadataResult] = await Promise.all([
        state.getUserProfile(),
        state.getIdentity(),
        state.getTask({ id: PROFILE_ID })
      ])
      if (!profileResult.profile) {
        throw new Error('Task user profile is not seeded')
      }
      if (!metadataResult.task?.result) {
        throw new Error('Task user metadata is not seeded')
      }
      const metadata = parseProfileMetadata(metadataResult.task.result)
      const deviceId = identity.deviceId.toString('hex')
      return {
        id: `user:${deviceId}`,
        name: profileResult.profile.name,
        age: metadata.age,
        deviceIds: [deviceId]
      }
    },
    async listTasks() {
      const { tasks } = await state.listTasks()
      return tasks
        .filter((task) => task.id.startsWith(TASK_PREFIX))
        .map(decodeTask)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    },
    async saveTask(_userId, task) {
      const id = `${TASK_PREFIX}${task.id}`
      const existing = await state.getTask({ id })
      if (!existing.task) {
        await state.createTask({
          id,
          title: task.text,
          input: JSON.stringify({ text: task.text, order: task.order })
        })
      }
      await state.updateTask({
        id,
        title: task.text,
        status: encodeStatus(task.status),
        result: JSON.stringify({
          result: task.result ?? null,
          error: task.error ?? null
        })
      })
    }
  }
}

function decodeTask(task: {
  readonly id: string
  readonly input: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  readonly result?: string | null
}): Task {
  const input = parseTaskInput(task.input)
  const outcome = task.result ? parseTaskOutcome(task.result) : {}
  return {
    id: task.id.slice(TASK_PREFIX.length),
    text: input.text,
    order: input.order,
    status: decodeStatus(task.status),
    ...outcome
  }
}

function encodeStatus(status: TaskStatus) {
  switch (status) {
    case 'processing':
      return 'running' as const
    case 'completed':
      return 'completed' as const
    case 'failed':
      return 'failed' as const
    case 'pending':
      return 'pending' as const
  }
}

function decodeStatus(
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
): TaskStatus {
  if (status === 'running') return 'processing'
  if (status === 'cancelled') return 'failed'
  return status
}

function parseProfileMetadata(serialized: string) {
  const value = JSON.parse(serialized)
  const age = typeof value === 'object' && value !== null
    ? Reflect.get(value, 'age')
    : undefined
  if (
    typeof age !== 'number'
  ) {
    throw new Error('Invalid task user metadata')
  }
  return { age }
}

function parseTaskInput(serialized: string) {
  const value = JSON.parse(serialized)
  const text = typeof value === 'object' && value !== null
    ? Reflect.get(value, 'text')
    : undefined
  const order = typeof value === 'object' && value !== null
    ? Reflect.get(value, 'order')
    : undefined
  if (
    typeof text !== 'string' ||
    typeof order !== 'number'
  ) {
    throw new Error('Invalid task input')
  }
  return { text, order }
}

function parseTaskOutcome(serialized: string) {
  const value = JSON.parse(serialized)
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
