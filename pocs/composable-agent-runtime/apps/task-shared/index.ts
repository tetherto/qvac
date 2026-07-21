export interface UserProfile {
  id: string
  name: string
  age: number
  deviceIds: readonly string[]
}

export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed'

export interface Task {
  id: string
  text: string
  order: number
  status: TaskStatus
  result?: string
  error?: string
}

export interface TaskStore {
  loadCurrentUser(): Promise<UserProfile>
  listTasks(userId: string): Promise<readonly Task[]>
  saveTask(userId: string, task: Task): Promise<void>
}

export interface TaskRunEvent {
  type: 'content' | 'status'
  text?: string
}

export interface TaskRunner {
  run(input: {
    taskId: string
    prompt: string
    user: Pick<UserProfile, 'id' | 'name' | 'age'>
  }): AsyncIterable<TaskRunEvent>
}

export interface TaskOutcome {
  taskId: string
  status: 'completed' | 'failed'
}

export async function processIncompleteTasks(
  store: TaskStore,
  runner: TaskRunner
): Promise<readonly TaskOutcome[]> {
  const user = await store.loadCurrentUser()
  const tasks = [...(await store.listTasks(user.id))]
    .filter((task) => task.status === 'pending')
    .sort(compareTasks)
  const outcomes: TaskOutcome[] = []

  for (const task of tasks) {
    await store.saveTask(user.id, { ...task, status: 'processing', error: undefined })
    try {
      const result = await collectResult(
        runner.run({
          taskId: task.id,
          prompt: task.text,
          user: { id: user.id, name: user.name, age: user.age }
        })
      )
      await store.saveTask(user.id, {
        ...task,
        status: 'completed',
        result,
        error: undefined
      })
      outcomes.push({ taskId: task.id, status: 'completed' })
    } catch (error) {
      await store.saveTask(user.id, {
        ...task,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
      outcomes.push({ taskId: task.id, status: 'failed' })
    }
  }

  return outcomes
}

function compareTasks(left: Task, right: Task) {
  return left.order - right.order || left.id.localeCompare(right.id)
}

async function collectResult(events: AsyncIterable<TaskRunEvent>) {
  let result = ''
  for await (const event of events) {
    if (event.type === 'content') result += event.text ?? ''
  }
  return result
}
