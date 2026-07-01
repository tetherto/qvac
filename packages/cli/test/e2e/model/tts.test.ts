import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { useModelServer } from '../helpers/server.js'

// The encoded formats (mp3/opus/aac/flac) shell out to ffmpeg/ffprobe, so they
// skip where those aren't on PATH and run where they are.
const TTS_CONFIG = {
  serve: {
    models: {
      'test-tts': {
        model: 'TTS_EN_SUPERTONIC_Q4_0',
        type: 'tts',
        preload: true,
        config: { ttsEngine: 'supertonic', language: 'en', voice: 'F1', ttsNumInferenceSteps: 5 }
      }
    },
    openai: { audio: { speech: { voices: { alloy: 'test-tts' } } } }
  }
}

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function ffprobeCodec(buf: Buffer): string {
  const f = join(tmpdir(), `qvac-tts-probe-${process.pid}-${buf.length}.bin`)
  writeFileSync(f, buf)
  try {
    return execFileSync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_name',
      '-of',
      'csv=p=0',
      f
    ])
      .toString()
      .trim()
  } finally {
    rmSync(f, { force: true })
  }
}

const FFMPEG = hasFfmpeg()

describe('tts (local): discovery + speech encoding', () => {
  const server = useModelServer(TTS_CONFIG)

  function speak(format: string) {
    return server().inject({
      method: 'POST',
      url: '/v1/audio/speech',
      payload: { model: 'test-tts', input: 'Hello from QVAC.', response_format: format }
    })
  }

  it('GET /v1/audio/models lists the loaded TTS model', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/audio/models' })
    const body = res.json() as { object: string; data: Array<{ id: string; object: string }> }
    assert.equal(body.object, 'list')
    assert.equal(body.data.length, 1)
    assert.ok(body.data.every((m) => m.object === 'model'))
    assert.equal(body.data[0]?.id, 'test-tts')
  })

  it('GET /v1/audio/voices returns the configured voices', async () => {
    const res = await server().inject({ method: 'GET', url: '/v1/audio/voices' })
    const body = res.json() as { object: string; voices: string[]; data: Array<{ id: string }> }
    assert.equal(body.object, 'list')
    assert.ok(body.voices.includes('alloy'))
    assert.ok(body.data.some((v) => v.id === 'alloy'))
  })

  it('speech: wav returns audio/wav with a RIFF body', async () => {
    const res = await speak('wav')
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'audio/wav')
    assert.equal(res.rawPayload.subarray(0, 4).toString('ascii'), 'RIFF')
  })

  it('speech: pcm returns audio/L16 with the sample rate', async () => {
    const res = await speak('pcm')
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /^audio\/L16; rate=\d+; channels=1$/)
  })

  const encoded: Array<[string, string, string]> = [
    ['mp3', 'audio/mpeg', 'mp3'],
    ['opus', 'audio/ogg', 'opus'],
    ['aac', 'audio/aac', 'aac'],
    ['flac', 'audio/flac', 'flac']
  ]
  for (const [format, contentType, codec] of encoded) {
    it(
      `speech: ${format} encodes to ${contentType}`,
      { skip: FFMPEG ? false : 'ffmpeg/ffprobe not on PATH' },
      async () => {
        const res = await speak(format)
        assert.equal(res.statusCode, 200)
        assert.equal(res.headers['content-type'], contentType)
        assert.equal(ffprobeCodec(res.rawPayload), codec)
      }
    )
  }
})
