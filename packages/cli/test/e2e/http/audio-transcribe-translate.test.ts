import { describe, it } from 'node:test'
import { useServer } from '../helpers/server.js'
import { assertError, multipart, JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'

// An empty file part with a filename: file present, contents empty.
const EMPTY_FILE = { name: 'file', filename: 'audio.wav', contentType: 'audio/wav', data: Buffer.alloc(0) }

describe('serve: transcriptions validation', () => {
  const server = useServer({ cors: true })

  it('JSON content-type returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/transcriptions', headers: JSON_HEADERS, payload: '{"model":"test"}' })
    assertStatusAndError(res, 400, 'invalid_content_type')
  })

  it('missing file returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/transcriptions', ...multipart([{ name: 'model', value: 'test' }]) })
    assertStatusAndError(res, 400, 'missing_file')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/transcriptions', ...multipart([EMPTY_FILE]) })
    assertStatusAndError(res, 400, 'missing_model')
  })

  for (const fmt of ['srt', 'vtt', 'verbose_json']) {
    it(`unsupported ${fmt} format returns 400`, async () => {
      const res = await server().inject({
        method: 'POST',
        url: '/v1/audio/transcriptions',
        ...multipart([{ name: 'model', value: 'test' }, { name: 'response_format', value: fmt }, EMPTY_FILE])
      })
      assertStatusAndError(res, 400, 'unsupported_response_format')
    })
  }

  it('invalid xml format returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([{ name: 'model', value: 'test' }, { name: 'response_format', value: 'xml' }, EMPTY_FILE])
    })
    assertStatusAndError(res, 400, 'invalid_response_format')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/audio/transcriptions', ...multipart([{ name: 'model', value: 'nonexistent' }, EMPTY_FILE])
    })
    assertStatusAndError(res, 404, 'model_not_found')
  })
})

describe('serve: translations validation', () => {
  const server = useServer({ cors: true })

  it('JSON content-type returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/translations', headers: JSON_HEADERS, payload: '{"model":"test"}' })
    assertStatusAndError(res, 400, 'invalid_content_type')
  })

  it('missing file returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/translations', ...multipart([{ name: 'model', value: 'test' }]) })
    assertStatusAndError(res, 400, 'missing_file')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({ method: 'POST', url: '/v1/audio/translations', ...multipart([EMPTY_FILE]) })
    assertStatusAndError(res, 400, 'missing_model')
  })

  it('language field returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/audio/translations',
      ...multipart([{ name: 'model', value: 'fake-transcribe' }, { name: 'language', value: 'es' }, EMPTY_FILE])
    })
    assertStatusAndError(res, 400, 'unsupported_param')
  })

  it('unsupported srt format returns 400', async () => {
    const res = await server().inject({
      method: 'POST', url: '/v1/audio/translations',
      ...multipart([{ name: 'model', value: 'fake-transcribe' }, { name: 'response_format', value: 'srt' }, EMPTY_FILE])
    })
    assertStatusAndError(res, 400, 'unsupported_response_format')
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
    assertStatusAndError(res, 404, 'model_not_found')
  })
})
