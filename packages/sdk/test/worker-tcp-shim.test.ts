import test from 'brittle'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const SHIM = path.resolve(__dirname, '../dist/src/worker/tcp-shim.js')
const ENTRY = path.resolve(__dirname, 'fixtures/echo-worker.mjs')
const BARE = path.join(
  path.dirname(require.resolve('bare-sidecar/package')),
  'prebuilds',
  `${process.platform}-${process.arch}`,
  process.platform === 'win32' ? 'bare.exe' : 'bare'
)

const CONTROL = 0
const DATA = 1

function frame(tag: number, payload: Buffer) {
  const header = Buffer.alloc(5)
  header.writeUInt32LE(payload.length + 1, 0)
  header.writeUInt8(tag, 4)
  return Buffer.concat([header, payload])
}

test('a client without an IPC pipe runs the worker over loopback TCP', async function (t) {
  t.timeout(30_000)

  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.teardown(() => server.close())
  const { port } = server.address() as net.AddressInfo

  const worker = spawn(BARE, [SHIM, ENTRY, String(port)], {
    stdio: ['ignore', 'inherit', 'inherit']
  })
  t.teardown(() => worker.kill('SIGKILL'))
  const exited = once(worker, 'exit')

  const [socket] = (await once(server, 'connection')) as [net.Socket]
  const received: { tag: number; payload: Buffer }[] = []
  let buffered = Buffer.alloc(0)
  const done = new Promise<void>((resolve) => {
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32LE(0)) {
        const length = buffered.readUInt32LE(0)
        const message = { tag: buffered.readUInt8(4), payload: buffered.subarray(5, 4 + length) }
        buffered = buffered.subarray(4 + length)
        received.push(message)
        if (message.tag === CONTROL) {
          const { type } = JSON.parse(message.payload.toString()) as { type: string }
          if (type === 'ready') socket.write(frame(DATA, Buffer.from('hello')))
          if (type === 'exit') resolve()
        } else {
          socket.write(frame(CONTROL, Buffer.from(JSON.stringify({ type: 'terminate' }))))
        }
      }
    })
  })

  await done
  const [code] = (await exited) as [number | null]

  const messages = received.map(({ tag, payload }) =>
    tag === CONTROL ? JSON.parse(payload.toString()) : payload.toString()
  )
  t.alike(messages, [{ type: 'ready' }, 'hello', { type: 'exit', code: 0 }])
  t.is(code, 0)
})
