import { WorkerStartupError } from '@/utils/errors-client'

export interface WorkerExit {
  code: number | null
  signal: string | null
}

export function createRPCInitTimeoutCause(
  stderrTail: string,
  workerExit: WorkerExit | null
): WorkerStartupError | undefined {
  const stderr = stderrTail.trimEnd()

  if (workerExit) {
    return new WorkerStartupError(
      `Worker process exited with code ${workerExit.code}, signal ${workerExit.signal} before IPC connection was established`,
      { code: workerExit.code, signal: workerExit.signal as NodeJS.Signals | null },
      stderr
    )
  }

  // A silent process that is still running carries no diagnostic worth
  // attaching; the bare timeout already says everything we know.
  if (!stderr) return undefined

  return new WorkerStartupError(
    'Worker did not establish IPC before the RPC initialization timeout',
    null,
    stderr
  )
}
