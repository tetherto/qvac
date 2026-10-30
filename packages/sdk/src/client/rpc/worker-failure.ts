import { WorkerCrashedError, WorkerStartupError } from '@/utils/errors-client'

/** bare-stow destroys the `ipc` with these when the worker process exits without saying why. */
type ExitReport = { exitCode?: number | null; signalCode?: string | null } | undefined

function exitOf(cause: unknown) {
  const exit = cause as ExitReport
  return {
    exitCode: exit?.exitCode ?? null,
    exitSignal: (exit?.signalCode ?? null) as NodeJS.Signals | null
  }
}

export function workerCrashed(cause: unknown): WorkerCrashedError {
  const { exitCode, exitSignal } = exitOf(cause)
  return new WorkerCrashedError(exitCode, exitSignal, cause)
}

export function workerStartupFailed(cause: unknown, timedOut: boolean): WorkerStartupError {
  return new WorkerStartupError(
    timedOut ? 'Worker did not signal ready in time' : 'Worker failed before signalling ready',
    { ...exitOf(cause), timedOut },
    cause
  )
}
