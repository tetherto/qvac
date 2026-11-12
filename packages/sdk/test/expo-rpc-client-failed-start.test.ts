import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadExpoClient, workerFailure } from './fixtures/expo-worklets'

const { client, started, harness } = await loadExpoClient()

// The second test leaves addon state behind for the rest of this process.

test('a worklet that reports its exit before ready lets the next call start a new one', async () => {
  harness.failNextStart = workerFailure('WORKER_EXITED', 1)
  await assert.rejects(
    client.getRPC(),
    (error: { name?: string }) => error.name === 'WORKER_STARTUP_FAILED'
  )

  await client.getRPC()
  assert.equal(started.length, 1)
  await client.close()
})

test('a worklet that times out before ready refuses the next start', async () => {
  harness.failNextStart = workerFailure('WORKER_TIMEOUT')
  await assert.rejects(
    client.getRPC(),
    (error: { name?: string; timedOut?: boolean }) =>
      error.name === 'WORKER_STARTUP_FAILED' && error.timedOut === true
  )
  const count = started.length

  await assert.rejects(
    client.getRPC(),
    (error: { name?: string; message?: string }) =>
      error.name === 'WORKER_STARTUP_FAILED' && /restart the app/.test(error.message ?? '')
  )
  assert.equal(started.length, count, 'a worklet started on the timed-out worklet’s addon state')
})
