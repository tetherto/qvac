import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { BridgeExecutor } from '../../dist/core/bridge-executor.js'

const here = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(here, '..', 'fixtures', 'lagging-client.mjs')

function executor() {
  return new BridgeExecutor({
    interpreter: process.execPath,
    args: [CLIENT],
    testDefinitions: [
      { testId: 'slow', params: {}, expectation: {}, metadata: {} },
      { testId: 'fast', params: {}, expectation: {}, metadata: {} }
    ],
    log: () => {}
  })
}

test('a late reply does not settle the next test', async () => {
  const bridge = executor()
  await bridge.start()
  try {
    // The caller gives up on `slow` -- a per-test timeout upstream -- and moves on.
    const abandoned = bridge.executeTest('slow', {}, {}, {})
    abandoned.catch(() => {})
    const next = await bridge.executeTest('fast', {}, {}, {})
    assert.equal(next.output, 'answer for fast', 'the next test must not receive the late reply')
  } finally {
    await bridge.stop()
  }
})

test('a result reaches the request that asked for it', async () => {
  const bridge = executor()
  await bridge.start()
  try {
    assert.equal((await bridge.executeTest('fast', {}, {}, {})).output, 'answer for fast')
    assert.equal((await bridge.executeTest('slow', {}, {}, {})).output, 'answer for slow')
  } finally {
    await bridge.stop()
  }
})
