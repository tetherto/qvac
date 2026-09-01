import test from 'brittle'
import { createRPCInitTimeoutCause } from '@/client/rpc/worker-startup-error'

test('RPC init timeout has no cause while a silent worker is still running', (t) => {
  t.is(createRPCInitTimeoutCause('', null), undefined)
})

test('RPC init timeout preserves stderr from a worker that is still running', (t) => {
  const cause = createRPCInitTimeoutCause('native loader failed\n', null)

  t.ok(cause instanceof Error)
  t.ok(cause?.message.includes('did not establish IPC'))
  t.ok(cause?.message.includes('Worker stderr:\nnative loader failed'))
})

test('RPC init timeout reports a pre-handshake worker signal even without stderr', (t) => {
  const cause = createRPCInitTimeoutCause('', { code: null, signal: 'SIGILL' })

  t.ok(cause instanceof Error)
  t.ok(cause?.message.includes('code null, signal SIGILL'))
  t.absent(cause?.message.includes('Worker stderr:'))
})

test('RPC init timeout includes both exit status and drained stderr when available', (t) => {
  const cause = createRPCInitTimeoutCause('last native line\n', { code: 134, signal: null })

  t.ok(cause instanceof Error)
  t.ok(cause?.message.includes('code 134, signal null'))
  t.ok(cause?.message.includes('Worker stderr:\nlast native line'))
})
