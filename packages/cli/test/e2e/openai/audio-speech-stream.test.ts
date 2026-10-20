import { describe, it, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { TextToSpeechStreamResponse, TextToSpeechStreamSession } from '@qvac/sdk'
import { createServer } from '../helpers/server.js'
import { assertStatusAndError, collectSSE } from '../helpers/http.js'
import { openaiState } from '@/serve/extensions/openai/state'

const CONFIG = {
  serve: {
    models: {
      'test-tts': {
        model: 'TTS_EN_SUPERTONIC_Q4_0',
        type: 'tts',
        preload: false,
        config: { ttsEngine: 'supertonic', language: 'en', voice: 'F1' }
      }
    }
  }
}

type Frame = Partial<TextToSpeechStreamResponse> & { buffer: number[] }

interface StubSession {
  written: string[]
  ended: boolean
}

// Yields `frames`, then throws `failAfter` when set.
function stubStream(frames: Frame[], failAfter?: Error) {
  const seen: StubSession = { written: [], ended: false }
  async function* iterate(): AsyncGenerator<TextToSpeechStreamResponse> {
    await Promise.resolve()
    for (const frame of frames) {
      yield { type: 'textToSpeechStream', done: false, ...frame }
    }
    if (failAfter !== undefined) throw failAfter
  }
  const fn = (): Promise<TextToSpeechStreamSession> =>
    Promise.resolve({
      requestId: 'req-test',
      write(fragment: string | Uint8Array) {
        seen.written.push(String(fragment))
      },
      end() {
        seen.ended = true
      },
      destroy() {},
      [Symbol.asyncIterator]: () => iterate()
    })
  return { fn, seen }
}

async function serverWith(t: TestContext, stream: ReturnType<typeof stubStream>) {
  const app = await createServer(t, {
    config: CONFIG,
    loadModelOverride: () => Promise.resolve('mock-model-id')
  })
  await app.ready()
  openaiState(app.qvac).textToSpeechStreamOverride = stream.fn
  return app
}

function speak(app: Awaited<ReturnType<typeof serverWith>>, responseFormat: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/audio/speech',
    payload: {
      model: 'test-tts',
      input: 'Hello. World.',
      response_format: responseFormat,
      stream_format: 'sse'
    }
  })
}

interface SpeechEvent {
  type?: string
  audio?: string
  usage?: Record<string, number>
  error?: { code: string }
}

describe('serve: speech stream_format=sse with a batch-only engine', () => {
  for (const ttsEngine of ['moss-sfx', 'moss-speech']) {
    it(`${ttsEngine} returns 400 unsupported_stream_format before loading`, async (t) => {
      let loads = 0
      const app = await createServer(t, {
        config: {
          serve: {
            models: {
              'test-moss': { model: 'TTS_EN_SUPERTONIC_Q4_0', type: 'tts', config: { ttsEngine } }
            }
          }
        },
        loadModelOverride: () => {
          loads++
          return Promise.resolve('mock-model-id')
        }
      })
      const res = await app.inject({
        method: 'POST',
        url: '/v1/audio/speech',
        payload: { model: 'test-moss', input: 'Rain on a tin roof.', stream_format: 'sse' }
      })
      assertStatusAndError(res, 400, 'unsupported_stream_format')
      assert.equal(loads, 0)
    })
  }
})

describe('serve: speech stream_format=sse', () => {
  it('pcm: one delta per audio frame, then done with usage', async (t) => {
    const stream = stubStream([
      { buffer: [1, -1], sampleRate: 16000 },
      { buffer: [] },
      { buffer: [2], done: true }
    ])
    const app = await serverWith(t, stream)
    const res = await speak(app, 'pcm')

    assert.equal(res.statusCode, 200, res.payload)
    assert.equal(res.headers['content-type'], 'text/event-stream')
    assert.equal(res.headers['x-audio-sample-rate'], '16000')
    assert.deepEqual(stream.seen, { written: ['Hello. World.'], ended: true })

    const events = collectSSE(res.payload).map((e) => e.data as SpeechEvent)
    assert.deepEqual(
      events.map((e) => e.type),
      ['speech.audio.delta', 'speech.audio.delta', 'speech.audio.done']
    )
    const pcm = Buffer.from(events[0]?.audio ?? '', 'base64')
    assert.deepEqual([pcm.readInt16LE(0), pcm.readInt16LE(2)], [1, -1])
    assert.equal(Buffer.from(events[1]?.audio ?? '', 'base64').readInt16LE(0), 2)
    assert.deepEqual(events[2]?.usage, { input_tokens: 0, output_tokens: 0, total_tokens: 0 })
    assert.ok(!res.payload.includes('[DONE]'))
  })

  it('wav: the first delta starts with a streaming RIFF header', async (t) => {
    const app = await serverWith(t, stubStream([{ buffer: [5], sampleRate: 24000 }]))
    const res = await speak(app, 'wav')

    assert.equal(res.statusCode, 200, res.payload)
    const first = collectSSE(res.payload)[0]?.data as SpeechEvent
    const bytes = Buffer.from(first.audio ?? '', 'base64')
    assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF')
    assert.equal(bytes.readUInt32LE(40), 0xffffffff)
    assert.equal(bytes.readInt16LE(44), 5)
  })

  it('no audio returns a JSON 502 speech_empty', async (t) => {
    const app = await serverWith(t, stubStream([{ buffer: [], done: true }]))
    const res = await speak(app, 'pcm')
    assertStatusAndError(res, 502, 'speech_empty')
  })

  it('an engine error before any audio stays a JSON error', async (t) => {
    const app = await serverWith(t, stubStream([], new Error('engine exploded')))
    const res = await speak(app, 'pcm')
    assert.equal(res.statusCode, 500)
    assert.match(String(res.headers['content-type']), /application\/json/)
  })

  it('an engine error after audio ends the stream with an error event', async (t) => {
    const app = await serverWith(t, stubStream([{ buffer: [1] }], new Error('engine exploded')))
    const res = await speak(app, 'pcm')

    assert.equal(res.statusCode, 200)
    const events = collectSSE(res.payload).map((e) => e.data as SpeechEvent)
    assert.equal(events[0]?.type, 'speech.audio.delta')
    assert.equal(events.at(-1)?.error?.code, 'internal_error')
    assert.ok(!events.some((e) => e.type === 'speech.audio.done'))
    assert.ok(!res.payload.includes('[DONE]'))
  })
})
