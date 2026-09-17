import { describe, it } from 'node:test'
import { createServer } from '../helpers/server.js'
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
