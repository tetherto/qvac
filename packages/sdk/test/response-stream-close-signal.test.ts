import test from 'brittle'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import RPC from 'bare-rpc'
import type { AbortSignal } from 'bare-abort-controller'
import { createResponseStreamIgnoringErrors, signalOnStreamClose } from '@/server/rpc/rpc-utils'

// Real bare-rpc pair over a socket; the server hands each response stream to `onResponseStream`.
async function rpcPair(onResponseStream: (responseStream: RPC.OutgoingStream) => void) {
  const socketPath = path.join(
    os.tmpdir(),
    `qvac-response-stream-close-${process.pid}-${Date.now()}.sock`
  )
  const sockets: net.Socket[] = []
  const server = net.createServer((socket) => {
    sockets.push(socket)
    new RPC(socket as never, (req: RPC.IncomingRequest) => {
      onResponseStream(createResponseStreamIgnoringErrors(req))
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  const clientSocket = net.connect(socketPath)
  await new Promise<void>((resolve) => clientSocket.once('connect', () => resolve()))
  const client = new RPC(clientSocket as never, () => {})
  return {
    client,
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

test('the stream signal aborts when the client destroys its end of the stream', async function (t) {
  let signal: AbortSignal | undefined
  const pair = await rpcPair((responseStream) => {
    signal = signalOnStreamClose(responseStream)
    responseStream.write('{"open":true}\n', 'utf-8')
  })
  t.teardown(() => pair.close())

  const req = pair.client.request(1)
  req.send('{}', 'utf-8')
  const responses = req.createResponseStream({ encoding: 'utf-8' })
  await new Promise((resolve) => responses.once('data', resolve))

  t.ok(signal, 'the worker opened the stream')
  t.absent(signal!.aborted, 'the signal is live while the client reads')

  responses.destroy()

  t.ok(await waitFor(() => signal!.aborted), 'the signal aborts once the client destroys its end')
})

test('the stream signal stays live while the stream is open', async function (t) {
  let signal: AbortSignal | undefined
  const pair = await rpcPair((responseStream) => {
    signal = signalOnStreamClose(responseStream)
  })
  t.teardown(() => pair.close())

  const req = pair.client.request(1)
  req.send('{}', 'utf-8')
  req.createResponseStream({ encoding: 'utf-8' })

  t.ok(await waitFor(() => signal !== undefined), 'the worker opened the stream')
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.absent(signal!.aborted, 'nothing aborts it while the client keeps its end')
})

test('a client that disconnects mid-stream closes the response stream without throwing', async function (t) {
  let responseStream: RPC.OutgoingStream | undefined
  let signal: AbortSignal | undefined
  const pair = await rpcPair((opened) => {
    responseStream = opened
    signal = signalOnStreamClose(opened)
  })
  t.teardown(() => pair.close())

  const req = pair.client.request(1)
  req.send('{}', 'utf-8')
  req.createResponseStream({ encoding: 'utf-8' })
  t.ok(await waitFor(() => responseStream !== undefined), 'the worker opened the stream')

  pair.disconnectClient()

  t.ok(await waitFor(() => signal!.aborted), 'the signal aborts once the client is gone')
  t.ok(responseStream!.destroyed, 'the response stream is destroyed')
})
