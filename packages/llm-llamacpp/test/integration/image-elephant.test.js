'use strict'
// QVAC-17830: elephant image VLM integration test.
// Split from the former image.test.js so iOS Device Farm can run
// each image in its own group (one bare process per image) — keeps
// peak memory low and isolates aurora-style OOM crashes from the
// other images' perf data. See _image-common.js for details.

const test = require('brittle')
const fs = require('bare-fs')
const {
  DEVICE_CONFIGS,
  LARGE_MULTIMODAL_CONFIG,
  TEST_CONSTANTS,
  checkKeywordsInText,
  describeImageByPath,
  describeMultipleImages,
  runPerImageBackendTests,
  setupMultimodalInference
} = require('./_image-common.js')
const { getMediaPath } = require('./utils')

const elephantCase = {
  name: 'elephant',
  imageFile: 'elephant.jpg',
  keywords: ['elephant', 'elephants'],
  keywordType: 'elephant-related'
}

runPerImageBackendTests(elephantCase)

test('llama addon accepts a file path string as media content', { timeout: TEST_CONSTANTS.timeout }, async t => {
  const deviceConfig = DEVICE_CONFIGS[0]
  const label = `[${deviceConfig.id.toUpperCase()}]`

  const { inference } = await setupMultimodalInference(t, deviceConfig.device)

  const imageFilePath = getMediaPath('elephant.jpg')
  t.ok(fs.existsSync(imageFilePath), `${label} elephant.jpg image file should exist`)

  const generatedText = await describeImageByPath(inference, imageFilePath)
  t.comment(`${label} Generated text: ${generatedText}`)

  t.ok(generatedText.length > 0, `${label} Should generate text output when media content is a file path`)
  const { hasMatch, foundKeywords } = checkKeywordsInText(generatedText, ['elephant', 'elephants'])
  t.ok(hasMatch,
    `${label} Output should describe the elephant when image is passed as a path string. ` +
    `Found keywords: ${foundKeywords.join(', ') || 'none'}. ` +
    `Full output: "${generatedText}"`)
})

// TODO: Fix multi-image for smaller models? Seems like an image per separate message works
// TODO: on smaller models, rather than all images on same message.
// TODO: Discussion at: https://github.com/tetherto/qvac/pull/172#discussion_r2807275659
test('llama addon can handle multiple images in one prompt', { timeout: TEST_CONSTANTS.timeout, skip: true }, async t => {
  const imageFiles = ['elephant.jpg', 'fruitPlate.png']
  const imagePaths = imageFiles.map(f => getMediaPath(f))
  const prompt = 'What is in these two images?'

  for (const deviceConfig of DEVICE_CONFIGS) {
    const label = `[${deviceConfig.id.toUpperCase()}]`

    const { inference } = await setupMultimodalInference(t, deviceConfig.device, LARGE_MULTIMODAL_CONFIG)

    for (const p of imagePaths) {
      t.ok(fs.existsSync(p), `${label} image file should exist: ${p}`)
    }

    const { generatedText } = await describeMultipleImages(inference, imagePaths, prompt)

    t.comment(`${label} Generated text: ${generatedText}`)
    t.ok(generatedText.length > 0, `${label} Should generate some text for multiple images`)

    const elephantKeywords = ['elephant', 'elephants']
    const fruitKeywords = ['fruit', 'fruits', 'plate', 'apple', 'apples']
    const { hasMatch: hasElephant } = checkKeywordsInText(generatedText, elephantKeywords)
    const { hasMatch: hasFruit } = checkKeywordsInText(generatedText, fruitKeywords)

    t.ok(
      hasElephant && hasFruit,
      `${label} Output should mention both images (elephant and fruit). ` +
      `Full output: "${generatedText}"`
    )
  }
})
