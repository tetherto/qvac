import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadExpoClient, tick } from './fixtures/expo-worklets'

const { client, started } = await loadExpoClient()

// Each test leaves the next one its state: the first two stop cleanly, the
// last leaves addon state behind for the rest of this process.

test('a worklet that reports its exit and closes lets the next call start a new one', async () => {
  await client.getRPC()
  started[0]!.exitCleanly(1)
  await tick()

  await client.getRPC()
  assert.equal(started.length, 2)
})

test('a worklet stopped by close() after reporting its exit lets the next call start a new one', async () => {
  await client.close()
  await client.getRPC()
  assert.equal(started.length, 3)
})

test('a worklet that dies without reporting its exit refuses the next start', async () => {
  started.at(-1)!.die()
  await tick()
  const count = started.length

  await assert.rejects(
    client.getRPC(),
    (error: { name?: string; message?: string }) =>
      error.name === 'WORKER_STARTUP_FAILED' && /restart the app/.test(error.message ?? '')
  )
  assert.equal(started.length, count, 'a worklet started on the dead worklet’s addon state')
})
