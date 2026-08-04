import type { HarnessRunStore } from '../lib/run-store.ts'

interface Assertions {
  is<T>(actual: T, expected: T, message?: string): boolean
  alike<T>(actual: T, expected: T, message?: string): boolean
}

export async function verifyAvailabilityLifecycle(
  t: Assertions,
  store: HarnessRunStore,
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
    agentId: 'agent-1',
    runId: `${prefix}-run`,
    operationId: `${prefix}-start`,
    events: [
      {
        kind: 'agent',
        event: { type: 'run-started', runId: `${prefix}-run` }
      }
    ]
  })
  t.is((await watch.next()).value.kind, 'available')

  await store.finish({
    agentId: 'agent-1',
    runId: `${prefix}-run`,
    operationId: `${prefix}-complete`,
    outcome: { status: 'completed', output: 'done' }
  })
  t.is((await watch.next()).value.kind, 'unavailable')
  await watch.return?.()
}
