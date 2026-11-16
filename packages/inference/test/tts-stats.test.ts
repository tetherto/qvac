import test from 'brittle'
import { appendPcm, carriesSpeechTokenIds, collectTtsStats, chunkMetadata } from '@/utils/tts-stats'

test('collectTtsStats: maps LavaSR enhancer and denoiser backend stats', (t) => {
  const stats = collectTtsStats({
    stats: {
      audioDurationMs: 1200,
      totalSamples: 48000,
      enhancerBackendDevice: 1,
      enhancerBackendId: 3,
      denoiserBackendDevice: 1,
      denoiserBackendId: 3
    }
  })

  t.alike(stats, {
    audioDuration: 1200,
    totalSamples: 48000,
    enhancerBackendDevice: 1,
    enhancerBackendId: 3,
    denoiserBackendDevice: 1,
    denoiserBackendId: 3
  })
})

test('collectTtsStats: reports an unloaded LavaSR stage as -1', (t) => {
  const stats = collectTtsStats({
    stats: {
      enhancerBackendDevice: 1,
      enhancerBackendId: 2,
      denoiserBackendDevice: -1,
      denoiserBackendId: -1
    }
  })

  t.alike(stats, {
    enhancerBackendDevice: 1,
    enhancerBackendId: 2,
    denoiserBackendDevice: -1,
    denoiserBackendId: -1
  })
})

test('collectTtsStats: maps the whole addon RuntimeStats surface', (t) => {
  // Previously only 4 of the addon's 11 fields survived, so RTF, throughput
  // and the engine's own backend selection never reached a caller.
  const stats = collectTtsStats({
    stats: {
      audioDurationMs: 1200,
      totalTime: 400,
      realTimeFactor: 0.33,
      tokensPerSecond: 75,
      totalSamples: 28800,
      generatedFrames: 26,
      backendDevice: 1,
      backendId: 1,
      gpuUnsupported: 0,
      enhancerBackendDevice: 0,
      enhancerBackendId: 0,
      denoiserBackendDevice: 0,
      denoiserBackendId: 0
    }
  })

  t.alike(stats, {
    audioDuration: 1200,
    totalTime: 400,
    realTimeFactor: 0.33,
    tokensPerSecond: 75,
    totalSamples: 28800,
    generatedFrames: 26,
    backendDevice: 1,
    backendId: 1,
    gpuUnsupported: 0,
    enhancerBackendDevice: 0,
    enhancerBackendId: 0,
    denoiserBackendDevice: 0,
    denoiserBackendId: 0
  })
})

test('collectTtsStats: preserves zero-valued backend codes', (t) => {
  // `backendDevice: 0` means CPU, not "absent"; a truthiness check would drop it.
  const stats = collectTtsStats({ stats: { backendDevice: 0, backendId: 0, gpuUnsupported: 0 } })
  t.alike(stats, { backendDevice: 0, backendId: 0, gpuUnsupported: 0 })
})

test('collectTtsStats: forwards the Audio8 Core ML codec flags, zero included', (t) => {
  // 0 is a real report (no sidecar, or this call fell back to ggml), not absence.
  t.alike(collectTtsStats({ stats: { codecSidecarLoaded: 1, codecOnCoreml: 1 } }), {
    codecSidecarLoaded: 1,
    codecOnCoreml: 1
  })
  t.alike(collectTtsStats({ stats: { codecSidecarLoaded: 1, codecOnCoreml: 0 } }), {
    codecSidecarLoaded: 1,
    codecOnCoreml: 0
  })
})

test('collectTtsStats: returns an empty object when the addon reported nothing', (t) => {
  t.alike(collectTtsStats({}), {})
})

test('chunkMetadata: forwards everything a chunk carries beyond its PCM', (t) => {
  t.alike(
    chunkMetadata({
      outputArray: new Int16Array(2),
      sampleRate: 48000,
      chunkIndex: 3,
      sentenceChunk: 'Hello.',
      isLast: true
    }),
    { sampleRate: 48000, chunkIndex: 3, sentenceChunk: 'Hello.', isLast: true }
  )
})

test('chunkMetadata: omits absent fields and empty sentence text', (t) => {
  t.alike(chunkMetadata({ outputArray: new Int16Array(2) }), {})
  t.alike(
    chunkMetadata({ outputArray: new Int16Array(2), chunkIndex: 0, sentenceChunk: '' }),
    { chunkIndex: 0 },
    'chunkIndex 0 is real; an empty sentenceChunk is not'
  )
})

test('appendPcm: appends each chunk in place, in order', (t) => {
  const buffer: number[] = []
  appendPcm(buffer, new Int16Array([1, -2, 3]))
  appendPcm(buffer, [])
  appendPcm(buffer, new Int16Array([32767, -32768]))
  t.alike(buffer, [1, -2, 3, 32767, -32768])
})

test('collectTtsStats: forwards the engines’ stage timings and counters, zero included', (t) => {
  // Chatterbox, CosyVoice3 and Audio8 each report their own stages; a zero
  // stage time (e.g. no reference to encode) is a real report, not absence.
  const stats = {
    firstAudioMs: 180,
    t3Ms: 410,
    s3genMs: 220,
    t3Tokens: 125,
    stageTotalMs: 900,
    lmPrefillMs: 30,
    lmDecodeMs: 400,
    flowFrontendMs: 5,
    ditEulerMs: 300,
    hiftF0Ms: 10,
    hiftSourceMs: 20,
    hiftStftMs: 15,
    hiftDecodeMs: 120,
    decodeSteps: 100,
    speechTokens: 98,
    flowFrames: 240,
    melFrames: 200,
    textIds: 12,
    promptSpeechTokens: 140,
    voiceEncodeMs: 0,
    promptMs: 2,
    prefillMs: 40,
    sampleMs: 350,
    fastDecodeMs: 200,
    slowDecodeMs: 150,
    codecLatentMs: 60,
    codecSynthMs: 90,
    resampleMs: 4
  }
  t.alike(collectTtsStats({ stats: { audioDurationMs: 1200, ...stats } }), {
    audioDuration: 1200,
    ...stats
  })
})

test('collectTtsStats: forwards only the stage fields the addon reported', (t) => {
  t.alike(collectTtsStats({ stats: { t3Ms: 410 } }), { t3Ms: 410 })
})

test('collectTtsStats: forwards the Parler Core ML sidecar flags, zero included', (t) => {
  // 0 is a real report: a retired sidecar, or a synthesis that ran on ggml.
  t.alike(
    collectTtsStats({
      stats: { decoderSidecarLoaded: 1, dacSidecarLoaded: 1, decoderOnCoreml: 0, dacOnCoreml: 1 }
    }),
    { decoderSidecarLoaded: 1, dacSidecarLoaded: 1, decoderOnCoreml: 0, dacOnCoreml: 1 }
  )
})

test('chunkMetadata: forwards CosyVoice3 speechTokenIds and nothing else on an end marker', (t) => {
  t.alike(
    chunkMetadata({ outputArray: new Int16Array(0), isLast: true, speechTokenIds: [12, 480, 3] }),
    { isLast: true, speechTokenIds: [12, 480, 3] }
  )
  t.is(carriesSpeechTokenIds({ outputArray: new Int16Array(0), speechTokenIds: [] }), true)
  t.is(carriesSpeechTokenIds({ outputArray: new Int16Array(0), isLast: true }), false)
})
