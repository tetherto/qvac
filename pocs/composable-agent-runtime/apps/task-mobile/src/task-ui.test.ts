import { describe, expect, test } from 'bun:test'
import type { TaskControllerTask } from './task-controller.ts'
import {
  connectionCopy,
  taskFormError,
  taskStatusCopy,
  visibleTasks
} from './task-ui.ts'

describe('mobile task UI helpers', () => {
  test('explains every connection state in user-facing language', () => {
    expect(connectionCopy({ state: 'connecting', error: null })).toEqual({
      label: 'Connecting',
      detail: 'Opening the saved Sync session.'
    })
    expect(connectionCopy({ state: 'awaiting-approval', error: null }).label).toBe(
      'Awaiting desktop approval'
    )
    expect(connectionCopy({ state: 'writable', error: null }).label).toBe('Writable')
    expect(connectionCopy({ state: 'offline', error: null }).label).toBe('Offline')
    expect(connectionCopy({ state: 'error', error: 'Invite expired' })).toEqual({
      label: 'Connection error',
      detail: 'Invite expired'
    })
  })

  test('requires both task fields and writer admission', () => {
    expect(taskFormError('idle', 'Title', 'Prompt')).toBe(
      'Pair with the desktop before creating tasks.'
    )
    expect(taskFormError('writable', ' ', 'Prompt')).toBe('Enter a task title.')
    expect(taskFormError('writable', 'Title', ' ')).toBe('Enter a task prompt.')
    expect(taskFormError('writable', ' Title ', ' Prompt ')).toBeNull()
  })

  test('renders supported task states and newest updates first', () => {
    expect(taskStatusCopy('pending')).toBe('Pending')
    expect(taskStatusCopy('running')).toBe('Running')
    expect(taskStatusCopy('completed')).toBe('Completed')
    expect(taskStatusCopy('failed')).toBe('Failed')

    const older = task({ id: 'older', updatedAt: 1 })
    const newer = task({ id: 'newer', updatedAt: 2 })
    expect(visibleTasks([older, newer]).map(({ id }) => id)).toEqual([
      'newer',
      'older'
    ])
  })
})

function task(
  override: Partial<TaskControllerTask> & Pick<TaskControllerTask, 'id'>
): TaskControllerTask {
  return {
    title: 'Task',
    input: 'Prompt',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    result: null,
    ...override
  }
}
