import { describe, expect, test } from 'bun:test'
import {
  processIncompleteTasks,
  type Task,
  type TaskRunEvent,
  type TaskRunner,
  type TaskStore,
  type UserProfile
} from './index.ts'

describe('task application workflow', function () {
  test('loads the app profile and processes pending tasks sequentially', async function () {
    const user: UserProfile = {
      id: 'user-1',
      name: 'Ada',
      age: 36,
      deviceIds: ['device-a']
    }
    const initial: Task[] = [
      { id: 'done', text: 'already done', order: 0, status: 'completed', result: 'old' },
      { id: 'second', text: 'second prompt', order: 2, status: 'pending' },
      { id: 'first', text: 'first prompt', order: 1, status: 'pending' }
    ]
    const saved: Task[] = []
    let active = 0
    let maximumActive = 0
    const observed: string[] = []

    const store: TaskStore = {
      async loadCurrentUser() {
        return user
      },
      async listTasks() {
        return initial
      },
      async saveTask(_userId, task) {
        saved.push(task)
      }
    }
    const runner: TaskRunner = {
      async *run(input): AsyncGenerator<TaskRunEvent> {
        active++
        maximumActive = Math.max(maximumActive, active)
        observed.push(`${input.taskId}:${input.user.name}:${input.user.age}`)
        await Promise.resolve()
        yield { type: 'content', text: `${input.prompt}:result` }
        active--
      }
    }

    const outcomes = await processIncompleteTasks(store, runner)

    expect(maximumActive).toBe(1)
    expect(observed).toEqual(['first:Ada:36', 'second:Ada:36'])
    expect(outcomes).toEqual([
      { taskId: 'first', status: 'completed' },
      { taskId: 'second', status: 'completed' }
    ])
    expect(saved.filter((task) => task.status === 'completed').map((task) => task.id)).toEqual([
      'first',
      'second'
    ])
  })

  test('records a failed task and continues the sequence', async function () {
    const tasks: Task[] = [
      { id: 'bad', text: 'fail', order: 1, status: 'pending' },
      { id: 'good', text: 'pass', order: 2, status: 'pending' }
    ]
    const saved: Task[] = []
    const store: TaskStore = {
      async loadCurrentUser() {
        return { id: 'user-1', name: 'Ada', age: 36, deviceIds: ['device-a'] }
      },
      async listTasks() {
        return tasks
      },
      async saveTask(_userId, task) {
        saved.push(task)
      }
    }
    const runner: TaskRunner = {
      async *run(input): AsyncGenerator<TaskRunEvent> {
        if (input.taskId === 'bad') throw new Error('model interrupted')
        yield { type: 'content', text: 'ok' }
      }
    }

    const outcomes = await processIncompleteTasks(store, runner)

    expect(outcomes).toEqual([
      { taskId: 'bad', status: 'failed' },
      { taskId: 'good', status: 'completed' }
    ])
    expect(saved.find((task) => task.id === 'bad' && task.status === 'failed')?.error).toBe(
      'model interrupted'
    )
  })
})
