'use strict'

const SENTENCE_TERMINATORS_LATIN = /([.!?])\s+/g
const SENTENCE_TERMINATORS_CJK = /([。！？])/g
const SENTENCE_TERMINATORS_MIXED = /([.!?。！？])\s*/g

const CJK_RANGE_GLOBAL = /[\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g

const MIN_CHUNK_GRAPHEMES = 10

function isCjkDominant (text) {
  CJK_RANGE_GLOBAL.lastIndex = 0
  const cjkMatches = text.match(CJK_RANGE_GLOBAL)
  if (!cjkMatches) return false
  return cjkMatches.length > text.length * 0.3
}

function splitBySentenceLatin (text) {
  const parts = []
  let lastIndex = 0

  text.replace(SENTENCE_TERMINATORS_LATIN, (match, terminator, offset) => {
    const end = offset + terminator.length
    parts.push(text.slice(lastIndex, end).trim())
    lastIndex = offset + match.length
  })

  const remaining = text.slice(lastIndex).trim()
  if (remaining.length > 0) {
    parts.push(remaining)
  }

  return parts
}

function splitBySentenceCjk (text) {
  const parts = []
  let lastIndex = 0

  text.replace(SENTENCE_TERMINATORS_CJK, (match, terminator, offset) => {
    const end = offset + terminator.length
    parts.push(text.slice(lastIndex, end).trim())
    lastIndex = end
  })

  const remaining = text.slice(lastIndex).trim()
  if (remaining.length > 0) {
    parts.push(remaining)
  }

  return parts
}

function splitBySentenceMixed (text) {
  const parts = []
  let lastIndex = 0

  text.replace(SENTENCE_TERMINATORS_MIXED, (match, terminator, offset) => {
    const end = offset + terminator.length
    parts.push(text.slice(lastIndex, end).trim())
    lastIndex = offset + match.length
  })

  const remaining = text.slice(lastIndex).trim()
  if (remaining.length > 0) {
    parts.push(remaining)
  }

  return parts
}

function splitBySentence (text) {
  return splitBySentenceMixed(text)
}

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

function splitByParagraphs (text) {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0)
}

function splitText (text) {
  const paragraphs = splitByParagraphs(text)
  const allChunks = []

  for (const paragraph of paragraphs) {
    const sentences = splitBySentence(paragraph)
    const merged = mergeShortChunks(sentences)
    for (const chunk of merged) {
      if (chunk.length > 0) {
        allChunks.push(chunk)
      }
    }
  }

  if (allChunks.length === 0 && text.trim().length > 0) {
    return [text.trim()]
  }

  return allChunks
}

module.exports = { splitText, splitBySentence, splitByParagraphs, mergeShortChunks }
