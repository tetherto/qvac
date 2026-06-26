import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import {
  openaiToolsToSdk,
  extractResponseFormat,
  InvalidResponseFormatError,
  UnsupportedImageContentError,
  extractGenerationParams
} from '../src/serve/schemas/common.js'
import { openaiMessagesToHistory, writeChatImages } from '../src/serve/schemas/chat.js'
import {
  parseExpiresAfter,
  parseMetadata,
  InvalidExpiresAfterError,
  InvalidMetadataError
} from '../src/serve/schemas/vector-stores.js'
import {
  vectorStoreToOpenAI,
  searchResultsToOpenAI
} from '../src/serve/adapters/openai/vector-stores-store.js'
import {
  sdkToolCallsToOpenai,
  sdkToolCallsToOpenaiDeltas
} from '../src/serve/adapters/openai/tool-calls.js'
import {
  openaiResponsesInputToHistory,
  openaiResponsesToolsToSdk,
  extractResponsesResponseFormat,
  validateResponsesStatefulOptions,
  normalizeResponsesInputItemsForStorage,
  historyPrefixFromStoredResponse,
  UnsupportedToolTypeError,
  InvalidResponsesConversationError,
  InvalidResponsesBackgroundError
} from '../src/serve/schemas/responses.js'
import {
  parseLegacyPrompt,
  legacyPromptToHistory,
  InvalidPromptError
} from '../src/serve/schemas/completions.js'
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
    const messages = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"Tokyo"}' }
          }
        ]
      }
    ]
    const history = openaiMessagesToHistory(messages)
    assert.equal(history[0]!.role, 'assistant')
    assert.ok(history[0]!.content.includes('<tool_call>'))
    assert.ok(history[0]!.content.includes('get_weather'))
    assert.ok(history[0]!.content.includes('Tokyo'))
  })

  it('handles multiple tool calls in single message', () => {
    const messages = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'fn_a', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'fn_b', arguments: '{"x":1}' } }
        ]
      }
    ]
    const history = openaiMessagesToHistory(messages)
    const content = history[0]!.content
    assert.ok(content.includes('fn_a'))
    assert.ok(content.includes('fn_b'))
  })

  it('handles malformed tool call arguments JSON', () => {
    const messages = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'broken', arguments: '{not valid json}' }
          }
        ]
      }
    ]
    const history = openaiMessagesToHistory(messages)
    assert.ok(history[0]!.content.includes('broken'))
  })

  it('preserves tool_call_id messages as-is', () => {
    const messages = [{ role: 'tool', content: '{"result": 42}', tool_call_id: 'call_1' }]
    const history = openaiMessagesToHistory(messages)
    assert.deepEqual(history[0], { role: 'tool', content: '{"result": 42}' })
  })

  it('concatenates text content parts into a string', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' }
        ]
      }
    ]
    const history = openaiMessagesToHistory(messages)
    assert.deepEqual(history[0], { role: 'user', content: 'hello world' })
  })

  it('decodes an image_url data URL into image bytes', () => {
    // 1x1 transparent PNG.
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ]
    const history = openaiMessagesToHistory(messages)
    assert.equal(history[0]!.role, 'user')
    assert.equal(history[0]!.content, 'what is this?')
    assert.equal(history[0]!.attachments!.length, 1)
    assert.equal(history[0]!.attachments![0]!.ext, 'png')
    assert.ok(Buffer.isBuffer(history[0]!.attachments![0]!.bytes))
  })

  it('accepts a string (data URL) image_url', () => {
    const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
    const messages = [{ role: 'user', content: [{ type: 'image_url', image_url: dataUrl }] }]
    const history = openaiMessagesToHistory(messages)
    assert.equal(history[0]!.attachments!.length, 1)
    assert.equal(history[0]!.attachments![0]!.ext, 'jpg')
  })

  // Reviewer ask: an image the server cannot materialize must fail loudly (→ 400) instead of
  // silently dropping to a text-only completion the user never asked for.
  it('throws on a remote (non-data) image_url', () => {
    const messages = [
      { role: 'user', content: [{ type: 'image_url', image_url: 'https://example.com/x.png' }] }
    ]
    assert.throws(() => openaiMessagesToHistory(messages), UnsupportedImageContentError)
  })

  it('throws on an unsupported image format (e.g. webp)', () => {
    const webp = 'data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA='
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image_url', image_url: { url: webp } }
        ]
      }
    ]
    assert.throws(() => openaiMessagesToHistory(messages), UnsupportedImageContentError)
  })

  it('throws on a payload that is not valid base64 image data', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,not*real*base64*data' } }
        ]
      }
    ]
    assert.throws(() => openaiMessagesToHistory(messages), UnsupportedImageContentError)
  })

  it('writeChatImages materializes attachment bytes to flat temp files', async () => {
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const messages = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }
    ]
    const { history, tmpPaths } = await writeChatImages(openaiMessagesToHistory(messages))
    assert.equal(tmpPaths.length, 1)
    assert.ok(tmpPaths[0]!.endsWith('.png'))
    assert.ok(existsSync(tmpPaths[0]!))
    assert.equal(history[0]!.attachments![0]!.path, tmpPaths[0])
    await unlink(tmpPaths[0]!)
    assert.ok(!existsSync(tmpPaths[0]!))
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
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a location',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location']
          }
        }
      }
    ]
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
    const tools = [{ type: 'retrieval' }, { type: 'function', function: { name: 'valid_fn' } }]
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
    const tools = [
      {
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
      }
    ]
    const result = openaiToolsToSdk(tools)
    assert.ok(result)
    const props = result[0]!.parameters as { properties: Record<string, { type: string }> }
    assert.equal(props.properties['path']!.type, 'string')
    assert.equal(props.properties['glob']!.type, 'string')
  })

  it('normalizes ["integer", "null"] to "integer"', () => {
    const tools = [
      {
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
      }
    ]
    const result = openaiToolsToSdk(tools)
    assert.ok(result)
    const props = result[0]!.parameters as { properties: Record<string, { type: string }> }
    assert.equal(props.properties['limit']!.type, 'integer')
  })

  it('falls back to "string" for unrecognized types', () => {
    const tools = [
      {
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
      }
    ]
    const result = openaiToolsToSdk(tools)
    assert.ok(result)
    const props = result[0]!.parameters as { properties: Record<string, { type: string }> }
    assert.equal(props.properties['field']!.type, 'string')
  })

  it('preserves valid simple types unchanged', () => {
    const tools = [
      {
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
      }
    ]
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

  it('converts tool calls with object arguments to JSON string', () => {
    const calls = [{ id: 'call_1', name: 'fn_a', arguments: { x: 1 } }]
    const result = sdkToolCallsToOpenai(calls)
    assert.ok(result)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.id, 'call_1')
    assert.equal(result[0]!.type, 'function')
    assert.equal(result[0]!.function.name, 'fn_a')
    assert.equal(result[0]!.function.arguments, '{"x":1}')
  })

  it('serializes nested object arguments', () => {
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
      { id: 'c1', name: 'fn_a', arguments: {} },
      { id: 'c2', name: 'fn_b', arguments: {} }
    ]
    const result = sdkToolCallsToOpenaiDeltas(calls)
    assert.ok(result)
    assert.equal(result[0]!.index, 0)
    assert.equal(result[1]!.index, 1)
  })
})

// Chat semantics: `max_completion_tokens` overrides `max_tokens`.
const extractChat = (body: Record<string, unknown>) =>
  extractGenerationParams(body, 'max_completion_tokens')

describe('extractGenerationParams (chat semantics)', () => {
  it('returns undefined for empty body', () => {
    assert.equal(extractChat({}), undefined)
  })

  it('extracts temperature', () => {
    const params = extractChat({ temperature: 0.7 })
    assert.ok(params)
    assert.equal(params.temp, 0.7)
  })

  it('extracts top_p', () => {
    const params = extractChat({ top_p: 0.9 })
    assert.ok(params)
    assert.equal(params.top_p, 0.9)
  })

  it('extracts seed', () => {
    const params = extractChat({ seed: 42 })
    assert.ok(params)
    assert.equal(params.seed, 42)
  })

  it('extracts frequency_penalty and presence_penalty', () => {
    const params = extractChat({ frequency_penalty: 0.5, presence_penalty: 0.3 })
    assert.ok(params)
    assert.equal(params.frequency_penalty, 0.5)
    assert.equal(params.presence_penalty, 0.3)
  })

  it('maps max_tokens to predict', () => {
    const params = extractChat({ max_tokens: 100 })
    assert.ok(params)
    assert.equal(params.predict, 100)
  })

  it('maps max_completion_tokens to predict (takes precedence)', () => {
    const params = extractChat({ max_tokens: 50, max_completion_tokens: 200 })
    assert.ok(params)
    assert.equal(params.predict, 200)
  })

  it('extracts all params together', () => {
    const params = extractChat({
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

  it('extracts reasoning_budget true → SDK-native -1', () => {
    const params = extractChat({ reasoning_budget: true })
    assert.ok(params)
    assert.equal(params.reasoning_budget, -1)
  })

  it('extracts reasoning_budget false → SDK-native 0', () => {
    const params = extractChat({ reasoning_budget: false })
    assert.ok(params)
    assert.equal(params.reasoning_budget, 0)
  })

  it('extracts SDK-native numeric reasoning_budget', () => {
    assert.equal(extractChat({ reasoning_budget: -1 })!.reasoning_budget, -1)
    assert.equal(extractChat({ reasoning_budget: 0 })!.reasoning_budget, 0)
  })

  it('ignores unsupported numeric reasoning_budget values', () => {
    const params = extractChat({ reasoning_budget: 1 })
    assert.equal(params, undefined)
  })

  it('extracts remove_thinking_from_context true', () => {
    const params = extractChat({ remove_thinking_from_context: true })
    assert.ok(params)
    assert.equal(params.remove_thinking_from_context, true)
  })

  it('extracts remove_thinking_from_context false', () => {
    const params = extractChat({ remove_thinking_from_context: false })
    assert.ok(params)
    assert.equal(params.remove_thinking_from_context, false)
  })

  it('ignores non-boolean remove_thinking_from_context', () => {
    const params = extractChat({ remove_thinking_from_context: 1 })
    assert.equal(params, undefined)
  })

  it('ignores non-number values', () => {
    const params = extractChat({ temperature: 'hot', max_tokens: '100' })
    assert.equal(params, undefined)
  })

  it('ignores unrelated params', () => {
    const params = extractGenerationParams({ model: 'test', messages: [], stream: true })
    assert.equal(params, undefined)
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
      () =>
        extractResponseFormat({
          response_format: { type: 'json_schema', json_schema: { schema: { type: 'object' } } }
        }),
      InvalidResponseFormatError
    )
    assert.throws(
      () =>
        extractResponseFormat({
          response_format: {
            type: 'json_schema',
            json_schema: { name: '', schema: { type: 'object' } }
          }
        }),
      InvalidResponseFormatError
    )
  })

  it('throws when json_schema.schema is missing or not an object', () => {
    assert.throws(
      () =>
        extractResponseFormat({
          response_format: { type: 'json_schema', json_schema: { name: 'P' } }
        }),
      InvalidResponseFormatError
    )
    assert.throws(
      () =>
        extractResponseFormat({
          response_format: { type: 'json_schema', json_schema: { name: 'P', schema: 'oops' } }
        }),
      InvalidResponseFormatError
    )
  })
})

function fixtureMeta(overrides: Partial<VectorStoreMeta> = {}): VectorStoreMeta {
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
    const out = vectorStoreToOpenAI(
      fixtureMeta({
        expiresAfter: { anchor: 'last_active_at', days: 7 },
        expiresAt: 1_700_604_800_000
      })
    )
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
    assert.deepEqual(parseExpiresAfter({ anchor: 'last_active_at', days: 30 }), {
      anchor: 'last_active_at',
      days: 30
    })
  })

  it('throws on a wrong anchor or non-integer days', () => {
    assert.throws(
      () => parseExpiresAfter({ anchor: 'created_at', days: 7 }),
      InvalidExpiresAfterError
    )
    assert.throws(
      () => parseExpiresAfter({ anchor: 'last_active_at', days: 0 }),
      InvalidExpiresAfterError
    )
    assert.throws(
      () => parseExpiresAfter({ anchor: 'last_active_at', days: 1.5 }),
      InvalidExpiresAfterError
    )
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

describe('openaiResponsesInputToHistory', () => {
  it('maps string input to user message', () => {
    const h = openaiResponsesInputToHistory('hello', undefined)
    assert.deepEqual(h, [{ role: 'user', content: 'hello' }])
  })

  it('prepends instructions as system', () => {
    const h = openaiResponsesInputToHistory('x', 'sys')
    assert.deepEqual(h, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'x' }
    ])
  })

  it('maps message items', () => {
    const h = openaiResponsesInputToHistory(
      [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'a' }] }],
      undefined
    )
    assert.equal(h[0]!.role, 'user')
    assert.equal(h[0]!.content, 'a')
  })

  it('maps function_call_output to tool role', () => {
    const h = openaiResponsesInputToHistory(
      [{ type: 'function_call_output', output: '{"ok":true}' }],
      undefined
    )
    assert.deepEqual(h[0], { role: 'tool', content: '{"ok":true}' })
  })

  it('maps function_call to synthesized assistant tool markup', () => {
    const h = openaiResponsesInputToHistory(
      [{ type: 'function_call', name: 'x', arguments: '{"a":1}' }],
      undefined
    )
    assert.equal(h[0]!.role, 'assistant')
    assert.ok(h[0]!.content.includes('<tool_call>'))
    assert.ok(h[0]!.content.includes('x'))
  })
})

describe('openaiResponsesToolsToSdk', () => {
  it('maps Responses-style function tools', () => {
    const t = openaiResponsesToolsToSdk([
      {
        type: 'function',
        name: 'fn',
        description: 'd',
        parameters: { type: 'object', properties: {} }
      }
    ])
    assert.ok(t && t.length === 1)
    assert.equal(t[0]!.name, 'fn')
  })

  it('throws on web_search', () => {
    assert.throws(
      () => openaiResponsesToolsToSdk([{ type: 'web_search' }]),
      UnsupportedToolTypeError
    )
  })
})

describe('extractGenerationParams (responses semantics)', () => {
  it('maps max_output_tokens to predict', () => {
    const p = extractGenerationParams({ max_output_tokens: 64 }, 'max_output_tokens')
    assert.equal(p!.predict, 64)
  })
})

describe('extractResponsesResponseFormat', () => {
  it('reads nested text.format', () => {
    const f = extractResponsesResponseFormat({
      text: { format: { type: 'json_object' } }
    })
    assert.ok(f && f.type === 'json_object')
  })
})

describe('validateResponsesStatefulOptions', () => {
  it('returns previous id and store default true', () => {
    const r = validateResponsesStatefulOptions({ previous_response_id: 'resp_x', input: '' })
    assert.equal(r.previousResponseId, 'resp_x')
    assert.equal(r.storeEnabled, true)
  })

  it('store false opts out', () => {
    const r = validateResponsesStatefulOptions({ store: false, input: '' })
    assert.equal(r.storeEnabled, false)
  })

  it('throws on conversation', () => {
    assert.throws(
      () => validateResponsesStatefulOptions({ conversation: 'c1' }),
      InvalidResponsesConversationError
    )
  })

  it('throws on background true', () => {
    assert.throws(
      () => validateResponsesStatefulOptions({ background: true }),
      InvalidResponsesBackgroundError
    )
  })
})

describe('normalizeResponsesInputItemsForStorage', () => {
  it('wraps string input', () => {
    const items = normalizeResponsesInputItemsForStorage('hi')
    assert.equal(items.length, 1)
    assert.equal((items[0] as { type: string }).type, 'message')
  })
})

describe('historyPrefixFromStoredResponse', () => {
  it('uses output_text when output array is empty', () => {
    const prefix = historyPrefixFromStoredResponse({
      inputItems: [
        { type: 'message', id: '1', role: 'user', content: [{ type: 'input_text', text: 'u' }] }
      ],
      responseObject: { output_text: 'assistant reply', output: [] }
    })
    assert.deepEqual(prefix, [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'assistant reply' }
    ])
  })

  it('prefers non-empty output array so tool calls are included with assistant text', () => {
    const prefix = historyPrefixFromStoredResponse({
      inputItems: [],
      responseObject: {
        output_text: 'ignored when structured output present',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] },
          { type: 'function_call', name: 'f', arguments: '{}', call_id: 'c1' }
        ]
      }
    })
    const assistantText = prefix.filter(
      (p) => p.role === 'assistant' && !p.content.includes('tool_call')
    )
    const toolCalls = prefix.filter(
      (p) => p.role === 'assistant' && p.content.includes('tool_call')
    )
    assert.equal(assistantText.length, 1)
    assert.equal(assistantText[0]!.content, 'hello')
    assert.equal(toolCalls.length, 1)
  })

  it('includes function_call_output from stored input items', () => {
    const prefix = historyPrefixFromStoredResponse({
      inputItems: [{ type: 'function_call_output', output: '{"r":1}' }],
      responseObject: { output: [], output_text: '' }
    })
    assert.deepEqual(prefix, [{ role: 'tool', content: '{"r":1}' }])
  })

  it('walks previous_response_id chain so depth-3 carries the grandparent turn', () => {
    const records: Record<
      string,
      { inputItems: unknown[]; responseObject: Record<string, unknown> }
    > = {
      resp_1: {
        inputItems: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A' }] }
        ],
        responseObject: { output: [], output_text: 'X' }
      },
      resp_2: {
        inputItems: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'B' }] }
        ],
        responseObject: { output: [], output_text: 'Y', previous_response_id: 'resp_1' }
      },
      resp_3: {
        inputItems: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'C' }] }
        ],
        responseObject: { output: [], output_text: 'Z', previous_response_id: 'resp_2' }
      }
    }
    const prefix = historyPrefixFromStoredResponse(records['resp_3']!, (id) => records[id])
    assert.deepEqual(prefix, [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'X' },
      { role: 'user', content: 'B' },
      { role: 'assistant', content: 'Y' },
      { role: 'user', content: 'C' },
      { role: 'assistant', content: 'Z' }
    ])
  })

  it('caps chain walk at maxDepth to bound work on pathological input', () => {
    const records: Record<
      string,
      { inputItems: unknown[]; responseObject: Record<string, unknown> }
    > = {
      a: {
        inputItems: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'aIn' }] }
        ],
        responseObject: { output: [], output_text: 'aOut' }
      },
      b: {
        inputItems: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'bIn' }] }
        ],
        responseObject: { output: [], output_text: 'bOut', previous_response_id: 'a' }
      },
      c: {
        inputItems: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'cIn' }] }
        ],
        responseObject: { output: [], output_text: 'cOut', previous_response_id: 'b' }
      }
    }
    const prefix = historyPrefixFromStoredResponse(records['c']!, (id) => records[id], 1)
    assert.deepEqual(prefix, [
      { role: 'user', content: 'bIn' },
      { role: 'assistant', content: 'bOut' },
      { role: 'user', content: 'cIn' },
      { role: 'assistant', content: 'cOut' }
    ])
  })
})

describe('parseLegacyPrompt', () => {
  it('returns a single prompt for a non-empty string', () => {
    assert.deepEqual(parseLegacyPrompt('hello'), { kind: 'single', value: 'hello' })
  })

  it('unwraps a single-element string array to a single prompt', () => {
    assert.deepEqual(parseLegacyPrompt(['hello']), { kind: 'single', value: 'hello' })
  })

  it('returns a multi prompt for arrays with two or more strings', () => {
    assert.deepEqual(parseLegacyPrompt(['a', 'b']), { kind: 'multi', values: ['a', 'b'] })
    assert.deepEqual(parseLegacyPrompt(['a', 'b', 'c']), { kind: 'multi', values: ['a', 'b', 'c'] })
  })

  it('throws on missing prompt', () => {
    assert.throws(() => parseLegacyPrompt(undefined), InvalidPromptError)
    assert.throws(() => parseLegacyPrompt(null), InvalidPromptError)
  })

  it('throws on empty string', () => {
    assert.throws(() => parseLegacyPrompt(''), InvalidPromptError)
  })

  it('throws on empty array', () => {
    assert.throws(() => parseLegacyPrompt([]), InvalidPromptError)
  })

  it('throws on array entries that are not strings (token IDs)', () => {
    assert.throws(() => parseLegacyPrompt([1, 2, 3]), InvalidPromptError)
    assert.throws(
      () =>
        parseLegacyPrompt([
          [1, 2],
          [3, 4]
        ]),
      InvalidPromptError
    )
    assert.throws(() => parseLegacyPrompt(['ok', 7]), InvalidPromptError)
  })

  it('throws on numeric prompt (single token id)', () => {
    assert.throws(() => parseLegacyPrompt(42), InvalidPromptError)
  })

  it('throws on array entry that is an empty string', () => {
    assert.throws(() => parseLegacyPrompt(['ok', '']), InvalidPromptError)
  })

  it('throws on non-string, non-array, non-numeric prompt', () => {
    assert.throws(() => parseLegacyPrompt({ text: 'oops' }), InvalidPromptError)
    assert.throws(() => parseLegacyPrompt(true), InvalidPromptError)
  })
})

describe('legacyPromptToHistory', () => {
  it('wraps a string in a single-turn user history', () => {
    assert.deepEqual(legacyPromptToHistory('hello'), [{ role: 'user', content: 'hello' }])
  })
})
