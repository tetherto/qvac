// A real upstream Bare-RPC peer. No Kotlin codec is involved on this side.
const net = require('node:net')
const RPC = require('bare-rpc')
const env = JSON.parse(process.argv.at(-1))
const endpoint = new URL(env.QVAC_IPC_SOCKET_PATH)
const socket = net.connect(Number(endpoint.port), endpoint.hostname, () => {
  if (env.QVAC_IPC_AUTH_TOKEN) socket.write(env.QVAC_IPC_AUTH_TOKEN + '\n')
})
let resolveInputClosed
const inputClosed = new Promise(resolve => { resolveInputClosed = resolve })
new RPC(socket, async request => {
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
  else if (payload.type === '__shutdown__') {
    request.reply(Buffer.from('{"success":true}'))
    setTimeout(() => socket.end(), 30)
  } else if (payload.type === 'stream') {
    const stream = request.createResponseStream()
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve, reject) => stream.write(Buffer.from(JSON.stringify({ type: 'item', index: i }) + '\n'), error => error ? reject(error) : resolve()))
    }
    stream.end()
  } else throw new Error('unexpected request')
})
