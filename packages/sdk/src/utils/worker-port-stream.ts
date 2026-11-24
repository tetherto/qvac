import { Duplex } from 'bare-stream'

/** The common postMessage surface of a Worker and its global scope. */
export interface WorkerPort {
  postMessage(message: unknown, transfer: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
}

/** Runs bare-rpc over a Dedicated Worker's ordered postMessage channel. */
export function createWorkerPortStream(port: WorkerPort): Duplex {
  const stream = new Duplex({
    write(data: Uint8Array, _encoding: string, callback: (error?: Error | null) => void) {
      const chunk = new Uint8Array(data)
      port.postMessage(chunk, [chunk.buffer])
      callback(null)
    }
  } as never)

  port.addEventListener('message', (event) => {
    if (event.data instanceof Uint8Array) stream.push(event.data)
  })

  return stream
}
