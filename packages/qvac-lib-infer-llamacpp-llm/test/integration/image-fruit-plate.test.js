'use strict'
// QVAC-17830: fruit-plate image VLM integration test.
// Split from the former image.test.js so iOS Device Farm can run
// each image in its own group. See _image-common.js for details.

const { runPerImageBackendTests } = require('./_image-common.js')

runPerImageBackendTests({
  name: 'fruit plate',
  imageFile: 'fruitPlate.png',
  keywords: ['fruit', 'fruits', 'plate', 'apple', 'apples'],
  keywordType: 'fruit-related'
})
