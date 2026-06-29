import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_API_KEY, DEFAULT_BASE_URL } from '../src/defaults.js'
import { createQvac, qvac } from '../src/provider.js'

test('createQvac returns a provider object with the AI SDK provider surface', () => {
  const provider = createQvac({ baseURL: 'http://127.0.0.1:55555/v1' })

  assert.equal(typeof provider, 'function', 'provider should be callable as `provider(modelId)`')
  assert.equal(typeof provider.chatModel, 'function')
  assert.equal(typeof provider.completionModel, 'function')
  assert.equal(typeof provider.textEmbeddingModel, 'function')
  assert.equal(typeof provider.imageModel, 'function')
})

test('createQvac default instance is constructable with no options', () => {
  const provider = createQvac()
  assert.equal(typeof provider, 'function')
})

test('the exported `qvac` singleton is a provider with the default surface', () => {
  assert.equal(typeof qvac, 'function')
  assert.equal(typeof qvac.chatModel, 'function')
  assert.equal(typeof qvac.textEmbeddingModel, 'function')
})

test('createQvac forwards baseURL/apiKey/headers/fetch to the underlying call', async () => {
  let capturedUrl: string | undefined
  let capturedAuth: string | undefined
  let capturedCustomHeader: string | undefined
  let capturedFetchCallCount = 0

  // lunte-disable-next-line require-await
  const customFetch: typeof fetch = async (input, init) => {
    capturedFetchCallCount += 1
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    capturedUrl = url
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    capturedAuth = headers.get('authorization') ?? undefined
    capturedCustomHeader = headers.get('x-qvac-test') ?? undefined
    return new Response(
      JSON.stringify({
        id: 'cmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  const provider = createQvac({
    baseURL: 'http://127.0.0.1:55555/v1',
    apiKey: 'secret-key',
    headers: { 'x-qvac-test': 'flowed-through' },
    fetch: customFetch
  })

  const model = provider.chatModel('test-model')

  // Use the AI SDK's `generateText` to drive the model through to fetch().
  // Importing inline so the rest of the test file remains import-light.
  const { generateText } = await import('ai')

  await generateText({
    model,
    prompt: 'hi'
  })

  assert.equal(capturedFetchCallCount, 1, 'custom fetch should be called exactly once')
  assert.ok(
    capturedUrl?.startsWith('http://127.0.0.1:55555/v1'),
    `expected custom baseURL, got ${capturedUrl}`
  )
  assert.equal(capturedAuth, 'Bearer secret-key', 'apiKey should propagate as Bearer auth header')
  assert.equal(capturedCustomHeader, 'flowed-through', 'custom headers should propagate')
})

test('createQvac without explicit baseURL uses DEFAULT_BASE_URL', async () => {
  let capturedUrl: string | undefined
  // lunte-disable-next-line require-await
  const customFetch: typeof fetch = async (input) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    capturedUrl = url
    return new Response(
      JSON.stringify({
        id: 'cmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  const provider = createQvac({ fetch: customFetch })
  const { generateText } = await import('ai')
  await generateText({ model: provider.chatModel('test-model'), prompt: 'hi' })

  assert.ok(
    capturedUrl?.startsWith(DEFAULT_BASE_URL),
    `expected DEFAULT_BASE_URL (${DEFAULT_BASE_URL}), got ${capturedUrl}`
  )
})

test('createQvac without explicit apiKey uses DEFAULT_API_KEY', async () => {
  let capturedAuth: string | undefined
  // lunte-disable-next-line require-await
  const customFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    capturedAuth = headers.get('authorization') ?? undefined
    return new Response(
      JSON.stringify({
        id: 'cmpl-test',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  const provider = createQvac({ fetch: customFetch })
  const { generateText } = await import('ai')
  await generateText({ model: provider.chatModel('test-model'), prompt: 'hi' })

  assert.equal(capturedAuth, `Bearer ${DEFAULT_API_KEY}`)
})
