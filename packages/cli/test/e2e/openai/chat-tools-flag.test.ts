import { describe, it } from 'node:test'
import { createServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } }
    }
  }
]

const CONFIG = {
  serve: {
    models: {
      'test-llm': { model: 'QWEN3_600M_INST_Q4', preload: false, config: { ctx_size: 2048 } }
    }
  }
}

describe('serve: tools load flag', () => {
  it('chat: tools request without config.tools returns 400 tools_not_enabled', async (t) => {
    const app = await createServer(t, {
      config: CONFIG,
      loadModelOverride: async () => 'mock-model-id'
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: JSON_HEADERS,
      payload: {
        model: 'test-llm',
        messages: [{ role: 'user', content: 'What is the weather in Lagos?' }],
        tools: TOOLS
      }
    })
    assertStatusAndError(res, 400, 'tools_not_enabled')
  })

  it('responses: tools request without config.tools returns 400 tools_not_enabled', async (t) => {
    const app = await createServer(t, {
      config: CONFIG,
      loadModelOverride: async () => 'mock-model-id'
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/responses',
      headers: JSON_HEADERS,
      payload: {
        model: 'test-llm',
        input: 'What is the weather in Lagos?',
        tools: TOOLS
      }
    })
    assertStatusAndError(res, 400, 'tools_not_enabled')
  })
})
