import test from 'brittle'
import RPC from 'bare-rpc'
import { decodeUtf8 } from '@/utils/encoding'
import { createWorkerPortStream, type WorkerPort } from '@/utils/worker-port-stream'
import { createWorkerRpc } from '@/server/rpc/rpc-utils'

function portPair(): [WorkerPort, WorkerPort, () => void] {
  const { port1, port2 } = new MessageChannel()
  port1.start()
  port2.start()
  return [
    port1 as unknown as WorkerPort,
    port2 as unknown as WorkerPort,
    () => {
      port1.close()
      port2.close()
    }
  ]
}

test('decodeUtf8 accepts browser and Node RPC byte containers', (t) => {
  const text = '{"type":"héllo"}'
  t.is(decodeUtf8(new TextEncoder().encode(text)), text)
  t.is(decodeUtf8(Buffer.from(text)), text)

  const decoder = globalThis.TextDecoder
  try {
    Object.defineProperty(globalThis, 'TextDecoder', { value: undefined, configurable: true })
    t.is(decodeUtf8(Buffer.from(text)), text, 'falls back to Buffer decoding in Bare')
  } finally {
    Object.defineProperty(globalThis, 'TextDecoder', { value: decoder, configurable: true })
  }
})

test('worker transport preserves replies, streams, and control-message isolation', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const [pagePort, workerPort, closePorts] = portPair()
    const server = new RPC(createWorkerPortStream(workerPort), (req: RPC.IncomingRequest) => {
      const request = JSON.parse(decodeUtf8(req.data!)) as { mode: string; value: number }
      if (request.mode === 'reply') {
        req.reply(JSON.stringify({ value: request.value }), 'utf8')
        return
      }
      const output = req.createResponseStream()
      output.write(`a${request.value}\n`)
      output.write(`b${request.value}\n`)
      output.end()
    })
    const client = new RPC(createWorkerPortStream(pagePort), () => {})

    pagePort.postMessage({ type: 'qvac:control', iteration }, [])
    const replyRequest = client.request(iteration * 2 + 1)
    replyRequest.send(JSON.stringify({ mode: 'reply', value: iteration }), 'utf8')
    const reply = JSON.parse(String(await replyRequest.reply('utf8'))) as { value: number }
    t.is(reply.value, iteration)

    const streamRequest = client.request(iteration * 2 + 2)
    streamRequest.send(JSON.stringify({ mode: 'stream', value: iteration }), 'utf8')
    let output = ''
    for await (const chunk of streamRequest.createResponseStream({
      encoding: 'utf-8'
    }) as AsyncIterable<string | Uint8Array>) {
      output += typeof chunk === 'string' ? chunk : decodeUtf8(chunk)
    }
    t.is(output, `a${iteration}\nb${iteration}\n`)

    t.ok(server)
    closePorts()
  }
})

test('worker transport forwards response-stream cancellation', async (t) => {
  for (let iteration = 0; iteration < 20; iteration++) {
    const [pagePort, workerPort, closePorts] = portPair()
    let cancelledResolve: (() => void) | undefined
    const cancelled = new Promise<void>((resolve) => {
      cancelledResolve = resolve
    })
    const server = createWorkerRpc(createWorkerPortStream(workerPort), (req) => {
      const output = req.createResponseStream()
      req.signal?.addEventListener('abort', () => cancelledResolve?.(), { once: true })
      output.on('error', () => {})
      output.write('first\n')
    })
    const client = new RPC(createWorkerPortStream(pagePort), () => {})
    const request = client.request(iteration + 1)
    request.send('{}', 'utf8')
    const response = request.createResponseStream({ encoding: 'utf-8' })
    response.on('error', () => {})
    await new Promise<void>((resolve) => response.once('data', () => resolve()))
    request.cancel(new Error('cancelled by test'))
    await cancelled
    t.pass(`cancel ${iteration + 1}/20 reached the worker`)
    t.ok(server)
    closePorts()
  }
})
