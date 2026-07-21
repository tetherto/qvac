import { Readable } from 'streamx'

interface WatchableStore {
  watch(listener: () => void): void
  unwatch(listener: () => void): void
  closing?: boolean | Promise<void> | null
  closed?: boolean
}

export function watchable<Request, Result>(
  store: WatchableStore,
  query: (request: Request) => Promise<Result>
) {
  return (request: Request): Readable & AsyncIterable<Result> => {
    let dirty = true
    let last = ''
    let wake: PromiseWithResolvers<void> | null = null
    const changed = () => {
      dirty = true
      wake?.resolve()
      wake = null
    }
    const stream = new Readable({
      open(callback: (error: Error | null) => void) {
        store.watch(changed)
        callback(null)
      },
      async read(callback: (error: Error | null) => void) {
        try {
          while (!stream.destroying) {
            if (store.closed || store.closing) {
              stream.push(null)
              break
            }
            if (!dirty) {
              wake = Promise.withResolvers()
              await wake.promise
              continue
            }
            dirty = false
            const value = await query(request)
            const encoded = JSON.stringify(value)
            if (encoded === last) continue
            last = encoded
            stream.push(value)
            break
          }
          callback(null)
        } catch (error) {
          callback(error as Error)
        }
      },
      predestroy() {
        changed()
      },
      destroy(callback: (error: Error | null) => void) {
        store.unwatch(changed)
        callback(null)
      }
    })
    return stream as Readable & AsyncIterable<Result>
  }
}
