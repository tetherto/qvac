import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  openaiMessagesToHistory,
  openaiToolsToSdk,
  sdkToolCallsToOpenai,
  sdkToolCallsToOpenaiDeltas,
  extractGenerationParams,
  extractResponseFormat,
  InvalidResponseFormatError,
  logUnsupportedParams,
  vectorStoreToOpenAI,
  searchResultsToOpenAI,
  parseExpiresAfter,
  parseMetadata,
  InvalidExpiresAfterError,
  InvalidMetadataError
} from '../src/serve/adapters/openai/translate.js'
import type { VectorStoreMeta } from '../src/serve/adapters/openai/vector-stores-store.js'

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

  it('extracts reasoning_budget true', () => {
    const params = extractGenerationParams({ reasoning_budget: true })
    assert.ok(params)
    assert.equal(params.reasoning_budget, true)
  })

  it('extracts reasoning_budget false', () => {
    const params = extractGenerationParams({ reasoning_budget: false })
    assert.ok(params)
    assert.equal(params.reasoning_budget, false)
  })

  it('ignores non-boolean reasoning_budget', () => {
    const params = extractGenerationParams({ reasoning_budget: -1 })
    assert.equal(params, undefined)
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
    logUnsupportedParams({ n: 2, logprobs: true, stop: ['END'] }, logger)
    assert.equal(warnings.length, 3)
    assert.ok(warnings.some(w => w.includes('n=')))
    assert.ok(warnings.some(w => w.includes('logprobs=')))
    assert.ok(warnings.some(w => w.includes('stop=')))
  })

  it('does not warn on response_format (now supported)', () => {
    const warnings: string[] = []
    const logger = { warn: (msg: string) => warnings.push(msg) } as Parameters<typeof logUnsupportedParams>[1]
    logUnsupportedParams({ response_format: { type: 'json_object' } }, logger)
    assert.equal(warnings.length, 0)
  })
})

describe('extractResponseFormat', () => {
  it('returns undefined when response_format is absent', () => {
    assert.equal(extractResponseFormat({}), undefined)
  })

  it('returns undefined when response_format is null', () => {
    assert.equal(extractResponseFormat({ response_format: null }), undefined)
  })

  it('parses { type: "text" }', () => {
    const result = extractResponseFormat({ response_format: { type: 'text' } })
    assert.deepEqual(result, { type: 'text' })
  })

  it('parses { type: "json_object" }', () => {
    const result = extractResponseFormat({ response_format: { type: 'json_object' } })
    assert.deepEqual(result, { type: 'json_object' })
  })

  it('parses a json_schema with required fields', () => {
    const result = extractResponseFormat({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'Person',
          schema: { type: 'object', properties: { name: { type: 'string' } } }
        }
      }
    })
    assert.deepEqual(result, {
      type: 'json_schema',
      json_schema: {
        name: 'Person',
        schema: { type: 'object', properties: { name: { type: 'string' } } }
      }
    })
  })

  it('forwards optional description and strict on json_schema', () => {
    const result = extractResponseFormat({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'P',
          description: 'a person',
          strict: true,
          schema: { type: 'object' }
        }
      }
    })
    assert.ok(result && result.type === 'json_schema')
    assert.equal(result.json_schema.description, 'a person')
    assert.equal(result.json_schema.strict, true)
  })

  it('throws on a non-object response_format', () => {
    assert.throws(
      () => extractResponseFormat({ response_format: 'json' }),
      InvalidResponseFormatError
    )
  })

  it('throws on an unknown type', () => {
    assert.throws(
      () => extractResponseFormat({ response_format: { type: 'yaml' } }),
      InvalidResponseFormatError
    )
  })

  it('throws when json_schema is missing', () => {
    assert.throws(
      () => extractResponseFormat({ response_format: { type: 'json_schema' } }),
      InvalidResponseFormatError
    )
  })

  it('throws when json_schema.name is missing or empty', () => {
    assert.throws(
      () => extractResponseFormat({
        response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } }
      }),
      InvalidResponseFormatError
    )
    assert.throws(
      () => extractResponseFormat({
        response_format: { type: 'json_schema', json_schema: { name: '', schema: { type: 'object' } } }
      }),
      InvalidResponseFormatError
    )
  })

  it('throws when json_schema.schema is missing or not an object', () => {
    assert.throws(
      () => extractResponseFormat({
        response_format: { type: 'json_schema', json_schema: { name: 'P' } }
      }),
      InvalidResponseFormatError
    )
    assert.throws(
      () => extractResponseFormat({
        response_format: { type: 'json_schema', json_schema: { name: 'P', schema: 'oops' } }
      }),
      InvalidResponseFormatError
    )
  })
})

function fixtureMeta (overrides: Partial<VectorStoreMeta> = {}): VectorStoreMeta {
  return {
    id: 'vs_abc123',
    createdAt: 1_700_000_000_000,
    name: 'docs',
    metadata: { topic: 'rag' },
    expiresAfter: null,
    expiresAt: null,
    lastActiveAt: 1_700_000_000_000,
    ...overrides
  }
}

describe('vectorStoreToOpenAI', () => {
  it('produces the OpenAI vector_store shape with second-precision timestamps', () => {
    const out = vectorStoreToOpenAI(fixtureMeta())
    assert.equal(out.object, 'vector_store')
    assert.equal(out.id, 'vs_abc123')
    assert.equal(out.created_at, 1_700_000_000)
    assert.equal(out.name, 'docs')
    assert.equal(out.usage_bytes, 0)
    assert.deepEqual(out.file_counts, {
      in_progress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: 0
    })
    assert.equal(out.last_active_at, 1_700_000_000)
    assert.deepEqual(out.metadata, { topic: 'rag' })
  })

  it('reports status="in_progress" when no underlying RAG workspace exists', () => {
    const out = vectorStoreToOpenAI(fixtureMeta())
    assert.equal(out.status, 'in_progress')
  })

  it('reports status="completed" once a workspace exists', () => {
    const out = vectorStoreToOpenAI(fixtureMeta(), { exists: true, open: true })
    assert.equal(out.status, 'completed')
  })

  it('preserves expires_after and converts expires_at to seconds', () => {
    const out = vectorStoreToOpenAI(fixtureMeta({
      expiresAfter: { anchor: 'last_active_at', days: 7 },
      expiresAt: 1_700_604_800_000
    }))
    assert.deepEqual(out.expires_after, { anchor: 'last_active_at', days: 7 })
    assert.equal(out.expires_at, 1_700_604_800)
  })

  it('keeps null name (no synthetic fallback)', () => {
    const out = vectorStoreToOpenAI(fixtureMeta({ name: null }))
    assert.equal(out.name, null)
  })

  it('clones metadata so mutations on the response do not leak', () => {
    const meta = fixtureMeta()
    const out = vectorStoreToOpenAI(meta)
    out.metadata['topic'] = 'mutated'
    assert.equal(meta.metadata['topic'], 'rag')
  })
})

describe('searchResultsToOpenAI', () => {
  it('returns an empty page on no results', () => {
    const page = searchResultsToOpenAI([], 'find me')
    assert.equal(page.object, 'vector_store.search_results.page')
    assert.equal(page.search_query, 'find me')
    assert.deepEqual(page.data, [])
    assert.equal(page.has_more, false)
    assert.equal(page.next_page, null)
  })

  it('maps RAG results to OpenAI search items preserving score', () => {
    const page = searchResultsToOpenAI(
      [
        { id: 'doc-1', content: 'first chunk text', score: 0.92 },
        { id: 'doc-2', content: 'second chunk text', score: 0.81 }
      ],
      'embedding query'
    )
    assert.equal(page.data.length, 2)
    const first = page.data[0]
    assert.ok(first)
    assert.equal(first.file_id, 'doc-1')
    assert.equal(first.filename, 'doc-1')
    assert.equal(first.score, 0.92)
    assert.deepEqual(first.attributes, {})
    assert.deepEqual(first.content, [{ type: 'text', text: 'first chunk text' }])
  })

  it('uses the attribution lookup for file_id and filename when available', () => {
    const page = searchResultsToOpenAI(
      [
        { id: 'chunk-1', content: 'first chunk', score: 0.9 },
        { id: 'chunk-2', content: 'second chunk', score: 0.8 }
      ],
      'query',
      (chunkId) => {
        if (chunkId === 'chunk-1') return { fileId: 'file-abc', fileName: 'notes.txt' }
        return null
      }
    )
    const first = page.data[0]
    const second = page.data[1]
    assert.ok(first)
    assert.ok(second)
    // Attributed hit reports the original upload's identity.
    assert.equal(first.file_id, 'file-abc')
    assert.equal(first.filename, 'notes.txt')
    // Unattributed hit falls back to the chunk id (today's behavior).
    assert.equal(second.file_id, 'chunk-2')
    assert.equal(second.filename, 'chunk-2')
  })
})

describe('parseExpiresAfter', () => {
  it('returns undefined when missing, null when explicit null', () => {
    assert.equal(parseExpiresAfter(undefined), undefined)
    assert.equal(parseExpiresAfter(null), null)
  })

  it('parses a valid expires_after object', () => {
    assert.deepEqual(
      parseExpiresAfter({ anchor: 'last_active_at', days: 30 }),
      { anchor: 'last_active_at', days: 30 }
    )
  })

  it('throws on a wrong anchor or non-integer days', () => {
    assert.throws(() => parseExpiresAfter({ anchor: 'created_at', days: 7 }), InvalidExpiresAfterError)
    assert.throws(() => parseExpiresAfter({ anchor: 'last_active_at', days: 0 }), InvalidExpiresAfterError)
    assert.throws(() => parseExpiresAfter({ anchor: 'last_active_at', days: 1.5 }), InvalidExpiresAfterError)
  })

  it('throws on non-object inputs', () => {
    assert.throws(() => parseExpiresAfter('soon'), InvalidExpiresAfterError)
    assert.throws(() => parseExpiresAfter(['anchor', 'last_active_at']), InvalidExpiresAfterError)
  })
})

describe('parseMetadata', () => {
  it('round-trips a small string-valued object', () => {
    assert.deepEqual(parseMetadata({ a: '1', b: 'two' }), { a: '1', b: 'two' })
  })

  it('returns undefined when missing, null when explicit null', () => {
    assert.equal(parseMetadata(undefined), undefined)
    assert.equal(parseMetadata(null), null)
  })

  it('rejects non-string values', () => {
    assert.throws(() => parseMetadata({ count: 5 }), InvalidMetadataError)
  })

  it('rejects more than 16 keys', () => {
    const big: Record<string, string> = {}
    for (let i = 0; i < 17; i++) big[`k${i}`] = 'v'
    assert.throws(() => parseMetadata(big), InvalidMetadataError)
  })

  it('rejects oversized keys or values', () => {
    assert.throws(() => parseMetadata({ ['x'.repeat(65)]: 'v' }), InvalidMetadataError)
    assert.throws(() => parseMetadata({ k: 'v'.repeat(513) }), InvalidMetadataError)
  })
})
