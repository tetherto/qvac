'use strict'

const DEFAULT_CROSSFADE_SAMPLES = 720
const SILENCE_GAP_SAMPLES = 2400

function applyCrossfade (prevChunk, nextChunk, crossfadeSamples) {
  if (crossfadeSamples <= 0) return { prev: prevChunk, next: nextChunk }
  if (prevChunk.length < crossfadeSamples || nextChunk.length < crossfadeSamples) {
    return { prev: prevChunk, next: nextChunk }
  }

  const prevCopy = prevChunk.slice()
  const nextCopy = nextChunk.slice()
  const fadeStart = prevCopy.length - crossfadeSamples

  for (let i = 0; i < crossfadeSamples; i++) {
    const fadeOut = 1.0 - (i / crossfadeSamples)
    const fadeIn = i / crossfadeSamples
    prevCopy[fadeStart + i] = Math.round(prevCopy[fadeStart + i] * fadeOut)
    nextCopy[i] = Math.round(nextCopy[i] * fadeIn)
  }

  return { prev: prevCopy, next: nextCopy }
}

function createSilenceGap (samples) {
  return new Int16Array(samples)
}

function concatenatePcmChunks (chunks, options = {}) {
  if (chunks.length === 0) return new Int16Array(0)
  if (chunks.length === 1) return toInt16Array(chunks[0])

  const crossfadeSamples = options.crossfadeSamples ?? DEFAULT_CROSSFADE_SAMPLES
  const silenceGapSamples = options.silenceGapSamples ?? SILENCE_GAP_SAMPLES

  const parts = []
  let previous = toInt16Array(chunks[0])

  for (let i = 1; i < chunks.length; i++) {
    let current = toInt16Array(chunks[i])

    if (crossfadeSamples > 0) {
      const result = applyCrossfade(previous, current, crossfadeSamples)
      previous = result.prev
      current = result.next
    }

    parts.push(previous)

    if (silenceGapSamples > 0) {
      parts.push(createSilenceGap(silenceGapSamples))
    }

    previous = current
  }

  parts.push(previous)

  return mergeInt16Arrays(parts)
}

function toInt16Array (arr) {
  if (arr instanceof Int16Array) return arr
  return Int16Array.from(arr)
}

function mergeInt16Arrays (arrays) {
  let totalLength = 0
  for (const arr of arrays) {
    totalLength += arr.length
  }

  const result = new Int16Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }

  return result
}

module.exports = { concatenatePcmChunks }
