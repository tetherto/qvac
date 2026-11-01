import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useModelServer } from '../helpers/server.js'
import { assertStatusAndError, multipart } from '../helpers/http.js'
import { blackPng, tinyJpeg, tinyPng } from '../helpers/fixtures.js'

const ALIAS = 'test-upscaler'

const UPSCALE_CONFIG = {
  serve: {
    models: {
      [ALIAS]: {
        model: 'REALESRGAN_X4PLUS_ANIME_6B',
        preload: true,
        config: { mode: 'upscale', device: 'cpu', upscaler: { tile_size: 64 } }
      }
    }
  }
}

interface UpscaleResult {
  created: number
  output_format: string
  size?: string
  data: { b64_json: string }[]
}

function pngSize(png: Buffer): string {
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', 'expected a PNG')
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`
}

describe('qvac images upscale: real ESRGAN model', () => {
  const server = useModelServer(UPSCALE_CONFIG)

  it('upscales a JSON data URL by the model scale', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/images/upscale',
      payload: {
        model: ALIAS,
        image: `data:image/png;base64,${tinyPng().toString('base64')}`
      }
    })
    assert.equal(res.statusCode, 200, res.body)

    const body = res.json() as UpscaleResult
    assert.equal(body.output_format, 'png')
    assert.equal(body.data.length, 1)
    const png = Buffer.from(body.data[0]!.b64_json, 'base64')
    assert.equal(pngSize(png), '4x4')
    assert.equal(body.size, '4x4')
  })

  it('upscales a JPEG and returns a PNG', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/images/upscale',
      ...multipart([
        { name: 'model', value: ALIAS },
        { name: 'image', filename: 'tiny.jpg', contentType: 'image/jpeg', data: tinyJpeg() }
      ])
    })
    assert.equal(res.statusCode, 200, res.body)

    const body = res.json() as UpscaleResult
    assert.equal(pngSize(Buffer.from(body.data[0]!.b64_json, 'base64')), '4x4')
  })

  it('an image the addon cannot decode returns 400 invalid_image', async () => {
    const truncated = tinyPng().subarray(0, 30)
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/images/upscale',
      payload: { model: ALIAS, image: `data:image/png;base64,${truncated.toString('base64')}` }
    })
    assertStatusAndError(res, 400, 'invalid_image')
  })

  it('an output over the 16,384-pixel edge returns 400 image_too_large', async () => {
    const wide = blackPng(4097, 1)
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/images/upscale',
      payload: { model: ALIAS, image: `data:image/png;base64,${wide.toString('base64')}` }
    })
    assertStatusAndError(res, 400, 'image_too_large')
  })

  it('runs repeats passes on a multipart upload', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/images/upscale',
      ...multipart([
        { name: 'model', value: ALIAS },
        { name: 'image', filename: 'tiny.png', contentType: 'image/png', data: tinyPng() },
        { name: 'repeats', value: '2' }
      ])
    })
    assert.equal(res.statusCode, 200, res.body)

    const body = res.json() as UpscaleResult
    assert.equal(pngSize(Buffer.from(body.data[0]!.b64_json, 'base64')), '16x16')
  })
})
