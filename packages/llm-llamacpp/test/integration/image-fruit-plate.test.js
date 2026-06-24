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
  // *before* the 10 MB PNG arrives. _image-common.js detects that this
  // pre-warmup ran successfully and SKIPS the standard PERF_WARMUP_RUNS
  // loop, so on iOS the fruit-plate test executes exactly 2 inferences
  // total: one cheap elephant pre-warmup + one counted fruit-plate run
  // (see iosPerfRuns below). Desktop + Android are unaffected — they
  // honour PERF_RUNS (PR default = 1, benchmark workflow = QVAC_PERF_RUNS).
  iosWarmupImage: 'elephant.jpg',
  // QVAC-17830: cap iOS counted iterations at 1 regardless of
  // QVAC_PERF_RUNS. Combined with the pre-warmup replacing the standard
  // warmup pass, this keeps the iOS cold-path footprint at exactly 2
  // inferences (1 small pre-warmup + 1 counted real image) — small
  // enough to stay under the ~3.3 GB Jetsam ceiling for the 10 MB PNG
  // even when the benchmark workflow_dispatch sets QVAC_PERF_RUNS=3.
  // Every other iOS image still runs the full PERF_RUNS counted cycle.
  iosPerfRuns: 1
})
