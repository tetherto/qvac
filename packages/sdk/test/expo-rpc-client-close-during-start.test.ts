import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadExpoClient, tick, workerFailure } from './fixtures/expo-worklets'

const { client, harness } = await loadExpoClient()

test('a start that close() interrupted rejects with WORKER_SHUTDOWN when it then times out', async () => {
  let release!: () => void
  harness.holdNextStart = new Promise<void>((resolve) => {
    release = resolve
  })
  harness.failNextStart = workerFailure('WORKER_TIMEOUT')

  const pending = client.getRPC()
  while (harness.starts === 0) await tick()
  const closing = client.close()
  release()

  await assert.rejects(pending, (error: { name?: string }) => error.name === 'WORKER_SHUTDOWN')
  await closing
})
