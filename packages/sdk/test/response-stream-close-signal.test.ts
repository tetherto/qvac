import test from 'brittle'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import RPC from 'bare-rpc'
import type { AbortSignal } from 'bare-abort-controller'
import { EventEmitter } from 'node:events'
import { AbortController } from 'bare-abort-controller'
import {
  createResponseStreamLoggingErrors,
  createWorkerRpc,
  signalOnCancelOrStreamClose
} from '@/server/rpc/rpc-utils'

interface Opened {
  signal: AbortSignal | null
  responseStream: RPC.OutgoingStream | undefined
}

// A worker RPC session over a socket. `onRequest` handles each request and
// returns its response stream, if it opened one.
async function rpcPair(onRequest: (req: RPC.IncomingRequest) => RPC.OutgoingStream | undefined) {
  const socketPath = path.join(
    os.tmpdir(),
    `qvac-response-stream-close-${process.pid}-${Date.now()}.sock`
  )
  const opened: Opened[] = []
  const sockets: net.Socket[] = []
  const server = net.createServer((socket) => {
    sockets.push(socket)
    createWorkerRpc(socket as never, (req) => {
      opened.push({ signal: req.signal, responseStream: onRequest(req) })
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  const clientSocket = net.connect(socketPath)
  await new Promise<void>((resolve) => clientSocket.once('connect', () => resolve()))
  const client = new RPC(clientSocket as never, () => {})
  return {
    client,
    opened,
    disconnectClient() {
      clientSocket.destroy()
    },
    async close() {
      clientSocket.destroy()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

function waitFor(condition: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms
  return new Promise((resolve) => {
    const check = () => {
      if (condition()) resolve(true)
      else if (Date.now() > deadline) resolve(false)
      else setTimeout(check, 5)
    }
    check()
  })
}

test('the request signal aborts when the client destroys its response stream', async function (t) {
  const pair = await rpcPair((req) => {
    const responseStream = createResponseStreamLoggingErrors(req)
    responseStream.write('{"open":true}\n', 'utf-8')
    return responseStream
  })
  t.teardown(() => pair.close())

  const req = pair.client.request(1)
  req.send('{}', 'utf-8')
  const responses = req.createResponseStream({ encoding: 'utf-8' })
  await new Promise((resolve) => responses.once('data', resolve))

  const signal = pair.opened[0]!.signal
  t.ok(signal, 'the worker gives the request a signal')
  t.absent(signal!.aborted, 'the signal is live while the client reads')

  responses.destroy()

  t.ok(await waitFor(() => signal!.aborted), 'the signal aborts once the client destroys its end')
})

test('the request signal aborts when the client cancels a request waiting for its reply', async function (t) {
  const pair = await rpcPair(() => undefined)
  t.teardown(() => pair.close())

  const req = pair.client.request(1)
  req.send('{}', 'utf-8')
  const reply = req.reply()
  reply.catch(() => {})
  t.ok(await waitFor(() => pair.opened.length === 1), 'the worker received the request')
  const signal = pair.opened[0]!.signal
  await new Promise((resolve) => setTimeout(resolve, 50))
  t.absent(signal!.aborted, 'nothing aborts it while the client waits')

  req.cancel()

  t.ok(await waitFor(() => signal!.aborted), 'the signal aborts once the client cancels')
})

// A client on an older bare-rpc stops a stream by destroying its end, which
// closes the worker's response stream without a cancel.
test('the stream signal aborts when the response stream closes without a cancel', function (t) {
  const request = new AbortController()
  const responseStream = new EventEmitter()
  const signal = signalOnCancelOrStreamClose({ signal: request.signal }, responseStream)
  t.absent(signal.aborted)

  responseStream.emit('close')

  t.ok(signal.aborted)
})

test('the stream signal aborts when the client cancels the request', function (t) {
  const request = new AbortController()
  const signal = signalOnCancelOrStreamClose({ signal: request.signal }, new EventEmitter())

  request.abort(undefined)

  t.ok(signal.aborted)
})

test('a client that disconnects mid-stream closes the response stream without throwing', async function (t) {
  const pair = await rpcPair((req) => createResponseStreamLoggingErrors(req))
  t.teardown(() => pair.close())

  const req = pair.client.request(1)
  req.send('{}', 'utf-8')
  req.createResponseStream({ encoding: 'utf-8' })
  t.ok(await waitFor(() => pair.opened.length === 1), 'the worker opened the stream')
  const { signal, responseStream } = pair.opened[0]!

  pair.disconnectClient()

  t.ok(await waitFor(() => signal!.aborted), 'the signal aborts once the client is gone')
  t.ok(await waitFor(() => responseStream!.destroyed), 'the response stream is destroyed')
})
