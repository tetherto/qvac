import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  RequestRejectedByPolicyError,
  SDK_SERVER_ERROR_CODES,
  type BciTranscribeStreamClientParams,
  type TranscribeSegment
} from '@qvac/sdk'
import { useServer } from '../helpers/server.js'
import { JSON_HEADERS, assertStatusAndError, collectSSE, multipart } from '../helpers/http.js'
import { defaultState } from '@/serve/extensions/default/state'

const URL = '/qvac/v1/bci/transcriptions'

// The src does not resolve, so a request that reaches the model load fails with
// a 503. Every input error below must therefore be raised before the load.
const MODELLESS_CONFIG = {
  serve: {
    models: {
      bci: { type: 'bci', src: 'hyper://example.invalid/bci', preload: false },
      ocr: { type: 'ggml-ocr', src: 'hyper://example.invalid/ocr', preload: false }
    }
  }
} as const

const STUB_CONFIG = {
  serve: { models: { bci: { type: 'bci', src: '/models/bci.bin', preload: false } } }
} as const

function neural(timesteps = 4, channels = 2): Buffer {
  const bytes = Buffer.alloc(8 + timesteps * channels * 4)
  bytes.writeUInt32LE(timesteps, 0)
  bytes.writeUInt32LE(channels, 4)
  return bytes
}

function dataUrl(bytes: Buffer): string {
  return `data:application/octet-stream;base64,${bytes.toString('base64')}`
}

const FILE = dataUrl(neural())
const BODY = { model: 'bci', file: FILE }

const SEGMENTS: TranscribeSegment[] = [
  { text: ' not too', startMs: 0, endMs: 400, append: false, id: 0 },
  { text: ' controversial', startMs: 400, endMs: 1200, append: false, id: 1 }
]

function addonError(message: string, code: number): Error {
  return Object.assign(new Error(message), { code })
}

// How the SDK surfaces a worker error on a stream.
function streamedError(cause: Error): Error {
  return Object.assign(new Error(cause.message, { cause }), {
    code: SDK_SERVER_ERROR_CODES.TRANSCRIPTION_FAILED
  })
}

describe('qvac bci: admin gate', () => {
  const server = useServer({ config: MODELLESS_CONFIG })

  it('refuses the route without --enable-admin, before reading the body', async () => {
    const res = await server().inject({
      method: 'POST',
      url: URL,
      headers: JSON_HEADERS,
      payload: '{{bad'
    })
    assertStatusAndError(res, 403, 'admin_disabled')
  })
})

describe('qvac bci: validation', () => {
  const server = useServer({ config: MODELLESS_CONFIG, enableAdmin: true })

  function post(payload: object) {
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

  it('missing or malformed fields return 400 before the load', async () => {
    assertStatusAndError(await post({ ...BODY, model: undefined }), 400, 'missing_model')
    assertStatusAndError(await post({ ...BODY, file: undefined }), 400, 'missing_file')
    assertStatusAndError(
      await post({ ...BODY, response_format: 'mp3' }),
      400,
      'invalid_response_format'
    )
    assertStatusAndError(await post({ ...BODY, window_timesteps: 100 }), 400, 'invalid_window')
    for (const window of [{ window_timesteps: 100 }, { window_timesteps: 3000 }]) {
      assertStatusAndError(await post({ ...BODY, stream: true, ...window }), 400, 'invalid_window')
    }
    assertStatusAndError(await post({ ...BODY, language: 'en' }), 400, 'invalid_request')
  })

  it('an empty recording returns 400', async () => {
    assertStatusAndError(
      await post({ ...BODY, file: dataUrl(neural(0)) }),
      400,
      'invalid_neural_data'
    )
    assertStatusAndError(
      await post({ ...BODY, file: dataUrl(neural(0)), stream: true }),
      400,
      'invalid_neural_data'
    )
  })

  it('a batch recording over one decode returns 400, but streams', async () => {
    const long = dataUrl(neural(3001, 1))
    const res = await post({ ...BODY, file: long })
    assertStatusAndError(res, 400, 'neural_data_too_large')
    assert.match((res.json() as { error: { message: string } }).error.message, /stream: true/)
    // Past validation, the stream fails at the model load instead.
    assert.equal((await post({ ...BODY, file: long, stream: true })).statusCode, 503)
  })

  it('a file that is not a neural recording returns 400', async () => {
    const truncated = neural().subarray(0, 12)
    const res = await server().inject({
      method: 'POST',
      url: URL,
      ...multipart([
        { name: 'model', value: 'bci' },
        {
          name: 'file',
          filename: 'x.bin',
          contentType: 'application/octet-stream',
          data: truncated
        }
      ])
    })
    assertStatusAndError(res, 400, 'invalid_neural_data')
  })

  it('a non-bci model returns 400 and an unknown one 404', async () => {
    assertStatusAndError(await post({ ...BODY, model: 'ocr' }), 400, 'invalid_model_type')
    assertStatusAndError(await post({ ...BODY, model: 'nope' }), 404, 'model_not_found')
  })
})

describe('qvac bci: without the openai extension', () => {
  const server = useServer({ config: MODELLESS_CONFIG, enableAdmin: true, extensions: ['default'] })

  it('a missing file returns missing_file', async () => {
    assertStatusAndError(
      await server().inject({ method: 'POST', url: URL, payload: { model: 'bci' } }),
      400,
      'missing_file'
    )
  })
})

describe('qvac bci: transcription against a stubbed SDK', () => {
  const server = useServer({
    config: STUB_CONFIG,
    enableAdmin: true,
    loadModelOverride: () => Promise.resolve('sdk-bci')
  })

  function state() {
    return defaultState(server().qvac)
  }

  function stubBatch(calls: unknown[] = [], fail?: () => Error) {
    state().bciTranscribeOverride = ((params: { metadata?: boolean }) => {
      calls.push(params)
      const result = fail
        ? Promise.reject(fail())
        : Promise.resolve(params.metadata === true ? SEGMENTS : ' not too controversial')
      return Object.assign(result, { requestId: 'bci-req' })
    }) as never
  }

  function stubStream(
    deltas: string[],
    opened: BciTranscribeStreamClientParams[] = [],
    fail?: Error
  ) {
    const written: Uint8Array[] = []
    state().bciTranscribeStreamOverride = ((params: BciTranscribeStreamClientParams) => {
      opened.push(params)
      return Promise.resolve({
        requestId: 'bci-stream',
        write: (chunk: Uint8Array) => written.push(chunk),
        end: () => undefined,
        destroy: () => undefined,
        [Symbol.asyncIterator]: async function* () {
          for (const delta of deltas) yield delta
          if (fail) throw fail
        }
      })
    }) as never
    return written
  }

  it('returns json text, and sends the recording bytes to the SDK', async () => {
    const calls: Array<{ modelId: string; neuralData: Uint8Array }> = []
    stubBatch(calls)
    const res = await server().inject({ method: 'POST', url: URL, payload: BODY })
    assert.equal(res.statusCode, 200, res.body)
    assert.deepEqual(res.json(), { text: ' not too controversial' })
    assert.equal(calls[0]!.modelId, 'sdk-bci')
    assert.deepEqual(Buffer.from(calls[0]!.neuralData), neural())
  })

  it('returns plain text, verbose_json and srt', async () => {
    stubBatch()
    // 100 timesteps of 20 ms: longer than the segments, so nothing is clamped.
    const timedBody = { ...BODY, file: dataUrl(neural(100)) }
    const text = await server().inject({
      method: 'POST',
      url: URL,
      payload: { ...BODY, response_format: 'text' }
    })
    assert.match(String(text.headers['content-type']), /text\/plain/)
    assert.equal(text.body, ' not too controversial')

    const verbose = await server().inject({
      method: 'POST',
      url: URL,
      payload: { ...timedBody, response_format: 'verbose_json' }
    })
    const body = verbose.json() as { text: string; duration: number; segments: unknown[] }
    assert.equal(body.text, 'not too controversial')
    assert.equal(body.duration, 2)
    assert.equal(body.segments.length, 2)

    const srt = await server().inject({
      method: 'POST',
      url: URL,
      payload: { ...timedBody, response_format: 'srt' }
    })
    assert.match(srt.body, /00:00:00,400 --> 00:00:01,200\ncontroversial/)
  })

  it('reports the recording length, not the padded window, as the duration', async () => {
    stubBatch()
    // 50 timesteps is 1 s; the second segment claims to end at 1.2 s.
    const timedBody = { ...BODY, file: dataUrl(neural(50)) }
    const verbose = await server().inject({
      method: 'POST',
      url: URL,
      payload: { ...timedBody, response_format: 'verbose_json' }
    })
    const body = verbose.json() as { duration: number; segments: Array<{ end: number }> }
    assert.equal(body.duration, 1)
    assert.deepEqual(
      body.segments.map((segment) => segment.end),
      [0.4, 1]
    )
    const vtt = await server().inject({
      method: 'POST',
      url: URL,
      payload: { ...timedBody, response_format: 'vtt' }
    })
    assert.match(vtt.body, /00:00:00\.400 --> 00:00:01\.000\ncontroversial/)
  })

  it('maps a recording the addon refuses to 400 and a busy model to 429', async () => {
    stubBatch([], () => addonError('bad neural input', 26006))
    assertStatusAndError(
      await server().inject({ method: 'POST', url: URL, payload: BODY }),
      400,
      'invalid_neural_data'
    )
    stubBatch([], () => addonError('stream already active', 26007))
    assertStatusAndError(
      await server().inject({ method: 'POST', url: URL, payload: BODY }),
      429,
      'request_rejected_by_policy'
    )
  })

  it('streams deltas as server-sent events', async () => {
    const opened: BciTranscribeStreamClientParams[] = []
    const written = stubStream([' not too', ' controversial'], opened)
    const res = await server().inject({
      method: 'POST',
      url: URL,
      payload: { ...BODY, stream: true, window_timesteps: 1000, hop_timesteps: 250 }
    })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /text\/event-stream/)
    assert.deepEqual(opened, [
      { modelId: 'sdk-bci', emit: 'delta', windowTimesteps: 1000, hopTimesteps: 250 }
    ])
    assert.deepEqual(Buffer.concat(written), neural())

    const events = collectSSE(res.body).map((e) => e.data)
    assert.deepEqual(events, [
      { type: 'transcript.text.delta', delta: ' not too' },
      { type: 'transcript.text.delta', delta: ' controversial' },
      { type: 'transcript.text.done', text: 'not too controversial' },
      '[DONE]'
    ])
  })

  it('joins trimmed deltas with a space in the done event', async () => {
    stubStream(['Not too.', 'controversial.'])
    const res = await server().inject({
      method: 'POST',
      url: URL,
      payload: { ...BODY, stream: true }
    })
    const events = collectSSE(res.body).map((e) => e.data)
    assert.deepEqual(events.at(-2), {
      type: 'transcript.text.done',
      text: 'Not too. controversial.'
    })
  })

  function listenOnce(): Promise<string> {
    const http = server().server
    if (!http.listening) return server().listen({ host: '127.0.0.1', port: 0 })
    return Promise.resolve(`http://127.0.0.1:${(http.address() as AddressInfo).port}`)
  }

  it('a client disconnect cancels the run without destroying the session', async () => {
    let destroyed = 0
    const cancelled: string[] = []
    let onCancel = () => undefined as void
    const runEnded = new Promise<void>((resolve) => {
      onCancel = resolve
    })
    let drained = false
    state().cancelOverride = (opts) => {
      cancelled.push('requestId' in opts ? String(opts.requestId) : '')
      onCancel()
      return Promise.resolve()
    }
    state().bciTranscribeStreamOverride = (() =>
      Promise.resolve({
        requestId: 'bci-stream',
        write: () => undefined,
        end: () => undefined,
        destroy: () => {
          destroyed += 1
        },
        [Symbol.asyncIterator]: async function* () {
          yield 'not too'
          await runEnded
          yield 'controversial'
          drained = true
          throw new Error('Stream cancelled')
        }
      })) as never

    const address = await listenOnce()
    const controller = new AbortController()
    const res = await fetch(`${address}${URL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...BODY, stream: true }),
      signal: controller.signal
    })
    const reader = res.body!.getReader()
    await reader.read()
    controller.abort()
    await runEnded
    for (let i = 0; i < 50 && !drained; i++) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(cancelled, ['bci-stream'])
    assert.equal(destroyed, 0)
    assert.ok(drained)
  })

  it('cancels a stream whose client left while the session was opening', async () => {
    const cancelled: string[] = []
    let onCancel = () => undefined as void
    const runEnded = new Promise<void>((resolve) => {
      onCancel = resolve
    })
    state().cancelOverride = (opts) => {
      cancelled.push('requestId' in opts ? String(opts.requestId) : '')
      onCancel()
      return Promise.resolve()
    }
    let requested = () => undefined as void
    const opening = new Promise<void>((resolve) => {
      requested = resolve
    })
    let open = () => undefined as void
    const opened = new Promise<void>((resolve) => {
      open = resolve
    })
    state().bciTranscribeStreamOverride = (async () => {
      requested()
      await opened
      return {
        requestId: 'bci-early',
        write: () => undefined,
        end: () => undefined,
        destroy: () => undefined,
        [Symbol.asyncIterator]: async function* () {
          await runEnded
          yield* []
        }
      }
    }) as never

    const address = await listenOnce()
    const controller = new AbortController()
    const res = fetch(`${address}${URL}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...BODY, stream: true }),
      signal: controller.signal
    }).catch(() => undefined)
    await opening
    controller.abort()
    await res
    await new Promise((r) => setTimeout(r, 20))
    open()
    await runEnded
    assert.deepEqual(cancelled, ['bci-early'])
  })

  it('maps a worker error that fails the first window by its streamed code', async () => {
    const cases: Array<[Error, number, string]> = [
      [addonError('bad neural input', 26006), 400, 'invalid_neural_data'],
      [addonError('stream already active', 26014), 429, 'request_rejected_by_policy'],
      [
        new RequestRejectedByPolicyError('bci-stream', 'transcribe', 'sdk-bci', 'queue full'),
        429,
        'request_rejected_by_policy'
      ]
    ]
    for (const [cause, status, code] of cases) {
      stubStream([], [], streamedError(cause))
      assertStatusAndError(
        await server().inject({ method: 'POST', url: URL, payload: { ...BODY, stream: true } }),
        status,
        code
      )
    }
  })

  it('ends the stream with an error event when a window fails after the first', async () => {
    stubStream([' not too'], [], new Error('decode failed'))
    const res = await server().inject({
      method: 'POST',
      url: URL,
      payload: { ...BODY, stream: true }
    })
    const events = collectSSE(res.body).map((e) => e.data)
    assert.deepEqual(events[0], { type: 'transcript.text.delta', delta: ' not too' })
    assert.equal((events.at(-1) as { error: { code: string } }).error.code, 'internal_error')
    assert.ok(!events.includes('[DONE]'))
  })
})
