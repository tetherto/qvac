'use strict'

/**
 * Text chunking for sentence-stream TTS.
 *
 * `Intl.Segmenter` is used when present (typical Bun/Node). The Bare worker
 * used by the SDK may not define `Intl.Segmenter`; in that case splitting falls
 * back to punctuation rules and max-length chunking only.
 */

/**
 * Whether `Intl.Segmenter` exists (Bun/Node). Bare may omit it; callers
 * should always use {@link splitTtsText} which falls back to punctuation
 * and max-length chunking.
 */
function intlSentenceSegmentationAvailable () {
  return (
    typeof Intl !== 'undefined' &&
    typeof Intl.Segmenter === 'function'
  )
}

/**
 * @param {string} text
 * @param {string} [locale]
 * @returns {string[]|null}
 */
function splitByIntlSentences (text, locale) {
  if (!intlSentenceSegmentationAvailable()) return null
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    const seg = new Intl.Segmenter(locale || 'en', { granularity: 'sentence' })
    const out = []
    for (const s of seg.segment(trimmed)) {
      const part = s.segment.trim()
      if (part.length > 0) out.push(part)
    }
    if (out.length === 0) return null
    return out
  } catch {
    return null
  }
}

const SENTENCE_TERMINATORS = /([.!?。！？؟])(\s*)/gu

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitByAsciiAndCjkPunctuation (text) {
  const parts = []
  let lastIndex = 0
  let m
  while ((m = SENTENCE_TERMINATORS.exec(text)) !== null) {
    const end = m.index + m[1].length
    const slice = text.slice(lastIndex, end).trim()
    if (slice.length > 0) parts.push(slice)
    lastIndex = m.index + m[0].length
  }
  const tail = text.slice(lastIndex).trim()
  if (tail.length > 0) parts.push(tail)
  return parts
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitByParagraphs (text) {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0)
}

const MIN_CHUNK_GRAPHEMES = 10

/**
 * @param {string[]} chunks
 * @returns {string[]}
 */
function mergeShortChunks (chunks) {
  const merged = []
  let buffer = ''

  for (const chunk of chunks) {
    if (buffer.length === 0) {
      buffer = chunk
      continue
    }

    const graphemeCount = [...buffer].length
    if (graphemeCount < MIN_CHUNK_GRAPHEMES) {
      buffer = buffer + ' ' + chunk
    } else {
      merged.push(buffer)
      buffer = chunk
    }
  }

  if (buffer.length > 0) {
    merged.push(buffer)
  }

  return merged
}

/**
 * @param {string} s
 * @returns {number}
 */
function countScalars (s) {
  return [...s].length
}

/**
 * @param {string} text
 * @param {number} maxScalars
 * @returns {string[]}
 */
function hardSplitByMaxScalars (text, maxScalars) {
  if (maxScalars < 10) maxScalars = 10
  const g = [...text]
  if (g.length <= maxScalars) return [text]
  const out = []
  let i = 0
  while (i < g.length) {
    const slice = g.slice(i, i + maxScalars).join('')
    out.push(slice)
    i += maxScalars
  }
  return out
}

/**
 * Merge adjacent pieces until each is at most maxScalars (grapheme count).
 * @param {string[]} pieces
 * @param {number} maxScalars
 * @returns {string[]}
 */
function mergeUpToMaxScalars (pieces, maxScalars) {
  const out = []
  let current = ''

  for (const p of pieces) {
    const piece = p.trim()
    if (!piece) continue
    const trial = current.length ? `${current} ${piece}` : piece
    if (countScalars(trial) <= maxScalars) {
      current = trial
    } else {
      if (current.length > 0) {
        out.push(...hardSplitByMaxScalars(current, maxScalars))
      }
      current = piece
    }
  }
  if (current.length > 0) {
    out.push(...hardSplitByMaxScalars(current, maxScalars))
  }
  return out.filter(s => s.trim().length > 0)
}

/**
 * Split long text into synthesis-sized chunks for sentence streaming.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.language] BCP-47 / model language (e.g. en, ko)
 * @param {string} [options.locale] Optional override for Intl.Segmenter
 * @param {number} [options.maxScalars] Max graphemes per chunk (default aligns with Supertonic)
 * @param {boolean} [options.mergeToMaxScalars] When false, return sentence-level pieces only (no
 *   mergeUpToMaxScalars pass). Default true. Useful for test harnesses that synthesize per sentence.
 * @returns {string[]}
 */
function splitTtsText (text, options = {}) {
  const mergeToMaxScalars = options.mergeToMaxScalars !== false
  const language = (options.language || 'en').toLowerCase()
  const maxScalars =
    options.maxScalars != null
      ? options.maxScalars
      : language === 'ko'
        ? 120
        : 300

  const raw = text.trim()
  if (!raw) return []

  const locale = options.locale || language

  let sentences = splitByIntlSentences(raw, locale)
  if (!sentences || sentences.length === 0) {
    const paras = splitByParagraphs(raw)
    const blocks = paras.length > 0 ? paras : [raw]
    sentences = []
    for (const para of blocks) {
      const sents = splitByAsciiAndCjkPunctuation(para)
      const mergedShort = mergeShortChunks(sents.length > 0 ? sents : [para])
      for (const m of mergedShort) {
        if (m.trim()) sentences.push(m.trim())
      }
    }
  }

  if (sentences.length === 0) {
    if (!mergeToMaxScalars) {
      return [raw]
    }
    return mergeUpToMaxScalars([raw], maxScalars)
  }

  if (!mergeToMaxScalars) {
    return sentences
  }

  return mergeUpToMaxScalars(sentences, maxScalars)
}

module.exports = {
  splitTtsText,
  intlSentenceSegmentationAvailable,
  splitByIntlSentences,
  splitByAsciiAndCjkPunctuation,
  countScalars
}
