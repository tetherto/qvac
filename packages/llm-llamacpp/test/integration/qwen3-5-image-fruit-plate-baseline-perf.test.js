'use strict'
// Baseline (no multi-tile) counterpart to qwen3-5-image-fruit-plate-perf.test.js.
// Uses --image-tile-mode baseline which routes through dyn_size (same as
// master), giving a direct pre-PR vs PR perf comparison on the same runner.

const test = require('brittle')
const { QWEN35_BASELINE_MODEL, IMAGE_CASES, runVlmImagePerf } = require('./_vlm-image-perf.js')

test('Qwen3.5-VL image perf baseline [fruit plate]', { timeout: 1_800_000 }, async t => {
  await runVlmImagePerf(t, QWEN35_BASELINE_MODEL, IMAGE_CASES['fruit-plate'])
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
