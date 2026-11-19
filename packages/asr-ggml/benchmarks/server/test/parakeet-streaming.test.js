'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  buildStreamingOptions,
  chunkBytesForMs,
  sliceBuffer,
  isTranscriptSegment,
  containsTranscript,
  collectAppendSegments,
  joinSegments,
  transcribeStreaming
} = require('../src/services/parakeetStreaming')

test('buildStreamingOptions applies the documented defaults', () => {
  const options = buildStreamingOptions({})

  assert.deepEqual(options, {
    emitPartials: true
  })
})

test('buildStreamingOptions forwards the ms-based controls', () => {
  const options = buildStreamingOptions({
    streamingChunkMs: 480,
    streamingHistoryMs: 30000,
    streamingEmitPartials: false
  })

  assert.deepEqual(options, { chunkMs: 480, emitPartials: false, historyMs: 30000 })
})

test('streaming PCM writes stay at 320 ms with or without a decode override', async () => {
  const sampleRate = 16000
  const writeBytes = chunkBytesForMs(sampleRate, 320)
  for (const chunkMs of [undefined, 30000]) {
    const config = chunkMs === undefined ? {} : { streamingChunkMs: chunkMs }
    const expected =
      chunkMs === undefined ? { emitPartials: true } : { emitPartials: true, chunkMs }
    const model = {
      async runStreaming(audio, options) {
        assert.deepEqual(options, expected)
        const sizes = []
        for await (const chunk of audio) sizes.push(chunk.length)
        assert.deepEqual(sizes, [writeBytes, 2])
        return {
          onUpdate(update) {
            update({ text: 'test transcript', toAppend: true })
            return this
          },
          await() {}
        }
      }
    }

    const result = await transcribeStreaming(
      model,
      new Uint8Array(writeBytes + 2),
      sampleRate,
      config,
      () => 0
    )
    assert.deepEqual(result, { text: 'test transcript', firstPartialMs: 0 })
  }
})

test('chunkBytesForMs sizes whole s16le samples', () => {
  assert.equal(chunkBytesForMs(16000, 320), 16000 * 0.32 * 2)
  assert.equal(chunkBytesForMs(16000, 320) % 2, 0)
})

test('sliceBuffer covers the buffer without loss', async () => {
  const buffer = Uint8Array.from({ length: 10 }, (_, i) => i)

  const chunks = []
  for await (const chunk of sliceBuffer(buffer, 4)) {
    chunks.push(chunk)
  }

  assert.deepEqual(
    chunks.map((c) => c.length),
    [4, 4, 2]
  )
  assert.deepEqual(
    Array.from(Uint8Array.from(chunks.flatMap((c) => Array.from(c)))),
    Array.from(buffer)
  )
})

test('isTranscriptSegment rejects events, empties, and silence sentinels', () => {
  assert.equal(isTranscriptSegment({ text: 'hello', toAppend: true }), true)
  assert.equal(isTranscriptSegment({ text: 'partial' }), true)
  assert.equal(isTranscriptSegment({ type: 'endOfTurn', source: 'model-eou' }), false)
  assert.equal(isTranscriptSegment({ type: 'vad', speaking: true, score: 1, text: 'x' }), false)
  assert.equal(isTranscriptSegment({ text: '   ' }), false)
  assert.equal(isTranscriptSegment({ text: '[No speech detected]' }), false)
})

test('containsTranscript spots the first partial in a mixed update', () => {
  assert.equal(containsTranscript([{ type: 'vad', speaking: true, score: 1 }]), false)
  assert.equal(
    containsTranscript([{ type: 'vad', speaking: true, score: 1 }, { text: 'hyp' }]),
    true
  )
})

test('collectAppendSegments keeps append segments and drops replacement hypotheses', () => {
  const segments = []

  collectAppendSegments(segments, [{ text: 'replacement hypothesis' }])
  collectAppendSegments(segments, [
    { text: 'increment', toAppend: true },
    { type: 'endOfTurn', source: 'model-eou' }
  ])
  collectAppendSegments(segments, [{ text: '[Audio too short]', toAppend: true }])

  assert.deepEqual(
    segments.map((s) => s.text),
    ['increment']
  )
})

test('joinSegments rejoins wordpiece continuations without a separator', () => {
  const text = joinSegments([
    { text: 'see', toAppend: true },
    { text: 'if', toAppend: true, startsWord: true },
    { text: 'pun', toAppend: true },
    { text: 'ctuation', toAppend: true, startsWord: false }
  ])

  assert.equal(text, 'see if punctuation')
})
