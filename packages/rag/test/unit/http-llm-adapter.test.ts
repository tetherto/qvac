import test from 'brittle'
import { HttpLlmAdapter, type HttpConfig } from '../../src/adapters/llm/HttpLlmAdapter.js'
import { BaseLlmAdapter } from '../../src/adapters/llm/BaseLlmAdapter.js'
import { QvacErrorRAG, ERR_CODES } from '../../src/errors.js'

type HttpLlmCtor = ConstructorParameters<typeof HttpLlmAdapter>
type RequestFormatter = HttpLlmCtor[1]
type ResponseFormatter = HttpLlmCtor[2]

// The formatted result the mock response formatter produces.
type LlmResult = { role: string; content: string; metadata?: Record<string, unknown> }
type RunLoose = (...args: unknown[]) => Promise<LlmResult>

// The canned HTTP response shape the mock request path returns.
interface MockHttpResponse {
  choices: Array<{ message: { role: string; content: string } }>
}

// Mock control flags for simulating failures
const mockConfig = {
  simulateLLMFailure: false,
  simulateNetworkFailure: false
}

// Helper to reset mock state
function resetMocks() {
  Object.keys(mockConfig).forEach((key) => {
    ;(mockConfig as Record<string, boolean>)[key] = false
  })
}

// Override the adapter's private HTTP request method with a canned response so
// the tests never touch the network.
// lunte-disable-next-line require-await
const mockMakeHttpRequest = async function (requestBody: object): Promise<unknown> {
  if (mockConfig.simulateNetworkFailure) {
    throw new Error('Network request failed')
  }
  if (mockConfig.simulateLLMFailure) {
    throw new Error('Simulated LLM failure')
  }

  // Mock realistic HTTP response that works with response formatters
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: 'Mock HTTP LLM response'
        }
      }
    ]
  }
}
;(
  HttpLlmAdapter.prototype as unknown as {
    _makeHttpRequest(requestBody: object): Promise<unknown>
  }
)._makeHttpRequest = mockMakeHttpRequest

// Mock formatters for testing
const mockRequestFormatter: RequestFormatter = (query) => ({
  model: 'test-model',
  messages: [{ role: 'user', content: query }],
  max_tokens: 100
})

const mockResponseFormatter: ResponseFormatter = (response) => ({
  role: 'assistant',
  content: (response as MockHttpResponse).choices[0].message.content
})

test('HttpLlmAdapter: should extend BaseLlmAdapter', (t) => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  t.ok(adapter instanceof BaseLlmAdapter, 'Should extend BaseLlmAdapter')
  t.ok(adapter instanceof HttpLlmAdapter, 'Should be instance of HttpLlmAdapter')
})

test('HttpLlmAdapter: should create with valid configuration', (t) => {
  const httpConfig = {
    apiUrl: 'https://api.test.com/chat',
    method: 'POST',
    headers: { Authorization: 'Bearer test-token' }
  }

  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  t.is(adapter.httpConfig.apiUrl, httpConfig.apiUrl, 'Should store API URL')
  t.is(adapter.httpConfig.method, 'POST', 'Should store HTTP method')
  t.ok(adapter.httpConfig.headers.Authorization, 'Should store headers')
})

test('HttpLlmAdapter: should use default method when not provided', (t) => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  t.is(adapter.httpConfig.method, 'POST', 'Should default to POST method')
})

test('HttpLlmAdapter: should throw error for missing httpConfig', (t) => {
  try {
    // eslint-disable-next-line no-new
    new HttpLlmAdapter(null as unknown as HttpConfig, mockRequestFormatter, mockResponseFormatter)
    t.fail('Should throw error for missing httpConfig')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    if (err instanceof QvacErrorRAG) {
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
      t.ok(
        err.message.includes('HTTP configuration'),
        'Error message should mention HTTP configuration'
      )
    }
  }
})

test('HttpLlmAdapter: should throw error for invalid config or URL', (t) => {
  const invalidConfigs: unknown[] = ['string', 123, true, []]
  invalidConfigs.forEach((invalidConfig) => {
    try {
      // eslint-disable-next-line no-new
      new HttpLlmAdapter(
        invalidConfig as unknown as HttpConfig,
        mockRequestFormatter,
        mockResponseFormatter
      )
      t.fail(`Should throw error for invalid config: ${invalidConfig}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      if (err instanceof QvacErrorRAG) {
        t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
      }
    }
  })

  try {
    // eslint-disable-next-line no-new
    new HttpLlmAdapter({} as unknown as HttpConfig, mockRequestFormatter, mockResponseFormatter)
    t.fail('Should throw error for missing apiUrl')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    if (err instanceof QvacErrorRAG) {
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
    }
  }

  const invalidUrls: unknown[] = [123, {}, [], true, null]
  invalidUrls.forEach((invalidUrl) => {
    try {
      // eslint-disable-next-line no-new
      new HttpLlmAdapter(
        { apiUrl: invalidUrl } as unknown as HttpConfig,
        mockRequestFormatter,
        mockResponseFormatter
      )
      t.fail(`Should throw error for invalid URL: ${invalidUrl}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      if (err instanceof QvacErrorRAG) {
        t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
      }
    }
  })
})

test('HttpLlmAdapter: should throw error for invalid formatters', (t) => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const invalidFormatters: unknown[] = [null, 'string', 123, {}, []]

  invalidFormatters.forEach((invalidFormatter) => {
    try {
      // eslint-disable-next-line no-new
      new HttpLlmAdapter(
        httpConfig,
        invalidFormatter as unknown as RequestFormatter,
        mockResponseFormatter
      )
      t.fail(`Should throw error for invalid request formatter: ${invalidFormatter}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      if (err instanceof QvacErrorRAG) {
        t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
      }
    }
  })

  invalidFormatters.forEach((invalidFormatter) => {
    try {
      // eslint-disable-next-line no-new
      new HttpLlmAdapter(
        httpConfig,
        mockRequestFormatter,
        invalidFormatter as unknown as ResponseFormatter
      )
      t.fail(`Should throw error for invalid response formatter: ${invalidFormatter}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      if (err instanceof QvacErrorRAG) {
        t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
      }
    }
  })
})

test('HttpLlmAdapter: run should process messages successfully', async (t) => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  const messages = [{ role: 'user', content: 'What is the capital of France?' }]

  const result = await (adapter.run as unknown as RunLoose)(messages)

  t.ok(result, 'Should return a result')
  t.is(result.role, 'assistant', 'Result should have assistant role')
  t.ok(result.content, 'Result should have content')
  t.is(typeof result.content, 'string', 'Content should be a string')
})

test('HttpLlmAdapter: run should handle multiple messages', async (t) => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' },
    { role: 'assistant', content: 'Hi there!' },
    { role: 'user', content: 'How are you?' }
  ]

  const result = await (adapter.run as unknown as RunLoose)(messages)

  t.ok(result, 'Should return a result')
  t.is(result.role, 'assistant', 'Result should have assistant role')
  t.ok(result.content, 'Result should have content')
})

test('HttpLlmAdapter: run should handle network failure', async (t) => {
  resetMocks()
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  // Simulate network failure
  mockConfig.simulateNetworkFailure = true

  try {
    await (adapter.run as unknown as RunLoose)([{ role: 'user', content: 'Test' }])
    t.fail('Should throw error on network failure')
  } catch (err) {
    t.ok(err instanceof Error, 'Should throw an error')
    if (err instanceof Error) {
      t.ok(err.message.includes('request failed'), 'Error should indicate network failure')
    }
  }
})

test('HttpLlmAdapter: run should handle LLM failure', async (t) => {
  resetMocks()
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  // Simulate LLM failure
  mockConfig.simulateLLMFailure = true

  try {
    await (adapter.run as unknown as RunLoose)([{ role: 'user', content: 'Test' }])
    t.fail('Should throw error on LLM failure')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    if (err instanceof QvacErrorRAG) {
      t.is(err.code, ERR_CODES.GENERATION_FAILED, 'Error code should be GENERATION_FAILED')
    }
  }
})

// lunte-disable-next-line require-await
test('HttpLlmAdapter: should use custom headers', async (t) => {
  resetMocks()
  const httpConfig = {
    apiUrl: 'https://api.test.com/chat',
    headers: {
      Authorization: 'Bearer custom-token',
      'X-Custom-Header': 'custom-value'
    }
  }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  t.ok(adapter.httpConfig.headers.Authorization, 'Should store Authorization header')
  t.ok(adapter.httpConfig.headers['X-Custom-Header'], 'Should store custom header')
})

test('HttpLlmAdapter: should handle empty messages array', async (t) => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  const result = await (adapter.run as unknown as RunLoose)([])

  t.ok(result, 'Should return a result even for empty messages')
  t.is(result.role, 'assistant', 'Result should have assistant role')
})

test('HttpLlmAdapter: should use request formatter correctly', async (t) => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }

  // Custom formatter that adds specific fields
  const customRequestFormatter: RequestFormatter = (messages) => ({
    model: 'custom-model',
    messages,
    temperature: 0.7,
    max_tokens: 150
  })

  const adapter = new HttpLlmAdapter(httpConfig, customRequestFormatter, mockResponseFormatter)

  const messages = [{ role: 'user', content: 'Test message' }]
  const result = await (adapter.run as unknown as RunLoose)(messages)

  t.ok(result, 'Should return a result with custom formatter')
})

test('HttpLlmAdapter: should use response formatter correctly', async (t) => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }

  // Custom response formatter
  const customResponseFormatter: ResponseFormatter = (response) => ({
    role: 'assistant',
    content: `Formatted: ${(response as MockHttpResponse).choices[0].message.content}`,
    metadata: { formatted: true }
  })

  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, customResponseFormatter)

  const result = await (adapter.run as unknown as RunLoose)('test query', [])

  t.ok(result.content.startsWith('Formatted:'), 'Should use custom response formatter')
  t.ok(result.metadata?.formatted, 'Should include custom metadata')
})

test('HttpLlmAdapter: should handle complex message structures', async (t) => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  const messages = [
    {
      role: 'system',
      content: 'You are a helpful assistant.',
      metadata: { timestamp: Date.now() }
    },
    {
      role: 'user',
      content: 'Complex question with context.',
      context: ['Additional context 1', 'Additional context 2']
    }
  ]

  const result = await (adapter.run as unknown as RunLoose)(messages)

  t.ok(result, 'Should handle complex message structures')
  t.is(result.role, 'assistant', 'Result should have assistant role')
})

test('HttpLlmAdapter: should merge default and custom headers', (t) => {
  const httpConfig = {
    apiUrl: 'https://api.test.com/chat',
    headers: {
      Authorization: 'Bearer token',
      'Custom-Header': 'value'
    }
  }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  // Default headers should be merged with custom ones
  t.ok(adapter.httpConfig.headers['Content-Type'], 'Should have default Content-Type header')
  t.is(
    adapter.httpConfig.headers.Authorization,
    'Bearer token',
    'Should preserve custom Authorization'
  )
  t.is(adapter.httpConfig.headers['Custom-Header'], 'value', 'Should preserve custom header')
})
