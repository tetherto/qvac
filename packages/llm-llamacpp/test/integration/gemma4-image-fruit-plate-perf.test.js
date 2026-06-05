'use strict'
// QVAC-18298: Gemma4-VL fruit-plate-image perf row. One image per file (like
// the SmolVLM2 image-*.test.js) so each Device Farm test stays under the
// 30-minute mobile cap. Asserts a fruit keyword + records perf.

const test = require('brittle')
const { GEMMA4_MODEL, IMAGE_CASES, runVlmImagePerf } = require('./_vlm-image-perf.js')

test('Gemma4-VL image perf [fruit plate]', { timeout: 1_800_000 }, async t => {
  await runVlmImagePerf(t, GEMMA4_MODEL, IMAGE_CASES['fruit-plate'])
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
