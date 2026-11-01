import { describe, it } from 'node:test'
import { useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError, multipart } from '../helpers/http.js'
import { textFile, tinyPng } from '../helpers/fixtures.js'

const ROUTE = '/qvac/v1/classifications'

// Neither src resolves, so a request that reaches the model load fails with a
// 503. Every image error below must therefore be raised before the load.
const CLASSIFICATION_CONFIG = {
  serve: {
    models: {
      cls: {
        type: 'ggml-classification',
        src: 'hyper://example.invalid/classifier',
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

const PNG_DATA_URL = `data:image/png;base64,${tinyPng().toString('base64')}`

describe('qvac classifications: validation', () => {
  const server = useServer({ config: CLASSIFICATION_CONFIG })

  function classify(payload: object) {
    return server().inject({ method: 'POST', url: ROUTE, payload })
  }

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: ROUTE,
      headers: JSON_HEADERS,
      payload: '{{bad'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing model returns 400', async () => {
    assertStatusAndError(await classify({ image: PNG_DATA_URL }), 400, 'missing_model')
  })

  it('missing image returns 400 with the extension-contributed code', async () => {
    assertStatusAndError(await classify({ model: 'cls' }), 400, 'missing_image')
  })

  it('rejects an unknown field', async () => {
    const res = await classify({ model: 'cls', image: PNG_DATA_URL, nope: true })
    assertStatusAndError(res, 400, 'invalid_request')
  })

  it('rejects a top_k that is not a positive integer', async () => {
    const res = await classify({ model: 'cls', image: PNG_DATA_URL, top_k: 0 })
    assertStatusAndError(res, 400, 'invalid_request')
  })

  it('rejects an empty data URL', async () => {
    assertStatusAndError(
      await classify({ model: 'cls', image: 'data:image/png;base64,' }),
      400,
      'empty_input'
    )
  })

  it('rejects a data URL that is not base64', async () => {
    const res = await classify({ model: 'cls', image: 'data:image/png,not-base64' })
    assertStatusAndError(res, 400, 'invalid_data_url')
  })

  it('rejects an unknown file id', async () => {
    assertStatusAndError(
      await classify({ model: 'cls', image: 'file-nope' }),
      400,
      'file_not_found'
    )
  })

  it('rejects a data URL whose bytes are not an image', async () => {
    const image = `data:image/png;base64,${textFile('hello').toString('base64')}`
    assertStatusAndError(await classify({ model: 'cls', image }), 400, 'unsupported_image_format')
  })

  it('rejects a multipart upload whose bytes are not an image', async () => {
    const { payload, headers } = multipart([
      { name: 'model', value: 'cls' },
      { name: 'image', filename: 'note.txt', contentType: 'text/plain', data: textFile('hello') }
    ])
    const res = await server().inject({ method: 'POST', url: ROUTE, payload, headers })
    assertStatusAndError(res, 400, 'unsupported_image_format')
  })

  it('rejects a multipart top_k that is not an integer', async () => {
    const { payload, headers } = multipart([
      { name: 'model', value: 'cls' },
      { name: 'image', filename: 'a.png', contentType: 'image/png', data: tinyPng() },
      { name: 'top_k', value: 'two' }
    ])
    const res = await server().inject({ method: 'POST', url: ROUTE, payload, headers })
    assertStatusAndError(res, 400, 'invalid_request')
  })

  it('unknown model returns 404', async () => {
    assertStatusAndError(
      await classify({ model: 'nope', image: PNG_DATA_URL }),
      404,
      'model_not_found'
    )
  })

  it('a chat model returns invalid_model_type', async () => {
    const res = await classify({ model: 'chat-model', image: PNG_DATA_URL })
    assertStatusAndError(res, 400, 'invalid_model_type')
  })
})
