import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'
import { assertError, multipart, collectSSE, assertStatusAndError } from '../helpers/http.js'
import { MODEL_CONFIG, E2E } from '../helpers/config.js'
import { silenceWav, tinyPng, textFile } from '../helpers/fixtures.js'

// One shared in-process server preloads the small models (LLM, embedding,
// Whisper ×2). test-video stays preload:false so its requests reach the model check.
const server = useModelServer(MODEL_CONFIG)

function post(url: string, payload: unknown) {
  return server().inject({ method: 'POST', url, payload: payload as object })
}
function get(url: string) {
  return server().inject({ method: 'GET', url })
}
const wavField = {
  name: 'file',
  filename: 'silence.wav',
  contentType: 'audio/wav',
  data: silenceWav()
}

describe('models', () => {
  it('GET /v1/models lists all 4 loaded models', async () => {
    const res = await get('/v1/models')
    assert.equal(res.statusCode, 200)
    const body = res.json() as {
      object: string
      data: Array<{ id: string; object: string; owned_by: string }>
    }
    assert.equal(body.object, 'list')
    assert.equal(body.data.length, 4)
    assert.deepEqual([...body.data.map((m) => m.id)].sort(), [
      'test-embed',
      'test-llm',
      'test-whisper',
      'test-whisper-translate'
    ])
    assert.ok(body.data.every((m) => m.object === 'model' && m.owned_by === 'qvac'))
  })

  it('GET /v1/models/:id returns model details', async () => {
    const res = await get(`/v1/models/${E2E.llm}`)
    const body = res.json() as { id: string; object: string; created: number }
    assert.equal(body.id, E2E.llm)
    assert.equal(body.object, 'model')
    assert.equal(typeof body.created, 'number')
  })
})

describe('chat completions (blocking)', () => {
  it('blocking completion returns valid response', async () => {
    const res = await post('/v1/chat/completions', {
      model: E2E.llm,
      messages: [{ role: 'user', content: 'Say hello and nothing else.' }],
      max_tokens: 512
    })
    const body = res.json() as any
    assert.ok(String(body.id).startsWith('chatcmpl-'))
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.model, E2E.llm)
    assert.equal(body.choices.length, 1)
    assert.equal(body.choices[0].index, 0)
    assert.equal(body.choices[0].message.role, 'assistant')
    assert.ok(body.choices[0].message.content.length > 0)
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.equal(typeof body.usage.completion_tokens, 'number')
  })

  it('respects max_completion_tokens', async () => {
    const res = await post('/v1/chat/completions', {
      model: E2E.llm,
      messages: [{ role: 'user', content: 'Write a very long story about a cat.' }],
      max_completion_tokens: 8
    })
    const body = res.json() as any
    assert.ok(body.choices[0].message.content.length > 0)
  })

  it('finish_reason=length when max_tokens exceeded (blocking)', async () => {
    const res = await post('/v1/chat/completions', {
      model: E2E.llm,
      messages: [{ role: 'user', content: 'Count from 1 to 100.' }],
      max_tokens: 1
    })
    const body = res.json() as any
    assert.equal(body.choices[0].finish_reason, 'length')
    assert.equal(body.usage.completion_tokens, 1)
  })
})

describe('chat completions (streaming)', () => {
  it('finish_reason=length when max_tokens exceeded (streaming)', async () => {
    const res = await post('/v1/chat/completions', {
      model: E2E.llm,
      messages: [{ role: 'user', content: 'Count from 1 to 100.' }],
      stream: true,
      max_tokens: 1
    })
    const chunks = collectSSE(res.payload)
      .map((e) => e.data)
      .filter((d) => d !== '[DONE]') as any[]
    const last = chunks[chunks.length - 1]
    assert.equal(last.choices[0].finish_reason, 'length')
    assert.equal(last.usage.completion_tokens, 1)
  })

  it('SSE stream returns valid chunks', async () => {
    const res = await post('/v1/chat/completions', {
      model: E2E.llm,
      messages: [{ role: 'user', content: 'Say hi.' }],
      stream: true,
      max_tokens: 512
    })
    const datas = collectSSE(res.payload).map((e) => e.data)
    assert.ok(datas.includes('[DONE]'), 'expected [DONE] sentinel')
    const chunks = datas.filter((d) => d !== '[DONE]') as any[]
    const first = chunks[0]
    assert.ok(String(first.id).startsWith('chatcmpl-'))
    assert.equal(first.object, 'chat.completion.chunk')
    assert.equal(first.model, E2E.llm)
    assert.equal(first.choices[0].delta.role, 'assistant')
    const last = chunks[chunks.length - 1]
    assert.ok(['stop', 'tool_calls'].includes(last.choices[0].finish_reason))
    const contentChunks = chunks.filter((c) => c.choices[0].delta.content)
    assert.ok(contentChunks.length > 0)
  })
})

describe('chat completions (tools / structured output)', () => {
  it('rejects response_format combined with tools (invalid_response_format)', async () => {
    const res = await post('/v1/chat/completions', {
      model: E2E.llm,
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
      tools: [
        {
          type: 'function',
          function: { name: 'f', parameters: { type: 'object', properties: {} } }
        }
      ]
    })
    assertStatusAndError(res, 400, 'invalid_response_format')
  })

  it('accepts a function tool and returns a valid completion', async () => {
    const res = await post('/v1/chat/completions', {
      model: E2E.llm,
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      max_tokens: 64,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: { city: { type: 'string' } } }
          }
        }
      ]
    })
    assert.equal(res.statusCode, 200)
    const body = res.json() as any
    assert.equal(body.object, 'chat.completion')
    assert.equal(body.choices.length, 1)
    assert.ok(body.choices[0].message)
    assert.ok(['stop', 'tool_calls', 'length'].includes(body.choices[0].finish_reason))
  })
})

// The rejection branches are request parsing — no multimodal model needed, just
// a resolvable chat model so the request reaches prepare().
describe('chat completions (image_url content)', () => {
  function withImage(url: string): Record<string, unknown> {
    return {
      model: E2E.llm,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe' },
            { type: 'image_url', image_url: { url } }
          ]
        }
      ]
    }
  }

  it('rejects a remote (non-data) image_url', async () => {
    const res = await post('/v1/chat/completions', withImage('http://example.invalid/x.png'))
    assertStatusAndError(res, 400, 'unsupported_image_content')
  })

  it('rejects an unsupported image type', async () => {
    const res = await post(
      '/v1/chat/completions',
      withImage('data:image/gif;base64,R0lGODlhAQABAAAAACw=')
    )
    assertStatusAndError(res, 400, 'unsupported_image_content')
  })

  it('rejects corrupt/mislabeled base64', async () => {
    const res = await post('/v1/chat/completions', withImage('data:image/png;base64,bm90LWEtcG5n'))
    assertStatusAndError(res, 400, 'unsupported_image_content')
  })
})

describe('transcriptions (prompt param)', () => {
  it('accepts a prompt and returns JSON with text', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([
        { name: 'model', value: E2E.whisper },
        { name: 'prompt', value: 'a greeting' },
        wavField
      ])
    })
    assert.equal(res.statusCode, 200)
    assert.equal(typeof (res.json() as { text: unknown }).text, 'string')
  })
})

describe('embeddings', () => {
  it('single input returns vector', async () => {
    const res = await post('/v1/embeddings', { model: E2E.embed, input: 'Hello world' })
    const body = res.json() as any
    assert.equal(body.object, 'list')
    assert.equal(body.data.length, 1)
    assert.equal(body.data[0].object, 'embedding')
    assert.equal(body.data[0].index, 0)
    assert.ok(body.data[0].embedding.length > 0)
    assert.equal(typeof body.data[0].embedding[0], 'number')
    assert.equal(body.model, E2E.embed)
  })

  it('batch input returns multiple vectors', async () => {
    const res = await post('/v1/embeddings', { model: E2E.embed, input: ['Hello', 'World'] })
    const body = res.json() as any
    assert.equal(body.data.length, 2)
    assert.equal(body.data[0].index, 0)
    assert.equal(body.data[1].index, 1)
    assert.ok(body.data[0].embedding.length > 0)
    assert.equal(body.data[0].embedding.length, body.data[1].embedding.length)
  })
})

// response_format=text returns either a non-JSON body or a bare JSON string.
function assertPlainText(payload: string): void {
  let parsed: unknown
  let threw = false
  try {
    parsed = JSON.parse(payload)
  } catch {
    threw = true
  }
  assert.ok(
    threw || typeof parsed === 'string',
    `expected plain text, got: ${payload.slice(0, 80)}`
  )
}

describe('transcriptions', () => {
  it('returns JSON with text field', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([{ name: 'model', value: E2E.whisper }, wavField])
    })
    assert.equal(typeof (res.json() as { text: unknown }).text, 'string')
  })

  it('response_format=text returns plain text', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([
        { name: 'model', value: E2E.whisper },
        { name: 'response_format', value: 'text' },
        wavField
      ])
    })
    assertPlainText(res.payload)
  })
})

describe('translations', () => {
  it('returns JSON with text field', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/translations',
      ...multipart([{ name: 'model', value: E2E.whisperTranslate }, wavField])
    })
    assert.equal(typeof (res.json() as { text: unknown }).text, 'string')
  })

  it('response_format=text returns plain text', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/translations',
      ...multipart([
        { name: 'model', value: E2E.whisperTranslate },
        { name: 'response_format', value: 'text' },
        wavField
      ])
    })
    assertPlainText(res.payload)
  })

  it('rejects transcription-only alias', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/translations',
      ...multipart([{ name: 'model', value: E2E.whisper }, wavField])
    })
    assertError(res, 'invalid_model_type')
  })
})

describe('vector stores', () => {
  it('CRUD — create, list, get, update, delete', async () => {
    const create = (
      await post('/v1/vector_stores', { name: 'crud', metadata: { by: 'e2e' } })
    ).json() as any
    assert.equal(create.object, 'vector_store')
    assert.ok(String(create.id).startsWith('vs_'))
    assert.equal(create.name, 'crud')
    const id = create.id

    const list = (await get('/v1/vector_stores')).json() as any
    assert.equal(list.object, 'list')
    assert.ok(list.data.some((s: any) => s.id === id))

    const before = (await get(`/v1/vector_stores/${id}`)).json() as any
    assert.equal(before.id, id)
    assert.equal(before.status, 'in_progress')

    const update = (await post(`/v1/vector_stores/${id}`, { name: 'crud-updated' })).json() as any
    assert.equal(update.name, 'crud-updated')

    const del = (
      await server().inject({ method: 'DELETE', url: `/v1/vector_stores/${id}` })
    ).json() as any
    assert.equal(del.id, id)
    assert.equal(del.object, 'vector_store.deleted')
    assert.equal(del.deleted, true)

    const after = await get(`/v1/vector_stores/${id}`)
    assert.equal(after.statusCode, 404)
  })

  it('upload → attach → search end-to-end', async () => {
    const doc = textFile(
      'Local e2e document about planets, moons and the solar system.\nAnother note about OpenAI vector stores and RAG.\n'
    )
    const vs = ((await post('/v1/vector_stores', { name: 'flow' })).json() as any).id

    const upload = (
      await server().inject({
        method: 'POST',
        url: '/v1/files',
        ...multipart([
          { name: 'file', filename: 'vs_doc.txt', contentType: 'text/plain', data: doc },
          { name: 'purpose', value: 'assistants' }
        ])
      })
    ).json() as any
    assert.equal(upload.object, 'file')
    assert.ok(String(upload.id).startsWith('file-'))
    assert.equal(upload.status, 'uploaded')
    assert.equal(upload.purpose, 'assistants')
    const file = upload.id

    assert.ok(((await get('/v1/files')).json() as any).data.some((f: any) => f.id === file))
    const meta = (await get(`/v1/files/${file}`)).json() as any
    assert.equal(meta.id, file)
    assert.equal(meta.object, 'file')

    const attach = (await post(`/v1/vector_stores/${vs}/files`, { file_id: file })).json() as any
    assert.equal(attach.object, 'vector_store.file')
    assert.equal(attach.id, file)
    assert.equal(attach.vector_store_id, vs)
    assert.equal(attach.status, 'completed')
    assert.equal(attach.last_error, null)
    assert.equal(typeof attach.usage_bytes, 'number')

    // Bytes dropped from the ephemeral store after attach.
    assert.equal((await get(`/v1/files/${file}`)).statusCode, 404)
    assert.equal(((await get(`/v1/vector_stores/${vs}`)).json() as any).status, 'completed')

    const search = (
      await post(`/v1/vector_stores/${vs}/search`, {
        query: 'planets and solar system',
        max_num_results: 5
      })
    ).json() as any
    assert.equal(search.object, 'vector_store.search_results.page')
    assert.ok(Array.isArray(search.data) && search.data.length > 0)
    const joined = search.data
      .map((hit: any) =>
        (hit.content ?? [])
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text ?? '')
          .join(' ')
      )
      .join(' ')
    assert.match(joined, /planets|moons|OpenAI|vector stores/i)

    await server().inject({ method: 'DELETE', url: `/v1/vector_stores/${vs}` })
  })

  it('search with missing query returns 400 missing_query', async () => {
    const vs = ((await post('/v1/vector_stores', {})).json() as any).id
    assertError(await post(`/v1/vector_stores/${vs}/search`, {}), 'missing_query')
    await server().inject({ method: 'DELETE', url: `/v1/vector_stores/${vs}` })
  })

  it('attach with unknown file_id returns 404 file_not_found', async () => {
    const vs = ((await post('/v1/vector_stores', {})).json() as any).id
    assertError(
      await post(`/v1/vector_stores/${vs}/files`, { file_id: 'file-doesnotexist' }),
      'file_not_found'
    )
    await server().inject({ method: 'DELETE', url: `/v1/vector_stores/${vs}` })
  })

  it('attach with missing file_id returns 400 missing_file_id', async () => {
    const vs = ((await post('/v1/vector_stores', {})).json() as any).id
    assertError(await post(`/v1/vector_stores/${vs}/files`, {}), 'missing_file_id')
    await server().inject({ method: 'DELETE', url: `/v1/vector_stores/${vs}` })
  })

  it('attach binary upload returns 400 unsupported_file_type', async () => {
    const vs = ((await post('/v1/vector_stores', { name: 'binary-sad' })).json() as any).id
    const upload = (
      await server().inject({
        method: 'POST',
        url: '/v1/files',
        ...multipart([
          { name: 'file', filename: 'bin.png', contentType: 'image/png', data: tinyPng() },
          { name: 'purpose', value: 'assistants' }
        ])
      })
    ).json() as any
    assertError(
      await post(`/v1/vector_stores/${vs}/files`, { file_id: upload.id }),
      'unsupported_file_type'
    )
    await server().inject({ method: 'DELETE', url: `/v1/vector_stores/${vs}` })
  })

  it('invalid id returns 400 invalid_vector_store_id', async () => {
    assertError(await get('/v1/vector_stores/bad%2Fid'), 'invalid_vector_store_id')
  })
})

describe('responses API', () => {
  it('startup banner documents the volatile store', () => {
    assert.match(server().qvac.responsesStore.bannerLine(), /in-memory only/i)
  })

  it('blocking completion returns response shape and stub header', async () => {
    const res = await post('/v1/responses', { model: E2E.llm, input: 'Reply with exactly OK.' })
    assert.match(String(res.headers['x-qvac-stub']), /responses-volatile/i)
    const body = res.json() as any
    assert.ok(String(body.id).startsWith('resp_'))
    assert.equal(body.object, 'response')
    assert.ok(body.output_text.length > 0)
    assert.equal(typeof body.usage.output_tokens, 'number')
  })

  it('streaming returns response.completed and stub header (no [DONE])', async () => {
    const res = await post('/v1/responses', {
      model: E2E.llm,
      input: 'Say hi.',
      stream: true,
      max_output_tokens: 512
    })
    assert.match(String(res.headers['x-qvac-stub']), /responses-volatile/i)
    assert.match(res.payload, /response\.created/)
    assert.match(res.payload, /response\.completed/)
    assert.ok(!res.payload.includes('data: [DONE]'))
  })

  it('store retrieve delete and input_items', async () => {
    const rid = (
      (await post('/v1/responses', { model: E2E.llm, input: 'ping', store: true })).json() as any
    ).id
    assert.ok(String(rid).startsWith('resp_'))

    const getRes = await get(`/v1/responses/${rid}`)
    assert.match(String(getRes.headers['x-qvac-stub']), /responses-volatile/i)
    assert.equal((getRes.json() as any).id, rid)

    const items = await get(`/v1/responses/${rid}/input_items`)
    assert.match(String(items.headers['x-qvac-stub']), /responses-volatile/i)
    const itemsBody = items.json() as any
    assert.equal(itemsBody.object, 'list')
    assert.ok(itemsBody.data.length >= 1)

    const del = (
      await server().inject({ method: 'DELETE', url: `/v1/responses/${rid}` })
    ).json() as any
    assert.equal(del.deleted, true)

    assertError(await get(`/v1/responses/${rid}`), 'response_not_found')
  })

  it('previous_response_id chains context', async () => {
    const rid = (
      (
        await post('/v1/responses', {
          model: E2E.llm,
          input: 'Remember the code word is XYZZY.',
          store: true,
          max_output_tokens: 512,
          temperature: 0,
          seed: 1
        })
      ).json() as any
    ).id
    const body2 = (
      await post('/v1/responses', {
        model: E2E.llm,
        previous_response_id: rid,
        input: 'What is the code word? Reply with one word only.',
        max_output_tokens: 512,
        temperature: 0,
        seed: 1
      })
    ).json() as any
    assert.match(body2.output_text, /XYZZY/i)
  })

  it('previous_response_id walks deeper than one step (chain depth 3)', async () => {
    const rid1 = (
      (
        await post('/v1/responses', {
          model: E2E.llm,
          input: 'Remember the code word is XYZZY.',
          store: true,
          max_output_tokens: 512,
          temperature: 0,
          seed: 1
        })
      ).json() as any
    ).id
    const rid2 = (
      (
        await post('/v1/responses', {
          model: E2E.llm,
          previous_response_id: rid1,
          input: 'Got it.',
          store: true,
          max_output_tokens: 256,
          temperature: 0,
          seed: 1
        })
      ).json() as any
    ).id
    const body3 = (
      await post('/v1/responses', {
        model: E2E.llm,
        previous_response_id: rid2,
        input: 'What is the code word? Reply with one word only.',
        max_output_tokens: 512,
        temperature: 0,
        seed: 1
      })
    ).json() as any
    assert.match(body3.output_text, /XYZZY/i)
  })

  it('bogus previous_response_id returns 404', async () => {
    assertError(
      await post('/v1/responses', {
        model: E2E.llm,
        previous_response_id: 'resp_nonexistent123',
        input: 'hi'
      }),
      'previous_response_not_found'
    )
  })

  it('rejects conversation id', async () => {
    assertError(
      await post('/v1/responses', { model: E2E.llm, conversation: 'conv_1', input: 'hi' }),
      'conversation_not_supported'
    )
  })

  it('rejects background mode', async () => {
    assertError(
      await post('/v1/responses', { model: E2E.llm, background: true, input: 'hi' }),
      'background_not_supported'
    )
  })

  it('rejects built-in web_search tool', async () => {
    assertError(
      await post('/v1/responses', { model: E2E.llm, input: 'hi', tools: [{ type: 'web_search' }] }),
      'invalid_tool_type'
    )
  })
})

describe('legacy completions', () => {
  it('blocking returns text_completion shape', async () => {
    const body = (
      await post('/v1/completions', {
        model: E2E.llm,
        prompt: 'Say hello and nothing else.',
        max_tokens: 4096
      })
    ).json() as any
    assert.ok(String(body.id).startsWith('cmpl-'))
    assert.equal(body.object, 'text_completion')
    assert.equal(body.model, E2E.llm)
    assert.equal(body.choices.length, 1)
    assert.equal(body.choices[0].index, 0)
    assert.equal(typeof body.choices[0].text, 'string')
    assert.ok(body.choices[0].text.length > 0)
    assert.equal(body.choices[0].logprobs, null)
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.equal(typeof body.usage.completion_tokens, 'number')
  })

  it('respects max_tokens', async () => {
    const body = (
      await post('/v1/completions', {
        model: E2E.llm,
        prompt: 'Write a very long story about a cat.',
        max_tokens: 8
      })
    ).json() as any
    assert.ok(body.choices[0].text.length > 0)
  })

  it('multi-prompt blocking returns N choices with matching indices', async () => {
    // Generous max_tokens so the reasoning model finishes naturally (stop, not length).
    const body = (
      await post('/v1/completions', {
        model: E2E.llm,
        prompt: ['Reply with the word "alpha".', 'Reply with the word "beta".'],
        max_tokens: 4096
      })
    ).json() as any
    assert.equal(body.object, 'text_completion')
    assert.equal(body.choices.length, 2)
    assert.equal(body.choices[0].index, 0)
    assert.equal(body.choices[1].index, 1)
    assert.ok(body.choices[0].text.length > 0)
    assert.ok(body.choices[1].text.length > 0)
    assert.equal(body.choices[0].finish_reason, 'stop')
    assert.equal(body.choices[1].finish_reason, 'stop')
  })

  it('multi-prompt with stream:true returns 400 unsupported_streaming', async () => {
    assertError(
      await post('/v1/completions', {
        model: E2E.llm,
        prompt: ['a', 'b'],
        stream: true,
        max_tokens: 4
      }),
      'unsupported_streaming'
    )
  })

  it('rejects token-id prompts', async () => {
    assertError(
      await post('/v1/completions', { model: E2E.llm, prompt: [15496, 11, 995], max_tokens: 4 }),
      'invalid_prompt'
    )
  })

  it('rejects missing prompt', async () => {
    assertError(await post('/v1/completions', { model: E2E.llm, max_tokens: 4 }), 'invalid_prompt')
  })

  it('SSE stream returns valid text_completion chunks', async () => {
    const res = await post('/v1/completions', {
      model: E2E.llm,
      prompt: 'Say hi.',
      stream: true,
      max_tokens: 512
    })
    const datas = collectSSE(res.payload).map((e) => e.data)
    assert.ok(datas.includes('[DONE]'))
    const chunks = datas.filter((d) => d !== '[DONE]') as any[]
    const first = chunks[0]
    assert.ok(String(first.id).startsWith('cmpl-'))
    assert.equal(first.object, 'text_completion')
    assert.equal(first.model, E2E.llm)
    assert.equal(typeof first.choices[0].text, 'string')
    assert.equal(first.choices[0].logprobs, null)
    const last = chunks[chunks.length - 1]
    assert.equal(last.choices[0].finish_reason, 'stop')
    assert.equal(typeof last.usage.completion_tokens, 'number')
    assert.ok(chunks.filter((c) => c.choices[0].text).length > 0)
  })
})

describe('cross-type model rejection', () => {
  it('chat endpoint rejects embedding model', async () => {
    assertError(
      await post('/v1/chat/completions', {
        model: E2E.embed,
        messages: [{ role: 'user', content: 'hi' }]
      }),
      'invalid_model_type'
    )
  })
  it('legacy completions endpoint rejects embedding model', async () => {
    assertError(
      await post('/v1/completions', { model: E2E.embed, prompt: 'hi' }),
      'invalid_model_type'
    )
  })
  it('embedding endpoint rejects chat model', async () => {
    assertError(
      await post('/v1/embeddings', { model: E2E.llm, input: 'hello' }),
      'invalid_model_type'
    )
  })
  it('transcription endpoint rejects chat model', async () => {
    assertError(
      await server().inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        ...multipart([{ name: 'model', value: E2E.llm }, wavField])
      }),
      'invalid_model_type'
    )
  })
  it('translations endpoint rejects chat model', async () => {
    assertError(
      await server().inject({
        method: 'POST',
        url: '/v1/audio/translations',
        ...multipart([{ name: 'model', value: E2E.llm }, wavField])
      }),
      'invalid_model_type'
    )
  })
  it('responses endpoint rejects embedding model', async () => {
    assertError(
      await post('/v1/responses', { model: E2E.embed, input: 'hello' }),
      'invalid_model_type'
    )
  })
})

const TINY_PNG_DATA_URI = `data:image/png;base64,${tinyPng().toString('base64')}`

describe('videos (HTTP layer only; test-video preload:false)', () => {
  it('JSON txt2vid reaches model check (503 model_not_ready)', async () => {
    assertError(
      await post('/v1/videos', { model: E2E.video, prompt: 'a bird flies' }),
      'model_not_ready'
    )
  })
  it('JSON img2vid with data URI reaches model check (503 model_not_ready)', async () => {
    assertError(
      await post('/v1/videos', {
        model: E2E.video,
        prompt: 'subject turns',
        input_reference: { image_url: TINY_PNG_DATA_URI }
      }),
      'model_not_ready'
    )
  })
  it('JSON img2vid with HTTP URL reaches model check (503 model_not_ready)', async () => {
    assertError(
      await post('/v1/videos', {
        model: E2E.video,
        prompt: 'subject turns',
        input_reference: { image_url: 'http://127.0.0.1:1/v1/models' }
      }),
      'model_not_ready'
    )
  })
  it('input_reference with wrong shape returns 400 invalid_request', async () => {
    assertError(
      await post('/v1/videos', {
        model: E2E.video,
        prompt: 'p',
        input_reference: { not_image_url: 'x' }
      }),
      'invalid_request'
    )
  })
  it('multipart POST with input_reference file reaches model check (503 model_not_ready)', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/videos',
      ...multipart([
        { name: 'model', value: E2E.video },
        { name: 'prompt', value: 'subject turns' },
        { name: 'input_reference', filename: 'ref.png', contentType: 'image/png', data: tinyPng() }
      ])
    })
    assertError(res, 'model_not_ready')
  })
})
