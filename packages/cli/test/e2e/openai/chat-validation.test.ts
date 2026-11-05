import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RequestRejectedByPolicyError } from '@qvac/sdk'
import { createServer, useServer } from '../helpers/server.js'
import { openaiState } from '@/serve/extensions/openai/state'
import { JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'

describe('serve: chat completions validation', () => {
  const server = useServer({ cors: true, corsOrigins: ['https://trusted.example'] })

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: JSON_HEADERS,
      payload: '{not valid json}'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { messages: [{ role: 'user', content: 'hi' }] }
    })
    assertStatusAndError(res, 400, 'missing_model')
  })

  it('missing messages returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'test' }
    })
    assertStatusAndError(res, 400, 'missing_messages')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'nonexistent', messages: [{ role: 'user', content: 'hi' }] }
    })
    assertStatusAndError(res, 404, 'model_not_found')
  })

  it('returns 429 when an existing chat route exceeds its model queue policy', async (t) => {
    const app = await createServer(t, {
      extensions: ['openai'],
      config: {
        serve: {
          models: {
            chat: { src: '/models/chat.gguf', type: 'llamacpp-completion', preload: false }
          }
        }
      },
      loadModelOverride: () => Promise.resolve('sdk-chat-id')
    })
    const busy = new RequestRejectedByPolicyError(
      'chat-overflow',
      'completion',
      'sdk-chat-id',
      'maxQueueDepthPerModel exceeded (depth=64, cap=64)'
    )
    openaiState(app.qvac).completionOverride = () => {
      throw busy
    }

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'chat', messages: [{ role: 'user', content: 'hi' }], stream: false }
    })
    assert.equal(res.statusCode, 429, res.body)
    assert.deepEqual(res.json().error, {
      message: busy.message,
      type: 'rate_limit_error',
      code: 'request_rejected_by_policy'
    })
  })
})
