import test from 'brittle'
import { createInMemoryAgentStateStore } from '../index.ts'
import { verifyAvailabilityLifecycle } from './agent-state-store-conformance.ts'

test('harness: in-memory AgentStateStore round-trips state', async (t) => {
  const store = createInMemoryAgentStateStore()
  await store.appendEvents({
    runId: 'run-1',
    operationId: 'events-1',
    events: [{ type: 'run-started', runId: 'run-1' }]
  })
  await store.saveCheckpoint({
    runId: 'run-1',
    operationId: 'checkpoint-1',
    checkpoint: {
      version: 1,
      agentId: 'agent-1',
      runId: 'run-1',
      nextOperationIndex: 1,
      outputs: [{ operationId: 'run-1/respond', output: 'hello' }]
    }
  })

  const loaded = await store.loadRun('run-1')
  t.is(loaded?.events.length, 1)
  t.is(loaded?.checkpoint?.outputs.at(0)?.output, 'hello')
})

test('harness: in-memory AgentStateStore availability semantics conform', async (t) => {
  await verifyAvailabilityLifecycle(
    t,
    createInMemoryAgentStateStore(),
    'memory'
  )
})
