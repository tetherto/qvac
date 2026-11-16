/**
 * Distinguishes a legitimate per-call timeout from a transport failure (e.g.
 * a worker crash) for callers racing this against other rejection sources.
 */
export class OperationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Operation timeout after ${timeoutMs}ms`)
    this.name = 'OperationTimeoutError'
  }
}

/**
 * Wraps a promise with an optional timeout
 * If no timeout is provided, returns the original promise unchanged
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (timeoutMs === undefined) {
    return promise
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OperationTimeoutError(timeoutMs)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Wraps an async generator with optional timeout per iteration
 * If no timeout is provided, returns the original generator unchanged
 */
export async function* withTimeoutStream<T>(
  generator: AsyncGenerator<T>,
  timeoutMs?: number
): AsyncGenerator<T> {
  if (timeoutMs === undefined) {
    yield* generator
    return
  }

  let timedOut = false
  try {
    while (true) {
      const result = await withTimeout(generator.next(), timeoutMs)
      if (result.done) return
      yield result.value
    }
  } catch (error) {
    timedOut = error instanceof OperationTimeoutError
    throw error
  } finally {
    const closing = generator.return(undefined)
    if (timedOut) {
      // return() queues behind a pending next(); waiting would hide the timeout.
      void closing.catch(() => {})
    } else {
      await closing
    }
  }
}
