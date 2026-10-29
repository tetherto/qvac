import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import {
  RequestValidationFailedError,
  type AudioEditClientParams,
  type AudioGenAudio,
  type AudioGenClientParams,
  type AudioGenProgress,
  type AudioGenResult,
  type AudioGenStats,
  type AudioUnderstandClientParams,
  type AudioUnderstandResult
} from '@qvac/sdk'
import { useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError, multipart } from '../helpers/http.js'
import { silenceWav } from '../helpers/fixtures.js'
import { defaultState } from '@/serve/extensions/default/state'

// Neither src resolves, so a request that reaches the model load fails with a
// 503. Every input error below must therefore be raised before the load.
const MODELLESS_CONFIG = {
  serve: {
    models: {
      music: { type: 'audiogen-ggml', src: 'hyper://example.invalid/dit', preload: false },
      'chat-model': {
        type: 'llamacpp-completion',
        src: 'hyper://example.invalid/chat',
        preload: false
      }
    }
  }
} as const

const STUB_CONFIG = {
  serve: {
    models: { music: { type: 'audiogen-ggml', src: '/models/dit.gguf', preload: false } }
  }
} as const

const WAV_DATA_URL = `data:audio/wav;base64,${silenceWav().toString('base64')}`
const REPAINT = { type: 'repaint', caption: 'analog synth solo', start: 0.1, end: 0.5 }

describe('qvac music: validation', () => {
  const server = useServer({ config: MODELLESS_CONFIG })

  function post(path: string, payload: object) {
    return server().inject({ method: 'POST', url: `/qvac/v1/audio/${path}`, payload })
  }

  it('invalid JSON returns 400', async () => {
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/audio/generations',
      headers: JSON_HEADERS,
      payload: '{{bad'
    })
    assertStatusAndError(res, 400, 'invalid_json')
  })

  it('missing model returns 400', async () => {
    assertStatusAndError(await post('generations', { caption: 'lofi' }), 400, 'missing_model')
  })

  it('missing caption returns 400', async () => {
    assertStatusAndError(await post('generations', { model: 'music' }), 400, 'missing_caption')
  })

  it('missing sourceAudio returns 400 on edits and understandings', async () => {
    const edit = await post('edits', { model: 'music', operations: [REPAINT] })
    assertStatusAndError(edit, 400, 'missing_source_audio')
    assertStatusAndError(
      await post('understandings', { model: 'music' }),
      400,
      'missing_source_audio'
    )
  })

  it('malformed operations return 400', async () => {
    for (const operations of [[], [{ type: 'mix' }], 'not json']) {
      const res = await post('edits', { model: 'music', sourceAudio: WAV_DATA_URL, operations })
      assertStatusAndError(res, 400, 'invalid_operations')
    }
  })

  it('a field of the wrong type returns 400', async () => {
    const res = await post('generations', { model: 'music', caption: 'lofi', seed: 'x' })
    assertStatusAndError(res, 400, 'invalid_request')
  })

  it('rejects an unknown field', async () => {
    const res = await post('generations', { model: 'music', caption: 'lofi', nope: true })
    assertStatusAndError(res, 400, 'invalid_request')
  })

  it('rejects bad audio inputs before loading the model', async () => {
    const cases: Array<[string, string]> = [
      ['data:audio/wav;base64,', 'empty_input'],
      ['data:audio/wav,raw', 'invalid_data_url'],
      ['file-nope', 'file_not_found']
    ]
    for (const [sourceAudio, code] of cases) {
      assertStatusAndError(await post('understandings', { model: 'music', sourceAudio }), 400, code)
      assertStatusAndError(
        await post('generations', { model: 'music', caption: 'c', referenceAudio: sourceAudio }),
        400,
        code
      )
    }
  })

  it('unknown model returns 404', async () => {
    assertStatusAndError(
      await post('generations', { model: 'nope', caption: 'lofi' }),
      404,
      'model_not_found'
    )
  })

  it('a chat model returns invalid_model_type', async () => {
    assertStatusAndError(
      await post('generations', { model: 'chat-model', caption: 'lofi' }),
      400,
      'invalid_model_type'
    )
  })

  for (const kind of ['generations', 'edits']) {
    it(`${kind}: unknown job ids return 404`, async () => {
      for (const [method, suffix] of [
        ['GET', ''],
        ['GET', '/content'],
        ['DELETE', '']
      ] as const) {
        const res = await server().inject({
          method,
          url: `/qvac/v1/audio/${kind}/nope${suffix}`
        })
        assertStatusAndError(res, 404, 'audio_job_not_found')
      }
    })

    it(`${kind}: lists no jobs`, async () => {
      const res = await server().inject({ method: 'GET', url: `/qvac/v1/audio/${kind}` })
      assert.equal(res.statusCode, 200, res.body)
      assert.deepEqual(res.json(), {
        object: 'list',
        data: [],
        first_id: null,
        last_id: null,
        has_more: false
      })
    })
  }
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

// Two stereo frames of 16-bit PCM.
const AUDIO: AudioGenAudio = {
  pcm: new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]),
  sampleRate: 48000,
  channels: 2,
  bitsPerSample: 16
}

const STATS: AudioGenStats = {
  audioDurationMs: 1000,
  metadata: {
    caption: 'lofi',
    lyrics: '',
    bpm: 90,
    keyscale: 'C minor',
    beatsPerBar: 4,
    vocalLanguage: 'en',
    seed: 7,
    codeFrames: 5
  }
}

let runCount = 0

function fakeRun(
  audio: Promise<AudioGenAudio>,
  progress: AudioGenProgress[] = [{ stage: 'dit', step: 4, total: 8 }]
): AudioGenResult {
  const requestId = `req-${++runCount}`
  return {
    requestId,
    progressStream: (async function* () {
      for (const tick of progress) yield await Promise.resolve(tick)
    })(),
    audio,
    stats: audio.then(() => STATS),
    diagnostics: Promise.resolve(undefined)
  }
}

interface JobBody {
  id: string
  object: string
  status: string
  progress: number
  stage: string | null
  error: { code: string; message: string } | null
  stats: Record<string, unknown> | null
}

async function waitForJob(app: FastifyInstance, path: string, id: string): Promise<JobBody> {
  for (let i = 0; i < 200; i++) {
    const res = await app.inject({ method: 'GET', url: `${path}/${id}` })
    assert.equal(res.statusCode, 200, res.body)
    const job = res.json() as JobBody
    if (job.status === 'completed' || job.status === 'failed') return job
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`job ${id} did not finish`)
}

describe('qvac music: jobs against a stubbed SDK', () => {
  const server = useServer({
    config: STUB_CONFIG,
    loadModelOverride: () => Promise.resolve('sdk-music')
  })

  const GENERATIONS = '/qvac/v1/audio/generations'
  const EDITS = '/qvac/v1/audio/edits'

  function state() {
    return defaultState(server().qvac)
  }

  it('runs a generation to completion and serves it as stereo WAV', async () => {
    const calls: AudioGenClientParams[] = []
    state().audioGenOverride = (params) => {
      calls.push(params)
      return fakeRun(Promise.resolve(AUDIO))
    }

    const res = await server().inject({
      method: 'POST',
      url: GENERATIONS,
      payload: { model: 'music', caption: 'lofi', duration: 10, seed: 7 }
    })
    assert.equal(res.statusCode, 200, res.body)
    const created = res.json() as JobBody
    assert.equal(created.object, 'audio.generation')
    assert.equal(created.status, 'queued')
    assert.deepEqual(calls, [{ modelId: 'sdk-music', caption: 'lofi', duration: 10, seed: 7 }])

    const job = await waitForJob(server(), GENERATIONS, created.id)
    assert.equal(job.status, 'completed')
    assert.equal(job.progress, 100)
    assert.equal(job.stage, 'dit')
    assert.deepEqual((job.stats?.['metadata'] as { seed: number }).seed, 7)

    const content = await server().inject({
      method: 'GET',
      url: `${GENERATIONS}/${created.id}/content`
    })
    assert.equal(content.statusCode, 200)
    assert.equal(content.headers['content-type'], 'audio/wav')
    const wav = content.rawPayload
    assert.equal(wav.subarray(0, 4).toString(), 'RIFF')
    assert.equal(wav.readUInt16LE(22), 2)
    assert.equal(wav.readUInt32LE(24), 48000)
    assert.deepEqual([...wav.subarray(44)], [...AUDIO.pcm])

    const list = await server().inject({ method: 'GET', url: GENERATIONS })
    assert.ok((list.json() as { data: JobBody[] }).data.some((j) => j.id === created.id))
  })

  it('answers 409 with Retry-After while a job runs, and DELETE cancels it', async () => {
    const audio = deferred<AudioGenAudio>()
    let requestId = ''
    const cancelled: string[] = []
    state().audioGenOverride = () => {
      const run = fakeRun(audio.promise)
      requestId = run.requestId
      return run
    }
    state().cancelOverride = (opts) => {
      if ('requestId' in opts) cancelled.push(opts.requestId)
      audio.reject(new Error('cancelled'))
      return Promise.resolve()
    }

    const res = await server().inject({
      method: 'POST',
      url: GENERATIONS,
      payload: { model: 'music', caption: 'lofi' }
    })
    const { id } = res.json() as JobBody

    const early = await server().inject({ method: 'GET', url: `${GENERATIONS}/${id}/content` })
    assertStatusAndError(early, 409, 'audio_job_not_ready')
    assert.equal(early.headers['retry-after'], '2')

    const deleted = await server().inject({ method: 'DELETE', url: `${GENERATIONS}/${id}` })
    assert.equal(deleted.statusCode, 200, deleted.body)
    assert.deepEqual(deleted.json(), { id, object: 'audio.generation.deleted', deleted: true })
    assert.deepEqual(cancelled, [requestId])

    const gone = await server().inject({ method: 'GET', url: `${GENERATIONS}/${id}` })
    assertStatusAndError(gone, 404, 'audio_job_not_found')
  })

  it('reports progress within the current stage', async () => {
    const audio = deferred<AudioGenAudio>()
    state().audioGenOverride = () =>
      fakeRun(audio.promise, [
        { stage: 'lm', step: 1, total: 1 },
        { stage: 'dit', step: 2, total: 8 }
      ])
    const res = await server().inject({
      method: 'POST',
      url: GENERATIONS,
      payload: { model: 'music', caption: 'lofi' }
    })
    const { id } = res.json() as JobBody

    let job: JobBody | undefined
    for (let i = 0; i < 100; i++) {
      job = (await server().inject({ method: 'GET', url: `${GENERATIONS}/${id}` })).json()
      if (job?.stage === 'dit') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(job?.status, 'in_progress')
    assert.equal(job?.stage, 'dit')
    assert.equal(job?.progress, 25)

    audio.resolve(AUDIO)
    assert.equal((await waitForJob(server(), GENERATIONS, id)).progress, 100)
  })

  it('records a failed run on the job', async () => {
    state().audioGenOverride = () => fakeRun(Promise.reject(new Error('DiT exploded')))
    const res = await server().inject({
      method: 'POST',
      url: GENERATIONS,
      payload: { model: 'music', caption: 'lofi' }
    })
    const job = await waitForJob(server(), GENERATIONS, (res.json() as JobBody).id)
    assert.equal(job.status, 'failed')
    assert.deepEqual(job.error, { code: 'audio_generation_failed', message: 'DiT exploded' })

    const content = await server().inject({
      method: 'GET',
      url: `${GENERATIONS}/${job.id}/content`
    })
    assertStatusAndError(content, 409, 'audio_job_failed')
  })

  it('returns the SDK validation error as 400', async () => {
    state().audioGenOverride = () => {
      throw new RequestValidationFailedError("taskType 'cover-nofsq' requires sourceAudio")
    }
    const res = await server().inject({
      method: 'POST',
      url: GENERATIONS,
      payload: { model: 'music', caption: 'lofi', taskType: 'cover-nofsq' }
    })
    assertStatusAndError(res, 400, 'invalid_request')
    assert.match(res.body, /requires sourceAudio/)
  })

  it('answers 503 for an encoded format when ffmpeg is missing', async () => {
    state().audioGenOverride = () => fakeRun(Promise.resolve(AUDIO))
    state().ffmpegAvailable = Promise.resolve(false)
    const res = await server().inject({
      method: 'POST',
      url: GENERATIONS,
      payload: { model: 'music', caption: 'lofi' }
    })
    const job = await waitForJob(server(), GENERATIONS, (res.json() as JobBody).id)
    const content = await server().inject({
      method: 'GET',
      url: `${GENERATIONS}/${job.id}/content?format=mp3`
    })
    assertStatusAndError(content, 503, 'transcode_unavailable')
    delete state().ffmpegAvailable
  })

  it('passes a multipart upload to the SDK as a temp file it deletes afterwards', async () => {
    const audio = deferred<AudioGenAudio>()
    const seen: Array<{ path: string; bytes: Buffer }> = []
    state().audioEditOverride = (params: AudioEditClientParams) => {
      const path = params.sourceAudio as string
      seen.push({ path, bytes: readFileSync(path) })
      assert.deepEqual(params.operations, [REPAINT])
      assert.equal(params.seed, 3)
      return fakeRun(audio.promise)
    }

    const res = await server().inject({
      method: 'POST',
      url: EDITS,
      ...multipart([
        { name: 'model', value: 'music' },
        { name: 'operations', value: JSON.stringify([REPAINT]) },
        { name: 'seed', value: '3' },
        { name: 'sourceAudio', filename: 'song.wav', contentType: 'audio/wav', data: silenceWav() }
      ])
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.equal((res.json() as JobBody).object, 'audio.edit')
    assert.equal(seen.length, 1)
    assert.match(seen[0]!.path, /\.wav$/)
    assert.deepEqual(seen[0]!.bytes, silenceWav())
    assert.equal(existsSync(seen[0]!.path), true, 'the file must outlive the request')

    audio.resolve(AUDIO)
    const job = await waitForJob(server(), EDITS, (res.json() as JobBody).id)
    assert.equal(job.status, 'completed')
    // The job completes just before its temp files are unlinked.
    for (let i = 0; i < 100 && existsSync(seen[0]!.path); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(existsSync(seen[0]!.path), false, 'the file must be deleted once the run ends')
  })

  it('describes a recording', async () => {
    const description = {
      caption: 'calm piano',
      bpm: 72,
      duration: 12,
      keyscale: 'A minor',
      timesignature: '4/4',
      vocalLanguage: 'unknown',
      audioCodes: [5, 6, 7],
      seed: 11
    }
    const calls: AudioUnderstandClientParams[] = []
    state().audioUnderstandOverride = (params): AudioUnderstandResult => {
      calls.push(params)
      return {
        requestId: 'req-understand',
        progressStream: (async function* () {})(),
        description: Promise.resolve(description),
        stats: Promise.resolve({ totalTimeMs: 50 }),
        diagnostics: Promise.resolve(undefined)
      }
    }
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/audio/understandings',
      payload: { model: 'music', sourceAudio: WAV_DATA_URL, seed: 11 }
    })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json(), {
      object: 'audio.understanding',
      model: 'music',
      description,
      stats: { totalTimeMs: 50 }
    })
    assert.equal(calls[0]!.seed, 11)
    assert.equal(existsSync(calls[0]!.sourceAudio as string), false)
  })

  it('reports a failed description as 502', async () => {
    state().audioUnderstandOverride = () => ({
      requestId: 'req-understand-fail',
      progressStream: (async function* () {})(),
      description: Promise.reject(new Error('encoder failed')),
      stats: Promise.reject(new Error('encoder failed')),
      diagnostics: Promise.resolve(undefined)
    })
    const res = await server().inject({
      method: 'POST',
      url: '/qvac/v1/audio/understandings',
      payload: { model: 'music', sourceAudio: WAV_DATA_URL }
    })
    assertStatusAndError(res, 502, 'audio_understanding_failed')
  })
})
