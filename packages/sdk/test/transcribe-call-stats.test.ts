import test from 'brittle'
import { createTranscribeCall } from '@/client/api/transcribe'
import type { stream } from '@/client/rpc/rpc-client'

function responseStream(frames: object[]): typeof stream {
  return async function* () {
    for (const frame of frames) yield frame
  } as typeof stream
}

test('batch transcription exposes terminal stats with metadata', async (t) => {
  const call = createTranscribeCall(
    { modelId: 'model', audioChunk: 'audio.wav', metadata: true },
    undefined,
    responseStream([
      {
        type: 'transcribe',
        segment: { text: 'hello', startMs: 0, endMs: 500, append: true, id: 1 }
      },
      { type: 'transcribe', done: true, stats: { encoderUsedCoreml: 1 } }
    ])
  )

  t.alike(await call, [{ text: 'hello', startMs: 0, endMs: 500, append: true, id: 1 }])
  t.alike(await call.stats, { encoderUsedCoreml: 1 })
  t.ok(call.requestId)
})

test('batch transcription resolves undefined when terminal stats are absent', async (t) => {
  const call = createTranscribeCall(
    { modelId: 'model', audioChunk: 'audio.wav' },
    undefined,
    responseStream([
      { type: 'transcribe', text: 'hello' },
      { type: 'transcribe', done: true }
    ])
  )

  t.is(await call, 'hello')
  t.is(await call.stats, undefined)
})

test('batch transcription rejects stats when the response stream fails', async (t) => {
  const failure = new Error('transport failed')
  const failedStream = async function* () {
    throw failure
  } as typeof stream
  const call = createTranscribeCall(
    { modelId: 'model', audioChunk: 'audio.wav' },
    undefined,
    failedStream
  )

  const outcomes = await Promise.allSettled([call, call.stats])
  t.alike(
    outcomes.map((outcome) => outcome.status),
    ['rejected', 'rejected']
  )
  t.is((outcomes[0] as PromiseRejectedResult).reason, failure)
  t.is((outcomes[1] as PromiseRejectedResult).reason, failure)
})

test('MOSS batch call forwards request options and preserves speaker labels', async (t) => {
  let request: unknown
  const responses = async function* (value: unknown) {
    request = value
    yield {
      type: 'transcribe',
      segment: {
        text: 'QVAC',
        startMs: 100,
        endMs: 300,
        append: false,
        id: 0,
        speaker: 'S01',
        speakerId: 0
      }
    }
    yield { type: 'transcribe', done: true }
  } as typeof stream
  const result = await createTranscribeCall(
    {
      modelId: 'moss',
      audioChunk: 'audio.wav',
      metadata: true,
      hotwords: ['QVAC'],
      maxNewTokens: 0
    },
    undefined,
    responses
  )
  t.alike((request as { hotwords: string[] }).hotwords, ['QVAC'])
  t.is((request as { maxNewTokens: number }).maxNewTokens, 0)
  t.alike(result, [
    { text: 'QVAC', startMs: 100, endMs: 300, append: false, id: 0, speaker: 'S01', speakerId: 0 }
  ])
})
