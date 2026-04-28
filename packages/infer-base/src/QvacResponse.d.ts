import EventEmitter from 'bare-events'

declare type ResponseStatus =
  | 'running'
  | 'cancelled'
  | 'ended'
  | 'errored'
  | 'paused'
declare class QvacResponse<Output = any> extends EventEmitter {
  protected output: Output[]
  protected stats: any

  constructor(
    handlers: {
      cancelHandler: () => Promise<void>
      /** @deprecated Will be removed in a future version. */
      pauseHandler?: () => Promise<void>
      /** @deprecated Will be removed in a future version. */
      continueHandler?: () => Promise<void>
    },
    pollInterval?: number
  )

  onUpdate(callback: (data: Output) => void): this

  onFinish(callback?: (result: Output[] | any) => void): this

  await(): Promise<Output[] | any>

  onError(callback: (error: Error) => void): this

  onCancel(callback: () => void): this

  /** @deprecated Will be removed in a future version. */
  onPause(callback: () => void): this

  /** @deprecated Will be removed in a future version. */
  onContinue(callback: () => void): this

  updateOutput(output: Output): void
  updateStats(stats: any): void
  failed(error: Error): void
  ended(result?: Output[] | any): void
  getLatest(): Output
  iterate(): AsyncIterableIterator<Output>

  cancel(): Promise<void>
  /** @deprecated Will be removed in a future version. */
  pause(): Promise<void>
  /** @deprecated Will be removed in a future version. */
  continue(): Promise<void>
  /** @deprecated Will be removed in a future version. */
  getStatus(): ResponseStatus
}

export = QvacResponse

