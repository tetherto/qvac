import type { HarnessEvent, HarnessStateAdapter } from './types.ts'

export function createMemoryStateAdapter(): HarnessStateAdapter {
  const runs = new Map<string, HarnessEvent[]>()
  let closed = false

  return {
    async append(runId, event) {
      if (closed) throw new Error('harness state is closed')
      const events = runs.get(runId) ?? []
      events.push(event)
      runs.set(runId, events)
    },
    async read(runId) {
      return [...(runs.get(runId) ?? [])]
    },
    async close() {
      closed = true
    }
  }
}
