import test from 'brittle'
import { createInMemoryHarnessRunStore } from '../lib/in-memory-harness-run-store.ts'
import { verifyAvailabilityLifecycle } from './harness-run-store-conformance.ts'

test('harness: in-memory HarnessRunStore round-trips state', async (t) => {
  const store = createInMemoryHarnessRunStore()
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
    checkpoint: {
      version: 2,
      agentId: 'agent-1',
      runId: 'run-1',
      nextOperationIndex: 1,
      outputs: [{ operationId: 'run-1/respond', output: 'hello' }]
    }
  })

  const loaded = await store.loadRun({ agentId: 'agent-1', runId: 'run-1' })
  t.is(loaded?.events.length, 1)
  t.is(loaded?.events.at(0)?.kind, 'agent')
  t.is(loaded?.checkpoint?.outputs.at(0)?.output, 'hello')
})

test('harness: in-memory HarnessRunStore availability semantics conform', async (t) => {
  await verifyAvailabilityLifecycle(
    t,
    createInMemoryHarnessRunStore(),
    'memory'
  )
})

test('harness: run events remain durable when outcome persistence must be retried', async (t) => {
  const store = createInMemoryHarnessRunStore()
  await store.appendEvents({
    agentId: 'agent-1',
    runId: 'run-retry',
    operationId: 'run-retry:event:1',
    events: [
      {
        kind: 'execution',
        event: { type: 'error', message: 'failed' }
      }
    ]
  })

  const beforeOutcome = await store.loadRun({
    agentId: 'agent-1',
    runId: 'run-retry'
  })
  t.is(beforeOutcome?.events.length, 1)
  t.is(beforeOutcome?.outcome, null)

  await store.finish({
    agentId: 'agent-1',
    runId: 'run-retry',
    operationId: 'run-retry:outcome',
    outcome: { status: 'failed', error: 'failed' }
  })
  const completed = await store.loadRun({
    agentId: 'agent-1',
    runId: 'run-retry'
  })
  t.alike(completed?.outcome, { status: 'failed', error: 'failed' })
})
