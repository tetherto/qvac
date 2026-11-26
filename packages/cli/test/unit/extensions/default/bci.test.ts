import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  BCI_FIELD_CODES,
  BCI_MAX_BATCH_TIMESTEPS,
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

function assertProblem(bytes: Buffer, stream: boolean, code: string, message: RegExp): void {
  const problem = neuralDataProblem(bytes, stream)
  assert.equal(problem?.code, code)
  assert.match(problem.message, message)
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

  it('checks the window pair the addon will run, filling in omitted defaults', () => {
    const stream = { ...BODY, stream: true }
    assert.equal(bciTranscriptionsBody.safeParse(stream).success, true)
    assert.equal(
      bciTranscriptionsBody.safeParse({ ...stream, window_timesteps: 600 }).success,
      true
    )
    assert.deepEqual(
      failedPaths(bciTranscriptionsBody.safeParse({ ...stream, window_timesteps: 100 })),
      ['window_timesteps']
    )
    assert.deepEqual(
      failedPaths(bciTranscriptionsBody.safeParse({ ...stream, hop_timesteps: 1500 })),
      ['hop_timesteps']
    )
    assert.equal(
      bciTranscriptionsBody.safeParse({ ...stream, window_timesteps: 2900, hop_timesteps: 1000 })
        .success,
      true
    )
    assert.deepEqual(
      failedPaths(bciTranscriptionsBody.safeParse({ ...stream, window_timesteps: 2901 })),
      ['window_timesteps']
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

  it('rejects a short header, zero channels or timesteps, and a length mismatch', () => {
    assertProblem(Buffer.alloc(4), false, 'invalid_neural_data', /8-byte header/)
    assertProblem(neural(3, 0), false, 'invalid_neural_data', /0 channels/)
    assertProblem(neural(0, 2), false, 'invalid_neural_data', /0 timesteps/)
    assertProblem(neural(3, 2, 5), false, 'invalid_neural_data', /3x2 samples/)
  })

  it('sends a batch recording over the decode window to streaming', () => {
    const over = BCI_MAX_BATCH_TIMESTEPS + 1
    assertProblem(neural(over, 1), false, 'neural_data_too_large', /stream: true/)
    assert.equal(neuralDataProblem(neural(over, 1), true), null)
  })

  it('ignores the timestep count for a stream but wants whole timesteps', () => {
    assert.equal(neuralDataProblem(neural(0, 2, 8), true), null)
    assertProblem(neural(0, 2, 7), true, 'invalid_neural_data', /whole number/)
    assertProblem(neural(0, 2, 0), true, 'invalid_neural_data', /no samples/)
  })
})

describe('BCI error codes', () => {
  it('do not clash with another extension', () => {
    assert.doesNotThrow(() => extensionErrorCodes([openaiExtension, defaultExtension]))
    assert.equal(BCI_FIELD_CODES['hop_timesteps'], 'invalid_window')
  })
})
