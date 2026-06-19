import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { assertError, JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'
import { probeFfmpegAvailable } from '../../../src/serve/lib/video-transcode.js'

describe('serve: speech validation', () => {
  const server = useServer({ cors: true })

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/speech', headers: JSON_HEADERS, payload: '{not valid json}' })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/speech', payload: { input: 'hello', voice: 'alloy' } })
    assertStatusAndError(res, 400, 'missing_model')
  })

  it('missing input returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/speech', payload: { model: 'test', voice: 'alloy' } })
    assertStatusAndError(res, 400, 'missing_input')
  })

  it('empty input returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/speech', payload: { model: 'test', voice: 'alloy', input: '   ' } })
    assertStatusAndError(res, 400, 'missing_input')
  })

  // ffmpeg-dependent: with ffmpeg the route reaches model lookup (model_not_found);
  // without it, the transcode is rejected up front (transcode_unavailable).
  let ffmpeg = false
  before(async () => { ffmpeg = await probeFfmpegAvailable() })

  for (const fmt of ['mp3', 'opus', 'aac', 'flac']) {
    it(`${fmt} format: transcode_unavailable without ffmpeg, model_not_found with ffmpeg`, async () => {
      const res = await server().inject({ method: 'POST', url: '/v1/audio/speech', payload: { model: 'test', voice: 'alloy', input: 'hi', response_format: fmt } })
      assertError(res, ffmpeg ? 'model_not_found' : 'transcode_unavailable')
    })
  }

  it('unknown response_format returns 400 invalid_response_format', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/speech', payload: { model: 'test', voice: 'alloy', input: 'hi', response_format: 'mp4' } })
    assertStatusAndError(res, 400, 'invalid_response_format')
  })

  it('input over default 4096-char cap returns 400 input_too_long', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/speech', payload: { model: 'test', voice: 'alloy', input: 'a'.repeat(4097) } })
    assertStatusAndError(res, 400, 'input_too_long')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/speech', payload: { model: 'nonexistent', voice: 'alloy', input: 'hi' } })
    assertStatusAndError(res, 404, 'model_not_found')
  })

  it('defaults voice to alloy when omitted (still 404 model_not_found)', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/speech', payload: { model: 'nonexistent', input: 'hi' } })
    assertStatusAndError(res, 404, 'model_not_found')
  })
})

describe('serve: speech auth', () => {
  const server = useServer({ apiKey: 'test-secret-key-12345' })

  it('auth required when api-key set', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/speech', payload: { model: 'test', voice: 'alloy', input: 'hi' } })
    assertStatusAndError(res, 401, 'invalid_api_key')
  })
})

describe('serve: audio discovery', () => {
  const server = useServer({ cors: true })

  it('GET /v1/audio/models returns empty list when no speech models loaded', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/audio/models' })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { object: string, data: unknown[] }
    assert.equal(body.object, 'list')
    assert.equal(body.data.length, 0)
  })

  it('GET /v1/audio/voices returns the default alloy voice', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/audio/voices' })
    assert.equal(res.statusCode, 200)
    const body = res.json() as { object: string, voices: string[], data: Array<Record<string, unknown>> }
    assert.equal(body.object, 'list')
    assert.deepEqual(body.voices, ['alloy'])
    assert.deepEqual(body.data[0], { id: 'alloy', object: 'audio.voice', model: null })
  })
})
