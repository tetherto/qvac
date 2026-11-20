import type { QvacConfig, QvacPlugin, Request, RequestDeadline } from '@/schemas/index'
import { CAPABILITY_CONTRACTS, UNTRACKED_REQUEST_TYPES } from '@/schemas/index'
import { DeadlineExceededError, type DeadlineBoundary } from '@/errors/index'
import { onResume } from '@/runtime/runtime-lifecycle'
import { getModelEntry } from '@/runtime/model-registry'
import { getPlugin } from '@/plugins/index'
import type { Logger } from '@/logging/types'

/** The deadlines in force for one request, after config and call are combined. */
export interface DeadlineLimits {
  queueMs?: number
  idleMs?: number
  runMs?: number
  loadMs?: number
}

export interface ResolvedDeadline {
  limits: DeadlineLimits
  /** The capability contract ID the limits were configured under, if any. */
  capability: string | undefined
}

const DEFAULT_CAPABILITY_KEY = 'default'

const OPERATION_CAPABILITY: ReadonlyMap<string, string> = (() => {
  const byOperation = new Map<string, string>()
  for (const contract of Object.values(CAPABILITY_CONTRACTS)) {
    for (const operation of [...contract.operations, ...contract.optionalOperations]) {
      byOperation.set(operation, contract.id)
    }
  }
  // Runs `completionStream` turns on the model, with tool results in between.
  byOperation.set('completionOrchestrate', CAPABILITY_CONTRACTS.completion.id)
  return byOperation
})()

type DeadlineSource =
  { kind: 'load' } | { kind: 'capability'; id: string | undefined } | { kind: 'none' }

function invokedCapability(modelId: string, handler: string): string | undefined {
  const modelType = getModelEntry(modelId)?.local.modelType
  const plugin = modelType === undefined ? undefined : getPlugin(modelType)
  const contract = (plugin?.provides ?? []).find(
    (candidate) =>
      candidate.operations.includes(handler) || candidate.optionalOperations.includes(handler)
  )
  return contract?.id
}

function deadlineSource(request: Request): DeadlineSource {
  if (UNTRACKED_REQUEST_TYPES.has(request.type)) return { kind: 'none' }
  if (request.type === 'loadModel') return { kind: 'load' }
  if (request.type === 'pluginInvoke' || request.type === 'pluginInvokeStream') {
    // A handler outside every contract takes the `default` entry.
    return { kind: 'capability', id: invokedCapability(request.modelId, request.handler) }
  }
  const id = OPERATION_CAPABILITY.get(request.type)
  return id === undefined ? { kind: 'none' } : { kind: 'capability', id }
}

function shorter(configured: number | null | undefined, called: number | undefined) {
  if (configured === undefined || configured === null) return called
  if (called === undefined) return configured
  return Math.min(configured, called)
}

/**
 * The deadlines for a request: the runtime configuration's entry for the
 * request's capability (or `load` for `loadModel`), each field shortened by
 * the call's own `deadline` when that is smaller. A field set in neither is
 * unbounded. Returns `undefined` when nothing bounds the request, and for the
 * request types that take no deadline: lookups, lifecycle, downloads, RAG and
 * vector indexes.
 */
export function resolveDeadline(
  request: Request,
  config: Pick<QvacConfig, 'deadlines'>
): ResolvedDeadline | undefined {
  const source = deadlineSource(request)
  if (source.kind === 'none') return undefined
  const called = (request as { deadline?: RequestDeadline }).deadline ?? {}
  const limits: DeadlineLimits = {}
  let capability: string | undefined

  if (source.kind === 'load') {
    const loadMs = shorter(config.deadlines?.load?.loadMs, called.loadMs)
    if (loadMs !== undefined) limits.loadMs = loadMs
  } else {
    capability = source.id
    const entries = config.deadlines?.capabilities ?? {}
    const configured = {
      ...entries[DEFAULT_CAPABILITY_KEY],
      ...(capability === undefined ? undefined : entries[capability])
    }
    for (const field of ['queueMs', 'idleMs', 'runMs'] as const) {
      const value = shorter(configured[field], called[field])
      if (value !== undefined) limits[field] = value
    }
  }

  return Object.keys(limits).length === 0 ? undefined : { limits, capability }
}

/** Warns about each configured capability ID that no registered plugin provides. */
export function warnUnprovidedDeadlineCapabilities(
  config: Pick<QvacConfig, 'deadlines'>,
  plugins: Iterable<QvacPlugin>,
  logger: Pick<Logger, 'warn'>
): void {
  const configured = Object.keys(config.deadlines?.capabilities ?? {}).filter(
    (id) => id !== DEFAULT_CAPABILITY_KEY
  )
  if (configured.length === 0) return
  const provided = new Set<string>()
  for (const plugin of plugins) {
    for (const contract of plugin.provides ?? []) provided.add(contract.id)
  }
  for (const id of configured) {
    if (!provided.has(id)) {
      logger.warn(
        `deadlines.capabilities names "${id}", which no registered plugin provides; the entry applies to no request`
      )
    }
  }
}

interface ArmedTimer {
  /** `Date.now()` at which the deadline passes. */
  dueAt: number
  timeoutMs: number
  handle: ReturnType<typeof setTimeout>
}

type ExpiryListener = (error: DeadlineExceededError) => void

/**
 * The timers of one request's deadlines. Dispatch creates it and races the
 * handler against `expired`; the request registry drives it as the request
 * queues, is admitted and reports progress.
 *
 * Deadlines are wall-clock: a deadline that passes while the runtime is
 * suspended expires when the runtime resumes.
 */
export class DeadlineClock {
  /** Rejects with the `DeadlineExceededError` when a deadline passes. */
  readonly expired: Promise<never>
  /** Set once a deadline has passed. */
  error: DeadlineExceededError | undefined

  readonly #limits: DeadlineLimits
  readonly #info: { requestId: string; capability: string | undefined; modelId: string | undefined }
  readonly #idleFromAdmission: boolean
  readonly #timers = new Map<DeadlineBoundary, ArmedTimer>()
  readonly #listeners = new Set<ExpiryListener>()
  readonly #stopResumeListener: () => void
  #rejectExpired: (error: DeadlineExceededError) => void = () => {}
  #queueListener: ExpiryListener | undefined
  #running = false
  #closed = false

  /**
   * `idleFromAdmission` starts the idle timer when the request is admitted.
   * Without it the idle timer starts at the first `touch()`, so a call that
   * returns one reply is not bounded by the time to that reply.
   */
  constructor(
    limits: DeadlineLimits,
    info: { requestId: string; capability?: string | undefined; modelId?: string | undefined },
    options: { idleFromAdmission: boolean }
  ) {
    this.#limits = limits
    this.#info = { requestId: info.requestId, capability: info.capability, modelId: info.modelId }
    this.#idleFromAdmission = options.idleFromAdmission
    this.expired = new Promise<never>((_resolve, reject) => {
      this.#rejectExpired = reject
    })
    // Nobody may be racing `expired` when it rejects.
    this.expired.catch(() => {})
    this.#stopResumeListener = onResume(() => this.#expireElapsed())
  }

  /** Calls `listener` when a deadline passes. Returns a function that removes it. */
  onExpire(listener: ExpiryListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * `work`'s result, or the deadline's error at the moment a deadline passes.
   * Unlike a race against `expired`, nothing stays attached to the clock once
   * `work` settles, so a stream can call this for every response.
   */
  within<T>(work: Promise<T>): Promise<T> {
    if (this.error !== undefined) {
      work.catch(() => {})
      return Promise.reject(this.error)
    }
    return new Promise<T>((resolve, reject) => {
      const stopListening = this.onExpire(reject)
      work.then(
        (value) => {
          stopListening()
          resolve(value)
        },
        (error: unknown) => {
          stopListening()
          reject(error)
        }
      )
    })
  }

  /**
   * The request started waiting for an admission slot. The run and idle
   * timers stop until `admitted()`; `onExpire` is called if the queue
   * deadline passes during the wait.
   */
  startQueue(onExpire: ExpiryListener): void {
    this.pause()
    if (this.#limits.queueMs === undefined) return
    this.#queueListener = onExpire
    this.#arm('queue', this.#limits.queueMs)
  }

  endQueue(): void {
    this.#queueListener = undefined
    this.#disarm('queue')
  }

  /**
   * The request is not running: it waits for a slot or for its caller. The
   * run and idle timers stop until `admitted()`, which starts them afresh.
   */
  pause(): void {
    this.#running = false
    this.#disarm('run')
    this.#disarm('idle')
  }

  /** The request holds its slot, or needs none: the run and idle timers start. */
  admitted(): void {
    this.#running = true
    if (this.#limits.runMs !== undefined && !this.#timers.has('run')) {
      this.#arm('run', this.#limits.runMs)
    }
    if (this.#idleFromAdmission && this.#limits.idleMs !== undefined && !this.#timers.has('idle')) {
      this.#arm('idle', this.#limits.idleMs)
    }
  }

  /** The request made progress: the idle timer restarts. */
  touch(): void {
    if (!this.#running || this.#limits.idleMs === undefined) return
    this.#arm('idle', this.#limits.idleMs)
  }

  /** The download phase of a load has ended: the load timer starts. */
  startLoad(): void {
    if (this.#limits.loadMs === undefined || this.#timers.has('load')) return
    this.#arm('load', this.#limits.loadMs)
  }

  /** Stops every timer. Called when dispatch has finished with the request. */
  close(): void {
    this.#closed = true
    this.#clearTimers()
    this.#stopResumeListener()
  }

  #arm(boundary: DeadlineBoundary, timeoutMs: number): void {
    this.#disarm(boundary)
    if (this.#closed || this.error !== undefined) return
    this.#timers.set(boundary, {
      dueAt: Date.now() + timeoutMs,
      timeoutMs,
      handle: setTimeout(() => this.#expire(boundary, timeoutMs), timeoutMs)
    })
  }

  #disarm(boundary: DeadlineBoundary): void {
    const timer = this.#timers.get(boundary)
    if (!timer) return
    clearTimeout(timer.handle)
    this.#timers.delete(boundary)
  }

  #clearTimers(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer.handle)
    this.#timers.clear()
  }

  // A timer does not advance while the process is suspended, so on resume the
  // deadlines that passed in the meantime are expired by their due time.
  #expireElapsed(): void {
    const now = Date.now()
    for (const [boundary, timer] of this.#timers) {
      if (now >= timer.dueAt) {
        this.#expire(boundary, timer.timeoutMs)
        return
      }
    }
  }

  #expire(boundary: DeadlineBoundary, timeoutMs: number): void {
    if (this.error !== undefined || this.#closed) return
    const error = new DeadlineExceededError(
      this.#info.requestId,
      boundary,
      timeoutMs,
      this.#info.capability,
      this.#info.modelId
    )
    this.error = error
    this.#clearTimers()
    // Reject first, so the caller's race settles with this error and not with
    // whatever the handler throws once the listeners below abort it.
    this.#rejectExpired(error)
    const queueListener = this.#queueListener
    this.#queueListener = undefined
    if (boundary === 'queue') queueListener?.(error)
    for (const listener of Array.from(this.#listeners)) listener(error)
  }
}
