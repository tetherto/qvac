/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-explicit-any, @typescript-eslint/no-namespace, @typescript-eslint/no-redundant-type-constituents, @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment -- Preserve the published untyped CommonJS response/result contract; namespace merging exposes its structural abort-signal type. */

import EventEmitter = require('bare-events')

const statuses = Object.freeze({
  RUNNING: 'running',
  ENDED: 'ended',
  ERRORED: 'errored'
} as const)

type ResponseStatus = (typeof statuses)[keyof typeof statuses]

/**
 * QvacResponse provides an interface for handling asynchronous responses
 * with update notifications, error handling, and more.
 * It extends EventEmitter to allow event-based interaction.
 */
class QvacResponse<Output = any> extends EventEmitter {
  declare protected output: Output[]
  declare protected stats: any

  /** @internal */
  private _status: ResponseStatus = statuses.RUNNING
  /** @internal */
  private _settleHooks: Array<() => void> = []
  /** @internal */
  declare private readonly _cancelHandler: () => Promise<void>
  /** @internal */
  declare private readonly _pollInterval: number
  /** @internal */
  declare private _abortSignal: QvacResponse.AbortSignalLike | null
  /** @internal */
  declare private _onAbort: (() => void) | null
  /** @internal */
  declare private readonly _finishPromise: Promise<any>
  /** @internal */
  declare private _resolveFinish: (result: any) => void
  /** @internal */
  declare private _rejectFinish: (error: any) => void
  /** @internal */
  declare private _error: Error | undefined

  constructor(
    handlers: {
      cancelHandler: () => Promise<void>
      /**
       * Optional abort signal. When aborted, the response is failed with
       * the abort `reason` — passed through unchanged when it's an Error,
       * otherwise wrapped in a default `Error('Aborted: ...')`. Wires
       * external timeout / crash into the response without polling. Addons
       * typically forward the signal they received from
       * `model.run(input, { signal })` straight into the response.
       */
      signal?: QvacResponse.AbortSignalLike
    },
    pollInterval?: number
  )
  constructor(
    {
      cancelHandler,
      signal
    }: Partial<{
      cancelHandler: () => Promise<void>
      signal: QvacResponse.AbortSignalLike
    }> = {},
    pollInterval = 100
  ) {
    super()
    this.output = []
    this.stats = {}
    this._cancelHandler = cancelHandler as () => Promise<void>
    this._pollInterval = pollInterval
    this._abortSignal = null
    this._onAbort = null

    this._finishPromise = new Promise((resolve, reject) => {
      this._resolveFinish = resolve
      this._rejectFinish = reject
    })

    this._finishPromise.catch(() => {}) // Error already handled via error event if listener exists

    if (signal) this._wireAbortSignal(signal)
  }

  /**
   * Registers a callback to be invoked on each output update.
   */
  onUpdate(callback: (data: Output) => void): this {
    this.on('output', callback as (data: unknown) => void)
    return this
  }

  /**
   * Registers a callback for when the response finishes.
   * If a callback is provided, it is invoked with the terminal result.
   */
  onFinish(callback?: (result: Output[] | any) => void): this {
    if (callback) {
      this.once('end', (result) => callback(result))
    }
    return this
  }

  /**
   * Returns a promise that resolves with the terminal result when the response finishes.
   */
  await(): Promise<Output[] | any> {
    return this._finishPromise
  }

  /**
   * Registers a callback to be invoked when an error occurs.
   */
  onError(callback: (error: Error) => void): this {
    this.on('error', callback as (error: unknown) => void)
    return this
  }

  /**
   * Registers a callback to be invoked when the response is cancelled.
   */
  onCancel(callback: () => void): this {
    this.on('cancel', callback)
    return this
  }

  /**
   * Adds an output update and emits an 'output' event.
   */
  updateOutput(output: Output): void {
    this.output.push(output)
    this.emit('output', output)
  }

  /**
   * Updates the response statistics and emits a 'stats' event.
   */
  updateStats(stats: any): void {
    this.stats = stats
    this.emit('stats', stats)
  }

  /**
   * Marks the response as failed, emits an 'error' event, and rejects the finish promise.
   * Idempotent: no-op once already settled. Detaches the abort-signal listener (if any).
   */
  failed(error: Error): void {
    if (this._status !== statuses.RUNNING) return
    if (!(error instanceof Error)) {
      error = new Error(String(error).trim())
    }

    this._status = statuses.ERRORED
    this._error = error
    this._teardownAbort()
    this._rejectFinish(error)
    this._runSettleHooks()
    const errorListeners = this.listenerCount('error')
    if (errorListeners > 0) {
      this.emit('error', error)
    }
  }

  /**
   * Marks the response as ended, emits an 'end' event, and resolves the finish promise.
   * Idempotent: no-op once already settled. Detaches the abort-signal listener (if any).
   */
  ended(result: Output[] | any = this.output): void {
    if (this._status !== statuses.RUNNING) return
    this._status = statuses.ENDED
    this._teardownAbort()
    this._resolveFinish(result)
    this._runSettleHooks()
    this.emit('end', result)
  }

  /**
   * Returns the most recent output.
   */
  getLatest(): Output | null {
    return this.output.length ? this.output.at(-1)! : null
  }

  /**
   * Async generator that yields each output update until the response stops running.
   *
   * Wakes up immediately on output/end/error events instead of polling
   * out the remaining `pollInterval` window. A single pair of EventEmitter
   * listeners is attached for the lifetime of the iterator (not per
   * yielded chunk), so high-frequency token streams don't churn
   * listener registrations.
   */
  async *iterate(): AsyncIterableIterator<Output> {
    if (this._status === statuses.ERRORED) {
      throw this._error!
    }

    let pendingResolve: (() => void) | null = null
    const wake = () => {
      if (pendingResolve === null) return
      // Clear before resolving so repeated events don't reuse this waiter.
      const resolve = pendingResolve
      pendingResolve = null
      resolve()
    }
    this.on('output', wake)
    this.on('end', wake)
    this.on('error', wake)

    try {
      let index = 0
      while (true) {
        while (index < this.output.length) yield this.output[index++]
        if (this._status !== statuses.RUNNING) break
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | null = null
          pendingResolve = () => {
            if (timer !== null) {
              clearTimeout(timer)
              timer = null
            }
            resolve()
          }
          timer = setTimeout(() => {
            pendingResolve = null
            timer = null
            resolve()
          }, this._pollInterval)
        })
      }
    } finally {
      this.off('output', wake)
      this.off('end', wake)
      this.off('error', wake)
      pendingResolve = null
    }

    if ((this._status as ResponseStatus) === statuses.ERRORED) {
      throw this._error!
    }
  }

  /** @internal */
  private _wireAbortSignal(signal: QvacResponse.AbortSignalLike): void {
    const buildError = () => {
      const reason: unknown = signal.reason
      if (reason instanceof Error) return reason
      if (reason !== undefined && reason !== null) {
        return new Error(`Aborted: ${String(reason)}`)
      }
      return new Error('Aborted')
    }

    if (signal.aborted) {
      this._markAbortPending(buildError())
      return
    }

    const onAbort = () => this.failed(buildError())
    this._abortSignal = signal
    this._onAbort = onAbort
    signal.addEventListener('abort', onAbort, { once: true })
  }

  /**
   * Reserves the errored terminal state synchronously for an already-aborted
   * signal, but defers the observable notification (error event + finish-promise
   * rejection) to a microtask.
   *
   * Reserving `_status`/`_error` synchronously closes the race where a synchronous
   * terminal callback (e.g. `ended()` from a synchronous native `runJob` callback)
   * fired right after construction would otherwise settle the response with success
   * before the abort failure ran. Deferring the notification still lets callers and
   * `createJobHandler.bindCleanup()` attach listeners before `error` is emitted.
   */
  /** @internal */
  private _markAbortPending(error: Error): void {
    if (this._status !== statuses.RUNNING) return
    this._status = statuses.ERRORED
    this._error = error
    this._teardownAbort()

    queueMicrotask(() => {
      this._rejectFinish(error)
      // Hooks run here rather than at the synchronous reservation above:
      // the job handler registers its hook right after construction returns,
      // which is after an already-aborted signal reserved the state.
      this._runSettleHooks()
      if (this.listenerCount('error') > 0) {
        this.emit('error', error)
      }
    })
  }

  /**
   * Internal: registers a hook invoked exactly once when the response
   * settles (ended / failed / abort), after the finish promise settles and
   * before any public 'end'/'error' listener runs — so a throwing listener
   * cannot skip it. Hooks must not throw. Not part of the public API.
   *
   * @internal
   */
  _onSettled(hook: () => void): void {
    this._settleHooks.push(hook)
  }

  /** @internal */
  private _runSettleHooks(): void {
    const hooks = this._settleHooks
    this._settleHooks = []
    for (const hook of hooks) hook()
  }

  /** @internal */
  private _teardownAbort(): void {
    if (this._abortSignal !== null && this._onAbort !== null) {
      try {
        this._abortSignal.removeEventListener('abort', this._onAbort)
      } catch {
        // Best-effort detach; ignore exotic signal implementations.
      }
      this._abortSignal = null
      this._onAbort = null
    }
  }

  /**
   * Cancels the response by invoking the cancel handler and emitting a 'cancel' event.
   */
  async cancel(): Promise<void> {
    if (this._status !== statuses.RUNNING) {
      return
    }
    await this._cancelHandler()
    this.emit('cancel')
  }
}

namespace QvacResponse {
  /**
   * Structural abort-signal contract covering only the members this package
   * touches, so Bare, DOM, and Node signals are all assignable.
   */
  export interface AbortSignalLike {
    readonly aborted: boolean
    readonly reason?: unknown
    addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
    removeEventListener(type: 'abort', listener: () => void): void
  }
}

export = QvacResponse
