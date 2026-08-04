import path from 'path'
import test from 'brittle'
import createTestnet from 'hyperdht/testnet.js'
import tmp from 'test-tmp'
import { createSync } from '@qvac/sync'
import { createSyncHarnessRunStore } from '../lib/sync-harness-run-store.ts'
import { verifyAvailabilityLifecycle } from './harness-run-store-conformance.ts'

const checkpoint = {
  version: 1 as const,
  agentId: 'agent-1',
  runId: 'run-1',
  nextOperationIndex: 1,
  outputs: [{ operationId: 'run-1/respond', output: 'hello' }]
}

test('harness: Sync HarnessRunStore survives real Sync reopen', async (t) => {
  t.timeout(60_000)
  const dir = await tmp(t)
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const storagePath = path.join(dir, 'sync-agent-state')
  const first = createSync({
    storagePath,
    bootstrap: testnet.bootstrap
  })
  await first.ready()
  const store = createSyncHarnessRunStore(first)
  await verifyAvailabilityLifecycle(t, store, 'sync')
  await store.appendEvents({
    agentId: 'agent-1',
    runId: 'run-1',
    operationId: 'events-1',
    events: [
      {
        kind: 'agent',
        event: { type: 'run-started', runId: 'run-1' }
      }
    ]
  })
  await store.saveCheckpoint({
    agentId: 'agent-1',
    runId: 'run-1',
    operationId: 'checkpoint-1',
    checkpoint
  })
  await first.close()

  const second = createSync({
    storagePath,
    bootstrap: testnet.bootstrap
  })
  t.teardown(() => second.close())
  await second.ready()
  const loaded = await createSyncHarnessRunStore(second).loadRun({
    agentId: 'agent-1',
    runId: 'run-1'
  })
  const firstEvent = loaded?.events.at(0)
  t.is(firstEvent?.kind, 'agent')
  if (firstEvent?.kind === 'agent') t.is(firstEvent.event.type, 'run-started')
  t.is(loaded?.checkpoint?.runId, 'run-1')
})
