import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { CompletionStreamRequest } from '@qvac/inference/surface'

const sent: CompletionStreamRequest[] = []
const stream = mock.fn(async function* (request: CompletionStreamRequest) {
  sent.push(request)
  yield {
    type: 'completionStream',
    done: true,
    events: [{ type: 'completionDone', seq: 0, stopReason: 'eos' }]
  }
})
mock.module('@/client/rpc/rpc-client', { namedExports: { stream } })
const { completion } = await import('@/client/api/completion-stream')
const { executeToolSearch } = await import('@qvac/inference/surface')

const tools = Array.from({ length: 6 }, (_, index) => ({
  name: `repo_tool_${index}`,
  description: 'Act on a repository',
  parameters: z.object({ id: z.string() }),
  deferLoading: true
}))

function loaded(content: string): string[] {
  return (JSON.parse(content) as { tool_search: { loaded: string[] } }).tool_search.loaded
}

test('completion forwards toolSearch, and executeToolSearch given the same params applies it', async () => {
  const params = { modelId: 'model', tools, toolSearch: { defaultLimit: 1, maxLimit: 2 } }
  await completion({ ...params, history: [{ role: 'user', content: 'hi' }], stream: true }).final

  assert.deepEqual(sent.at(-1)?.toolSearch, { defaultLimit: 1, maxLimit: 2 })
  assert.equal(loaded(executeToolSearch(params, { query: 'repository' }, [])).length, 1)
  assert.equal(loaded(executeToolSearch(params, { query: 'repository', limit: 5 }, [])).length, 2)
  assert.equal(
    loaded(executeToolSearch(tools, { query: 'repository' }, [])).length,
    3,
    'a bare tool list applies the defaults'
  )
})

test('completion leaves toolSearch unset when the caller does not set it', async () => {
  await completion({
    modelId: 'model',
    history: [{ role: 'user', content: 'hi' }],
    stream: true,
    tools
  }).final
  assert.equal(sent.at(-1)?.toolSearch, undefined)
})
