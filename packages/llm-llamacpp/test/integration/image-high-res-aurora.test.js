'use strict'
// QVAC-17830: high-resolution (3000x4000) aurora image VLM test.
// Isolated in its own Device Farm group because this image pushes
// peak memory hardest and has historically tripped iOS Jetsam.
// With per-test flushing (see _image-common.js) we preserve data
// from earlier iterations even when the final run OOMs.

const { runPerImageBackendTests } = require('./_image-common.js')

runPerImageBackendTests({
  name: 'high-res aurora',
  imageFile: 'highRes3000x4000.jpg',
  keywords: ['sky', 'light', 'lights', 'mountain', 'snow', 'aurora'],
  keywordType: 'aurora-sky-related',
  // QVAC-17830: iOS Device Farm (iPhone 16 Pro / 17) was hanging the
  // on-PR run on this image because the 3000x4000 (~12 MP) JPEG pushed
  // peak memory past the ~3.3 GB Jetsam ceiling once the device was
  // already warm from earlier jobs in the queue. The app died via
  // memorystatus and Appium never got a clean failure signal, so the
  // Device Farm run sat in RUNNING (PENDING) until the 60-min job
  // timeout. Mirror the fruit-plate mitigation: pre-warm the multimodal
  // pipeline with the tiny elephant.jpg (~23 KB) so Metal shaders,
  // KV cache, and image-prefill buffers are allocated *before* the
  // 12 MP JPEG arrives, and cap iOS counted iterations at 1 regardless
  // of QVAC_PERF_RUNS. Together this keeps the iOS cold-path footprint
  // at exactly 2 inferences (1 small pre-warmup + 1 counted real image)
  // — the same shape fruit-plate uses, which reliably passes.
  iosWarmupImage: 'elephant.jpg',
  iosPerfRuns: 1
})
