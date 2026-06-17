'use strict'
const test = require('brittle')
const { QWEN35_SEQUENTIAL_MODEL, IMAGE_CASES, runVlmImagePerf } = require('./_vlm-image-perf.js')

test('Qwen3.5-VL image perf sequential [elephant]', { timeout: 1_800_000 }, async t => {
  await runVlmImagePerf(t, QWEN35_SEQUENTIAL_MODEL, IMAGE_CASES.elephant)
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
