import test from 'brittle'
import { waitForBareChildren } from './fixtures/bare-children'

// Real worker. The owner holds a model id, the bare child is killed, and the
// next owner call naming that id must fail locally with
// ModelHandleInvalidatedError rather than reach a fresh worker and come back
// as an unknown model.
test('an owner model handle is refused locally once the worker is lost', async function (t) {
  t.timeout(25_000)

  delete process.env['QVAC_WORKER_PATH']

  const { heartbeat } = await import('@/client/api/heartbeat')
  const { unloadModel } = await import('@/client/api/unload-model')
  const { close } = await import('@/client/rpc/rpc-client')
  const { recordHeldModel, resetSessionRegistry } = await import('@/client/session-registry')
  const { ModelHandleInvalidatedError } = await import('@/utils/errors-client')

  t.teardown(async () => {
    resetSessionRegistry()
    try {
      await close()
    } catch {}
  })

  await heartbeat()
  // Stands in for a resolved loadModel: the registry records the id the same way.
  recordHeldModel(undefined, 'owner-model-before-crash')

  const pids = await waitForBareChildren(process.pid)
  t.ok(pids.length > 0, `expected at least one bare child; found ${pids.length}`)
  if (pids.length === 0) return

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }

  try {
    await heartbeat()
  } catch (error) {
    t.is((error as { name?: string }).name, 'WORKER_CRASHED', 'the crash is observed')
  }

  let refused: unknown
  try {
    await unloadModel({ modelId: 'owner-model-before-crash' })
  } catch (error) {
    refused = error
  }
  t.ok(
    refused instanceof ModelHandleInvalidatedError,
    `expected ModelHandleInvalidatedError, got ${(refused as { name?: string } | undefined)?.name}`
  )
  t.is((refused as ModelHandleInvalidatedError).modelId, 'owner-model-before-crash')

  const fresh = await heartbeat()
  t.is(fresh.type, 'heartbeat', 'an owner call without the dead id respawns the worker')
})
