import type { AbortSignal } from 'bare-abort-controller'
import { InferenceCancelledError } from '@/errors/index'

// A load, reload or last-lease unload in progress per model id. Two sessions
// loading the same configuration at once would both pass the loaded check and
// both load natively; the second native model could never be registered or
// unloaded. The id is a hash of the configuration, so one native load per id
// is the rule, and a lease is taken only once the model is registered or
// reconfigured.
const modelWorkInFlight = new Map<string, Promise<unknown>>()

/**
 * Runs `task` as the only load, reload or unload of `modelId`. A caller that
 * arrives while one is running waits for it to settle before running its own
 * task, so it sees the model registered (and takes a lease) or finds it absent
 * (and loads it itself after a failed load or a finished unload). A caller
 * whose request is cancelled while it waits leaves the queue at once with
 * `InferenceCancelledError`; the work it waited for is not touched.
 */
export async function withModelWorkLock<T>(
  modelId: string,
  task: () => Promise<T>,
  request?: { signal: AbortSignal; requestId: string }
): Promise<T> {
  let pending = modelWorkInFlight.get(modelId)
  while (pending !== undefined) {
    await (request ? untilSettledOrAborted(pending, request.signal) : pending)
    if (request?.signal.aborted === true) throw new InferenceCancelledError(request.requestId)
    pending = modelWorkInFlight.get(modelId)
  }
  const run = task()
  modelWorkInFlight.set(
    modelId,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  try {
    return await run
  } finally {
    modelWorkInFlight.delete(modelId)
  }
}

function untilSettledOrAborted(pending: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
    )
  })
}
