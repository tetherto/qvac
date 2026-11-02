'use strict'

const test = require('brittle')
const process = require('bare-process')
const {
  SentenceStreamer,
  computeSentenceStreamStats,
  emptyStreamAccumulator,
  normalizeTextStream,
  resolveRunStreamingOptions,
  splitSentenceChunks
} = require('../../lib/sentenceStream.js')

global.process = process

function fakeHost({ dispatch } = {}) {
  const host = {
    started: 0,
    jobs: [],
    ended: [],
    failed: [],
    frames: false,
    startJob() {
      return { id: ++host.started }
    },
    async dispatchJob(job) {
      host.jobs.push(job)
      if (dispatch) await dispatch(job, host)
    },
    endJob(stats) {
      host.ended.push(stats)
    },
    failJob(error) {
      host.failed.push(error)
    },
    countsFrames() {
      return host.frames
    }
  }
  return host
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('sentence stream: chunks run one at a time and their stats fold into one aggregate', async (t) => {
  const host = fakeHost()
  const streamer = new SentenceStreamer(host)
  const response = streamer.streamChunks(['One.', 'Two.'], { voice: 'Rohit' })
  t.is(response.id, 1, 'the host opened the response')
  await tick()
  t.alike(
    host.jobs,
    [{ type: 'text', input: 'One.', voice: 'Rohit' }],
    'the second chunk waits for the first stats event; job fields replay per chunk'
  )
  const first = streamer.enrich({ outputArray: new Int16Array(2), sampleRate: 24000, isLast: true })
  t.is(first.chunkIndex, 0)
  t.is(first.sentenceChunk, 'One.')
  t.is(first.sampleRate, 24000)
  t.is(first.isLast, false, 'not the last sentence yet')
  t.ok(
    streamer.onStats({
      totalTime: 0.5,
      audioDurationMs: 1000,
      totalSamples: 24000,
      firstAudioMs: 80
    })
  )
  await tick()
  t.is(host.jobs.length, 2)
  t.is(host.jobs[1].input, 'Two.')
  t.is(
    streamer.enrich({ outputArray: new Int16Array(1), isLast: true }).isLast,
    true,
    'the last native chunk of the last sentence is last'
  )
  t.ok(
    streamer.onStats({
      totalTime: 0.5,
      audioDurationMs: 1000,
      totalSamples: 24000,
      firstAudioMs: 20
    })
  )
  await tick()
  t.is(host.ended.length, 1)
  const stats = host.ended[0]
  t.is(stats.firstAudioMs, 80, 'the first chunk sets the first-audio latency')
  t.is(stats.totalTime, 1)
  t.is(stats.audioDurationMs, 2000)
  t.is(stats.tokensPerSecond, 8, 'eight characters over one second')
  t.is(stats.realTimeFactor, 0.5)
  t.is(streamer.ctx, null, 'the stream is released')
  t.alike(host.failed, [])
})

test('sentence stream: a rejected dispatch fails the stream once and clears it', async (t) => {
  const host = fakeHost({
    dispatch: () => {
      throw new Error('dispatch failed')
    }
  })
  const streamer = new SentenceStreamer(host)
  streamer.streamChunks(['One.'])
  await tick()
  t.is(streamer.ctx, null)
  t.is(host.failed.length, 1)
  t.is(host.failed[0].message, 'dispatch failed')
  t.alike(host.ended, [])
})

test('sentence stream: fail() rejects the chunk in flight and reports the reason once', async (t) => {
  const host = fakeHost()
  const streamer = new SentenceStreamer(host)
  streamer.streamChunks(['One.', 'Two.'])
  await tick()
  streamer.fail('Synthesis cancelled')
  await tick()
  t.is(streamer.ctx, null)
  t.alike(host.failed, ['Synthesis cancelled'])
  t.is(host.jobs.length, 1, 'the second chunk never dispatches')
})

test('sentence stream: text-stream mode skips blank pieces and ends with aggregate stats', async (t) => {
  const host = fakeHost()
  const streamer = new SentenceStreamer(host)
  async function* pieces() {
    yield '   '
    yield 'Hello.'
  }
  streamer.streamText(pieces())
  await tick()
  t.is(host.jobs.length, 1)
  t.is(host.jobs[0].input, 'Hello.')
  const chunk = streamer.enrich({ outputArray: new Int16Array(1), isLast: true })
  t.is(chunk.sentenceChunk, 'Hello.')
  t.absent(chunk.isLast, 'text streaming cannot know the last chunk up front')
  t.ok(streamer.onStats({ totalTime: 0.25, audioDurationMs: 500, totalSamples: 12000 }))
  await tick()
  t.is(host.ended.length, 1)
  t.is(host.ended[0].tokensPerSecond, 24, 'six characters over a quarter second')
  t.is(streamer.ctx, null)

  const quiet = fakeHost()
  const quietStreamer = new SentenceStreamer(quiet)
  quietStreamer.streamText((async function* () {})())
  await tick()
  t.alike(
    quiet.ended,
    [{ totalTime: 0, tokensPerSecond: 0, realTimeFactor: 0, audioDurationMs: 0, totalSamples: 0 }],
    'an empty source ends with zeroed stats'
  )
})

test('sentence stream: frame-paced engines count codec frames instead of characters', (t) => {
  const acc = emptyStreamAccumulator()
  acc.totalTime = 2
  acc.audioDurationMs = 4000
  acc.totalSamples = 1
  acc.generatedFrames = 86
  acc.codecOnCoreml = 1
  const frames = computeSentenceStreamStats(['abcd'], acc, true)
  t.is(frames.tokensPerSecond, 43)
  t.is(frames.generatedFrames, 86)
  t.is(frames.codecOnCoreml, 1)
  const chars = computeSentenceStreamStats(['abcd'], acc, false)
  t.is(chars.tokensPerSecond, 2)
  t.absent(chars.generatedFrames, 'text-paced engines do not report frames')
  t.is(chars.realTimeFactor, 0.5)
})

test('sentence stream: runStreaming options default by input shape', (t) => {
  async function* source() {}
  t.ok(resolveRunStreamingOptions(source(), {}).accumulateSentences, 'async iterables accumulate')
  t.absent(resolveRunStreamingOptions(['a'], {}).accumulateSentences)
  t.absent(resolveRunStreamingOptions('a', {}).accumulateSentences)
  const resolved = resolveRunStreamingOptions('a', {
    accumulateSentences: true,
    sentenceDelimiterPreset: 'nope',
    sentenceDelimiter: 'not a regexp',
    maxBufferScalars: 40
  })
  t.is(resolved.sentenceDelimiterPreset, 'multilingual', 'an unknown preset falls back')
  t.absent(resolved.sentenceDelimiter, 'only a RegExp delimiter is kept')
  t.is(resolved.maxBufferScalars, 40)
  t.is(typeof resolved.flushAfterMs, 'number')
  t.is(
    resolveRunStreamingOptions('a', { sentenceDelimiterPreset: 'cjk', flushAfterMs: 5 })
      .flushAfterMs,
    5
  )
})

test('sentence stream: every text input shape normalizes to an async iterable', async (t) => {
  async function collect(input) {
    const out = []
    for await (const piece of normalizeTextStream(input)) out.push(piece)
    return out
  }
  t.alike(await collect('one'), ['one'])
  t.alike(await collect(['a', 'b']), ['a', 'b'])
  t.alike(await collect(new Set(['x'])), ['x'])
  t.alike(
    await collect(
      (async function* () {
        yield 'y'
      })()
    ),
    ['y']
  )
  t.exception(() => normalizeTextStream(null), /text stream is required/)
  t.exception(
    () => normalizeTextStream(42),
    /expected string, array of strings, Iterable, or AsyncIterable/
  )
})

test('sentence stream: splitting text that yields no chunks is an error', (t) => {
  t.ok(splitSentenceChunks('One. Two.', { maxChunkScalars: 5 }, 'en').length >= 2)
  t.exception(() => splitSentenceChunks('   ', {}, 'en'), /produced no chunks after split/)
})
