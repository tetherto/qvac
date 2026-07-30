import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { describe, it } from 'node:test'
import type { TestContext } from 'node:test'
import type { transcribe, TranscribeSegment } from '@qvac/sdk'
import { createServer, useServer } from '../helpers/server.js'
import { assertError, multipart, JSON_HEADERS, assertStatusAndError } from '../helpers/http.js'

type TranscribeClientParams = Parameters<typeof transcribe>[0]

// An empty file part with a filename: file present, contents empty.
const EMPTY_FILE = {
  name: 'file',
  filename: 'audio.wav',
  contentType: 'audio/wav',
  data: Buffer.alloc(0)
}

const TIMED_SEGMENTS: TranscribeSegment[] = [
  { id: 0, startMs: 0, endMs: 1_250, text: ' Hello', append: false },
  { id: 1, startMs: 1_250, endMs: 2_500, text: ' world', append: true }
]

const AUDIO_CONFIG = {
  serve: {
    models: {
      'whisper-transcription': {
        type: 'whispercpp-transcription',
        src: 'hyper://example.invalid/whisper-transcription',
        preload: false
      },
      'whisper-translation': {
        type: 'whispercpp-audio-translation',
        src: 'hyper://example.invalid/whisper-translation',
        preload: false
      },
      'non-whisper-translation': {
        type: 'audio-translation',
        src: 'hyper://example.invalid/non-whisper-translation',
        preload: false
      },
      'parakeet-transcription': {
        type: 'parakeet-transcription',
        src: 'hyper://example.invalid/parakeet-transcription',
        preload: false
      }
    }
  }
} as const

function makeTranscribeOverride(calls: TranscribeClientParams[]) {
  function transcribeOverride(opts: TranscribeClientParams) {
    calls.push(opts)
    const value = opts.metadata === true ? TIMED_SEGMENTS : 'Hello world'
    const promise = Promise.resolve(value) as Promise<string | TranscribeSegment[]> & {
      requestId: string
    }
    promise.requestId = 'req-audio-format'
    return promise
  }
  return transcribeOverride
}

async function createReadyAudioServer(t: TestContext) {
  const calls: TranscribeClientParams[] = []
  const boundRequestIds: string[] = []
  const app = await createServer(t, {
    config: AUDIO_CONFIG,
    transcribeOverride: makeTranscribeOverride(calls)
  })
  app.addHook('onRequest', (req, _reply, done) => {
    const bindCancel = req.bindCancel
    req.bindCancel = (requestId: string) => {
      boundRequestIds.push(requestId)
      bindCancel(requestId)
    }
    done()
  })
  await app.ready()
  for (const [alias, entry] of app.qvac.serveConfig.models) {
    app.qvac.registry.register(alias, entry)
  }
  app.qvac.registry.setReady('whisper-transcription', 'sdk-whisper-transcription')
  app.qvac.registry.setReady('whisper-translation', 'sdk-whisper-translation')
  app.qvac.registry.setReady('non-whisper-translation', 'sdk-non-whisper-translation')
  app.qvac.registry.setReady('parakeet-transcription', 'sdk-parakeet-transcription')
  return { app, calls, boundRequestIds }
}

describe('serve: transcriptions validation', () => {
  const server = useServer({ cors: true })

  it('JSON content-type returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      headers: JSON_HEADERS,
      payload: '{"model":"test"}'
    })
    assertStatusAndError(res, 400, 'invalid_content_type')
  })

  it('missing file returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([{ name: 'model', value: 'test' }])
    })
    assertStatusAndError(res, 400, 'missing_file')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([EMPTY_FILE])
    })
    assertStatusAndError(res, 400, 'missing_model')
  })

  it('invalid xml format returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([
        { name: 'model', value: 'test' },
        { name: 'response_format', value: 'xml' },
        EMPTY_FILE
      ])
    })
    assertStatusAndError(res, 400, 'invalid_response_format')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([{ name: 'model', value: 'nonexistent' }, EMPTY_FILE])
    })
    assertStatusAndError(res, 404, 'model_not_found')
  })
})

describe('serve: translations validation', () => {
  const server = useServer({ cors: true })

  it('JSON content-type returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/translations',
      headers: JSON_HEADERS,
      payload: '{"model":"test"}'
    })
    assertStatusAndError(res, 400, 'invalid_content_type')
  })

  it('missing file returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/translations',
      ...multipart([{ name: 'model', value: 'test' }])
    })
    assertStatusAndError(res, 400, 'missing_file')
  })

  it('missing model returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/translations',
      ...multipart([EMPTY_FILE])
    })
    assertStatusAndError(res, 400, 'missing_model')
  })

  it('language field returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/translations',
      ...multipart([
        { name: 'model', value: 'fake-transcribe' },
        { name: 'language', value: 'es' },
        EMPTY_FILE
      ])
    })
    assertStatusAndError(res, 400, 'unsupported_param')
  })

  it('transcription-only model returns invalid_model_type', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/translations',
      ...multipart([{ name: 'model', value: 'fake-transcribe' }, EMPTY_FILE])
    })
    assertError(res, 'invalid_model_type')
  })

  it('unknown model returns 404', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/v1/audio/translations',
      ...multipart([{ name: 'model', value: 'nonexistent' }, EMPTY_FILE])
    })
    assertStatusAndError(res, 404, 'model_not_found')
  })
})

describe('serve: timed transcription and translation formats', () => {
  it('returns SRT transcription from Whisper segment metadata', async (t) => {
    const { app, calls, boundRequestIds } = await createReadyAudioServer(t)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([
        { name: 'model', value: 'whisper-transcription' },
        { name: 'response_format', value: 'srt' },
        EMPTY_FILE
      ])
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(
      res.body,
      '1\n00:00:00,000 --> 00:00:01,250\nHello\n\n' + '2\n00:00:01,250 --> 00:00:02,500\nworld\n'
    )
    assert.equal(calls[0]?.metadata, true)
    assert.deepEqual(boundRequestIds, ['req-audio-format'])
    const audioChunk = calls[0]?.audioChunk
    assert.equal(typeof audioChunk, 'string')
    assert.equal(existsSync(audioChunk as string), false)
  })

  it('returns WebVTT transcription from Whisper segment metadata', async (t) => {
    const { app, calls } = await createReadyAudioServer(t)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([
        { name: 'model', value: 'whisper-transcription' },
        { name: 'response_format', value: 'vtt' },
        EMPTY_FILE
      ])
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'text/vtt; charset=utf-8')
    assert.equal(
      res.body,
      'WEBVTT\n\n' +
        '1\n00:00:00.000 --> 00:00:01.250\nHello\n\n' +
        '2\n00:00:01.250 --> 00:00:02.500\nworld\n'
    )
    assert.equal(calls[0]?.metadata, true)
  })

  it('returns partial verbose JSON transcription', async (t) => {
    const { app, calls } = await createReadyAudioServer(t)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([
        { name: 'model', value: 'whisper-transcription' },
        { name: 'response_format', value: 'verbose_json' },
        EMPTY_FILE
      ])
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
    assert.deepEqual(res.json(), {
      text: 'Hello world',
      duration: 2.5,
      segments: [
        { id: 0, start: 0, end: 1.25, text: ' Hello' },
        { id: 1, start: 1.25, end: 2.5, text: ' world' }
      ]
    })
    assert.equal(calls[0]?.metadata, true)
  })

  it('returns timed translation from Whisper segment metadata', async (t) => {
    const { app, calls } = await createReadyAudioServer(t)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audio/translations',
      ...multipart([
        { name: 'model', value: 'whisper-translation' },
        { name: 'response_format', value: 'vtt' },
        EMPTY_FILE
      ])
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'text/vtt; charset=utf-8')
    assert.match(res.body, /^WEBVTT\n\n1\n00:00:00\.000 --> 00:00:01\.250\nHello/)
    assert.equal(calls[0]?.metadata, true)
  })

  it('rejects timed formats for non-Whisper translation before inference', async (t) => {
    const { app, calls } = await createReadyAudioServer(t)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audio/translations',
      ...multipart([
        { name: 'model', value: 'non-whisper-translation' },
        { name: 'response_format', value: 'srt' },
        EMPTY_FILE
      ])
    })

    assertStatusAndError(res, 400, 'unsupported_response_format')
    assert.equal(calls.length, 0)
  })

  it('preserves JSON and text behavior without requesting metadata on either route', async (t) => {
    const { app, calls } = await createReadyAudioServer(t)
    const transcriptionJsonRes = await app.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([
        { name: 'model', value: 'whisper-transcription' },
        { name: 'response_format', value: 'json' },
        EMPTY_FILE
      ])
    })
    const transcriptionTextRes = await app.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([
        { name: 'model', value: 'whisper-transcription' },
        { name: 'response_format', value: 'text' },
        EMPTY_FILE
      ])
    })
    const translationJsonRes = await app.inject({
      method: 'POST',
      url: '/v1/audio/translations',
      ...multipart([
        { name: 'model', value: 'whisper-translation' },
        { name: 'response_format', value: 'json' },
        EMPTY_FILE
      ])
    })
    const translationTextRes = await app.inject({
      method: 'POST',
      url: '/v1/audio/translations',
      ...multipart([
        { name: 'model', value: 'whisper-translation' },
        { name: 'response_format', value: 'text' },
        EMPTY_FILE
      ])
    })

    assert.equal(transcriptionJsonRes.statusCode, 200)
    assert.deepEqual(transcriptionJsonRes.json(), { text: 'Hello world' })
    assert.equal(transcriptionTextRes.statusCode, 200)
    assert.equal(transcriptionTextRes.headers['content-type'], 'text/plain')
    assert.equal(transcriptionTextRes.body, 'Hello world')
    assert.equal(translationJsonRes.statusCode, 200)
    assert.deepEqual(translationJsonRes.json(), { text: 'Hello world' })
    assert.equal(translationTextRes.statusCode, 200)
    assert.equal(translationTextRes.headers['content-type'], 'text/plain')
    assert.equal(translationTextRes.body, 'Hello world')
    assert.equal(calls.length, 4)
    assert.equal(
      calls.every((call) => !Object.hasOwn(call, 'metadata')),
      true
    )
  })

  it('rejects timed formats for Parakeet before inference', async (t) => {
    const { app, calls } = await createReadyAudioServer(t)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audio/transcriptions',
      ...multipart([
        { name: 'model', value: 'parakeet-transcription' },
        { name: 'response_format', value: 'srt' },
        EMPTY_FILE
      ])
    })

    assertStatusAndError(res, 400, 'unsupported_response_format')
    assert.equal(calls.length, 0)
  })
})
