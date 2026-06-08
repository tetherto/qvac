'use strict'
// QVAC-18298: Qwen3.5-VL elephant-image perf row. One image per file (like
// the SmolVLM2 image-*.test.js) so each Device Farm test stays under the
// 30-minute mobile cap. Asserts the elephant keyword + records perf.

const test = require('brittle')
const { QWEN35_MODEL, IMAGE_CASES, runVlmImagePerf } = require('./_vlm-image-perf.js')

test('Qwen3.5-VL image perf [elephant]', { timeout: 1_800_000 }, async t => {
  await runVlmImagePerf(t, QWEN35_MODEL, IMAGE_CASES.elephant)
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
