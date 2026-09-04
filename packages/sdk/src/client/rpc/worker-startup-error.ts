import { WorkerStartupError } from '@/utils/errors-client'

export interface WorkerExit {
  code: number | null
  signal: string | null
}

/**
 * Always returns a cause. A worker that is still running and has written
 * nothing carries no diagnostic text, but `workerExited: false` is what tells a
 * caller that waiting longer could still help.
 */
export function createRPCInitTimeoutCause(
  stderrTail: string,
  workerExit: WorkerExit | null
): WorkerStartupError {
  const stderr = stderrTail.trimEnd()

  if (workerExit) {
    return new WorkerStartupError(
      `Worker process exited with code ${workerExit.code}, signal ${workerExit.signal} before IPC connection was established`,
      { code: workerExit.code, signal: workerExit.signal as NodeJS.Signals | null },
      stderr
    )
  }

  return new WorkerStartupError(
    'Worker did not establish IPC before the RPC initialization timeout',
    null,
    stderr
  )
}
