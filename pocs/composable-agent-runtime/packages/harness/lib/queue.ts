export function createAsyncQueue<T>() {
  const values: T[] = []
  const waiters: Array<(result: IteratorResult<T>) => void> = []
  let ended = false

  function push(value: T) {
    if (ended) return
    const waiter = waiters.shift()
    if (waiter) waiter({ value, done: false })
    else values.push(value)
  }

  function end() {
    if (ended) return
    ended = true
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  return {
    push,
    end,
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          const value = values.shift()
          if (value !== undefined) return Promise.resolve({ value, done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => waiters.push(resolve))
        }
      }
    }
  }
}
