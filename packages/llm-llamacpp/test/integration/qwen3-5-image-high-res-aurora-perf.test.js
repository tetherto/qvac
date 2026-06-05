'use strict'
// QVAC-18298: Qwen3.5-VL high-res-aurora-image perf row. One image per file
// (like the SmolVLM2 image-*.test.js) so each Device Farm test stays under
// the 30-minute mobile cap. Asserts an aurora keyword + records perf.

const test = require('brittle')
const { QWEN35_MODEL, IMAGE_CASES, runVlmImagePerf } = require('./_vlm-image-perf.js')

test('Qwen3.5-VL image perf [high-res aurora]', { timeout: 1_800_000 }, async t => {
  await runVlmImagePerf(t, QWEN35_MODEL, IMAGE_CASES['high-res-aurora'])
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
