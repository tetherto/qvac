// A real upstream Bare-RPC peer. No Kotlin codec is involved on this side. It
// connects back the way the SDK's TCP shim does and carries bare-rpc inside
// bare-stow's framing, encoded by bare-stow itself.
const net = require('node:net')
const { Duplex } = require('bare-stream')
const RPC = require('bare-rpc')
const protocol = require('bare-stow/protocol')

const socket = net.connect(Number(process.argv.at(-1)), '127.0.0.1', () => {
  const token = process.env.QVAC_IPC_AUTH_TOKEN
  if (token) socket.write(token + '\n')
  ipc.send('ready')
})

const stream = new Duplex({
  write(data, encoding, callback) {
    socket.write(data, callback)
  },
  final(callback) {
    socket.end()
    callback(null)
  }
})
socket.on('data', (chunk) => stream.push(chunk))
socket.on('end', () => stream.push(null))

const ipc = protocol.attach(stream)
ipc.on('terminate', async () => {
  await ipc.send('exit', { code: 0 })
  stream.end()
})

let resolveInputClosed
const inputClosed = new Promise(resolve => { resolveInputClosed = resolve })
new RPC(ipc, async request => {
  if (!request.data) {
    const input = request.createRequestStream()
    const output = request.createResponseStream()
    input.on('error', () => {})
    output.on('error', () => {})
    input.on('end', () => { resolveInputClosed(); output.end() })
    input.resume()
    return
  }
  const payload = JSON.parse(request.data.toString())
  if (payload.type === '__init_config') request.reply(Buffer.from('{"success":true}'))
  else if (payload.type === 'heartbeat') request.reply(Buffer.from('{"type":"heartbeat","number":9}'))
  else if (payload.type === 'inputClosed') {
    await inputClosed
    request.reply(Buffer.from('{"type":"inputClosed","closed":true}'))
  }
  else if (payload.type === 'stream') {
    const stream = request.createResponseStream()
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve, reject) => stream.write(Buffer.from(JSON.stringify({ type: 'item', index: i }) + '\n'), error => error ? reject(error) : resolve()))
    }
    stream.end()
  } else throw new Error('unexpected request')
})
