import test from 'brittle'
import type {
  AudioEditStreamRequest,
  AudioGenClientParams,
  AudioGenStreamRequest,
  AudioUnderstandRequest
} from '@qvac/inference/surface'
import {
  createAudioEditResult,
  createAudioGenResult,
  createAudioUnderstandResult,
  type AudioGenStreamFactory,
  type AudioUnderstandStreamFactory
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

test('audioGen client forwards ACE-Step per-run steps and shift and resolves the run metadata', async (t) => {
  let capturedRequest: AudioGenStreamRequest | undefined
  const metadata = {
    caption: 'a hopeful indie track with jangly guitars',
    lyrics: '[Instrumental]',
    bpm: 112,
    keyscale: 'D major',
    beatsPerBar: 4,
    vocalLanguage: 'unknown',
    seed: 1_234_567,
    codeFrames: 150
  }
  const run = createAudioGenResult(
    {
      modelId: 'audio-model',
      caption: 'a hopeful indie track',
      bpm: 0,
      inferenceSteps: 50,
      shift: 1.5
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
        {
          type: 'audioGenStream',
          done: true,
          stopReason: 'completed',
          stats: { totalTimeMs: 9000, metadata }
        }
      ])
    }
  )

  await run.audio
  t.is(capturedRequest?.bpm, 0, 'bpm 0 lets the LM infer it')
  t.is(capturedRequest?.inferenceSteps, 50)
  t.is(capturedRequest?.shift, 1.5)
  t.alike((await run.stats)?.metadata, metadata)
})

test('audioGen client rejects values the addon would refuse before opening the stream', (t) => {
  const rejects = (params: Partial<AudioGenClientParams>, message: string) => {
    let opened = false
    t.exception(
      () =>
        createAudioGenResult(
          { modelId: 'audio-model', caption: 'x', ...params },
          function streamFactory() {
            opened = true
            return mockResponses([])
          }
        ),
      RequestValidationFailedError,
      message
    )
    t.absent(opened, `${message}: no stream is opened`)
  }
  rejects({ shift: 1e-50 }, 'a positive shift that rounds to a float32 zero')
  rejects({ inferenceSteps: 1001 }, 'steps are capped at 1000')
  rejects({ bpm: 2147483648 }, 'bpm is an int32')
  rejects({ seed: 2 ** 53 }, 'seed is a safe integer')
  rejects({ dcwScaler: 1e39 }, 'DCW scalers are within the float32 range')
})

test('audioEdit client forwards the edit-run controls and normalizes the reference', async (t) => {
  let capturedRequest: AudioEditStreamRequest | undefined
  const reference = new Float32Array([0.5, -0.5])
  const run = createAudioEditResult(
    {
      modelId: 'audio-model',
      sourceAudio: '/tmp/song.wav',
      operations: [{ type: 'repaint', caption: 'analog synth solo', start: 10, end: 20 }],
      referenceAudio: Buffer.from(reference.buffer, reference.byteOffset, reference.byteLength),
      vocalLanguage: 'en',
      bpm: 120,
      keyscale: 'C minor',
      timesignature: '4/4',
      augmentCaptionWithMetadata: true,
      dcwEnabled: false,
      dcwScaler: 0.04,
      dcwHighScaler: 0.01,
      inferenceSteps: 16,
      shift: 2
    },
    function streamFactory(request) {
      capturedRequest = request
      return mockResponses([
        {
          type: 'audioEditStream',
          data: 'AAE=',
          sampleRate: 48000,
          channels: 2,
          bitsPerSample: 16
        },
        { type: 'audioEditStream', done: true, stopReason: 'completed' }
      ])
    }
  )

  await run.audio
  t.alike(capturedRequest?.referenceAudio, {
    type: 'base64',
    value: Buffer.from(reference.buffer).toString('base64')
  })
  t.is(capturedRequest?.vocalLanguage, 'en')
  t.is(capturedRequest?.bpm, 120)
  t.is(capturedRequest?.keyscale, 'C minor')
  t.is(capturedRequest?.timesignature, '4/4')
  t.is(capturedRequest?.augmentCaptionWithMetadata, true)
  t.is(capturedRequest?.dcwEnabled, false)
  t.is(capturedRequest?.dcwScaler, 0.04)
  t.is(capturedRequest?.dcwHighScaler, 0.01)
  t.is(capturedRequest?.inferenceSteps, 16)
  t.is(capturedRequest?.shift, 2)
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

// ---------------------------------------------------------------------------
// audioUnderstand: the reverse pipeline returns a description, not PCM
// ---------------------------------------------------------------------------

const description = {
  caption: 'downtempo synthwave',
  bpm: 96,
  duration: 12.5,
  keyscale: 'F minor',
  timesignature: '4/4',
  vocalLanguage: 'en',
  audioCodes: [7, -3, 2048],
  seed: 11
}

function createUnderstandRun(
  responses: unknown[],
  capture?: (request: AudioUnderstandRequest) => void
) {
  const streamFactory: AudioUnderstandStreamFactory = function (request) {
    capture?.(request)
    return mockResponses(responses)
  }
  return createAudioUnderstandResult(
    { modelId: 'audio-model', sourceAudio: '/tmp/song.wav', seed: 11 },
    streamFactory
  )
}

test('audioUnderstand client collects progress, the description, stats and requestId', async (t) => {
  let capturedRequest: AudioUnderstandRequest | undefined
  const run = createUnderstandRun(
    [
      { type: 'audioUnderstand', progress: { stage: 'lm', step: 1, total: 2 } },
      { type: 'audioGenStream', data: 'AAE=', sampleRate: 44100, channels: 2 },
      { type: 'audioUnderstand', understand: description },
      {
        type: 'audioUnderstand',
        done: true,
        stopReason: 'completed',
        stats: { audioDurationMs: 12_500, understand: description },
        diagnostics: { selectedBackend: 'cpu', selectedDevice: 'cpu' }
      }
    ],
    function capture(request) {
      capturedRequest = request
    }
  )

  t.ok(run.requestId.length > 0, 'requestId is available synchronously')
  const progress = await collect(run.progressStream)
  const resolved = await run.description
  const stats = await run.stats
  const diagnostics = await run.diagnostics

  t.is(capturedRequest?.type, 'audioUnderstand')
  t.is(capturedRequest?.requestId, run.requestId)
  t.alike(capturedRequest?.sourceAudio, { type: 'filePath', value: '/tmp/song.wav' })
  t.is(capturedRequest?.seed, 11)

  t.alike(progress, [{ stage: 'lm', step: 1, total: 2 }])
  t.alike(resolved, description)
  t.is(resolved.seed, 11, 'the description reports the seed the LM decode used')
  t.alike(stats?.understand, description)
  t.alike(diagnostics, { selectedBackend: 'cpu', selectedDevice: 'cpu' })
})

test('audioUnderstand client falls back to the streamed description', async (t) => {
  const run = createUnderstandRun([
    { type: 'audioUnderstand', understand: description },
    { type: 'audioUnderstand', done: true, stopReason: 'completed', stats: { totalTimeMs: 40 } }
  ])

  t.alike(
    await run.description,
    description,
    'a terminal frame without stats.understand still settles'
  )
  t.is((await run.stats)?.totalTimeMs, 40)
  t.absent(await run.diagnostics)
})

test('audioUnderstand client rejects a terminal frame carrying no description', async (t) => {
  const run = createUnderstandRun([
    { type: 'audioUnderstand', done: true, stopReason: 'completed', stats: { totalTimeMs: 40 } }
  ])

  const settled = await Promise.allSettled([run.description, run.stats, run.diagnostics])
  for (const outcome of settled) {
    t.is(outcome.status, 'rejected')
    if (outcome.status === 'rejected') t.ok(outcome.reason instanceof InvalidResponseError)
  }
})

test('audioUnderstand client rejects aggregates with a typed cancellation error', async (t) => {
  const run = createUnderstandRun([
    { type: 'audioUnderstand', progress: { stage: 'lm', step: 1, total: 2 } },
    { type: 'audioUnderstand', done: true, stopReason: 'cancelled' }
  ])

  const progress = await collect(run.progressStream)
  const settled = await Promise.allSettled([run.description, run.stats, run.diagnostics])

  t.is(progress.length, 1)
  for (const outcome of settled) {
    t.is(outcome.status, 'rejected')
    if (outcome.status === 'rejected') {
      t.ok(outcome.reason instanceof InferenceCancelledError)
      t.is(outcome.reason.requestId, run.requestId)
    }
  }
})

test('audioUnderstand client rejects a stream without a terminal frame', async (t) => {
  const run = createUnderstandRun([{ type: 'audioUnderstand', understand: description }])

  const settled = await Promise.allSettled([
    run.description,
    run.stats,
    run.diagnostics,
    collect(run.progressStream)
  ])

  for (const outcome of settled) {
    t.is(outcome.status, 'rejected')
    if (outcome.status === 'rejected') t.ok(outcome.reason instanceof InvalidResponseError)
  }
})

test('audioUnderstand client rejects invalid params before opening a stream', async (t) => {
  let opened = 0
  const streamFactory: AudioUnderstandStreamFactory = function () {
    opened++
    return mockResponses([])
  }
  t.exception(
    () => createAudioUnderstandResult({ modelId: '', sourceAudio: '/tmp/song.wav' }, streamFactory),
    RequestValidationFailedError
  )
  t.is(opened, 0, 'no RPC stream is opened for a rejected request')
})
