import test from 'brittle'
import { findBareChildren, waitForBareChildren } from './fixtures/bare-children'

// Real worker. A session close that resumes after the owner's close ended the
// session must fail locally: sending would start a new worker only to close a
// session that worker never had.
test('a session close that resumes after the owner close starts no worker', async function (t) {
  t.timeout(25_000)

  delete process.env['QVAC_WORKER_PATH']

  const { openSession } = await import('@/client/session')
  const { close } = await import('@/client/rpc/rpc-client')
  const { resetSessionRegistry } = await import('@/client/session-registry')
  const { SessionInvalidatedError } = await import('@/utils/errors-client')

  t.teardown(async () => {
    resetSessionRegistry()
    try {
      await close()
    } catch {}
  })

  const session = openSession({ name: 'close-race' })
  await session.opened
  const pidsBefore = await waitForBareChildren(process.pid)
  t.ok(pidsBefore.length > 0, `expected at least one bare child; found ${pidsBefore.length}`)

  // The session close waits on `opened` for one turn; the owner's close ends
  // the session in that turn.
  const closing = session.close()
  const ownerClose = close()

  let error: unknown
  try {
    await closing
  } catch (caught) {
    error = caught
  }
  await ownerClose

  t.ok(
    error instanceof SessionInvalidatedError,
    `expected SessionInvalidatedError, got ${(error as { name?: string } | undefined)?.name}`
  )
  t.is((error as SessionInvalidatedError).reason, 'shutdown')
  const started = findBareChildren(process.pid).filter((pid) => !pidsBefore.includes(pid))
  t.is(started.length, 0, `no worker is started for the close; new: ${started.join(',')}`)
})

// Same race for an ordinary call: the session check passes, the owner's close
// runs while the call waits for its stamp, and the call must still fail
// locally rather than start a worker that never opened the session.
test('a session call that resumes after the owner close starts no worker', async function (t) {
  t.timeout(25_000)

  delete process.env['QVAC_WORKER_PATH']

  const { openSession } = await import('@/client/session')
  const { close } = await import('@/client/rpc/rpc-client')
  const { resetSessionRegistry } = await import('@/client/session-registry')
  const { SessionInvalidatedError } = await import('@/utils/errors-client')

  t.teardown(async () => {
    resetSessionRegistry()
    try {
      await close()
    } catch {}
  })

  const session = openSession({ name: 'call-race' })
  await session.opened
  const pidsBefore = await waitForBareChildren(process.pid)
  t.ok(pidsBefore.length > 0, `expected at least one bare child; found ${pidsBefore.length}`)

  let ownerClose: Promise<void> = Promise.resolve()
  const call = session.heartbeat()
  queueMicrotask(() => {
    ownerClose = close()
  })

  let error: unknown
  try {
    await call
  } catch (caught) {
    error = caught
  }
  await ownerClose

  t.ok(
    error instanceof SessionInvalidatedError,
    `expected SessionInvalidatedError, got ${(error as { name?: string } | undefined)?.name}`
  )
  t.is((error as SessionInvalidatedError).reason, 'shutdown')
  const started = findBareChildren(process.pid).filter((pid) => !pidsBefore.includes(pid))
  t.is(started.length, 0, `no worker is started for the call; new: ${started.join(',')}`)
})
