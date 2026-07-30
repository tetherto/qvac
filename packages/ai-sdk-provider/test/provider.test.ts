import assert from 'node:assert/strict'
import test from 'node:test'

import { APICallError } from '@ai-sdk/provider'

import { DEFAULT_API_KEY, DEFAULT_BASE_URL } from '../src/defaults.js'
import { createQvac, qvac } from '../src/provider.js'

async function captureApiCallError(promise: PromiseLike<unknown>): Promise<APICallError> {
  try {
    await promise
    assert.fail('expected APICallError')
  } catch (error) {
    assert.ok(APICallError.isInstance(error), `expected APICallError, got ${String(error)}`)
    return error
  }
}

test('createQvac returns a provider object with the AI SDK provider surface', () => {
  const provider = createQvac({ baseURL: 'http://127.0.0.1:55555/v1' })

  assert.equal(typeof provider, 'function', 'provider should be callable as `provider(modelId)`')
  assert.equal(provider.specificationVersion, 'v4')
  assert.equal(typeof provider.chatModel, 'function')
  assert.equal(typeof provider.completionModel, 'function')
  assert.equal(typeof provider.textEmbeddingModel, 'function')
  assert.equal(typeof provider.imageModel, 'function')
  assert.equal(typeof provider.transcriptionModel, 'function')
  assert.equal(typeof provider.speechModel, 'function')
  assert.equal(typeof provider.files, 'function')
})

test('native transcription and speech models use the local QVAC audio endpoints', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const wavBytes = Uint8Array.from([
    82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69, 102, 109, 116, 32, 16, 0, 0, 0, 1, 0, 1, 0, 128,
    62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0, 100, 97, 116, 97, 0, 0, 0, 0
  ])
  const customFetch: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url, ...(init !== undefined && { init }) })
    if (url.endsWith('/v1/audio/transcriptions')) {
      assert.ok(init?.body instanceof FormData)
      assert.equal(new Headers(init.headers).get('content-type'), null)
      assert.equal(init.body.get('model'), 'whisper-local')
      assert.equal(init.body.get('prompt'), 'Sensor vocabulary')
      return Promise.resolve(Response.json({ text: 'temperature is twenty four degrees' }))
    }
    if (url.endsWith('/v1/audio/speech')) {
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/json')
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      assert.deepEqual(body, {
        model: 'tts-local',
        input: 'Local speech check.',
        voice: 'default',
        response_format: 'wav'
      })
      return Promise.resolve(new Response(wavBytes, { headers: { 'content-type': 'audio/wav' } }))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }

  const provider = createQvac({
    baseURL: 'http://127.0.0.1:55555/v1',
    headers: { 'Content-Type': 'application/x-invalid-global-default' },
    fetch: customFetch
  })
  const { generateSpeech, transcribe } = await import('ai')
  const transcript = await transcribe({
    model: provider.transcriptionModel('whisper-local'),
    audio: wavBytes,
    providerOptions: { qvac: { prompt: 'Sensor vocabulary' } }
  })
  assert.equal(transcript.text, 'temperature is twenty four degrees')

  const speech = await generateSpeech({
    model: provider.speechModel('tts-local'),
    text: 'Local speech check.',
    voice: 'default',
    outputFormat: 'wav'
  })
  assert.deepEqual(speech.audio.uint8Array, wavBytes)
  assert.deepEqual(
    calls.map(({ url }) => url),
    ['http://127.0.0.1:55555/v1/audio/transcriptions', 'http://127.0.0.1:55555/v1/audio/speech']
  )
})

test('uploadFile returns a qvac reference and language models resolve it through the local serve', async () => {
  const calls: string[] = []
  let chatBody: Record<string, unknown> | undefined
  const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
  const customFetch: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    if (url.endsWith('/v1/files') && init?.method === 'POST') {
      assert.ok(init.body instanceof FormData)
      assert.equal(new Headers(init.headers).get('content-type'), null)
      assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${DEFAULT_API_KEY}`)
      return Promise.resolve(Response.json({ id: 'file-local-1', filename: 'sensor.png' }))
    }
    if (url.endsWith('/v1/files/file-local-1/content')) {
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'Bearer per-call')
      assert.equal(headers.get('x-configured'), 'provider')
      assert.equal(headers.get('x-trace-id'), 'turn-1')
      return Promise.resolve(new Response(imageBytes, { headers: { 'content-type': 'image/png' } }))
    }
    if (url.endsWith('/v1/chat/completions')) {
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('authorization'), 'Bearer per-call')
      assert.equal(headers.get('x-configured'), 'provider')
      assert.equal(headers.get('x-trace-id'), 'turn-1')
      chatBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Promise.resolve(
        Response.json({
          id: 'cmpl-file',
          object: 'chat.completion',
          created: 0,
          model: 'vision',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '24 degrees' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        })
      )
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }
  const provider = createQvac({
    baseURL: 'http://127.0.0.1:55555/v1',
    headers: {
      'Content-Type': 'application/x-invalid-global-default',
      'x-configured': 'provider'
    },
    fetch: customFetch
  })
  const { generateText, uploadFile } = await import('ai')
  const uploaded = await uploadFile({
    api: provider,
    data: imageBytes,
    mediaType: 'image/png',
    filename: 'sensor.png'
  })
  assert.deepEqual(uploaded.providerReference, { qvac: 'file-local-1' })

  const result = await generateText({
    model: provider('vision'),
    headers: { authorization: 'Bearer per-call', 'x-trace-id': 'turn-1' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read this sensor.' },
          { type: 'file', mediaType: 'image/png', data: uploaded.providerReference }
        ]
      }
    ]
  })
  assert.equal(result.text, '24 degrees')
  assert.deepEqual(calls, [
    'http://127.0.0.1:55555/v1/files',
    'http://127.0.0.1:55555/v1/files/file-local-1/content',
    'http://127.0.0.1:55555/v1/chat/completions'
  ])
  assert.match(JSON.stringify(chatBody), /data:image\/png;base64,iVBORw0KGgo=/)
})

test('native HTTP adapters expose structured APICallError details and retryability', async () => {
  const seen = new Map<string, RequestInit | undefined>()
  const customFetch: typeof fetch = (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    seen.set(url, init)
    if (url.endsWith('/audio/transcriptions')) {
      return Promise.resolve(
        new Response('transcription busy', {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'x-qvac-error': 'transcription' }
        })
      )
    }
    if (url.endsWith('/audio/speech')) {
      return Promise.resolve(
        new Response('invalid speech request', {
          status: 400,
          statusText: 'Bad Request',
          headers: { 'x-qvac-error': 'speech' }
        })
      )
    }
    if (url.endsWith('/files') && init?.method === 'POST') {
      return Promise.resolve(
        new Response('file store unavailable', {
          status: 503,
          statusText: 'Service Unavailable',
          headers: { 'x-qvac-error': 'upload' }
        })
      )
    }
    if (url.endsWith('/files/file-missing/content')) {
      return Promise.resolve(
        new Response('file missing', {
          status: 404,
          statusText: 'Not Found',
          headers: { 'x-qvac-error': 'reference' }
        })
      )
    }
    return Promise.resolve(new Response('unexpected request', { status: 500 }))
  }

  const provider = createQvac({
    baseURL: 'http://127.0.0.1:55555/v1',
    headers: { authorization: 'Bearer local', 'x-configured': 'yes' },
    fetch: customFetch
  })

  const transcriptionAbort = new AbortController()
  const transcriptionError = await captureApiCallError(
    provider.transcriptionModel('whisper-local').doGenerate({
      audio: Uint8Array.from([1, 2, 3]),
      mediaType: 'audio/wav',
      headers: { 'x-per-call': 'transcription' },
      abortSignal: transcriptionAbort.signal
    })
  )
  assert.equal(transcriptionError.url, 'http://127.0.0.1:55555/v1/audio/transcriptions')
  assert.equal(transcriptionError.statusCode, 429)
  assert.equal(transcriptionError.responseBody, 'transcription busy')
  assert.equal(transcriptionError.responseHeaders?.['x-qvac-error'], 'transcription')
  assert.equal(transcriptionError.isRetryable, true)
  assert.equal(
    (transcriptionError.requestBodyValues as Record<string, unknown>)['model'],
    'whisper-local'
  )
  const transcriptionInit = seen.get(transcriptionError.url)
  assert.equal(new Headers(transcriptionInit?.headers).get('x-configured'), 'yes')
  assert.equal(new Headers(transcriptionInit?.headers).get('x-per-call'), 'transcription')
  assert.equal(transcriptionInit?.signal, transcriptionAbort.signal)

  const speechError = await captureApiCallError(
    provider.speechModel('tts-local').doGenerate({
      text: 'hello',
      headers: { 'x-per-call': 'speech' }
    })
  )
  assert.equal(speechError.url, 'http://127.0.0.1:55555/v1/audio/speech')
  assert.equal(speechError.statusCode, 400)
  assert.equal(speechError.responseBody, 'invalid speech request')
  assert.equal(speechError.responseHeaders?.['x-qvac-error'], 'speech')
  assert.equal(speechError.isRetryable, false)
  assert.deepEqual(speechError.requestBodyValues, { model: 'tts-local', input: 'hello' })

  const uploadError = await captureApiCallError(
    provider.files().uploadFile({
      data: { type: 'data', data: Uint8Array.from([4, 5, 6]) },
      mediaType: 'application/octet-stream',
      filename: 'payload.bin'
    })
  )
  assert.equal(uploadError.url, 'http://127.0.0.1:55555/v1/files')
  assert.equal(uploadError.statusCode, 503)
  assert.equal(uploadError.responseBody, 'file store unavailable')
  assert.equal(uploadError.responseHeaders?.['x-qvac-error'], 'upload')
  assert.equal(uploadError.isRetryable, true)
  assert.ok('file' in (uploadError.requestBodyValues as Record<string, unknown>))

  const referenceError = await captureApiCallError(
    provider('vision').doGenerate({
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              mediaType: 'image/png',
              data: { type: 'reference', reference: { qvac: 'file-missing' } }
            }
          ]
        }
      ]
    })
  )
  assert.equal(referenceError.url, 'http://127.0.0.1:55555/v1/files/file-missing/content')
  assert.equal(referenceError.statusCode, 404)
  assert.equal(referenceError.responseBody, 'file missing')
  assert.equal(referenceError.responseHeaders?.['x-qvac-error'], 'reference')
  assert.equal(referenceError.isRetryable, false)
  assert.deepEqual(referenceError.requestBodyValues, {})
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

test('caller authorization headers override apiKey without duplicate casing', async () => {
  const capturedAuth: string[] = []
  const customFetch: typeof fetch = (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    )
    capturedAuth.push(headers.get('authorization') ?? '')
    return Promise.resolve(
      Response.json({
        id: 'cmpl-auth',
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
      })
    )
  }
  const { generateText } = await import('ai')

  for (const [name, value] of [
    ['authorization', 'Bearer lowercase'],
    ['Authorization', 'Bearer uppercase']
  ] as const) {
    const provider = createQvac({
      baseURL: 'http://127.0.0.1:55555/v1',
      apiKey: 'must-not-override-caller',
      headers: { [name]: value },
      fetch: customFetch
    })
    await generateText({ model: provider('test-model'), prompt: 'hi' })
  }

  assert.deepEqual(capturedAuth, ['Bearer lowercase', 'Bearer uppercase'])
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
