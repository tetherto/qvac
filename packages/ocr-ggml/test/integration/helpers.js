'use strict'

// Shared helpers for the @qvac/ocr-ggml integration suite.
//
// This file is intentionally not named `*.test.js` so the brittle glob
// (`test/integration/*.test.js`) does not pick it up as a test file.

const fs = require('bare-fs')
const path = require('bare-path')

function modelsPresent (paths) {
  return paths.every(p => {
    try { return fs.statSync(p).isFile() } catch { return false }
  })
}

function assertRowShape (t, rows) {
  t.ok(Array.isArray(rows), 'output is an array')
  if (rows && rows.length > 0) {
    const [box, text, conf] = rows[0]
    t.is(box.length, 4, 'each row has a 4-point bounding box')
    t.is(typeof text, 'string', 'second element is the text string')
    t.is(typeof conf, 'number', 'third element is the confidence number')
  }
}

function assertStatsShape (t, stats) {
  // QvacResponse initialises `response.stats = {}` and only fills it when
  // the addon is constructed with `opts.stats: true`. Treat an empty object
  // (or any falsy value) as "stats not requested" and skip the assertions.
  if (!stats || Object.keys(stats).length === 0) return
  t.ok(typeof stats.totalTime === 'number', 'stats.totalTime is a number')
  t.ok(typeof stats.detectionTime === 'number', 'stats.detectionTime is a number')
  t.ok(typeof stats.recognitionTime === 'number', 'stats.recognitionTime is a number')
}

function defaultSampleImage () {
  return path.join(__dirname, '..', '..', 'samples', 'english.png')
}

module.exports = {
  modelsPresent,
  assertRowShape,
  assertStatsShape,
  defaultSampleImage
}
