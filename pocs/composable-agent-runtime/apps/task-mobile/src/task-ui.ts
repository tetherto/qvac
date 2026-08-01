import type {
  TaskControllerSnapshot,
  TaskControllerState,
  TaskControllerTask
} from './task-controller.ts'

interface ConnectionCopy {
  readonly label: string
  readonly detail: string
}

export function connectionCopy(snapshot: TaskControllerSnapshot): ConnectionCopy {
  if (snapshot.state === 'idle') {
    return {
      label: 'Not paired',
      detail: 'Paste the pairing URI shown by the desktop service.'
    }
  }
  if (snapshot.state === 'connecting') {
    return {
      label: 'Connecting',
      detail: 'Opening the saved Sync session.'
    }
  }
  if (snapshot.state === 'awaiting-approval') {
    return {
      label: 'Awaiting desktop approval',
      detail: 'Confirm this writer fingerprint in the desktop terminal.'
    }
  }
  if (snapshot.state === 'writable') {
    return {
      label: 'Writable',
      detail: 'This phone can create tasks and receive live results.'
    }
  }
  if (snapshot.state === 'offline') {
    return {
      label: 'Offline',
      detail: 'The Sync Worklet disconnected. Reconnect to the saved session.'
    }
  }
  return {
    label: 'Connection error',
    detail: snapshot.error ?? 'Mobile Sync could not connect.'
  }
}

export function taskFormError(
  state: TaskControllerState,
  title: string,
  prompt: string
) {
  if (state !== 'writable') {
    return 'Pair with the desktop before creating tasks.'
  }
  if (title.trim().length === 0) return 'Enter a task title.'
  if (prompt.trim().length === 0) return 'Enter a task prompt.'
  return null
}

export function taskStatusCopy(status: TaskControllerTask['status']) {
  if (status === 'pending') return 'Pending'
  if (status === 'running') return 'Running'
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return 'Failed'
  return 'Cancelled'
}

export function visibleTasks(tasks: readonly TaskControllerTask[]) {
  return [...tasks].sort((left, right) => right.updatedAt - left.updatedAt)
}
