import EventEmitter from 'bare-events'

declare class QvacResponse<Output = any> extends EventEmitter {
  protected output: Output[]
  protected stats: any

  constructor(
    handlers: {
      cancelHandler: () => Promise<void>
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
