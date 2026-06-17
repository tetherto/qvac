import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { useServer } from '../helpers/server.js'
import { assertError, multipart, JSON_HEADERS } from '../helpers/http.js'

// An empty file part with a filename — the bats `file=@/dev/null;filename=audio.wav`.
const EMPTY_FILE = { name: 'file', filename: 'audio.wav', contentType: 'audio/wav', data: Buffer.alloc(0) }

// Ported from cli.bats "Serve: transcriptions validation".
describe('serve: transcriptions validation', () => {
  const server = useServer({ cors: true })

  it('JSON content-type returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/transcriptions', headers: JSON_HEADERS, payload: '{"model":"test"}' })
    assert.equal(res.statusCode, 400)
    assertError(res, 'invalid_content_type')
  })

  it('missing file returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/transcriptions', ...multipart([{ name: 'model', value: 'test' }]) })
    assert.equal(res.statusCode, 400)
    assertError(res, 'missing_file')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/transcriptions', ...multipart([EMPTY_FILE]) })
    assert.equal(res.statusCode, 400)
    assertError(res, 'missing_model')
  })

  for (const fmt of ['srt', 'vtt', 'verbose_json']) {
    it(`unsupported ${fmt} format returns 400`, async () => {
      const res = await server().inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        ...multipart([{ name: 'model', value: 'test' }, { name: 'response_format', value: fmt }, EMPTY_FILE])
      })
      assert.equal(res.statusCode, 400)
      assertError(res, 'unsupported_response_format')
    })
  }

  it('invalid xml format returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([{ name: 'model', value: 'test' }, { name: 'response_format', value: 'xml' }, EMPTY_FILE])
    })
    assert.equal(res.statusCode, 400)
    assertError(res, 'invalid_response_format')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/audio/transcriptions', ...multipart([{ name: 'model', value: 'nonexistent' }, EMPTY_FILE])
    })
    assert.equal(res.statusCode, 404)
    assertError(res, 'model_not_found')
  })
})

// Ported from cli.bats "Serve: translations validation".
describe('serve: translations validation', () => {
  const server = useServer({ cors: true })

  it('JSON content-type returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/translations', headers: JSON_HEADERS, payload: '{"model":"test"}' })
    assert.equal(res.statusCode, 400)
    assertError(res, 'invalid_content_type')
  })

  it('missing file returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/translations', ...multipart([{ name: 'model', value: 'test' }]) })
    assert.equal(res.statusCode, 400)
    assertError(res, 'missing_file')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/translations', ...multipart([EMPTY_FILE]) })
    assert.equal(res.statusCode, 400)
    assertError(res, 'missing_model')
  })

  it('language field returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/audio/translations',
      ...multipart([{ name: 'model', value: 'fake-transcribe' }, { name: 'language', value: 'es' }, EMPTY_FILE])
    })
    assert.equal(res.statusCode, 400)
    assertError(res, 'unsupported_param')
  })

  it('unsupported srt format returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/audio/translations',
      ...multipart([{ name: 'model', value: 'fake-transcribe' }, { name: 'response_format', value: 'srt' }, EMPTY_FILE])
    })
    assert.equal(res.statusCode, 400)
    assertError(res, 'unsupported_response_format')
  })

  it('transcription-only model returns invalid_model_type', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/audio/translations', ...multipart([{ name: 'model', value: 'fake-transcribe' }, EMPTY_FILE])
    })
    assertError(res, 'invalid_model_type')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/audio/translations', ...multipart([{ name: 'model', value: 'nonexistent' }, EMPTY_FILE])
    })
    assert.equal(res.statusCode, 404)
    assertError(res, 'model_not_found')
  })
})
