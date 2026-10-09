import test from 'brittle'

const FAKE_PLATFORM = 'commodore64'

void test('RPC init reports a platform with no Bare runtime as a startup failure', async function (t) {
  t.timeout(10_000)

  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  // `#rpc` loads the built client, as the SDK does, so it finds the built worker files.
  const { getRPC, close } = await import('#rpc')

  t.teardown(async function () {
    if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor)
    try {
      await close()
    } catch {}
  })

  Object.defineProperty(process, 'platform', { configurable: true, value: FAKE_PLATFORM })

  const startedAt = Date.now()
  let thrown: Error | undefined
  try {
    await getRPC()
  } catch (error) {
    thrown = error as Error
  }

  t.is(thrown?.name, 'WORKER_STARTUP_FAILED')
  t.ok(Date.now() - startedAt < 5_000, 'fails without waiting for the startup timeout')
})
