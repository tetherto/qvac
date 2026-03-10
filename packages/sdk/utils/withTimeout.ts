/**
 * Creates a timeout promise that rejects after the specified duration
 */
function createTimeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Operation timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

/**
 * Wraps a promise with an optional timeout
 * If no timeout is provided, returns the original promise unchanged
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  if (timeoutMs === undefined) {
    return promise;
  }

  const timeoutPromise = createTimeoutPromise(timeoutMs);
  return Promise.race([promise, timeoutPromise]);
}

/**
 * Wraps an async generator with optional timeout per iteration
 * If no timeout is provided, returns the original generator unchanged
 */
export async function* withTimeoutStream<T>(
  generator: AsyncGenerator<T>,
  timeoutMs?: number,
): AsyncGenerator<T> {
  if (timeoutMs === undefined) {
    yield* generator;
    return;
  }

  for await (const item of generator) {
    const itemPromise = Promise.resolve(item);
    const timeoutPromise = createTimeoutPromise(timeoutMs);
    const result = await Promise.race([itemPromise, timeoutPromise]);
    yield result;
  }
}
