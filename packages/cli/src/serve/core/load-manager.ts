import {
  loadModel as sdkLoadModel,
  unloadModel as sdkUnloadModel,
  cancel as sdkCancel
} from '@qvac/sdk'
import type { ModelConstant } from '@qvac/sdk'
import type { ModelRegistry } from '@/serve/core/model-registry'
import type { Logger } from '@/logger'

/** SDK loader, overridable in tests. `@qvac/sdk`'s `loadModel` is heavily
 * overloaded; this is the shape serve calls it with (free-form `modelType`
 * string), returning a bare model-id promise. The real SDK promise also carries
 * a `requestId` used for cancellation, read defensively at call time. */
export type LoadModelFn = (opts: {
  modelSrc: string | ModelConstant
  modelType: string
  modelConfig: Record<string, unknown>
}) => Promise<string>

export const defaultLoadFn: LoadModelFn = (opts) => sdkLoadModel(opts)

/** SDK cancel/unload, injectable so the cancel + timeout paths can be tested
 * without a live SDK. */
export interface LoadManagerDeps {
  cancel?: (requestId: string) => Promise<void>
  unload?: (modelId: string) => Promise<void>
}

const defaultCancel = (requestId: string): Promise<void> => sdkCancel({ requestId })
const defaultUnload = (modelId: string): Promise<void> => sdkUnloadModel({ modelId })

export class ModelLoadTimeoutError extends Error {
  constructor(alias: string, timeoutMs: number) {
    super(`Loading model "${alias}" timed out after ${timeoutMs}ms`)
    this.name = 'ModelLoadTimeoutError'
  }
}

export interface LoadManagerOptions {
  /** Max simultaneous loads across distinct aliases. `1` mirrors preload's
   * sequential behavior and bounds memory under lazy request-time loads. */
  concurrency: number
  /** Per-load deadline; on expiry the SDK load is cancelled and the load
   * rejects with {@link ModelLoadTimeoutError}. `null` = unbounded. */
  timeoutMs: number | null
}

export interface LoadManager {
  /**
   * Load `alias` to READY, deduping concurrent callers onto one SDK load.
   * `signal` (from a request) opts this caller into disconnect-cancellation:
   * when every signalled caller has aborted and no permanent (preload) caller
   * remains, the in-flight SDK load is cancelled. A caller without a signal
   * keeps the load alive regardless of disconnects.
   */
  load: (alias: string, signal?: AbortSignal) => Promise<void>
  isLoading: (alias: string) => boolean
  /** Resolve when any in-flight load of `alias` settles (never rejects). */
  settled: (alias: string) => Promise<void>
}

interface InflightLoad {
  promise: Promise<void>
  requestId: string | null
  activeWaiters: number
  hasPermanentWaiter: boolean
  cancelRequested: boolean
  timedOut: boolean
  settled: boolean
  disposers: Array<() => void>
}

export function createLoadManager(
  registry: ModelRegistry,
  logger: Logger,
  options: LoadManagerOptions,
  getLoadFn: () => LoadModelFn,
  deps: LoadManagerDeps = {}
): LoadManager {
  const cancelFn = deps.cancel ?? defaultCancel
  const unloadFn = deps.unload ?? defaultUnload
  const inflight = new Map<string, InflightLoad>()

  const concurrency = Math.max(1, options.concurrency)
  let activeSlots = 0
  const slotQueue: Array<() => void> = []

  function acquireSlot(): Promise<void> {
    if (activeSlots < concurrency) {
      activeSlots++
      return Promise.resolve()
    }
    return new Promise((resolve) => slotQueue.push(resolve))
  }

  function releaseSlot(): void {
    const next = slotQueue.shift()
    if (next) next()
    else activeSlots--
  }

  function cancelSdk(alias: string, rec: InflightLoad): void {
    if (!rec.requestId) return
    cancelFn(rec.requestId).catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      logger.warn(`Cancel of in-flight load "${alias}" failed: ${message}`)
    })
  }

  function maybeCancelForDisconnect(alias: string, rec: InflightLoad): void {
    if (rec.settled || rec.cancelRequested || rec.hasPermanentWaiter) return
    if (rec.activeWaiters > 0) return
    rec.cancelRequested = true
    logger.info(`All clients for "${alias}" disconnected; cancelling in-flight load.`)
    cancelSdk(alias, rec)
  }

  function addWaiter(alias: string, rec: InflightLoad, signal?: AbortSignal): void {
    if (rec.settled) return
    if (!signal) {
      rec.hasPermanentWaiter = true
      return
    }
    if (signal.aborted) {
      maybeCancelForDisconnect(alias, rec)
      return
    }
    rec.activeWaiters++
    const onAbort = (): void => {
      rec.activeWaiters--
      maybeCancelForDisconnect(alias, rec)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    rec.disposers.push(() => signal.removeEventListener('abort', onAbort))
  }

  async function run(alias: string, rec: InflightLoad): Promise<void> {
    await acquireSlot()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (rec.cancelRequested) throw new Error(`Load of "${alias}" cancelled before start`)
      const entry = registry.getEntry(alias)
      if (!entry) throw new Error(`Model "${alias}" not registered`)
      if (entry.state === registry.STATES.READY) return

      const displaySrc = typeof entry.modelSrc === 'string' ? entry.modelSrc : entry.modelSrc.src
      logger.info(`Loading model "${alias}" from ${displaySrc}...`)
      registry.setLoading(alias)

      const loaded = getLoadFn()({
        modelSrc: entry.modelSrc,
        modelType: entry.sdkType,
        modelConfig: entry.config
      }) as Promise<string> & { requestId?: string }
      rec.requestId = loaded.requestId ?? null
      // A cancel that raced ahead of the requestId: apply it now.
      if (rec.cancelRequested) cancelSdk(alias, rec)
      // If we give up (timeout / disconnect) but the SDK load still completes,
      // unload the orphaned model so it doesn't leak.
      loaded.then(
        (id) => {
          if (rec.cancelRequested || rec.timedOut) {
            unloadFn(id).catch(() => {})
          }
        },
        () => {}
      )

      let sdkModelId: string
      if (options.timeoutMs !== null) {
        const timeoutMs = options.timeoutMs
        sdkModelId = await new Promise<string>((resolve, reject) => {
          timer = setTimeout(() => {
            rec.timedOut = true
            cancelSdk(alias, rec)
            reject(new ModelLoadTimeoutError(alias, timeoutMs))
          }, timeoutMs)
          loaded.then(resolve, reject)
        })
      } else {
        sdkModelId = await loaded
      }

      if (rec.cancelRequested || rec.timedOut) {
        throw new Error(`Load of "${alias}" was cancelled`)
      }
      registry.setReady(alias, sdkModelId)
      logger.info(`Model "${alias}" loaded (SDK modelId: ${sdkModelId}).`)
    } catch (err) {
      // A timeout or a client-disconnect cancel is not a fault: reset to IDLE
      // (retriable, and not shown as `error` in the model listing) but log it so
      // the event isn't silent. Genuine load failures stay ERROR.
      if (rec.timedOut) {
        logger.warn(`Load of "${alias}" timed out; left unloaded (retry on next request).`)
        registry.markUnloaded(alias)
      } else if (rec.cancelRequested) {
        logger.info(`Load of "${alias}" cancelled (client disconnected); left unloaded.`)
        registry.markUnloaded(alias)
      } else {
        registry.setError(alias, err)
      }
      throw err
    } finally {
      if (timer) clearTimeout(timer)
      rec.settled = true
      for (const dispose of rec.disposers) dispose()
      inflight.delete(alias)
      releaseSlot()
    }
  }

  function load(alias: string, signal?: AbortSignal): Promise<void> {
    const entry = registry.getEntry(alias)
    if (!entry) return Promise.reject(new Error(`Model "${alias}" not registered`))
    if (entry.state === registry.STATES.READY) return Promise.resolve()

    let rec = inflight.get(alias)
    if (!rec) {
      rec = {
        promise: Promise.resolve(),
        requestId: null,
        activeWaiters: 0,
        hasPermanentWaiter: false,
        cancelRequested: false,
        timedOut: false,
        settled: false,
        disposers: []
      }
      inflight.set(alias, rec)
      rec.promise = run(alias, rec)
    }
    addWaiter(alias, rec, signal)
    return rec.promise
  }

  function isLoading(alias: string): boolean {
    return inflight.has(alias)
  }

  function settled(alias: string): Promise<void> {
    const rec = inflight.get(alias)
    if (!rec) return Promise.resolve()
    return rec.promise.then(
      () => {},
      () => {}
    )
  }

  return { load, isLoading, settled }
}
