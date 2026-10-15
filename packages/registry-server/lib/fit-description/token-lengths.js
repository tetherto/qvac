'use strict'

const { FormatError } = require('./file-cursor')

const NO_PREFIX_BYTES = 0

async function skipToken(cursor, prefixBytes, maxTokenBytes) {
  cursor.skip(prefixBytes)
  const length = await cursor.u32()
  if (length > maxTokenBytes) throw new FormatError(`token of ${length} bytes`)
  cursor.skip(length)
  return length
}

async function readTokenLengths(cursor, count, maxTokenBytes, prefixBytes = NO_PREFIX_BYTES) {
  const lengths = []
  for (let i = 0; i < count; i++) lengths.push(await skipToken(cursor, prefixBytes, maxTokenBytes))
  return lengths
}

function longest(lengths) {
  return lengths.reduce((max, length) => Math.max(max, length), -1)
}

function lengthHistogram(lengths) {
  const counts = new Array(longest(lengths) + 1).fill(0)
  for (const length of lengths) counts[length]++
  return counts
}

module.exports = { readTokenLengths, lengthHistogram }
