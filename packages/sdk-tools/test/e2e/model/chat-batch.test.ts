import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'
import { assertStatusAndError } from '../helpers/http.js'

const ALIAS = 'test-llm-batch'

const BATCH_CONFIG = {
  serve: {
    models: {
      [ALIAS]: {
        model: 'QWEN3_600M_INST_Q4',
        preload: true,
        config: { ctx_size: 4096, parallel: 2, tools: true }
      }
    }
  }
}

interface BatchBody {
  object: string
  model: string
  results: Array<{
    id: string
    index: number
    message: { role: string; content: string | null; reasoning_content?: string }
    finish_reason: string
  }>
  stats?: Record<string, unknown>
}

function ask(word: string, id?: string) {
  return {
    ...(id !== undefined ? { id } : {}),
    messages: [{ role: 'user', content: `Reply with only the word ${word}.` }],
    temperature: 0,
    seed: 42,
    max_tokens: 64,
    reasoning_budget: false
  }
}

const weatherTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } } }
  }
}

describe('qvac chat batch: real LLM', () => {
  const server = useModelServer(BATCH_CONFIG)

  function batch(payload: unknown) {
    return server().inject({
      method: 'POST',
      url: '/qvac/v1/chat/batch',
      payload: payload as object
    })
  }

  it('returns one result per prompt, in prompt order, under the given ids', async () => {
    const res = await batch({
      model: ALIAS,
      prompts: [ask('CHERRY', 'cherry'), ask('BANANA', 'banana'), ask('GRAPE', 'grape')]
    })
    assert.equal(res.statusCode, 200, res.body)

    const body = res.json() as BatchBody
    assert.equal(body.object, 'chat.batch')
    assert.equal(body.model, ALIAS)
    assert.deepEqual(
      body.results.map((r) => [r.id, r.index]),
      [
        ['cherry', 0],
        ['banana', 1],
        ['grape', 2]
      ]
    )
    for (const [i, word] of ['CHERRY', 'BANANA', 'GRAPE'].entries()) {
      const result = body.results[i]!
      assert.equal(result.message.role, 'assistant')
      assert.ok(['stop', 'length'].includes(result.finish_reason))
      assert.match(result.message.content ?? '', new RegExp(word, 'i'))
    }
  })

  it('assigns distinct ids when the caller gives none', async () => {
    const res = await batch({ model: ALIAS, prompts: [ask('RED'), ask('BLUE')] })
    assert.equal(res.statusCode, 200, res.body)

    const ids = (res.json() as BatchBody).results.map((r) => r.id)
    assert.equal(ids.length, 2)
    assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0))
    assert.equal(new Set(ids).size, 2)
  })

  it('rejects deferred tools, naming the prompt', async () => {
    const res = await batch({
      model: ALIAS,
      prompts: [ask('RED'), { ...ask('BLUE'), tools: [{ ...weatherTool, defer_loading: true }] }]
    })
    assertStatusAndError(res, 400, 'deferred_tools_unsupported')
    assert.match(res.body, /prompts\[1\]/)
  })

  it('rejects response_format combined with tools', async () => {
    const res = await batch({
      model: ALIAS,
      prompts: [{ ...ask('RED'), tools: [weatherTool], response_format: { type: 'json_object' } }]
    })
    assertStatusAndError(res, 400, 'invalid_response_format')
  })
})
