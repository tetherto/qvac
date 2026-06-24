'use strict'
// QVAC-18298: Gemma4-VL elephant-image perf row. One image per file (like
// the SmolVLM2 image-*.test.js) so each Device Farm test stays under the
// 30-minute mobile cap. Asserts the elephant keyword + records perf.

const test = require('brittle')
const { GEMMA4_MODEL, IMAGE_CASES, isDarwinX64, runVlmImagePerf } = require('./_vlm-image-perf.js')

test('Gemma4-VL image perf [elephant]', { timeout: 1_800_000, skip: isDarwinX64 }, async t => {
  await runVlmImagePerf(t, GEMMA4_MODEL, IMAGE_CASES.elephant)
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
