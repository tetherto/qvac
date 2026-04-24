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
  keywordType: 'aurora-sky-related'
})
