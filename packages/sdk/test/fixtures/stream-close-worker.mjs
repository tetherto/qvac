// Bare worker that holds every loggingStream request open and reports on the
// `probe` stream when one opens and when the client closes it. A stream for the
// id `chatty` gets one log right away, and one for `pair` gets two in a single
// write; every other id gets none, like a model that logs nothing more. Used by
// rpc-stream-abort.test.ts.

import RPC from 'bare-rpc'
import { connect } from 'bare-net'
import Signal from 'bare-signals'

const { QVAC_IPC_SOCKET_PATH: socketPath } = JSON.parse(Bare.argv[2])

let probe = null
const pending = []

function frame(id, message) {
  return (
    JSON.stringify({
      type: 'loggingStream',
      id,
      level: 'info',
      namespace: 'fixture',
      message,
      timestamp: Date.now()
    }) + '\n'
  )
}

function report(message) {
  if (probe) probe.write(frame('probe', message), 'utf-8')
  else pending.push(message)
}

new RPC(connect(socketPath), (req) => {
  const request = JSON.parse(req.data.toString())

  // The client configures the worker before its first call.
  if (request.type === '__init_config') {
    req.reply(JSON.stringify({ success: true }), 'utf-8')
    return
  }
  if (request.type !== 'loggingStream') return

  const wire = req.createResponseStream()
  if (request.id === 'probe') {
    probe = wire
    for (const message of pending.splice(0)) report(message)
    return
  }

  wire.on('close', () => report(`closed:${request.id}`))
  report(`opened:${request.id}`)
  if (request.id === 'chatty') wire.write(frame('chatty', 'hello'), 'utf-8')
  if (request.id === 'pair') wire.write(frame('pair', 'first') + frame('pair', 'second'), 'utf-8')
})

const signals = new Signal.Emitter()
signals.once('SIGTERM', () => Bare.exit(0))
