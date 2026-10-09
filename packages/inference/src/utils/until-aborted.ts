import type { AbortSignalLike } from '@/schemas/common'

const ABORTED = Symbol('aborted')

/**
 * Iterates `source` until `signal` aborts, then ends without an error.
 *
 * Each pending `next()` is raced against the signal instead of awaited,
 * because an async generator queues `return()` behind its pending `next()`: a
 * source that never yields again would otherwise never end. Once aborted, the
 * source is returned in the background and a late rejection from it is
 * dropped, since the caller has stopped listening.
 */
export async function* untilAborted<T>(
  source: AsyncGenerator<T>,
  signal: AbortSignalLike | undefined
): AsyncGenerator<T> {
  if (!signal) {
    yield* source
    return
  }
  try {
    while (!signal.aborted) {
      const next = source.next()
      const result = await new Promise<IteratorResult<T> | typeof ABORTED>((resolve, reject) => {
        const onAbort = () => resolve(ABORTED)
        signal.addEventListener('abort', onAbort, { once: true })
        next.then(
          (value) => {
            signal.removeEventListener('abort', onAbort)
            resolve(value)
          },
          (error: unknown) => {
            signal.removeEventListener('abort', onAbort)
            reject(error)
          }
        )
      })
      if (result === ABORTED || result.done) return
      yield result.value
    }
  } finally {
    void source.return(undefined).catch(() => {})
  }
}
