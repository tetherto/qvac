import { describe, expect, it } from 'vitest'
import type { AssistantStateEndpoint } from '../lib/contracts.ts'
import { createRunStateAdapter } from '../lib/run-state.ts'

describe('run-state adapter', () => {
  it('caches immediate events and flushes terminal events once', async () => {
    const state = createState()
    const adapter = createRunStateAdapter(state.endpoint)

    await adapter.append('run-1', { type: 'content', text: 'first' })
    await adapter.append('run-1', { type: 'thinking', text: 'second' })

    expect(state.queries).toBe(0)
    expect(state.applies).toBe(0)

    await adapter.append('run-1', {
      type: 'error',
      message: 'failed'
    })

    expect(state.queries).toBe(2)
    expect(state.applies).toBe(3)
    expect(await adapter.read('run-1')).toEqual([
      { type: 'content', text: 'first' },
      { type: 'thinking', text: 'second' },
      { type: 'error', message: 'failed' }
    ])
  })

  it('records a completed outcome only after successful stream completion', async () => {
    const state = createState()
    const adapter = createRunStateAdapter(state.endpoint)

    await adapter.append('run-1', { type: 'content', text: 'done' })
    await adapter.finish('run-1', true)

    expect(state.commands).toEqual([
      'record-work',
      'append-journal',
      'record-outcome'
    ])
  })

  it('retains pending events until journal and outcome persistence both succeed', async () => {
    const state = createState({ failOutcomeOnce: true })
    const adapter = createRunStateAdapter(state.endpoint)

    await adapter.append('run-1', { type: 'content', text: 'before failure' })
    await expect(
      adapter.append('run-1', { type: 'error', message: 'failed' })
    ).rejects.toThrow('outcome unavailable')

    await adapter.finish('run-1')

    expect(await adapter.read('run-1')).toEqual([
      { type: 'content', text: 'before failure' },
      { type: 'error', message: 'failed' }
    ])
    expect(state.commands.filter((command) => command === 'record-outcome')).toHaveLength(2)
  })
})

function createState(options: { readonly failOutcomeOnce?: boolean } = {}) {
  const entries: Array<{ entryType: string; body: Buffer }> = []
  let exists = false
  let queries = 0
  let applies = 0
  let outcomeFailures = options.failOutcomeOnce ? 1 : 0
  const commands: string[] = []
  const endpoint = {
    openProfile() {
      return {
        async apply(command: {
          type: string
          entryType?: string
          body?: Buffer
        }) {
          applies++
          commands.push(command.type)
          if (command.type === 'record-work') exists = true
          if (command.type === 'record-outcome' && outcomeFailures > 0) {
            outcomeFailures--
            throw new Error('outcome unavailable')
          }
          if (
            command.type === 'append-journal' &&
            command.entryType &&
            command.body
          ) {
            entries.push({
              entryType: command.entryType,
              body: command.body
            })
          }
          return {}
        },
        async query(query: { type: string }) {
          queries++
          if (query.type === 'get-work') {
            return { work: exists ? { workId: 'run-1' } : null }
          }
          return { entries }
        },
        watch: async function* () {}
      }
    }
  } as unknown as AssistantStateEndpoint
  return {
    endpoint,
    get queries() {
      return queries
    },
    get applies() {
      return applies
    },
    get commands() {
      return commands
    }
  }
}
