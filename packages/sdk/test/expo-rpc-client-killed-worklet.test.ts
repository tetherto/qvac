import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadExpoClient } from './fixtures/expo-worklets'

const { client, started } = await loadExpoClient()

test('a worklet that close() has to kill refuses the next start', async () => {
  await client.getRPC()
  started[0]!.onTerminate = 'kill'

  await client.close()

  await assert.rejects(
    client.getRPC(),
    (error: { name?: string; message?: string }) =>
      error.name === 'WORKER_STARTUP_FAILED' && /restart the app/.test(error.message ?? '')
  )
  assert.equal(started.length, 1, 'a worklet started on the killed worklet’s addon state')
})
