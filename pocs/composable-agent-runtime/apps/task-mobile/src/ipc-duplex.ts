import { Duplex } from 'streamx'

type IpcEvent = 'data' | 'error' | 'close' | 'end'
type IpcListener = ((data: Uint8Array) => void) | ((error: Error) => void) | (() => void)

export interface WorkletIPC {
  on(event: IpcEvent, listener: IpcListener): WorkletIPC
  removeListener(event: IpcEvent, listener: IpcListener): WorkletIPC
  write(data: Uint8Array): unknown
}

export function createIpcDuplex(ipc: WorkletIPC) {
  let pendingRead: ((error: Error | null) => void) | null = null
  let opened = false

  const stream = new Duplex({
    highWaterMark: 0,
    open(callback) {
      opened = true
      ipc.on('data', onData)
      ipc.on('error', onError)
      ipc.on('close', onClose)
      ipc.on('end', onEnd)
      callback(null)
    },
    read(callback) {
      pendingRead = callback
    },
    write(data, callback) {
      if (!(data instanceof Uint8Array)) {
        callback(new Error('BareKit IPC accepts only binary HRPC frames'))
        return
      }
      try {
        ipc.write(data)
        callback(null)
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)))
      }
    },
    predestroy() {
      finishRead()
    },
    destroy(callback) {
      if (opened) {
        ipc.removeListener('data', onData)
        ipc.removeListener('error', onError)
        ipc.removeListener('close', onClose)
        ipc.removeListener('end', onEnd)
      }
      callback(null)
    }
  })

  function onData(data: Uint8Array) {
    if (stream.destroying) return
    stream.push(data)
    finishRead()
  }

  function onError(error: Error) {
    stream.destroy(error)
  }

  function onClose() {
    stream.destroy()
  }

  function onEnd() {
    if (!stream.destroying) stream.push(null)
    finishRead()
  }

  function finishRead() {
    const callback = pendingRead
    pendingRead = null
    callback?.(null)
  }

  return stream
}
