import type {
  GeneratedHarnessStream,
  WireValue
} from '../spec/hrpc/index.js'
import AbortController from '#abort-controller'
import { createAsyncQueue } from './queue.ts'
import type {
  HarnessRunStore,
  HarnessWorkChange
} from './run-store.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
}

export function createRemoteHarnessRunStore() {
  let stream: GeneratedHarnessStream | null = null
  let attached: Promise<void> | null = null
  let resolveAttached: (() => void) | null = null
  let nextRequestId = 0
  const pending = new Map<string, Deferred<WireValue>>()
  const watches = new Map<string, ReturnType<typeof createAsyncQueue<HarnessWorkChange>>>()

  function ready() {
    attached ??= new Promise<void>((resolve) => {
      resolveAttached = resolve
    })
    return attached
  }

  function attach(next: GeneratedHarnessStream) {
    if (stream) throw new Error('Harness state port is already attached')
    stream = next
    next.on('data', receive)
    next.on('close', closePending)
    next.on('error', closePending)
    if (resolveAttached) resolveAttached()
    else attached = Promise.resolve()
  }

  async function request(name: string, data?: unknown) {
    await ready()
    if (!stream) throw new Error('Harness state port is unavailable')
    const requestId = String(++nextRequestId)
    const deferred = createDeferred<WireValue>()
    pending.set(requestId, deferred)
    stream.write({
      type: 'state-request',
      runId: requestId,
      name,
      ...(data === undefined ? {} : { data: jsonWire(data) })
    })
    return deferred.promise
  }

  function receive(frame: Record<string, WireValue>) {
    if (typeof frame.runId !== 'string') return
    if (frame.type === 'state-watch') {
      const queue = watches.get(frame.runId)
      if (frame.data === null) {
        queue?.end()
        watches.delete(frame.runId)
      } else if (frame.data !== undefined) {
        queue?.push(frame.data as unknown as HarnessWorkChange)
      }
      return
    }
    const deferred = pending.get(frame.runId)
    if (!deferred) return
    pending.delete(frame.runId)
    if (frame.type === 'state-error') {
      deferred.reject(new Error(typeof frame.message === 'string' ? frame.message : 'state port failed'))
    } else {
      deferred.resolve(frame.data ?? null)
    }
  }

  function closePending() {
    stream = null
    const error = new Error('Harness state port closed')
    for (const deferred of pending.values()) deferred.reject(error)
    pending.clear()
    for (const queue of watches.values()) queue.end()
    watches.clear()
  }

  const store: HarnessRunStore = {
    async loadRun(identity) {
      return await request('load-run', identity) as unknown as Awaited<
        ReturnType<HarnessRunStore['loadRun']>
      >
    },
    async appendEvents(input) {
      return String(await request('append-events', input))
    },
    async saveCheckpoint(input) {
      return String(await request('save-checkpoint', input))
    },
    async finish(input) {
      return String(await request('finish', input))
    },
    watchAvailableWork(input = {}) {
      return (async function* () {
        await ready()
        if (!stream) throw new Error('Harness state port is unavailable')
        const requestId = String(++nextRequestId)
        const queue = createAsyncQueue<HarnessWorkChange>()
        watches.set(requestId, queue)
        const abort = () => {
          stream?.write({ type: 'state-cancel-watch', runId: requestId })
          queue.end()
        }
        input.signal?.addEventListener('abort', abort, { once: true })
        stream.write({
          type: 'state-request',
          runId: requestId,
          name: 'watch-work',
          ...(input.after ? { data: input.after } : {})
        })
        try {
          yield* queue
        } finally {
          input.signal?.removeEventListener('abort', abort)
          watches.delete(requestId)
        }
      })()
    },
    async close() {
      stream?.destroy()
      closePending()
    }
  }

  return { store, attach }
}

export function serveHarnessRunStore(
  stream: GeneratedHarnessStream,
  store: HarnessRunStore
) {
  const watches = new Map<string, AbortController>()
  const close = () => {
    for (const controller of watches.values()) controller.abort()
    watches.clear()
  }
  stream.on('close', close)
  stream.on('error', close)
  stream.on('data', (frame) => {
    if (typeof frame.runId !== 'string') return
    if (frame.type === 'state-cancel-watch') {
      watches.get(frame.runId)?.abort()
      watches.delete(frame.runId)
      return
    }
    if (frame.type !== 'state-request' || typeof frame.name !== 'string') return
    void handle(frame.runId, frame.name, frame.data)
  })

  async function handle(requestId: string, name: string, data: WireValue | undefined) {
    try {
      if (name === 'watch-work') {
        const controller = new AbortController()
        watches.set(requestId, controller)
        for await (const change of store.watchAvailableWork({
          ...(typeof data === 'string' ? { after: data } : {}),
          signal: controller.signal
        })) {
          stream.write({
            type: 'state-watch',
            runId: requestId,
            data: jsonWire(change)
          })
        }
        stream.write({ type: 'state-watch', runId: requestId, data: null })
        watches.delete(requestId)
        return
      }
      const result = await invoke(store, name, data)
      stream.write({
        type: 'state-response',
        runId: requestId,
        data: jsonWire(result)
      })
    } catch (error) {
      stream.write({
        type: 'state-error',
        runId: requestId,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return close
}

function invoke(store: HarnessRunStore, name: string, data: WireValue | undefined) {
  switch (name) {
    case 'load-run':
      return store.loadRun(data as never)
    case 'append-events':
      return store.appendEvents(data as never)
    case 'save-checkpoint':
      return store.saveCheckpoint(data as never)
    case 'finish':
      return store.finish(data as never)
    default:
      throw new Error(`unknown Harness state operation: ${name}`)
  }
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function jsonWire(value: unknown): WireValue {
  return JSON.parse(JSON.stringify(value)) as WireValue
}
