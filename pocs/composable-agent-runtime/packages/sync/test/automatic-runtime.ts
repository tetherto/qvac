import path from 'path'
import test from 'brittle'
import { createSync } from '../index.ts'
import { testContext } from './helpers.ts'

test('sync: createSync owns a desktop sidecar worker', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'automatic-sidecar'),
    bootstrap: testnet.bootstrap
  })
  await sync.ready()
  t.teardown(() => sync.close())

  const identity = await sync.runtime.describe()
  t.is(identity.processId === process.pid, false)
  t.is((await sync.runtime.status()).phase, 'ready')
  await sync.lifecycle.suspend()
  t.is((await sync.runtime.status()).phase, 'suspended')
  await sync.lifecycle.resume()
  t.is((await sync.runtime.status()).phase, 'ready')
  const exited = sync.exited
  await sync.close()
  t.is((await exited).kind, 'closed')
})
