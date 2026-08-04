import type { AgentStateStore } from '@qvac/agents'

interface Assertions {
  is<T>(actual: T, expected: T, message?: string): boolean
  alike<T>(actual: T, expected: T, message?: string): boolean
}

export async function verifyAvailabilityLifecycle(
  t: Assertions,
  store: AgentStateStore,
  prefix: string
) {
  const watch = store.watchAvailableWork()[Symbol.asyncIterator]()
  const snapshot = await watch.next()
  t.alike(snapshot.value, {
    kind: 'snapshot',
    workIds: [],
    cursor: snapshot.value.cursor
  })

  await store.appendEvents({
    runId: `${prefix}-run`,
    operationId: `${prefix}-start`,
    events: [{ type: 'run-started', runId: `${prefix}-run` }]
  })
  t.is((await watch.next()).value.kind, 'available')

  const checkpoint = {
    version: 1 as const,
    agentId: 'agent-1',
    runId: `${prefix}-run`,
    nextOperationIndex: 0,
    outputs: []
  }
  await store.appendEvents({
    runId: `${prefix}-run`,
    operationId: `${prefix}-complete`,
    events: [
      {
        type: 'run-completed',
        runId: `${prefix}-run`,
        output: 'done',
        checkpoint
      }
    ]
  })
  t.is((await watch.next()).value.kind, 'unavailable')
  await watch.return?.()
}
