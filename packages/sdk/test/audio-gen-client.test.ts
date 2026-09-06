import test from 'brittle'
import { createAudioGenResult, type AudioGenStreamFactory } from '@/client/api/audio-gen-result'
import type { AudioGenStreamRequest } from '@/schemas/audio-gen'
import { InvalidResponseError } from '@/utils/errors-client'
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
