// Worker for rpc-stream-abort.test.ts. Holds loggingStream requests open and
// reports `opened:<id>` / `closed:<id>` on the `probe` stream. `chatty` gets one
// log, `pair` two in one write, any other id none. A duplex request (no request
// data) echoes each chunk back as one log and reports as `duplex`. A `heartbeat`
// is never answered; it reports `cancelled:heartbeat` when the client cancels it.

import RPC from 'bare-rpc'
import { AbortController } from 'bare-abort-controller'

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

function echoDuplex(req) {
  const requestStream = req.createRequestStream()
  const responseStream = req.createResponseStream()
  // The client cancelling the request destroys both streams with an error.
  requestStream.on('error', () => {})
  responseStream.on('error', () => {})
  responseStream.on('close', () => report('closed:duplex'))
  requestStream.on('data', (chunk) => {
    responseStream.write(frame('duplex', chunk.toString()), 'utf-8')
  })
  report('opened:duplex')
}

export default function start(ipc) {
  new RPC(ipc, onRequest, { AbortController })
}

function onRequest(req) {
  if (!req.data || req.data.length === 0) {
    echoDuplex(req)
    return
  }

  const request = JSON.parse(req.data.toString())

  // Sent by the client before its first call.
  if (request.type === '__init_config') {
    req.reply(JSON.stringify({ success: true }), 'utf-8')
    return
  }
  if (request.type === 'heartbeat') {
    req.signal.addEventListener('abort', () => report('cancelled:heartbeat'), { once: true })
    return
  }
  if (request.type !== 'loggingStream') return

  const responseStream = req.createResponseStream()
  if (request.id === 'probe') {
    probe = responseStream
    for (const message of pending.splice(0)) report(message)
    return
  }

  responseStream.on('close', () => report(`closed:${request.id}`))
  report(`opened:${request.id}`)
  if (request.id === 'chatty') responseStream.write(frame('chatty', 'hello'), 'utf-8')
  if (request.id === 'pair') {
    responseStream.write(frame('pair', 'first') + frame('pair', 'second'), 'utf-8')
  }
}
