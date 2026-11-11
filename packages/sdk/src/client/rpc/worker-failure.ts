import { WorkerCrashedError, WorkerStartupError } from '@/utils/errors-client'

/**
 * How long a worker gets to start, from launch until it has applied its
 * configuration, when `rpcInitTimeoutMs` is not set.
 */
export const DEFAULT_WORKER_START_TIMEOUT_MS = 60_000

/** How long a stopping worker gets to unload its engines before it is killed. */
export const WORKER_SHUTDOWN_GRACE_MS = 10_000

/** The fields bare-stow-host sets on a worker's failure. */
type ExitReport =
  { code?: string; exitCode?: number | null; signalCode?: string | null } | undefined

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

/** Rejects with the signal's reason once it aborts. */
export function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () =>
      reject(signal.reason instanceof Error ? signal.reason : new WorkerCrashedError(null, null))
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
  })
}

/** Rejects once `ms` have passed, for the part of the start after the worker is ready. */
export function startDeadline(ms: number): { expired: Promise<never>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        reject(
          new WorkerStartupError('Worker did not apply its configuration in time', {
            exitCode: null,
            exitSignal: null,
            timedOut: true
          })
        )
      },
      Math.max(ms, 0)
    )
  })
  return { expired, clear: () => clearTimeout(timer) }
}

export function workerStartupFailed(cause: unknown, stderrTail?: string): WorkerStartupError {
  const timedOut = (cause as ExitReport)?.code === 'WORKER_TIMEOUT'
  return new WorkerStartupError(
    timedOut ? 'Worker did not signal ready in time' : 'Worker failed before signalling ready',
    { ...exitOf(cause), timedOut, ...(stderrTail ? { stderrTail } : {}) },
    cause
  )
}

const STDERR_TAIL_CHARS = 4096

/** Keeps the end of a worker's stderr and passes each chunk to `log`. */
export function stderrTail(log: (text: string) => void): {
  write: (chunk: unknown) => void
  read: () => string | undefined
} {
  let tail = ''
  return {
    write(chunk) {
      const text = String(chunk)
      log(text.trimEnd())
      tail = (tail + text).slice(-STDERR_TAIL_CHARS)
    },
    read: () => tail || undefined
  }
}
