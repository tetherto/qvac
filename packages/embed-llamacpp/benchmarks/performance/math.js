'use strict'

const process = require('bare-process')

function elapsedMs (hrStart) {
  const [sec, nano] = process.hrtime(hrStart)
  return sec * 1000 + nano / 1e6
}

function round (num, digits = 4) {
  const scale = Math.pow(10, digits)
  return Math.round(num * scale) / scale
}

function cosineSimilarity (a, b) {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`)
  }
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator < 1e-12) return 1.0 * Math.sign(dotProduct)
  return dotProduct / denominator
}

function similarityStats (baseline, candidate) {
  if (!baseline || !candidate) return null
  if (baseline.length !== candidate.length) return null
  const scores = []
  for (let i = 0; i < baseline.length; i++) {
    scores.push(cosineSimilarity(baseline[i], candidate[i]))
  }
  if (scores.length === 0) return null
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let sum = 0
  for (const score of scores) {
    if (score < min) min = score
    if (score > max) max = score
    sum += score
  }
  return {
    avg: round(sum / scores.length, 6),
    min: round(min, 6),
    max: round(max, 6),
    count: scores.length
  }
}

function cartesianProduct (arrays) {
  return arrays.reduce(
    (acc, curr) => acc.flatMap((prefix) => curr.map((x) => [...prefix, x])),
    [[]]
  )
}

function average (values) {
  if (!values.length) return null
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function stddev (values) {
  if (!values.length) return null
  if (values.length === 1) return 0
  const avg = average(values)
  let varianceSum = 0
  for (const value of values) {
    const diff = value - avg
    varianceSum += diff * diff
  }
  return Math.sqrt(varianceSum / values.length)
}

module.exports = {
  elapsedMs,
  round,
  cosineSimilarity,
  similarityStats,
  cartesianProduct,
  average,
  stddev
}
