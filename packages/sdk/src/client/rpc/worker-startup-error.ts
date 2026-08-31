export interface WorkerExit {
  code: number | null
  signal: string | null
}

export function createWorkerStartupError(details: string, stderrTail: string): Error {
  const stderr = stderrTail.trimEnd()
  if (!stderr) return new Error(details)

  return new Error(`${details}\n\nWorker stderr:\n${stderr}`)
}

export function createRPCInitTimeoutCause(
  stderrTail: string,
  workerExit: WorkerExit | null
): Error | undefined {
  if (workerExit) {
    return createWorkerStartupError(
      `Worker process exited with code ${workerExit.code}, signal ${workerExit.signal} before IPC connection was established`,
      stderrTail
    )
  }

  if (!stderrTail) return undefined

  return createWorkerStartupError(
    'Worker did not establish IPC before the RPC initialization timeout',
    stderrTail
  )
}
