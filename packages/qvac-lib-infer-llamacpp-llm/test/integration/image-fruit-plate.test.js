'use strict'
// QVAC-17830: fruit-plate image VLM integration test.
// Split from the former image.test.js so iOS Device Farm can run
// each image in its own group. See _image-common.js for details.

const { runPerImageBackendTests } = require('./_image-common.js')

runPerImageBackendTests({
  name: 'fruit plate',
  imageFile: 'fruitPlate.png',
  keywords: ['fruit', 'fruits', 'plate', 'apple', 'apples'],
  keywordType: 'fruit-related',
  // QVAC-17830: iOS Device Farm (iPhone 16 Pro / 17) consistently killed
  // the app via memorystatus / V8 Zone OOM during the fruit-plate cold
  // start — no perf rows ever landed on disk or in logcat. Pre-warming
  // the multimodal pipeline with the tiny elephant.jpg (~23 KB) gets
  // Metal shaders, KV cache, and image-prefill buffers allocated
  // *before* the 10 MB PNG arrives, which kept us under Jetsam's per-
  // process limit in local simulation. Desktop + Android are
  // unaffected (see _image-common.js; the pre-warmup is platform === 'ios'
  // only).
  iosWarmupImage: 'elephant.jpg',
  // QVAC-17830: warmup alone wasn't enough — the previous run still
  // SIGABRT'd at t+85s (V8 bad_alloc during JSON.stringify) on counted
  // iteration 2-3, leaving zero fruit-plate rows on both iPhone 16 Pro
  // and iPhone 17. Drop to 1 counted iteration on iOS (alongside the
  // warmup) so the cold-path peak footprint is 2 inferences instead of
  // 4. Every other iOS image still runs the full PERF_RUNS=3.
  iosPerfRuns: 1
})
