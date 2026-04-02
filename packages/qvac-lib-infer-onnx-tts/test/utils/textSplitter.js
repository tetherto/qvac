'use strict'

const SENTENCE_TERMINATORS = /([.!?。！？])\s*/g

const MIN_CHUNK_GRAPHEMES = 10

function splitBySentence (text) {
  const parts = []
  let lastIndex = 0

  text.replace(SENTENCE_TERMINATORS, (match, terminator, offset) => {
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
