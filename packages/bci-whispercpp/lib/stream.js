'use strict'

const { QvacErrorAddonBCI, ERR_CODES } = require('./error')

/**
 * Streaming helpers for the sliding-window transcription driver in index.js.
 *
 * These are pure functions kept separate from the class so they can be
 * unit-tested in isolation (see test/unit/stitch.test.js) and so index.js
 * stays focused on lifecycle orchestration.
 */

/**
 * Coerce a stream chunk into a Uint8Array without copying when possible.
 * Throws INVALID_STREAM_INPUT if the chunk isn't a recognised binary form.
 */
function toUint8 (chunk) {
  if (chunk instanceof Uint8Array) return chunk
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  if (Array.isArray(chunk)) return Uint8Array.from(chunk)
  throw new QvacErrorAddonBCI({
    code: ERR_CODES.INVALID_STREAM_INPUT,
    adds: 'stream yielded non-binary chunk'
  })
}

/**
 * Copy out the byte range [startTs, endTs) from a list of body chunks
 * (each element a Uint8Array) into a single contiguous Uint8Array.
 * The caller owns timestep→byte translation via bytesPerTimestep.
 */
function sliceBody (bodyChunks, bytesPerTimestep, startTs, endTs, totalBytes) {
  const startByte = startTs * bytesPerTimestep
  const endByte = Math.min(endTs * bytesPerTimestep, totalBytes)
  const out = new Uint8Array(Math.max(0, endByte - startByte))
  if (out.byteLength === 0) return out
  let offset = 0
  let cursor = 0
  for (const chunk of bodyChunks) {
    const chunkStart = cursor
    const chunkEnd = cursor + chunk.byteLength
    cursor = chunkEnd
    if (chunkEnd <= startByte) continue
    if (chunkStart >= endByte) break
    const from = Math.max(0, startByte - chunkStart)
    const to = Math.min(chunk.byteLength, endByte - chunkStart)
    out.set(chunk.subarray(from, to), offset)
    offset += (to - from)
  }
  return out
}

/**
 * Build an [T, C] header-prefixed buffer the addon can consume as a single
 * batch input, reusing the per-window body bytes.
 */
function buildWindowBuffer (windowBody, channels, windowTimesteps) {
  const out = new Uint8Array(8 + windowBody.byteLength)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(0, windowTimesteps, true)
  view.setUint32(4, channels, true)
  out.set(windowBody, 8)
  return out
}

function normalizeWord (w) {
  return w.toLowerCase().replace(/[^a-z0-9']/g, '')
}

/**
 * Text-only word-level stitch: find the longest normalised-word suffix of
 * `prevText` that also appears as a prefix of `newText`, and treat only
 * the remainder of `newText` as fresh content.
 *
 * The streaming driver in index.js uses `stitchSegments` (below) because
 * it needs to preserve per-segment timestamp metadata. `stitchMerge` is
 * retained as a public text-only helper for callers that only have raw
 * transcript strings to merge (e.g. post-hoc analysis, unit testing the
 * overlap algorithm without constructing segment objects) and as the
 * reference implementation of the underlying word-overlap logic.
 *
 * Returns { delta, merged, bestK }:
 *  - delta:  the newly-discovered tail
 *  - merged: prevText extended by delta
 *  - bestK:  number of words absorbed as overlap (for inspection/tests)
 *
 * maxWords caps the search depth so pathological inputs stay O(maxWords^2).
 * Known limitation: legitimate immediate word repetitions at a window
 * boundary (e.g. "the the") will collapse; acceptable for v1 sliding
 * window until a segmentation model replaces this.
 */
function stitchMerge (prevText, newText, maxWords) {
  const prevWords = prevText.trim().split(/\s+/).filter(Boolean)
  const newWords = newText.trim().split(/\s+/).filter(Boolean)

  if (prevWords.length === 0) {
    return { delta: newWords.join(' '), merged: newWords.join(' '), bestK: 0 }
  }
  if (newWords.length === 0) {
    return { delta: '', merged: prevWords.join(' '), bestK: 0 }
  }

  const bestK = _computeBestK(prevWords, newWords, maxWords)
  const deltaWords = newWords.slice(bestK)
  const delta = deltaWords.join(' ')
  const merged = [...prevWords, ...deltaWords].join(' ')
  return { delta, merged, bestK }
}

/**
 * Segment-aware variant of stitchMerge: preserves the per-segment
 * timestamp/metadata fields emitted by the native decoder.
 *
 * `segments` is the array returned by a per-window decode (each entry is
 * a whisper-style `{ text, t0, t1, ... }`). We run the same word-level
 * overlap detection but trim the leading `bestK` words from the incoming
 * segments rather than flattening to a single string.
 *
 * `windowStartTimestep` is attached to every emitted segment so
 * consumers can correlate a window-local `t0`/`t1` back to the absolute
 * position in the input stream.
 *
 * Returns:
 *   - deltaSegments: trimmed segments the driver should emit as an update
 *       (segments fully absorbed by the overlap are dropped; a segment
 *       partially overlapped gets its `text` rewritten to the surviving
 *       tail words).
 *   - merged: running transcript text (identical to stitchMerge.merged)
 *   - bestK: for inspection / tests
 */
function stitchSegments (prevText, segments, maxWords, windowStartTimestep = 0) {
  const prevWords = prevText.trim().split(/\s+/).filter(Boolean)

  const perSegment = []
  const newWords = []
  for (const seg of segments) {
    const text = (seg && typeof seg.text === 'string') ? seg.text : ''
    const words = text.trim().split(/\s+/).filter(Boolean)
    perSegment.push({ seg, words })
    for (const w of words) newWords.push(w)
  }

  if (newWords.length === 0) {
    return { deltaSegments: [], merged: prevWords.join(' '), bestK: 0 }
  }
  if (prevWords.length === 0) {
    const deltaSegments = perSegment
      .filter(({ words }) => words.length > 0)
      .map(({ seg }) => ({ ...seg, windowStartTimestep }))
    return { deltaSegments, merged: newWords.join(' '), bestK: 0 }
  }

  const bestK = _computeBestK(prevWords, newWords, maxWords)

  let toSkip = bestK
  const deltaSegments = []
  for (const { seg, words } of perSegment) {
    if (words.length === 0) continue
    if (toSkip >= words.length) { toSkip -= words.length; continue }
    if (toSkip === 0) {
      deltaSegments.push({ ...seg, windowStartTimestep })
    } else {
      const remainingWords = words.slice(toSkip)
      const hasT0 = typeof seg.t0 === 'number'
      const hasT1 = typeof seg.t1 === 'number'
      const approxT0 = (hasT0 && hasT1)
        ? seg.t0 + Math.round((seg.t1 - seg.t0) * (toSkip / words.length))
        : seg.t0
      deltaSegments.push({
        ...seg,
        text: remainingWords.join(' '),
        t0: approxT0,
        windowStartTimestep
      })
      toSkip = 0
    }
  }

  const merged = [...prevWords, ...newWords.slice(bestK)].join(' ')
  return { deltaSegments, merged, bestK }
}

function _computeBestK (prevWords, newWords, maxWords) {
  const maxK = Math.min(prevWords.length, newWords.length, maxWords)
  for (let k = maxK; k >= 1; k--) {
    let match = true
    for (let i = 0; i < k; i++) {
      const a = normalizeWord(prevWords[prevWords.length - k + i])
      const b = normalizeWord(newWords[i])
      if (a.length === 0 || b.length === 0 || a !== b) { match = false; break }
    }
    if (match) return k
  }
  return 0
}

module.exports = {
  toUint8,
  sliceBody,
  buildWindowBuffer,
  normalizeWord,
  stitchMerge,
  stitchSegments
}
