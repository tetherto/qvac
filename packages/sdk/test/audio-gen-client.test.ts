import test from 'brittle'
import type { AudioEditStreamRequest, AudioGenStreamRequest } from '@qvac/inference/surface'
import {
  createAudioEditResult,
  createAudioGenResult,
  type AudioGenStreamFactory
} from '@/client/api/audio-gen-result'
import { InvalidResponseError, RequestValidationFailedError } from '@/utils/errors-client'
import { InferenceCancelledError } from '@/utils/errors-server'

async function* mockResponses(responses: unknown[]): AsyncGenerator<unknown> {
  for (const response of responses) yield response
}

async function collect<T>(events: AsyncIterable<T>) {
  const collected: T[] = []
  for await (const event of events) collected.push(event)
  return collected
}

function createRun(responses: unknown[], capture?: (request: AudioGenStreamRequest) => void) {
  const streamFactory: AudioGenStreamFactory = function (request) {
    capture?.(request)
    return mockResponses(responses)
  }
  return createAudioGenResult(
    {
      modelId: 'audio-model',
      caption: 'ambient electronic music',
      seed: 42
    },
    streamFactory
  )
}

test('audioGen client collects progress, PCM, stats, and requestId', async (t) => {
  let capturedRequest: AudioGenStreamRequest | undefined
  const run = createRun(
    [
      {
        type: 'audioGenStream',
        progress: { stage: 'dit', step: 1, total: 2 }
      },
      {
        type: 'audioGenStream',
        data: 'AAE=',
        sampleRate: 44100,
        channels: 2,
        bitsPerSample: 16
      },
      {
        type: 'audioGenStream',
        data: 'AgM=',
        sampleRate: 44100,
        channels: 2,
        bitsPerSample: 16
      },
      {
        type: 'audioGenStream',
        done: true,
        stopReason: 'completed',
        stats: {
          audioDurationMs: 10,
          totalTimeMs: 5,
          realTimeFactor: 0.5,
          backendDevice: 0,
          backendId: 0
        },
        diagnostics: {
          selectedBackend: 'cpu',
          selectedDevice: 'cpu'
        }
      }
    ],
    function capture(request) {
      capturedRequest = request
    }
  )

  t.ok(run.requestId.length > 0, 'requestId is available synchronously')
  const progress = await collect(run.progressStream)
  const audio = await run.audio
  const stats = await run.stats
  const diagnostics = await run.diagnostics

  t.alike(progress, [{ stage: 'dit', step: 1, total: 2 }])
  t.alike(Array.from(audio.pcm), [0, 1, 2, 3])
  t.is(audio.sampleRate, 44100)
  t.is(audio.channels, 2)
  t.is(audio.bitsPerSample, 16)
  t.alike(stats, {
    audioDurationMs: 10,
    totalTimeMs: 5,
    realTimeFactor: 0.5,
    backendDevice: 0,
    backendId: 0
  })
  t.alike(diagnostics, {
    selectedBackend: 'cpu',
    selectedDevice: 'cpu'
  })
  t.is(capturedRequest?.requestId, run.requestId)
})

test('audioGen client yields indeterminate LM progress', async (t) => {
  const run = createRun([
    {
      type: 'audioGenStream',
      progress: { stage: 'lm', step: 1, total: -1 }
    },
    {
      type: 'audioGenStream',
      data: 'AAE=',
      sampleRate: 44100,
      channels: 2,
      bitsPerSample: 16
    },
    {
      type: 'audioGenStream',
      done: true,
      stopReason: 'completed'
    }
  ])

  t.alike(await collect(run.progressStream), [{ stage: 'lm', step: 1, total: -1 }])
  await run.audio
})

test('audioGen client forwards MiniMax frame and flow controls', async (t) => {
  let capturedRequest: AudioGenStreamRequest | undefined
  const run = createAudioGenResult(
    {
      modelId: 'minimax-model',
      caption: 'warm cinematic piano',
      maxFrames: 250,
      inferenceSteps: 12,
      cfgScale: 1.8
    },
    function streamFactory(request) {
      capturedRequest = request
      return mockResponses([
        {
          type: 'audioGenStream',
          data: 'AAE=',
          sampleRate: 44100,
          channels: 2,
          bitsPerSample: 16
        },
        {
          type: 'audioGenStream',
          done: true,
          stopReason: 'completed'
        }
      ])
    }
  )

  await run.audio
  t.is(capturedRequest?.maxFrames, 250)
  t.is(capturedRequest?.inferenceSteps, 12)
  t.is(capturedRequest?.cfgScale, 1.8)
})

test('audioGen client forwards caption augmentation and frozen codes as a plain int array', async (t) => {
  let capturedRequest: AudioGenStreamRequest | undefined
  const run = createAudioGenResult(
    {
      modelId: 'audio-model',
      caption: 'energetic cumbia with brass stabs',
      bpm: 98,
      augmentCaptionWithMetadata: true,
      audioCodes: new Int32Array([12095, 63487, 12741])
    },
    function streamFactory(request) {
      capturedRequest = request
      return mockResponses([
        {
          type: 'audioGenStream',
          data: 'AAE=',
          sampleRate: 48000,
          channels: 2,
          bitsPerSample: 16
        },
        { type: 'audioGenStream', done: true, stopReason: 'completed' }
      ])
    }
  )

  await run.audio
  t.is(capturedRequest?.augmentCaptionWithMetadata, true)
  t.alike(capturedRequest?.audioCodes, [12095, 63487, 12741])
})

test('audioEdit client normalizes the source, forwards the pipeline, and collects the edit', async (t) => {
  let capturedRequest: AudioEditStreamRequest | undefined
  const source = new Float32Array([0.25, -0.25])
  const run = createAudioEditResult(
    {
      modelId: 'audio-model',
      sourceAudio: Buffer.from(source.buffer, source.byteOffset, source.byteLength),
      seed: 22883,
      operations: [
        {
          type: 'flow-edit',
          from: { caption: 'original pop song', lyrics: 'la la' },
          to: { caption: 'guitar pop-rock' }
        },
        { type: 'repaint', caption: 'analog synth solo', start: 10, end: 20, mode: 'balanced' }
      ]
    },
    function streamFactory(request) {
      capturedRequest = request
      return mockResponses([
        { type: 'audioEditStream', progress: { stage: 'dit', step: 1, total: 8 } },
        {
          type: 'audioEditStream',
          data: 'AAE=',
          sampleRate: 48000,
          channels: 2,
          bitsPerSample: 16
        },
        {
          type: 'audioEditStream',
          done: true,
          stopReason: 'completed',
          stats: { audioDurationMs: 20000, backendDevice: 0, backendId: 0 },
          diagnostics: { selectedBackend: 'cpu', selectedDevice: 'cpu' }
        }
      ])
    }
  )

  t.ok(run.requestId.length > 0)
  const progress = await collect(run.progressStream)
  const audio = await run.audio
  t.alike(progress, [{ stage: 'dit', step: 1, total: 8 }])
  t.alike(Array.from(audio.pcm), [0, 1])
  t.is(audio.sampleRate, 48000)
  t.alike(await run.stats, { audioDurationMs: 20000, backendDevice: 0, backendId: 0 })
  t.alike(await run.diagnostics, { selectedBackend: 'cpu', selectedDevice: 'cpu' })

  t.is(capturedRequest?.type, 'audioEditStream')
  t.is(capturedRequest?.requestId, run.requestId)
  t.is(capturedRequest?.seed, 22883)
  t.alike(capturedRequest?.sourceAudio, {
    type: 'base64',
    value: Buffer.from(source.buffer).toString('base64')
  })
  t.alike(capturedRequest?.operations, [
    {
      type: 'flow-edit',
      from: { caption: 'original pop song', lyrics: 'la la' },
      to: { caption: 'guitar pop-rock' }
    },
    { type: 'repaint', caption: 'analog synth solo', start: 10, end: 20, mode: 'balanced' }
  ])
})

test('audioEdit client rejects an invalid pipeline before opening the stream', (t) => {
  let opened = 0
  t.exception(
    () =>
      createAudioEditResult(
        { modelId: 'audio-model', sourceAudio: '/tmp/song.wav', operations: [] },
        function streamFactory() {
          opened++
          return mockResponses([])
        }
      ),
    RequestValidationFailedError
  )
  t.is(opened, 0)
})

test('audioEdit client ignores generation frames and requires its own terminal frame', async (t) => {
  const run = createAudioEditResult(
    {
      modelId: 'audio-model',
      sourceAudio: '/tmp/song.wav',
      operations: [{ type: 'repaint', caption: 'drum fill', start: 0 }]
    },
    function streamFactory() {
      return mockResponses([
        { type: 'audioGenStream', data: 'AAE=', sampleRate: 48000, channels: 2, bitsPerSample: 16 },
        { type: 'audioGenStream', done: true, stopReason: 'completed' }
      ])
    }
  )

  const settled = await Promise.allSettled([run.audio, run.stats, run.diagnostics])
  for (const outcome of settled) {
    t.is(outcome.status, 'rejected')
    if (outcome.status === 'rejected') t.ok(outcome.reason instanceof InvalidResponseError)
  }
})

test('audioGen client rejects aggregates with a typed cancellation error', async (t) => {
  const run = createRun([
    {
      type: 'audioGenStream',
      progress: { stage: 'dit', step: 1, total: 8 }
    },
    {
      type: 'audioGenStream',
      done: true,
      stopReason: 'cancelled'
    }
  ])

  const progress = await collect(run.progressStream)
  const settled = await Promise.allSettled([run.audio, run.stats, run.diagnostics])

  t.is(progress.length, 1)
  for (const outcome of settled) {
    t.is(outcome.status, 'rejected')
    if (outcome.status === 'rejected') {
      t.ok(outcome.reason instanceof InferenceCancelledError)
      t.is(outcome.reason.requestId, run.requestId)
    }
  }
})

test('audioGen client rejects a stream without a terminal frame', async (t) => {
  const run = createRun([
    {
      type: 'audioGenStream',
      data: 'AAE=',
      sampleRate: 44100,
      channels: 2
    }
  ])

  const settled = await Promise.allSettled([
    run.audio,
    run.stats,
    run.diagnostics,
    collect(run.progressStream)
  ])

  for (const outcome of settled) {
    t.is(outcome.status, 'rejected')
    if (outcome.status === 'rejected') {
      t.ok(outcome.reason instanceof InvalidResponseError)
    }
  }
})
