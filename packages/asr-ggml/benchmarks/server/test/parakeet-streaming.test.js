'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  STREAMING_DEFAULT_CHUNK_MS,
  buildStreamingOptions,
  chunkBytesForMs,
  sliceBuffer,
  isTranscriptSegment,
  containsTranscript,
  collectFinalSegments,
  joinSegments
} = require('../src/services/parakeetStreaming')

test('buildStreamingOptions applies the documented defaults', () => {
  const options = buildStreamingOptions({})

  assert.deepEqual(options, {
    chunkMs: STREAMING_DEFAULT_CHUNK_MS,
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

test('collectFinalSegments keeps finals and drops partial hypotheses', () => {
  const segments = []

  collectFinalSegments(segments, [{ text: 'partial hypothesis' }])
  collectFinalSegments(segments, [
    { text: 'final', toAppend: true },
    { type: 'endOfTurn', source: 'model-eou' }
  ])
  collectFinalSegments(segments, [{ text: '[Audio too short]', toAppend: true }])

  assert.deepEqual(
    segments.map((s) => s.text),
    ['final']
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
