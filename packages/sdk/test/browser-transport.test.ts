import test from 'brittle'
import RPC from 'bare-rpc'
import { decodeUtf8 } from '@/utils/encoding'
import { createWorkerPortStream, type WorkerPort } from '@/utils/worker-port-stream'

// -----------------------------------------------------------------------------
// Browser transport: bare-rpc between the page and the SDK's Dedicated Worker
// over postMessage. A MessageChannel stands in for the Worker / worker global
// pair; both expose the same postMessage + 'message' event surface.
// -----------------------------------------------------------------------------

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

test('decodeUtf8: decodes a plain Uint8Array, as the browser worker receives it', (t) => {
  const bytes = new TextEncoder().encode('{"type":"héllo"}')
  t.is(decodeUtf8(bytes), '{"type":"héllo"}')
})

test('decodeUtf8: decodes a Buffer, as Bare and Node receive it', (t) => {
  t.is(decodeUtf8(Buffer.from('{"type":"héllo"}')), '{"type":"héllo"}')
})

test('worker port stream: a request and its reply cross the channel', async (t) => {
  const [pagePort, workerPort, closePorts] = portPair()
  t.teardown(closePorts)

  const server = new RPC(createWorkerPortStream(workerPort), (req: RPC.IncomingRequest) => {
    const request = JSON.parse(decodeUtf8(req.data!)) as { type: string }
    req.reply(JSON.stringify({ success: true, echo: request.type }), 'utf8')
  })
  const client = new RPC(createWorkerPortStream(pagePort), () => {})

  const req = client.request(1)
  req.send(JSON.stringify({ type: '__init_config' }), 'utf8')
  const reply = JSON.parse(String(await req.reply('utf8'))) as { success: boolean; echo: string }

  t.alike(reply, { success: true, echo: '__init_config' })
  t.ok(server)
})

test('worker port stream: a streamed response arrives in order', async (t) => {
  const [pagePort, workerPort, closePorts] = portPair()
  t.teardown(closePorts)

  const server = new RPC(createWorkerPortStream(workerPort), (req: RPC.IncomingRequest) => {
    const stream = req.createResponseStream()
    for (const token of ['Pa', 'ri', 's']) stream.write(`${token}\n`)
    stream.end()
  })
  const client = new RPC(createWorkerPortStream(pagePort), () => {})

  const req = client.request(2)
  req.send('{}', 'utf8')
  let text = ''
  for await (const chunk of req.createResponseStream({ encoding: 'utf-8' }) as AsyncIterable<
    string | Uint8Array
  >) {
    text += typeof chunk === 'string' ? chunk : decodeUtf8(chunk)
  }

  t.is(text, 'Pa\nri\ns\n')
  t.ok(server)
})
