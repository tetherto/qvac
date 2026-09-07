import { describe, it } from 'node:test'
import { useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'

const TRANSLATE_CONFIG = {
  serve: {
    models: {
      'ta-en': {
        type: 'nmtcpp-translation',
        src: 'hyper://example.invalid/ta-en',
        preload: false
      },
      'chat-model': {
        type: 'llamacpp-completion',
        src: 'hyper://example.invalid/chat',
        preload: false
      }
    }
  }
} as const

describe('qvac translate: validation', () => {
  const server = useServer({ config: TRANSLATE_CONFIG })

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/translate',
      headers: JSON_HEADERS,
      payload: '{{bad'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/translate',
      payload: { text: 'வணக்கம்' }
    })
    assertStatusAndError(res, 400, 'missing_model')
  })

  it('missing text returns 400 with the extension-contributed code', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/translate',
      payload: { model: 'ta-en' }
    })
    assertStatusAndError(res, 400, 'missing_text')
  })

  it('empty text returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/translate',
      payload: { model: 'ta-en', text: '' }
    })
    assertStatusAndError(res, 400, 'missing_text')
  })

  it('rejects a batch over the input cap with its own code', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/translate',
      payload: { model: 'ta-en', text: Array.from({ length: 101 }, () => 'a') }
    })
    assertStatusAndError(res, 400, 'too_many_inputs')
  })

  it('rejects an unknown field', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/translate',
      payload: { model: 'ta-en', text: 'வணக்கம்', nope: true }
    })
    assertStatusAndError(res, 400, 'invalid_request')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/translate',
      payload: { model: 'nope', text: 'வணக்கம்' }
    })
    assertStatusAndError(res, 404, 'model_not_found')
  })

  it('a chat model returns invalid_model_type', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/translate',
      payload: { model: 'chat-model', text: 'வணக்கம்' }
    })
    assertStatusAndError(res, 400, 'invalid_model_type')
  })
})
