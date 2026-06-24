'use strict'

const process = require('bare-process')

function round (num, digits) {
  if (typeof num !== 'number' || Number.isNaN(num)) return null
  const scale = Math.pow(10, digits)
  return Math.round(num * scale) / scale
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

function elapsedMs (hrStart) {
  const [sec, nano] = process.hrtime(hrStart)
  return sec * 1000 + nano / 1e6
}

function parsePositiveInt (value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}. Expected a positive integer.`)
  }
  return parsed
}

function exactMatch (baseline, candidate) {
  if (baseline == null || candidate == null) return null
  return baseline === candidate ? 1.0 : 0.0
}

function cartesianProduct (arrays) {
  return arrays.reduce(
    (acc, curr) => acc.flatMap((prefix) => curr.map((x) => [...prefix, x])),
    [[]]
  )
}

module.exports = {
  round,
  average,
  stddev,
  elapsedMs,
  parsePositiveInt,
  exactMatch,
  cartesianProduct
}
