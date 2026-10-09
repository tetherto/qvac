import test from 'brittle'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import RPC from 'bare-rpc'
import type { AbortSignal } from 'bare-abort-controller'
import { signalOnWireClose } from '@/server/rpc/rpc-utils'

type Wire = ReturnType<RPC.IncomingRequest['createResponseStream']>

// A real bare-rpc pair over a socket, the transport between the SDK client and
// the worker. The server hands each response stream it opens to `onWire`.
async function rpcPair(onWire: (wire: Wire) => void) {
  const socketPath = path.join(os.tmpdir(), `qvac-wire-close-${process.pid}-${Date.now()}.sock`)
  const sockets: net.Socket[] = []
  const server = net.createServer((socket) => {
    sockets.push(socket)
    new RPC(socket as never, (req: RPC.IncomingRequest) => {
      onWire(req.createResponseStream())
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  const clientSocket = net.connect(socketPath)
  await new Promise<void>((resolve) => clientSocket.once('connect', () => resolve()))
  const client = new RPC(clientSocket as never, () => {})
  return {
    client,
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

test('the wire signal aborts when the client destroys its end of the stream', async function (t) {
  let signal: AbortSignal | undefined
  const pair = await rpcPair((wire) => {
    signal = signalOnWireClose(wire)
    wire.write('{"open":true}\n', 'utf-8')
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

test('the wire signal stays live while the stream is open', async function (t) {
  let signal: AbortSignal | undefined
  const pair = await rpcPair((wire) => {
    signal = signalOnWireClose(wire)
  })
  t.teardown(() => pair.close())

  const req = pair.client.request(1)
  req.send('{}', 'utf-8')
  req.createResponseStream({ encoding: 'utf-8' })

  t.ok(await waitFor(() => signal !== undefined), 'the worker opened the stream')
  await new Promise((resolve) => setTimeout(resolve, 100))
  t.absent(signal!.aborted, 'nothing aborts it while the client keeps its end')
})
