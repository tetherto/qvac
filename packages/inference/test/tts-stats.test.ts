import test from 'brittle'
import { collectTtsStats, chunkMetadata } from '@/utils/tts-stats'

test('collectTtsStats: maps LavaSR enhancer backend stats', (t) => {
  const stats = collectTtsStats({
    stats: {
      audioDurationMs: 1200,
      totalSamples: 48000,
      enhancerBackendDevice: 1,
      enhancerBackendId: 3
    }
  })

  t.alike(stats, {
    audioDuration: 1200,
    totalSamples: 48000,
    enhancerBackendDevice: 1,
    enhancerBackendId: 3
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
      enhancerBackendId: 0
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
    enhancerBackendId: 0
  })
})

test('collectTtsStats: preserves zero-valued backend codes', (t) => {
  // `backendDevice: 0` means CPU, not "absent"; a truthiness check would drop it.
  const stats = collectTtsStats({ stats: { backendDevice: 0, backendId: 0, gpuUnsupported: 0 } })
  t.alike(stats, { backendDevice: 0, backendId: 0, gpuUnsupported: 0 })
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
