import test from 'brittle'
import { createRPCInitTimeoutCause } from '@/client/rpc/worker-startup-error'
import { WorkerStartupError } from '@/utils/errors-client'
import { SDK_CLIENT_ERROR_CODES } from '@/schemas/sdk-errors-client'

test('RPC init timeout has no cause while a silent worker is still running', (t) => {
  t.is(createRPCInitTimeoutCause('', null), undefined)
})

test('RPC init timeout preserves stderr from a worker that is still running', (t) => {
  const cause = createRPCInitTimeoutCause('native loader failed\n', null)

  t.ok(cause instanceof WorkerStartupError)
  t.ok(cause?.message.includes('did not establish IPC'))
  t.ok(cause?.message.includes('Worker stderr:\nnative loader failed'))
  t.absent(cause?.workerExited, 'a process that never exited is reported as still running')
  t.is(cause?.stderrTail, 'native loader failed')
})

test('RPC init timeout reports a pre-handshake worker signal even without stderr', (t) => {
  const cause = createRPCInitTimeoutCause('', { code: null, signal: 'SIGILL' })

  t.ok(cause instanceof WorkerStartupError)
  t.ok(cause?.message.includes('code null, signal SIGILL'))
  t.absent(cause?.message.includes('Worker stderr:'))
  t.ok(cause?.workerExited)
  t.is(cause?.exitSignal, 'SIGILL')
  t.is(cause?.exitCode, null)
  t.is(cause?.stderrTail, '')
})

test('RPC init timeout includes both exit status and drained stderr when available', (t) => {
  const cause = createRPCInitTimeoutCause('last native line\n', { code: 134, signal: null })

  t.ok(cause instanceof WorkerStartupError)
  t.ok(cause?.message.includes('code 134, signal null'))
  t.ok(cause?.message.includes('Worker stderr:\nlast native line'))
  t.ok(cause?.workerExited)
  t.is(cause?.exitCode, 134)
  t.is(cause?.exitSignal, null)
})

// The exit status used to be readable only by matching the message text, which
// is the contract this error type replaces.
test('startup cause carries the registered error identity', (t) => {
  const cause = createRPCInitTimeoutCause('', { code: null, signal: 'SIGSEGV' })

  t.is(cause?.name, 'WORKER_STARTUP_FAILED')
  t.is(cause?.code, SDK_CLIENT_ERROR_CODES.WORKER_STARTUP_FAILED)
})
