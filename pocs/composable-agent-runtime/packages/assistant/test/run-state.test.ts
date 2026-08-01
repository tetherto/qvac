import { describe, expect, it } from 'vitest'
import type { AssistantStateEndpoint } from '../lib/contracts.ts'
import { createRunStateAdapter } from '../lib/run-state.ts'

describe('run-state adapter', () => {
  it('caches immediate events and flushes terminal events once', async () => {
    const state = createState()
    const adapter = createRunStateAdapter(state.endpoint)

    await adapter.append('run-1', { type: 'content', text: 'first' })
    await adapter.append('run-1', { type: 'thinking', text: 'second' })

    expect(state.gets).toBe(0)
    expect(state.updates).toBe(0)

    await adapter.append('run-1', {
      type: 'error',
      message: 'failed'
    })

    expect(state.gets).toBe(1)
    expect(state.creates).toBe(1)
    expect(state.updates).toBe(1)
    expect(await adapter.read('run-1')).toEqual([
      { type: 'content', text: 'first' },
      { type: 'thinking', text: 'second' },
      { type: 'error', message: 'failed' }
    ])
  })
})

function createState() {
  let persisted: string | null = null
  let gets = 0
  let creates = 0
  let updates = 0
  const endpoint = {
    async getTask() {
      gets++
      return {
        task: persisted
          ? { result: persisted }
          : null
      }
    },
    async createTask() {
      creates++
      return {}
    },
    async updateTask(request: { result?: string | null }) {
      updates++
      persisted = request.result ?? null
      return {}
    }
  } as unknown as AssistantStateEndpoint
  return {
    endpoint,
    get gets() {
      return gets
    },
    get creates() {
      return creates
    },
    get updates() {
      return updates
    }
  }
}
