import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BCI_FIELD_CODES,
  bciTranscriptionsBody,
  neuralDataProblem
} from '@/serve/extensions/default/schemas/bci'
import { extensionErrorCodes } from '@/serve/core/extensions'
import openaiExtension from '@/serve/extensions/openai'
import defaultExtension from '@/serve/extensions/default'

const BODY = { model: 'bci', file: Buffer.from([1]) }

function neural(timesteps: number, channels: number, samples = timesteps * channels): Buffer {
  const bytes = Buffer.alloc(8 + samples * 4)
  bytes.writeUInt32LE(timesteps, 0)
  bytes.writeUInt32LE(channels, 4)
  return bytes
}

function failedPaths(result: {
  success: boolean
  error?: { issues: Array<{ path: PropertyKey[] }> }
}): string[] {
  assert.equal(result.success, false)
  return result.error!.issues.map((i) => i.path.join('/'))
}

describe('bciTranscriptionsBody', () => {
  it('accepts an upload or a string reference and reads multipart strings', () => {
    assert.equal(bciTranscriptionsBody.safeParse(BODY).success, true)
    const body = bciTranscriptionsBody.parse({
      ...BODY,
      file: 'file-abc',
      stream: 'true',
      window_timesteps: '1000',
      hop_timesteps: '250'
    })
    assert.equal(body.stream, true)
    assert.equal(body.window_timesteps, 1000)
  })

  it('rejects an unknown response_format', () => {
    assert.deepEqual(
      failedPaths(bciTranscriptionsBody.safeParse({ ...BODY, response_format: 'mp3' })),
      ['response_format']
    )
  })

  it('takes window options only with a stream, and a hop below the window', () => {
    assert.deepEqual(
      failedPaths(bciTranscriptionsBody.safeParse({ ...BODY, window_timesteps: 100 })),
      ['window_timesteps']
    )
    assert.deepEqual(
      failedPaths(
        bciTranscriptionsBody.safeParse({
          ...BODY,
          stream: true,
          window_timesteps: 100,
          hop_timesteps: 100
        })
      ),
      ['hop_timesteps']
    )
  })

  it('takes json or text only for a stream', () => {
    assert.equal(
      bciTranscriptionsBody.safeParse({ ...BODY, stream: true, response_format: 'text' }).success,
      true
    )
    assert.deepEqual(
      failedPaths(
        bciTranscriptionsBody.safeParse({ ...BODY, stream: true, response_format: 'srt' })
      ),
      ['response_format']
    )
  })

  it('rejects unknown fields', () => {
    assert.equal(bciTranscriptionsBody.safeParse({ ...BODY, language: 'en' }).success, false)
  })
})

describe('neuralDataProblem', () => {
  it('accepts a recording whose length matches its header', () => {
    assert.equal(neuralDataProblem(neural(3, 2), false), null)
  })

  it('rejects a short header, zero channels and a length mismatch', () => {
    assert.match(neuralDataProblem(Buffer.alloc(4), false)!, /8-byte header/)
    assert.match(neuralDataProblem(neural(3, 0), false)!, /0 channels/)
    assert.match(neuralDataProblem(neural(3, 2, 5), false)!, /3x2 samples/)
  })

  it('ignores the timestep count for a stream but wants whole timesteps', () => {
    assert.equal(neuralDataProblem(neural(0, 2, 8), true), null)
    assert.match(neuralDataProblem(neural(0, 2, 7), true)!, /whole number/)
  })
})

describe('BCI error codes', () => {
  it('do not clash with another extension', () => {
    assert.doesNotThrow(() => extensionErrorCodes([openaiExtension, defaultExtension]))
    assert.equal(BCI_FIELD_CODES['hop_timesteps'], 'invalid_window')
  })
})
