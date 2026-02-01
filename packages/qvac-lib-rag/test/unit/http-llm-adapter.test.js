'use strict'

const test = require('brittle')
const HttpLlmAdapter = require('../../src/adapters/llm/HttpLlmAdapter')
const BaseLlmAdapter = require('../../src/adapters/llm/BaseLlmAdapter')
const { QvacErrorRAG, ERR_CODES } = require('../../src/errors')

// Mock control flags for simulating failures
const mockConfig = {
  simulateLLMFailure: false,
  simulateNetworkFailure: false
}

// Helper to reset mock state
function resetMocks () {
  Object.keys(mockConfig).forEach(key => { mockConfig[key] = false })
}

// Mock HTTP LLM Adapter's _makeHttpRequest method
HttpLlmAdapter.prototype._makeHttpRequest = async function (requestBody) {
  if (mockConfig.simulateNetworkFailure) {
    throw new Error('Network request failed')
  }
  if (mockConfig.simulateLLMFailure) {
    throw new Error('Simulated LLM failure')
  }

  // Mock realistic HTTP response that works with response formatters
  return {
    choices: [{
      message: {
        role: 'assistant',
        content: 'Mock HTTP LLM response'
      }
    }]
  }
}

// Mock formatters for testing
const mockRequestFormatter = (query, searchResults, opts) => ({
  model: 'test-model',
  messages: [{ role: 'user', content: query }],
  max_tokens: 100
})

const mockResponseFormatter = (response) => ({
  role: 'assistant',
  content: response.choices[0].message.content
})

test('HttpLlmAdapter: should extend BaseLlmAdapter', t => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  t.ok(adapter instanceof BaseLlmAdapter, 'Should extend BaseLlmAdapter')
  t.ok(adapter instanceof HttpLlmAdapter, 'Should be instance of HttpLlmAdapter')
})

test('HttpLlmAdapter: should create with valid configuration', t => {
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

test('HttpLlmAdapter: should use default method when not provided', t => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  t.is(adapter.httpConfig.method, 'POST', 'Should default to POST method')
})

test('HttpLlmAdapter: should throw error for missing httpConfig', t => {
  try {
    // eslint-disable-next-line no-new
    new HttpLlmAdapter(null, mockRequestFormatter, mockResponseFormatter)
    t.fail('Should throw error for missing httpConfig')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
    t.ok(err.message.includes('HTTP configuration'), 'Error message should mention HTTP configuration')
  }
})

test('HttpLlmAdapter: should throw error for invalid config or URL', t => {
  const invalidConfigs = ['string', 123, true, []]
  invalidConfigs.forEach(invalidConfig => {
    try {
      // eslint-disable-next-line no-new
      new HttpLlmAdapter(invalidConfig, mockRequestFormatter, mockResponseFormatter)
      t.fail(`Should throw error for invalid config: ${invalidConfig}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
    }
  })

  try {
    // eslint-disable-next-line no-new
    new HttpLlmAdapter({}, mockRequestFormatter, mockResponseFormatter)
    t.fail('Should throw error for missing apiUrl')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
  }

  const invalidUrls = [123, {}, [], true, null]
  invalidUrls.forEach(invalidUrl => {
    try {
      // eslint-disable-next-line no-new
      new HttpLlmAdapter({ apiUrl: invalidUrl }, mockRequestFormatter, mockResponseFormatter)
      t.fail(`Should throw error for invalid URL: ${invalidUrl}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
    }
  })
})

test('HttpLlmAdapter: should throw error for invalid formatters', t => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const invalidFormatters = [null, 'string', 123, {}, []]

  invalidFormatters.forEach(invalidFormatter => {
    try {
      // eslint-disable-next-line no-new
      new HttpLlmAdapter(httpConfig, invalidFormatter, mockResponseFormatter)
      t.fail(`Should throw error for invalid request formatter: ${invalidFormatter}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
    }
  })

  invalidFormatters.forEach(invalidFormatter => {
    try {
      // eslint-disable-next-line no-new
      new HttpLlmAdapter(httpConfig, mockRequestFormatter, invalidFormatter)
      t.fail(`Should throw error for invalid response formatter: ${invalidFormatter}`)
    } catch (err) {
      t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
      t.is(err.code, ERR_CODES.INVALID_INPUT, 'Error code should be INVALID_INPUT')
    }
  })
})

test('HttpLlmAdapter: run should process messages successfully', async t => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  const messages = [
    { role: 'user', content: 'What is the capital of France?' }
  ]

  const result = await adapter.run(messages)

  t.ok(result, 'Should return a result')
  t.is(result.role, 'assistant', 'Result should have assistant role')
  t.ok(result.content, 'Result should have content')
  t.is(typeof result.content, 'string', 'Content should be a string')
})

test('HttpLlmAdapter: run should handle multiple messages', async t => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' },
    { role: 'assistant', content: 'Hi there!' },
    { role: 'user', content: 'How are you?' }
  ]

  const result = await adapter.run(messages)

  t.ok(result, 'Should return a result')
  t.is(result.role, 'assistant', 'Result should have assistant role')
  t.ok(result.content, 'Result should have content')
})

test('HttpLlmAdapter: run should handle network failure', async t => {
  resetMocks()
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  // Simulate network failure
  mockConfig.simulateNetworkFailure = true

  try {
    await adapter.run([{ role: 'user', content: 'Test' }])
    t.fail('Should throw error on network failure')
  } catch (err) {
    t.ok(err instanceof Error, 'Should throw an error')
    t.ok(err.message.includes('request failed'), 'Error should indicate network failure')
  }
})

test('HttpLlmAdapter: run should handle LLM failure', async t => {
  resetMocks()
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  // Simulate LLM failure
  mockConfig.simulateLLMFailure = true

  try {
    await adapter.run([{ role: 'user', content: 'Test' }])
    t.fail('Should throw error on LLM failure')
  } catch (err) {
    t.ok(err instanceof QvacErrorRAG, 'Error should be instance of QvacErrorRAG')
    t.is(err.code, ERR_CODES.GENERATION_FAILED, 'Error code should be GENERATION_FAILED')
  }
})

test('HttpLlmAdapter: should use custom headers', async t => {
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

test('HttpLlmAdapter: should handle empty messages array', async t => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }
  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, mockResponseFormatter)

  const result = await adapter.run([])

  t.ok(result, 'Should return a result even for empty messages')
  t.is(result.role, 'assistant', 'Result should have assistant role')
})

test('HttpLlmAdapter: should use request formatter correctly', async t => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }

  // Custom formatter that adds specific fields
  const customRequestFormatter = (messages) => ({
    model: 'custom-model',
    messages,
    temperature: 0.7,
    max_tokens: 150
  })

  const adapter = new HttpLlmAdapter(httpConfig, customRequestFormatter, mockResponseFormatter)

  const messages = [{ role: 'user', content: 'Test message' }]
  const result = await adapter.run(messages)

  t.ok(result, 'Should return a result with custom formatter')
})

test('HttpLlmAdapter: should use response formatter correctly', async t => {
  const httpConfig = { apiUrl: 'https://api.test.com/chat' }

  // Custom response formatter
  const customResponseFormatter = (response) => ({
    role: 'assistant',
    content: `Formatted: ${response.choices[0].message.content}`,
    metadata: { formatted: true }
  })

  const adapter = new HttpLlmAdapter(httpConfig, mockRequestFormatter, customResponseFormatter)

  const result = await adapter.run('test query', [])

  t.ok(result.content.startsWith('Formatted:'), 'Should use custom response formatter')
  t.ok(result.metadata?.formatted, 'Should include custom metadata')
})

test('HttpLlmAdapter: should handle complex message structures', async t => {
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

  const result = await adapter.run(messages)

  t.ok(result, 'Should handle complex message structures')
  t.is(result.role, 'assistant', 'Result should have assistant role')
})

test('HttpLlmAdapter: should merge default and custom headers', t => {
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
  t.is(adapter.httpConfig.headers.Authorization, 'Bearer token', 'Should preserve custom Authorization')
  t.is(adapter.httpConfig.headers['Custom-Header'], 'value', 'Should preserve custom header')
})
