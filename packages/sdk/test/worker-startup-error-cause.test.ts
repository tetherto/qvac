import test from 'brittle'
import { createRPCInitTimeoutCause } from '@/client/rpc/worker-startup-error'
import { WorkerStartupError } from '@/utils/errors-client'
import { SDK_CLIENT_ERROR_CODES } from '@/schemas/sdk-errors-client'

// The case an integrator asks about most: nothing was written, nothing exited,
// so only `workerExited` can say whether waiting longer could help.
test('RPC init timeout still reports liveness for a silent worker that is running', (t) => {
  const cause = createRPCInitTimeoutCause('', null)

  t.ok(cause instanceof WorkerStartupError)
  t.absent(cause.workerExited)
  t.is(cause.exitCode, null)
  t.is(cause.exitSignal, null)
  t.is(cause.stderrTail, '')
  t.ok(cause.message.includes('did not establish IPC'))
  t.absent(cause.message.includes('Worker stderr:'))
})

test('RPC init timeout preserves stderr from a worker that is still running', (t) => {
  const cause = createRPCInitTimeoutCause('native loader failed\n', null)

  t.ok(cause instanceof WorkerStartupError)
  t.ok(cause.message.includes('did not establish IPC'))
  t.ok(cause.message.includes('Worker stderr:\nnative loader failed'))
  t.absent(cause.workerExited, 'a process that never exited is reported as still running')
  t.is(cause.stderrTail, 'native loader failed')
})

test('RPC init timeout reports a pre-handshake worker signal even without stderr', (t) => {
  const cause = createRPCInitTimeoutCause('', { code: null, signal: 'SIGILL' })

  t.ok(cause instanceof WorkerStartupError)
  t.ok(cause.message.includes('code null, signal SIGILL'))
  t.absent(cause.message.includes('Worker stderr:'))
  t.ok(cause.workerExited)
  t.is(cause.exitSignal, 'SIGILL')
  t.is(cause.exitCode, null)
  t.is(cause.stderrTail, '')
})

test('RPC init timeout includes both exit status and drained stderr when available', (t) => {
  const cause = createRPCInitTimeoutCause('last native line\n', { code: 134, signal: null })

  t.ok(cause instanceof WorkerStartupError)
  t.ok(cause.message.includes('code 134, signal null'))
  t.ok(cause.message.includes('Worker stderr:\nlast native line'))
  t.ok(cause.workerExited)
  t.is(cause.exitCode, 134)
  t.is(cause.exitSignal, null)
})

test('startup cause carries the registered error identity', (t) => {
  const cause = createRPCInitTimeoutCause('', { code: null, signal: 'SIGSEGV' })

  t.is(cause.name, 'WORKER_STARTUP_FAILED')
  t.is(cause.code, SDK_CLIENT_ERROR_CODES.WORKER_STARTUP_FAILED)
})

test('missing libatomic gives an actionable hint without changing startup metadata', (t) => {
  const stderr =
    'Error: libatomic.so.1: cannot open shared object file: No such file or directory\n' +
    'at rocksdb-native/prebuilds/linux-arm64/rocksdb-native.bare\n'

  for (const workerExit of [null, { code: 134, signal: null }]) {
    const cause = createRPCInitTimeoutCause(stderr, workerExit)

    t.ok(cause.message.includes('Missing Linux runtime library libatomic.so.1'))
    t.ok(cause.message.includes('On Debian or Ubuntu, install libatomic1'))
    t.is(cause.stderrTail, stderr.trimEnd())
    t.is(cause.workerExited, workerExit !== null)
    t.is(cause.exitCode, workerExit?.code ?? null)
    t.is(cause.code, SDK_CLIENT_ERROR_CODES.WORKER_STARTUP_FAILED)
  }
})

test('other loader failures and library mentions do not suggest libatomic1', (t) => {
  for (const stderr of [
    'Cannot find addon rocksdb-native',
    'libvulkan.so.1: cannot open shared object file: No such file or directory',
    'libatomic.so.1: version ATOMIC_9.0 not found',
    'Loaded libatomic.so.1 successfully'
  ]) {
    const cause = createRPCInitTimeoutCause(stderr, { code: 1, signal: null })
    t.absent(cause.message.includes('install libatomic1'))
    t.is(cause.stderrTail, stderr)
  }
})
