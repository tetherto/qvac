import test from 'brittle'

test('a call made while close() waits on a pending start gets a fresh worker', async function (t) {
  t.timeout(60_000)

  delete process.env['QVAC_WORKER_PATH']

  const { heartbeat } = await import('@/client/api/heartbeat')
  const { close } = await import('@/client/rpc/rpc-client')

  t.teardown(async () => {
    try {
      await close()
    } catch {}
  })

  const first = heartbeat()
  const closing = close()
  const second = heartbeat()

  try {
    await first
    t.fail('expected the call started before close() to reject')
  } catch (error) {
    t.is((error as { name?: string }).name, 'WORKER_SHUTDOWN')
  }
  await closing
  t.ok(await second)
})
