'use strict'

function round (num, digits) {
  if (typeof num !== 'number' || Number.isNaN(num)) return null
  const scale = Math.pow(10, digits)
  return Math.round(num * scale) / scale
}

function median (values) {
  const xs = values.filter((x) => typeof x === 'number' && !Number.isNaN(x))
  if (xs.length === 0) return null
  const sorted = xs.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function min (values) {
  const xs = values.filter((x) => typeof x === 'number' && !Number.isNaN(x))
  return xs.length ? Math.min(...xs) : null
}

function max (values) {
  const xs = values.filter((x) => typeof x === 'number' && !Number.isNaN(x))
  return xs.length ? Math.max(...xs) : null
}

function pctDelta (candidate, baseline) {
  if (candidate == null || baseline == null || baseline === 0) return null
  return ((candidate - baseline) / baseline) * 100
}

module.exports = { round, median, min, max, pctDelta }
