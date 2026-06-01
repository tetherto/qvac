import EventEmitter from 'bare-events'

declare class QvacResponse<Output = any> extends EventEmitter {
  protected output: Output[]
  protected stats: any

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
      signal?: AbortSignal
    },
    pollInterval?: number
  )

  onUpdate(callback: (data: Output) => void): this

  onFinish(callback?: (result: Output[] | any) => void): this

  await(): Promise<Output[] | any>

  onError(callback: (error: Error) => void): this

  onCancel(callback: () => void): this

  updateOutput(output: Output): void
  updateStats(stats: any): void
  failed(error: Error): void
  ended(result?: Output[] | any): void
  getLatest(): Output
  iterate(): AsyncIterableIterator<Output>

  cancel(): Promise<void>
}

export = QvacResponse
