'use strict'
// QVAC-18298: Gemma4-VL high-res-aurora-image perf row. One image per file
// (like the SmolVLM2 image-*.test.js) so each Device Farm test stays under
// the 30-minute mobile cap. Asserts an aurora keyword + records perf.

const test = require('brittle')
const { GEMMA4_MODEL, IMAGE_CASES, isDarwinX64, skipHeavyImages, runVlmImagePerf } = require('./_vlm-image-perf.js')

// QVAC-19368: aurora is the heaviest image; skip it on Android on-PR runs
// where the 30-min Device Farm cap is tight. Darwin x64 is skipped separately.
// The benchmark (QVAC_PERF_ONLY=true) runs all 3 images on supported platforms.
test('Gemma4-VL image perf [high-res aurora]', { timeout: 1_800_000, skip: isDarwinX64 || skipHeavyImages }, async t => {
  await runVlmImagePerf(t, GEMMA4_MODEL, IMAGE_CASES['high-res-aurora'])
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
