'use strict'
// QVAC-18298: Qwen3.5-VL high-res-aurora-image perf row. One image per file
// (like the SmolVLM2 image-*.test.js) so each Device Farm test stays under
// the 30-minute mobile cap. Asserts an aurora keyword + records perf.

const test = require('brittle')
const { QWEN35_MODEL, IMAGE_CASES, skipHeavyImages, runVlmImagePerf } = require('./_vlm-image-perf.js')

// QVAC-19368: aurora is the heaviest image; skip it on Android on-PR runs
// where the 30-min Device Farm cap is tight. iOS + desktop always run it.
// The benchmark (QVAC_PERF_ONLY=true) runs all 3 images on all platforms.
test('Qwen3.5-VL image perf [high-res aurora]', { timeout: 1_800_000, skip: skipHeavyImages }, async t => {
  await runVlmImagePerf(t, QWEN35_MODEL, IMAGE_CASES['high-res-aurora'])
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
