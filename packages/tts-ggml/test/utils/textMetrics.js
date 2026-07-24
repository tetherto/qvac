'use strict'

function normalizeText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:"“”„«»()[\]{}]/g, '')
    .replace(/['’ʼ]/g, ' ')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function levenshtein(reference, hypothesis) {
  const previous = Array(hypothesis.length + 1)
  const current = Array(hypothesis.length + 1)

  for (let j = 0; j <= hypothesis.length; j++) previous[j] = j

  for (let i = 1; i <= reference.length; i++) {
    current[0] = i
    for (let j = 1; j <= hypothesis.length; j++) {
      const cost = reference[i - 1] === hypothesis[j - 1] ? 0 : 1
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
    }
    for (let j = 0; j <= hypothesis.length; j++) previous[j] = current[j]
  }

  return previous[hypothesis.length]
}

function errorRate(reference, hypothesis) {
  if (reference.length === 0) return hypothesis.length === 0 ? 0 : 1
  return levenshtein(reference, hypothesis) / reference.length
}

function wordErrorRate(expected, actual) {
  const reference = normalizeText(expected).split(/\s+/).filter(Boolean)
  const hypothesis = normalizeText(actual).split(/\s+/).filter(Boolean)
  return errorRate(reference, hypothesis)
}

function characterErrorRate(expected, actual) {
  const reference = Array.from(normalizeText(expected))
  const hypothesis = Array.from(normalizeText(actual))
  return errorRate(reference, hypothesis)
}

module.exports = {
  normalizeText,
  levenshtein,
  wordErrorRate,
  characterErrorRate
}
