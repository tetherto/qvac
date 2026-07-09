'use strict'

const process = require('bare-process')

function elapsedMs (hrStart) {
  const [sec, nano] = process.hrtime(hrStart)
  return sec * 1000 + nano / 1e6
}

function round (num, digits) {
  if (typeof num !== 'number' || Number.isNaN(num)) return null
  const scale = Math.pow(10, digits)
  return Math.round(num * scale) / scale
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
  cartesianProduct,
  average,
  stddev
}
