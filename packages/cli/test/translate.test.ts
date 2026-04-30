import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  openaiMessagesToHistory,
  openaiToolsToSdk,
  sdkToolCallsToOpenai,
  sdkToolCallsToOpenaiDeltas,
  extractGenerationParams,
  logUnsupportedParams
} from '../src/serve/adapters/openai/translate.js'

describe('openaiMessagesToHistory', () => {
  it('converts simple user/assistant messages', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' }
    ]
    const history = openaiMessagesToHistory(messages)
    assert.deepEqual(history, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' }
    ])
  })

  it('handles null content gracefully', () => {
    const messages = [{ role: 'assistant', content: null }]
    const history = openaiMessagesToHistory(messages)
    assert.equal(history[0]!.content, '')
  })

  it('handles undefined content gracefully', () => {
    const messages = [{ role: 'assistant', content: undefined }]
    const history = openaiMessagesToHistory(messages)
    assert.equal(history[0]!.content, '')
  })

  it('synthesizes tool_call content for assistant messages', () => {
    const messages = [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' }
      }]
    }]
    const history = openaiMessagesToHistory(messages)
    assert.equal(history[0]!.role, 'assistant')
    assert.ok(history[0]!.content.includes('<tool_call>'))
    assert.ok(history[0]!.content.includes('get_weather'))
    assert.ok(history[0]!.content.includes('Tokyo'))
  })

  it('handles multiple tool calls in single message', () => {
    const messages = [{
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'fn_a', arguments: '{}' } },
        { id: 'call_2', type: 'function', function: { name: 'fn_b', arguments: '{"x":1}' } }
      ]
    }]
    const history = openaiMessagesToHistory(messages)
    const content = history[0]!.content
    assert.ok(content.includes('fn_a'))
    assert.ok(content.includes('fn_b'))
  })

  it('handles malformed tool call arguments JSON', () => {
    const messages = [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: { name: 'broken', arguments: '{not valid json}' }
      }]
    }]
    const history = openaiMessagesToHistory(messages)
    assert.ok(history[0]!.content.includes('broken'))
  })

  it('preserves tool_call_id messages as-is', () => {
    const messages = [{ role: 'tool', content: '{"result": 42}', tool_call_id: 'call_1' }]
    const history = openaiMessagesToHistory(messages)
    assert.deepEqual(history[0], { role: 'tool', content: '{"result": 42}' })
  })
})

describe('openaiToolsToSdk', () => {
  it('returns undefined for undefined input', () => {
    assert.equal(openaiToolsToSdk(undefined), undefined)
  })

  it('returns undefined for empty array', () => {
    assert.equal(openaiToolsToSdk([]), undefined)
  })

  it('converts a single function tool', () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather for a location',
        parameters: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] }
      }
    }]
    const result = openaiToolsToSdk(tools)
    assert.ok(result)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.type, 'function')
    assert.equal(result[0]!.name, 'get_weather')
    assert.equal(result[0]!.description, 'Get weather for a location')
    assert.deepEqual(result[0]!.parameters, tools[0]!.function!.parameters)
  })

  it('handles tools with no description or parameters', () => {
    const tools = [{ type: 'function', function: { name: 'noop' } }]
    const result = openaiToolsToSdk(tools)
    assert.ok(result)
    assert.equal(result[0]!.description, '')
    assert.deepEqual(result[0]!.parameters, { type: 'object', properties: {} })
  })

  it('filters out non-function tools', () => {
    const tools = [
      { type: 'retrieval' },
      { type: 'function', function: { name: 'valid_fn' } }
    ]
    const result = openaiToolsToSdk(tools as Parameters<typeof openaiToolsToSdk>[0])
    assert.ok(result)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.name, 'valid_fn')
  })

  it('converts multiple tools', () => {
    const tools = [
      { type: 'function', function: { name: 'fn_a', description: 'A' } },
      { type: 'function', function: { name: 'fn_b', description: 'B' } }
    ]
    const result = openaiToolsToSdk(tools)
    assert.ok(result)
    assert.equal(result.length, 2)
    assert.equal(result[0]!.name, 'fn_a')
    assert.equal(result[1]!.name, 'fn_b')
  })

  it('normalizes composite types like ["string", "null"] to "string"', () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: ['string', 'null'], description: 'File path' },
            glob: { type: ['string', 'null'], description: 'Glob pattern' }
          },
          required: ['path']
        }
      }
    }]
    const result = openaiToolsToSdk(tools)
    assert.ok(result)
    const props = result[0]!.parameters as { properties: Record<string, { type: string }> }
    assert.equal(props.properties['path']!.type, 'string')
    assert.equal(props.properties['glob']!.type, 'string')
  })

  it('normalizes ["integer", "null"] to "integer"', () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'fetch',
        description: 'Fetch data',
        parameters: {
          type: 'object',
          properties: {
            limit: { type: ['integer', 'null'] }
          }
        }
      }
    }]
    const result = openaiToolsToSdk(tools)
    assert.ok(result)
    const props = result[0]!.parameters as { properties: Record<string, { type: string }> }
    assert.equal(props.properties['limit']!.type, 'integer')
  })

  it('falls back to "string" for unrecognized types', () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'test',
        description: 'Test',
        parameters: {
          type: 'object',
          properties: {
            field: { type: 'unknown_type' }
          }
        }
      }
    }]
    const result = openaiToolsToSdk(tools)
    assert.ok(result)
    const props = result[0]!.parameters as { properties: Record<string, { type: string }> }
    assert.equal(props.properties['field']!.type, 'string')
  })

  it('preserves valid simple types unchanged', () => {
    const tools = [{
      type: 'function',
      function: {
        name: 'test',
        description: 'Test',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            count: { type: 'number' },
            enabled: { type: 'boolean' },
            items: { type: 'array' },
            config: { type: 'object' }
          }
        }
      }
    }]
    const result = openaiToolsToSdk(tools)
    assert.ok(result)
    const props = result[0]!.parameters as { properties: Record<string, { type: string }> }
    assert.equal(props.properties['name']!.type, 'string')
    assert.equal(props.properties['count']!.type, 'number')
    assert.equal(props.properties['enabled']!.type, 'boolean')
    assert.equal(props.properties['items']!.type, 'array')
    assert.equal(props.properties['config']!.type, 'object')
  })
})

describe('sdkToolCallsToOpenai', () => {
  it('returns undefined for null', () => {
    assert.equal(sdkToolCallsToOpenai(null), undefined)
  })

  it('returns undefined for empty array', () => {
    assert.equal(sdkToolCallsToOpenai([]), undefined)
  })

  it('converts tool calls with string arguments', () => {
    const calls = [{ id: 'call_1', name: 'fn_a', arguments: '{"x":1}' }]
    const result = sdkToolCallsToOpenai(calls)
    assert.ok(result)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.id, 'call_1')
    assert.equal(result[0]!.type, 'function')
    assert.equal(result[0]!.function.name, 'fn_a')
    assert.equal(result[0]!.function.arguments, '{"x":1}')
  })

  it('converts tool calls with object arguments to JSON string', () => {
    const calls = [{ id: 'call_2', name: 'fn_b', arguments: { key: 'value' } }]
    const result = sdkToolCallsToOpenai(calls)
    assert.ok(result)
    assert.equal(result[0]!.function.arguments, '{"key":"value"}')
  })
})

describe('sdkToolCallsToOpenaiDeltas', () => {
  it('returns undefined for null', () => {
    assert.equal(sdkToolCallsToOpenaiDeltas(null), undefined)
  })

  it('includes index in delta output', () => {
    const calls = [
      { id: 'c1', name: 'fn_a', arguments: '{}' },
      { id: 'c2', name: 'fn_b', arguments: '{}' }
    ]
    const result = sdkToolCallsToOpenaiDeltas(calls)
    assert.ok(result)
    assert.equal(result[0]!.index, 0)
    assert.equal(result[1]!.index, 1)
  })
})

describe('extractGenerationParams', () => {
  it('returns undefined for empty body', () => {
    assert.equal(extractGenerationParams({}), undefined)
  })

  it('extracts temperature', () => {
    const params = extractGenerationParams({ temperature: 0.7 })
    assert.ok(params)
    assert.equal(params.temp, 0.7)
  })

  it('extracts top_p', () => {
    const params = extractGenerationParams({ top_p: 0.9 })
    assert.ok(params)
    assert.equal(params.top_p, 0.9)
  })

  it('extracts seed', () => {
    const params = extractGenerationParams({ seed: 42 })
    assert.ok(params)
    assert.equal(params.seed, 42)
  })

  it('extracts frequency_penalty and presence_penalty', () => {
    const params = extractGenerationParams({ frequency_penalty: 0.5, presence_penalty: 0.3 })
    assert.ok(params)
    assert.equal(params.frequency_penalty, 0.5)
    assert.equal(params.presence_penalty, 0.3)
  })

  it('maps max_tokens to predict', () => {
    const params = extractGenerationParams({ max_tokens: 100 })
    assert.ok(params)
    assert.equal(params.predict, 100)
  })

  it('maps max_completion_tokens to predict (takes precedence)', () => {
    const params = extractGenerationParams({ max_tokens: 50, max_completion_tokens: 200 })
    assert.ok(params)
    assert.equal(params.predict, 200)
  })

  it('extracts all params together', () => {
    const params = extractGenerationParams({
      temperature: 0.0,
      top_p: 0.95,
      seed: 123,
      max_tokens: 256,
      frequency_penalty: 0.2,
      presence_penalty: 0.1
    })
    assert.ok(params)
    assert.equal(params.temp, 0.0)
    assert.equal(params.top_p, 0.95)
    assert.equal(params.seed, 123)
    assert.equal(params.predict, 256)
    assert.equal(params.frequency_penalty, 0.2)
    assert.equal(params.presence_penalty, 0.1)
  })

  it('ignores non-number values', () => {
    const params = extractGenerationParams({ temperature: 'hot', max_tokens: '100' })
    assert.equal(params, undefined)
  })

  it('ignores unrelated params', () => {
    const params = extractGenerationParams({ model: 'test', messages: [], stream: true })
    assert.equal(params, undefined)
  })
})

describe('logUnsupportedParams', () => {
  it('does not throw on empty body', () => {
    const warnings: string[] = []
    const logger = { warn: (msg: string) => warnings.push(msg) } as Parameters<typeof logUnsupportedParams>[1]
    logUnsupportedParams({}, logger)
    assert.equal(warnings.length, 0)
  })

  it('logs warnings for unsupported params', () => {
    const warnings: string[] = []
    const logger = { warn: (msg: string) => warnings.push(msg) } as Parameters<typeof logUnsupportedParams>[1]
    logUnsupportedParams({ n: 2, logprobs: true, response_format: { type: 'json' } }, logger)
    assert.equal(warnings.length, 3)
    assert.ok(warnings.some(w => w.includes('n=')))
    assert.ok(warnings.some(w => w.includes('logprobs=')))
    assert.ok(warnings.some(w => w.includes('response_format=')))
  })
})
