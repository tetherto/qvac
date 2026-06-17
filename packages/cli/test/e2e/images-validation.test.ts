import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from './helpers/server.js'
import { assertError, multipart, JSON_HEADERS } from './helpers/http.js'
import { tinyPng } from './helpers/fixtures.js'

// Ported from cli.bats "Serve: images generations validation (JSON)".
// Image routes resolve the model BEFORE per-param checks, so unknown models
// surface model_not_found (404) rather than the per-param error.
describe('serve: images generations validation', () => {
  const server = useServer({ cors: true })

  it('missing model returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/images/generations', payload: { prompt: 'a red square' } })
    assert.equal(res.statusCode, 400)
    assertError(res, 'missing_model')
  })

  const modelFirst: Array<[string, Record<string, unknown>]> = [
    ['invalid response_format', { model: 'x', prompt: 'a red square', response_format: 'png' }],
    ['unknown model', { model: 'nonexistent', prompt: 'a red square' }],
    ['response_format=url without publicBaseUrl', { model: 'x', prompt: 'a red square', response_format: 'url' }],
    ['output_format=jpeg', { model: 'x', prompt: 'p', output_format: 'jpeg' }],
    ['output_compression', { model: 'x', prompt: 'p', output_compression: 80 }],
    ['background', { model: 'x', prompt: 'p', background: 'transparent' }]
  ]
  for (const [name, payload] of modelFirst) {
    it(`${name} returns 404 model_not_found (model resolves first)`, async () => {
      const res = await server().inject({ method: 'POST', url: '/v1/images/generations', payload })
      assert.equal(res.statusCode, 404)
      assertError(res, 'model_not_found')
    })
  }
})

// Ported from cli.bats "Serve: images edits validation (multipart)".
describe('serve: images edits validation', () => {
  const server = useServer({ cors: true })
  const image = (): { name: string, filename: string, contentType: string, data: Buffer } =>
    ({ name: 'image', filename: 'tiny.png', contentType: 'image/png', data: tinyPng() })

  it('JSON body returns 400 invalid_content_type', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/images/edits', headers: JSON_HEADERS, payload: '{"model":"test","prompt":"hi"}' })
    assert.equal(res.statusCode, 400)
    assertError(res, 'invalid_content_type')
  })

  it('missing image returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/images/edits', ...multipart([{ name: 'model', value: 'test' }, { name: 'prompt', value: 'make it blue' }]) })
    assert.equal(res.statusCode, 400)
    assertError(res, 'missing_image')
  })

  it('mask file returns 400 mask_not_supported', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/images/edits',
      ...multipart([image(), { name: 'mask', filename: 'tiny.png', contentType: 'image/png', data: tinyPng() }, { name: 'model', value: 'test' }, { name: 'prompt', value: 'hi' }])
    })
    assert.equal(res.statusCode, 400)
    assertError(res, 'mask_not_supported')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/images/edits', ...multipart([image(), { name: 'prompt', value: 'make it blue' }]) })
    assert.equal(res.statusCode, 400)
    assertError(res, 'missing_model')
  })

  const modelFirst: Array<[string, Array<{ name: string, value?: string, filename?: string, contentType?: string, data?: Buffer }>]> = [
    ['invalid response_format', [{ name: 'model', value: 'nonexistent' }, { name: 'prompt', value: 'make it blue' }, { name: 'response_format', value: 'png' }]],
    ['response_format=url without publicBaseUrl', [{ name: 'model', value: 'x' }, { name: 'prompt', value: 'p' }, { name: 'response_format', value: 'url' }]],
    ['output_format=jpeg', [{ name: 'model', value: 'x' }, { name: 'prompt', value: 'p' }, { name: 'output_format', value: 'jpeg' }]],
    ['background', [{ name: 'model', value: 'x' }, { name: 'prompt', value: 'p' }, { name: 'background', value: 'transparent' }]],
    ['unknown model', [{ name: 'model', value: 'nonexistent' }, { name: 'prompt', value: 'make it blue' }]],
    ['stream=true not rejected before model lookup', [{ name: 'model', value: 'nonexistent' }, { name: 'prompt', value: 'p' }, { name: 'stream', value: 'true' }]]
  ]
  for (const [name, fields] of modelFirst) {
    it(`${name} returns 404 model_not_found (model resolves first)`, async () => {
      const res = await server().inject({ method: 'POST', url: '/v1/images/edits', ...multipart([image(), ...fields]) })
      assert.equal(res.statusCode, 404)
      assertError(res, 'model_not_found')
    })
  }
})

// Ported from cli.bats images on the publicBaseUrl-enabled server.
describe('serve: images on publicBaseUrl server', () => {
  const server = useServer({ publicBaseUrl: 'http://127.0.0.1:19923' })

  it('response_format=url is ACCEPTED when publicBaseUrl is set (then 404 on unknown model)', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/images/generations', payload: { model: 'nonexistent', prompt: 'p', response_format: 'url' } })
    assert.equal(res.statusCode, 404)
    assertError(res, 'model_not_found')
  })
})
