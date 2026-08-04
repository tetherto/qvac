import path from 'path'
import test from 'brittle'
import { createSync } from '../index.ts'
import { durableWorkProfile } from '../profiles/durable-work.ts'
import { testContext } from './helpers.ts'

test('sync: worker errors cross RPC as sanitized envelopes', async (t) => {
  const { dir, testnet } = await testContext(t)
  const sync = createSync({
    storagePath: path.join(dir, 'sanitized-errors'),
    bootstrap: testnet.bootstrap
  })
  await sync.ready()
  t.teardown(() => sync.close())
  const profile = sync.openProfile(durableWorkProfile)

  let error: unknown = null
  try {
    await profile.apply(
      {
        type: 'record-outcome',
        workId: 'missing',
        status: 'failed'
      },
      {
        operationId: 'invalid-transition-op',
        traceId: 'safe-trace'
      }
    )
  } catch (caught) {
    error = caught
  }
  t.ok(error instanceof Error)
  if (!(error instanceof Error)) return
  t.is(Reflect.get(error, 'category'), 'invalid-transition')
  t.is(Reflect.get(error, 'retryable'), false)
  t.is(Reflect.get(error, 'operationId'), 'invalid-transition-op')
  t.is(Reflect.get(error, 'traceId'), 'safe-trace')
  t.absent(Reflect.get(error, 'stack'), 'remote stack is not exposed')
})
