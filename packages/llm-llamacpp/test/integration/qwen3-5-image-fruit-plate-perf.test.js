'use strict'
// QVAC-18298: Qwen3.5-VL fruit-plate-image perf row. One image per file
// (like the SmolVLM2 image-*.test.js) so each Device Farm test stays under
// the 30-minute mobile cap. Asserts a fruit keyword + records perf.

const test = require('brittle')
const { QWEN35_MODEL, IMAGE_CASES, isDarwinX64, runVlmImagePerf } = require('./_vlm-image-perf.js')

test('Qwen3.5-VL image perf [fruit plate]', { timeout: 1_800_000, skip: isDarwinX64 }, async t => {
  await runVlmImagePerf(t, QWEN35_MODEL, IMAGE_CASES['fruit-plate'])
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
