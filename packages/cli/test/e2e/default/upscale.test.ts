import { describe, it } from 'node:test'
import { useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError, multipart } from '../helpers/http.js'
import { tinyPng, textFile } from '../helpers/fixtures.js'

const URL = '/qvac/v1/images/upscale'

const UPSCALE_CONFIG = {
  serve: {
    models: {
      upscaler: {
        type: 'sdcpp-generation',
        src: 'hyper://example.invalid/esrgan',
        preload: false,
        config: { mode: 'upscale' }
      },
      'image-model': {
        type: 'sdcpp-generation',
        src: 'hyper://example.invalid/sd',
        preload: false
      }
    }
  }
} as const

const PNG_DATA_URL = `data:image/png;base64,${tinyPng().toString('base64')}`

describe('qvac images upscale: validation', () => {
  const server = useServer({ config: UPSCALE_CONFIG })

  function upscale(payload: object) {
    return server().inject({ method: 'POST', url: URL, payload })
  }

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL,
      headers: JSON_HEADERS,
      payload: '{{bad'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing model returns 400', async () => {
    assertStatusAndError(await upscale({ image: PNG_DATA_URL }), 400, 'missing_model')
  })

  it('missing image returns 400', async () => {
    assertStatusAndError(await upscale({ model: 'upscaler' }), 400, 'missing_image')
  })

  it('missing multipart image returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL,
      ...multipart([{ name: 'model', value: 'upscaler' }])
    })
    assertStatusAndError(res, 400, 'missing_image')
  })

  it('repeats over the cap returns 400', async () => {
    const res = await upscale({ model: 'upscaler', image: PNG_DATA_URL, repeats: 5 })
    assertStatusAndError(res, 400, 'invalid_repeats')
  })

  it('a non-numeric multipart repeats returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL,
      ...multipart([
        { name: 'model', value: 'upscaler' },
        { name: 'image', filename: 'tiny.png', contentType: 'image/png', data: tinyPng() },
        { name: 'repeats', value: 'two' }
      ])
    })
    assertStatusAndError(res, 400, 'invalid_repeats')
  })

  it('rejects an unknown field', async () => {
    const res = await upscale({ model: 'upscaler', image: PNG_DATA_URL, response_format: 'url' })
    assertStatusAndError(res, 400, 'invalid_request')
  })

  it('a data URL that is not base64 returns 400', async () => {
    const res = await upscale({ model: 'upscaler', image: 'data:image/png,abc' })
    assertStatusAndError(res, 400, 'invalid_data_url')
  })

  it('an unknown file id returns 400', async () => {
    const res = await upscale({ model: 'upscaler', image: 'file-nope' })
    assertStatusAndError(res, 400, 'file_not_found')
  })

  it('an empty upload returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL,
      ...multipart([
        { name: 'model', value: 'upscaler' },
        { name: 'image', filename: 'empty.png', contentType: 'image/png', data: Buffer.alloc(0) }
      ])
    })
    assertStatusAndError(res, 400, 'empty_input')
  })

  it('refuses a non-image before resolving the model', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL,
      ...multipart([
        { name: 'model', value: 'nope' },
        { name: 'image', filename: 'a.txt', contentType: 'text/plain', data: textFile('hi') }
      ])
    })
    assertStatusAndError(res, 400, 'unsupported_image_format')
  })

  it('refuses a PNG prefix without the full 8-byte signature', async () => {
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('junk')])
    const res = await upscale({
      model: 'upscaler',
      image: `data:image/png;base64,${fake.toString('base64')}`
    })
    assertStatusAndError(res, 400, 'unsupported_image_format')
  })

  it('unknown model returns 404', async () => {
    assertStatusAndError(
      await upscale({ model: 'nope', image: PNG_DATA_URL }),
      404,
      'model_not_found'
    )
  })

  it('a generation-mode diffusion model returns invalid_model_type', async () => {
    const res = await upscale({ model: 'image-model', image: PNG_DATA_URL })
    assertStatusAndError(res, 400, 'invalid_model_type')
  })
})
