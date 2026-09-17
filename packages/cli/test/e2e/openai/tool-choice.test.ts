import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CompletionRun, ToolCall, ToolCallError } from '@qvac/sdk'
import { createServer } from '../helpers/server.js'
import { openaiState } from '@/serve/extensions/openai/state'
import { JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'

const CHAT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } }
    }
  }
]

const RESPONSES_TOOLS = [
  {
    type: 'function',
    name: 'get_weather',
    description: 'Get weather',
    parameters: { type: 'object', properties: { city: { type: 'string' } } }
  }
]

// tools is on, so a rejection here is the tool_choice check and never the
// load-flag gate that `tools-flag.test.ts` covers.
const CONFIG = {
  serve: {
    models: {
      'test-llm': {
        model: 'QWEN3_600M_INST_Q4',
        preload: false,
        config: { ctx_size: 2048, tools: true }
      }
    }
  }
}

function server(t: Parameters<typeof createServer>[0]) {
  return createServer(t, {
    config: CONFIG,
    loadModelOverride: () => Promise.resolve('mock-model-id')
  })
}

describe('serve: tool_choice rejections', () => {
  it(
    'chat: a demanding tool_choice with no tools returns 400 invalid_tool_choice',
    { timeout: 15000 },
    async (t) => {
      const app = await server(t)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: JSON_HEADERS,
        payload: {
          model: 'test-llm',
          messages: [{ role: 'user', content: 'What is the weather in Lagos?' }],
          tool_choice: 'required'
        }
      })
      assertStatusAndError(res, 400, 'invalid_tool_choice')
    }
  )

  it(
    'chat: a tool_choice naming an undeclared tool returns 400 invalid_tool_choice',
    { timeout: 15000 },
    async (t) => {
      const app = await server(t)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: JSON_HEADERS,
        payload: {
          model: 'test-llm',
          messages: [{ role: 'user', content: 'What is the weather in Lagos?' }],
          tools: CHAT_TOOLS,
          tool_choice: { type: 'function', function: { name: 'get_stock' } }
        }
      })
      assertStatusAndError(res, 400, 'invalid_tool_choice')
    }
  )

  // A bare name is not OpenAI's way to force a tool even when it matches a
  // declared one -- the object form is.
  it(
    'chat: a bare tool name in place of the object form returns 400 invalid_tool_choice',
    { timeout: 15000 },
    async (t) => {
      const app = await server(t)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: JSON_HEADERS,
        payload: {
          model: 'test-llm',
          messages: [{ role: 'user', content: 'What is the weather in Lagos?' }],
          tools: CHAT_TOOLS,
          tool_choice: 'get_weather'
        }
      })
      assertStatusAndError(res, 400, 'invalid_tool_choice')
    }
  )

  it(
    'responses: a demanding tool_choice with no tools returns 400 invalid_tool_choice',
    { timeout: 15000 },
    async (t) => {
      const app = await server(t)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: JSON_HEADERS,
        payload: {
          model: 'test-llm',
          input: 'What is the weather in Lagos?',
          tool_choice: 'required'
        }
      })
      assertStatusAndError(res, 400, 'invalid_tool_choice')
    }
  )

  it(
    'responses: an undeclared name in the flattened form returns 400 invalid_tool_choice',
    { timeout: 15000 },
    async (t) => {
      const app = await server(t)
      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: JSON_HEADERS,
        payload: {
          model: 'test-llm',
          input: 'What is the weather in Lagos?',
          tools: RESPONSES_TOOLS,
          tool_choice: { type: 'function', name: 'get_stock' }
        }
      })
      assertStatusAndError(res, 400, 'invalid_tool_choice')
    }
  )
})

// Hands back a finished run so the assertions are about what serve passed the
// SDK and what it made of the answer -- no model is loaded.
function stubRun(opts: { text?: string; toolCalls?: ToolCall[]; toolErrors?: ToolCallError[] }) {
  async function* events(): AsyncGenerator<unknown> {
    let seq = 0
    if (opts.text !== undefined) yield { type: 'contentDelta', seq: seq++, text: opts.text }
    for (const call of opts.toolCalls ?? []) yield { type: 'toolCall', seq: seq++, call }
    for (const error of opts.toolErrors ?? []) yield { type: 'toolError', seq: seq++, error }
    yield { type: 'completionStats', seq: seq++, stats: { emittedTokens: 3 } }
    yield { type: 'completionDone', seq: seq++, stopReason: 'eos' }
  }
  return {
    requestId: 'tool-choice-request',
    events: events(),
    final: Promise.resolve(undefined),
    text: Promise.resolve(opts.text ?? ''),
    toolCalls: Promise.resolve(opts.toolCalls ?? []),
    stats: Promise.resolve(undefined),
    tokenStream: (async function* () {})(),
    toolCallStream: (async function* () {})()
  } as unknown as CompletionRun
}

// `completion()` is overloaded, so the override's inferred parameter is the
// narrowest form. These are the fields the assertions read.
interface SeenRequest {
  tools?: { name: string }[]
  generationParams?: { tool_choice?: string }
}

const WEATHER_CALL: ToolCall = {
  id: 'call_1',
  name: 'get_weather',
  arguments: { city: 'Lagos' }
}

describe('serve: tool_choice success path', () => {
  it(
    'chat: required reaches the SDK and the tool call comes back on the wire',
    { timeout: 15000 },
    async (t) => {
      const app = await server(t)
      await app.ready()
      const seen: SeenRequest[] = []
      openaiState(app.qvac).completionOverride = (params) => {
        seen.push(params as SeenRequest)
        return stubRun({ toolCalls: [WEATHER_CALL] })
      }

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: JSON_HEADERS,
        payload: {
          model: 'test-llm',
          messages: [{ role: 'user', content: 'What is the weather in Lagos?' }],
          tools: CHAT_TOOLS,
          tool_choice: 'required'
        }
      })

      assert.equal(res.statusCode, 200, res.payload)
      assert.equal(seen[0]?.generationParams?.tool_choice, 'required')
      assert.equal(seen[0]?.tools?.length, 1)

      const body = res.json()
      assert.equal(body.choices[0].finish_reason, 'tool_calls')
      assert.equal(body.choices[0].message.tool_calls[0].function.name, 'get_weather')
    }
  )

  it(
    'chat: the object form arrives at the SDK as the bare tool name',
    { timeout: 15000 },
    async (t) => {
      const app = await server(t)
      await app.ready()
      const seen: SeenRequest[] = []
      openaiState(app.qvac).completionOverride = (params) => {
        seen.push(params as SeenRequest)
        return stubRun({ toolCalls: [WEATHER_CALL] })
      }

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: JSON_HEADERS,
        payload: {
          model: 'test-llm',
          messages: [{ role: 'user', content: 'What is the weather in Lagos?' }],
          tools: CHAT_TOOLS,
          tool_choice: { type: 'function', function: { name: 'get_weather' } }
        }
      })

      assert.equal(res.statusCode, 200, res.payload)
      assert.equal(seen[0]?.generationParams?.tool_choice, 'get_weather')
    }
  )

  it('chat: none reaches the SDK with no tools declared', { timeout: 15000 }, async (t) => {
    const app = await server(t)
    await app.ready()
    const seen: SeenRequest[] = []
    openaiState(app.qvac).completionOverride = (params) => {
      seen.push(params as SeenRequest)
      return stubRun({ text: 'It is warm.' })
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: JSON_HEADERS,
      payload: {
        model: 'test-llm',
        messages: [{ role: 'user', content: 'What is the weather in Lagos?' }],
        tool_choice: 'none'
      }
    })

    assert.equal(res.statusCode, 200, res.payload)
    assert.equal(seen[0]?.generationParams?.tool_choice, 'none')
    assert.equal(res.json().choices[0].finish_reason, 'stop')
  })

  it('chat: omitting tool_choice leaves it off the SDK request', { timeout: 15000 }, async (t) => {
    const app = await server(t)
    await app.ready()
    const seen: SeenRequest[] = []
    openaiState(app.qvac).completionOverride = (params) => {
      seen.push(params as SeenRequest)
      return stubRun({ text: 'It is warm.' })
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: JSON_HEADERS,
      payload: {
        model: 'test-llm',
        messages: [{ role: 'user', content: 'What is the weather in Lagos?' }],
        tools: CHAT_TOOLS
      }
    })

    assert.equal(res.statusCode, 200, res.payload)
    assert.equal(seen[0]?.generationParams?.tool_choice, undefined)
  })

  // The documented shape for a forced call the addon could not parse: still a
  // 200, no tool_calls, and finish_reason 'stop'.
  it(
    'chat: a run of only tool errors answers 200 with no tool calls',
    { timeout: 15000 },
    async (t) => {
      const app = await server(t)
      await app.ready()
      openaiState(app.qvac).completionOverride = () =>
        stubRun({
          toolErrors: [{ code: 'PARSE_ERROR', message: 'bad json', raw: '{' }]
        })

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: JSON_HEADERS,
        payload: {
          model: 'test-llm',
          messages: [{ role: 'user', content: 'What is the weather in Lagos?' }],
          tools: CHAT_TOOLS,
          tool_choice: 'required'
        }
      })

      assert.equal(res.statusCode, 200, res.payload)
      const choice = res.json().choices[0]
      assert.equal(choice.finish_reason, 'stop')
      assert.equal(choice.message.tool_calls, undefined)
    }
  )

  it(
    'responses: the flattened object form arrives as the bare tool name',
    { timeout: 15000 },
    async (t) => {
      const app = await server(t)
      await app.ready()
      const seen: SeenRequest[] = []
      openaiState(app.qvac).completionOverride = (params) => {
        seen.push(params as SeenRequest)
        return stubRun({ toolCalls: [WEATHER_CALL] })
      }

      const res = await app.inject({
        method: 'POST',
        url: '/v1/responses',
        headers: JSON_HEADERS,
        payload: {
          model: 'test-llm',
          input: 'What is the weather in Lagos?',
          tools: RESPONSES_TOOLS,
          tool_choice: { type: 'function', name: 'get_weather' }
        }
      })

      assert.equal(res.statusCode, 200, res.payload)
      assert.equal(seen[0]?.generationParams?.tool_choice, 'get_weather')
    }
  )
})
