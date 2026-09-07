'use strict'

// Pure helpers for the parakeet streaming benchmark path. No bare-* imports
// so `node --test` can exercise them without the Bare runtime.

const STREAMING_DEFAULT_CHUNK_MS = 320
const STREAMING_DEFAULT_EMIT_PARTIALS = true
const BYTES_PER_S16LE_SAMPLE = 2
const MS_PER_SECOND = 1000

// Placeholder texts parakeet-cpp emits instead of a transcript; they must not
// reach WER scoring or count as a first partial.
const SILENCE_SENTINELS = new Set([
  '[No speech detected]',
  '[Audio too short]',
  '[Model not ready]'
])

const buildStreamingOptions = (config) => {
  const options = {
    chunkMs: config.streamingChunkMs || STREAMING_DEFAULT_CHUNK_MS,
    emitPartials: config.streamingEmitPartials ?? STREAMING_DEFAULT_EMIT_PARTIALS
  }
  if (config.streamingHistoryMs) {
    options.historyMs = config.streamingHistoryMs
  }
  return options
}

const chunkBytesForMs = (sampleRate, chunkMs) => {
  const samples = Math.round((sampleRate * chunkMs) / MS_PER_SECOND)
  return Math.max(samples, 1) * BYTES_PER_S16LE_SAMPLE
}

async function* sliceBuffer(buffer, chunkBytes) {
  for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
    yield buffer.subarray(offset, Math.min(offset + chunkBytes, buffer.length))
  }
}

const isEvent = (item) => typeof item?.type === 'string'

const isTranscriptSegment = (item) =>
  !isEvent(item) &&
  typeof item?.text === 'string' &&
  item.text.trim().length > 0 &&
  !SILENCE_SENTINELS.has(item.text)

const containsTranscript = (items) => items.some(isTranscriptSegment)

// Partial hypotheses arrive with toAppend unset and are superseded by the
// finalized segments that follow, so only toAppend segments join the
// transcript (same rule as the package's live-mic example).
const collectFinalSegments = (segments, items) => {
  for (const item of items) {
    if (isTranscriptSegment(item) && item.toAppend) {
      segments.push(item)
    }
  }
}

// `startsWord: false` marks a wordpiece continuation straddling a chunk
// boundary ("pun" + "ctuation"), which must rejoin without a separator.
const joinSegments = (segments) => {
  let text = ''
  for (const segment of segments) {
    const separator = text.length > 0 && segment.startsWord !== false ? ' ' : ''
    text += separator + segment.text
  }
  return text.replace(/\s+/g, ' ').trim()
}

module.exports = {
  STREAMING_DEFAULT_CHUNK_MS,
  STREAMING_DEFAULT_EMIT_PARTIALS,
  buildStreamingOptions,
  chunkBytesForMs,
  sliceBuffer,
  isTranscriptSegment,
  containsTranscript,
  collectFinalSegments,
  joinSegments
}
