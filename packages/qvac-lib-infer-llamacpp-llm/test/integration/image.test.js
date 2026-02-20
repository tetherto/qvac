'use strict'
// test/integration/image.test.js
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const { ensureModel, getMediaPath } = require('./utils')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'

// CPU is used for: Intel Macs (DarwinX64), and ARM64 Linux
const useCpu = isDarwinX64 || isLinuxArm64

const MULTIMODAL_MODEL_CONFIG = {
  llmModel: {
    modelName: 'SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    downloadUrl: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
  },
  projModel: {
    modelName: 'mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    downloadUrl: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
  },
  ctx_size: '2048'
}

const LARGE_MULTIMODAL_CONFIG = {
  llmModel: {
    modelName: 'Qwen3VL-2B-Instruct-Q4_K_M.gguf',
    downloadUrl: 'https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/main/Qwen3VL-2B-Instruct-Q4_K_M.gguf'
  },
  projModel: {
    modelName: 'mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf',
    downloadUrl: 'https://huggingface.co/Qwen/Qwen3-VL-2B-Instruct-GGUF/resolve/main/mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf'
  },
  ctx_size: '7046'
}

const TEST_CONSTANTS = {
  timeout: 900_000, // 15 minutes
  maxWaitSeconds: 1000,
  defaultPrompt: 'Describe the image briefly in one sentence.'
}

/**
 * Device configurations for testing
 * - Mobile (iOS/Android): CPU only
 * - Desktop (DarwinX64): CPU only
 * - Desktop (LinuxARM64): CPU only
 * - Desktop (other): GPU only
 */
const ALL_DEVICE_CONFIGS = [
  { id: 'gpu', device: 'gpu' },
  { id: 'cpu', device: 'cpu' }
]

const DEVICE_CONFIGS = isMobile
  ? ALL_DEVICE_CONFIGS
  : useCpu
    ? ALL_DEVICE_CONFIGS.filter(c => c.id === 'cpu')
    : ALL_DEVICE_CONFIGS.filter(c => c.id === 'gpu')

/**
 * Creates model configuration for the specified device
 * @param {string} device - Device type ('cpu' or 'gpu')
 * @returns {Object} Model configuration object
 */
function getConfig (device, modelConfig) {
  return {
    gpu_layers: '98',
    temp: '0.0',
    verbosity: '2',
    device,
    ctx_size: modelConfig.ctx_size
  }
}

/**
 * Sets up a multimodal LlmLlamacpp instance with LLM and projection models
 * @param {Object} t - Test instance
 * @param {string} device - Device to use ('cpu' or 'gpu')
 * @returns {Promise<{inference: LlmLlamacpp, loader: FilesystemDL}>}
 */
async function setupMultimodalInference (t, device = 'gpu', modelConfig = MULTIMODAL_MODEL_CONFIG) {
  const [modelName, dirPath] = await ensureModel(modelConfig.llmModel)
  t.ok(fs.existsSync(path.join(dirPath, modelName)), 'LLM model file should exist')

  const [projModelName] = await ensureModel(modelConfig.projModel)
  t.ok(fs.existsSync(path.join(dirPath, projModelName)), 'Projection model file should exist')

  const loader = new FilesystemDL({ dirPath })
  const inference = new LlmLlamacpp({
    modelName,
    loader,
    logger: console,
    diskPath: dirPath,
    projectionModel: projModelName
  }, getConfig(device, modelConfig))

  t.teardown(async () => {
    await loader.close()
    await inference.unload()
  })

  await inference.load()

  return { inference, loader }
}

/**
 * Describes an image using the inference instance
 * @param {LlmLlamacpp} inference - LlmLlamacpp instance
 * @param {string} imageFilePath - Path to the image file
 * @param {string} prompt - Custom prompt for image description
 * @returns {Promise<{generatedText: string, startTime: number, endTime: number}>}
 */
async function describeImage (inference, imageFilePath, prompt = TEST_CONSTANTS.defaultPrompt) {
  const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))

  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', type: 'media', content: imageBytes },
    { role: 'user', content: prompt }
  ]

  const startTime = Date.now()
  const response = await inference.run(messages)
  const generatedText = []
  let error = null

  response.onUpdate(data => {
    generatedText.push(data)
  }).onError(err => {
    error = err
  })

  await response.await()

  if (error) {
    throw new Error('Inference error: ' + error)
  }

  return {
    generatedText: generatedText.join(''),
    startTime,
    endTime: Date.now()
  }
}

/**
 * Runs inference with multiple images and a single text prompt (e.g. "what is in these two images?").
 * @param {LlmLlamacpp} inference - LlmLlamacpp instance
 * @param {string[]} imageFilePaths - Paths to image files (order preserved)
 * @param {string} prompt - Text prompt after the images
 * @returns {Promise<{generatedText: string, startTime: number, endTime: number}>}
 */
async function describeMultipleImages (inference, imageFilePaths, prompt) {
  const messages = [
    { role: 'system', content: 'You are a helpful, respectful and honest assistant.' }
  ]
  for (const imageFilePath of imageFilePaths) {
    const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))
    messages.push({ role: 'user', type: 'media', content: imageBytes })
  }
  messages.push({ role: 'user', content: prompt })

  const startTime = Date.now()
  const response = await inference.run(messages)
  const generatedText = []
  let error = null

  response.onUpdate(data => {
    generatedText.push(data)
  }).onError(err => {
    error = err
  })

  await response.await()

  if (error) {
    throw new Error('Inference error: ' + error)
  }

  return {
    generatedText: generatedText.join(''),
    startTime,
    endTime: Date.now()
  }
}

/**
 * Checks if any of the specified keywords appear in text as whole words
 * @param {string} text - Text to search in
 * @param {string[]} keywords - Array of keywords to search for
 * @returns {Object} Result object with found keywords and match status
 * @returns {string[]} result.foundKeywords - Array of keywords that were found
 * @returns {boolean} result.hasMatch - Whether any keywords were found
 */
function checkKeywordsInText (text, keywords) {
  const foundKeywords = keywords.filter(keyword => {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i')
    return regex.test(text)
  })

  return {
    foundKeywords,
    hasMatch: foundKeywords.length > 0
  }
}

/**
 * Formats performance metrics for test output
 * @param {string} label - Test label (e.g., '[GPU]')
 * @param {number} totalTime - Total execution time in milliseconds
 * @returns {string} Formatted performance metrics string
 */
function formatPerformanceMetrics (label, totalTime) {
  const totalSeconds = (totalTime / 1000).toFixed(2)

  return `${label} Performance Metrics:
    - Total time: ${totalTime}ms (${totalSeconds}s)`
}

/**
 * Image test cases with expected recognition keywords
 * Each test case validates that the model can recognize key elements in the image
 * @typedef {Object} ImageTestCase
 * @property {string} name - Human-readable test case name
 * @property {string} imageFile - Image filename in media directory
 * @property {string[]} keywords - Keywords expected to appear in model output
 * @property {string} keywordType - Description of keyword category for error messages
 */
const imageTestCases = [
  {
    name: 'elephant',
    imageFile: 'elephant.jpg',
    keywords: ['elephant', 'elephants'],
    keywordType: 'elephant-related'
  },
  {
    name: 'fruit plate',
    imageFile: 'fruitPlate.png',
    keywords: ['fruit', 'fruits', 'plate', 'apple', 'apples'],
    keywordType: 'fruit-related'
  },
  {
    name: 'high-res aurora',
    imageFile: 'highRes3000x4000.jpg',
    keywords: ['sky', 'light', 'lights', 'mountain', 'snow', 'aurora'],
    keywordType: 'aurora-sky-related'
  }
]

for (const testCase of imageTestCases) {
  test(`llama addon can recognize ${testCase.name} in an image`, { timeout: TEST_CONSTANTS.timeout }, async t => {
    for (const deviceConfig of DEVICE_CONFIGS) {
      const label = `[${deviceConfig.id.toUpperCase()}]`

      // Setup test infrastructure
      const { inference } = await setupMultimodalInference(t, deviceConfig.device)

      // Verify image file exists
      const imageFilePath = getMediaPath(testCase.imageFile)
      t.ok(fs.existsSync(imageFilePath), `${label} ${testCase.imageFile} image file should exist`)

      // Run image description inference
      const { generatedText, startTime, endTime } = await describeImage(inference, imageFilePath, TEST_CONSTANTS.defaultPrompt)
      const totalTime = endTime - startTime

      // Log output and statistics
      t.comment(`${label} Generated text: ${generatedText}`)
      t.comment(formatPerformanceMetrics(label, totalTime))

      // Assertions: Content recognition
      t.ok(generatedText.length > 0, `${label} Should generate some text output for the image`)
      const { foundKeywords, hasMatch } = checkKeywordsInText(generatedText, testCase.keywords)
      t.ok(hasMatch,
        `${label} Output should contain at least one ${testCase.keywordType} word as a whole word. ` +
        `Found keywords: ${foundKeywords.join(', ') || 'none'}. ` +
        `Full output: "${generatedText}"`)
    }
  })
}

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

    const { generatedText, startTime, endTime } = await describeMultipleImages(
      inference,
      imagePaths,
      prompt
    )
    const totalTime = endTime - startTime

    t.comment(`${label} Generated text: ${generatedText}`)
    t.comment(formatPerformanceMetrics(label, totalTime))

    t.ok(generatedText.length > 0, `${label} Should generate some text for multiple images`)

    // Expect output to reference both images: at least one elephant-related and one fruit-related
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
