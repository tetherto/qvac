import { Duplex } from 'bare-stream'

/**
 * The postMessage side of a Dedicated Worker: the `Worker` object in the
 * page, `self` inside the worker.
 */
export interface WorkerPort {
  postMessage(message: unknown, transfer: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/**
 * A byte stream over a worker's postMessage channel, the browser counterpart
 * of a Worklet's IPC stream, so bare-rpc runs unchanged on both sides. Each
 * written chunk is copied once and its buffer transferred.
 */
export function createWorkerPortStream(port: WorkerPort): Duplex {
  const stream = new Duplex({
    write(data: Uint8Array, _encoding: string, callback: (error?: Error | null) => void) {
      // A copy with its own ArrayBuffer: Buffer#slice returns a view, often
      // into a shared pool that must not be transferred.
      const chunk = new Uint8Array(data)
      port.postMessage(chunk, [chunk.buffer])
      callback(null)
    }
  } as never)
  port.addEventListener('message', (event) => {
    stream.push(event.data as Uint8Array)
  })
  return stream
}
