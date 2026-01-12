'use strict'
// test/integration/image.test.js
const test = require('brittle')
const { LlamaInterface } = require('../../addon.js')
const fs = require('bare-fs')
const { ensureModelPath, getMediaPath } = require('./utils')
const { makeOutputCollector } = require('../mocks/utils')
const { attachSpecLogger } = require('./spec-logger')
const binding = require('../../binding')
const os = require('bare-os')

const isDarwinX64 = os.platform() === 'darwin' && os.arch() === 'x64'
const isLinuxArm64 = os.platform() === 'linux' && os.arch() === 'arm64'
const isMobile = os.platform() === 'ios' || os.platform() === 'android'
const useCpu = isDarwinX64 || isLinuxArm64 || isMobile

const MULTIMODAL_MODEL_CONFIG = {
  llmModel: {
    modelName: 'SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    downloadUrl: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
  },
  projModel: {
    modelName: 'mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf',
    downloadUrl: 'https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf'
  },
  config: {
    gpu_layers: '98',
    ctx_size: '2048',
    device: useCpu ? 'cpu' : 'gpu',
    verbosity: '2'
  }
}

const MAX_WAIT_SECONDS = 1000

/**
 * Sets up a multimodal addon with LLM and projection models
 * @param {Object} t - Test instance
 * @param {Function} onOutput - Output callback function
 * @returns {Promise<{addon: LlamaInterface, llmModelPath: string, projModelPath: string}>}
 */
async function setupMultimodalAddon (t, onOutput) {
  const llmModelPath = await ensureModelPath(MULTIMODAL_MODEL_CONFIG.llmModel)
  t.ok(fs.existsSync(llmModelPath), 'LLM model file should exist')

  const projModelPath = await ensureModelPath(MULTIMODAL_MODEL_CONFIG.projModel)
  t.ok(fs.existsSync(projModelPath), 'Projection model file should exist')

  const specLogger = attachSpecLogger({ forwardToConsole: true })

  const addon = new LlamaInterface(
    binding,
    {
      path: llmModelPath,
      projectionPath: projModelPath,
      config: MULTIMODAL_MODEL_CONFIG.config
    },
    onOutput
  )

  const status = await addon.status()
  t.ok(['LOADING', 'IDLE', 'LISTENING'].includes(status), 'Addon should have valid initial status')

  t.teardown(async () => {
    specLogger.release()
    await addon.destroyInstance()
  })

  return { addon, llmModelPath, projModelPath }
}

/**
 * Waits for a job to complete
 * @param {LlamaInterface} addon - Addon instance
 * @param {Object} collector - Output collector with jobCompleted property
 * @param {number} maxWaitSeconds - Maximum seconds to wait (default: MAX_WAIT_SECONDS)
 * @returns {Promise<void>}
 */
async function waitForJobCompletion (addon, collector, maxWaitSeconds = MAX_WAIT_SECONDS) {
  for (let i = 0; i < maxWaitSeconds; i++) {
    const currentStatus = await addon.status()
    if (currentStatus === 'IDLE' && collector.jobCompleted) {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

/**
 * Describes an image using the addon
 * @param {LlamaInterface} addon - Addon instance
 * @param {string} imageFilePath - Path to the image file
 * @param {string} prompt - Optional custom prompt (default: standard description prompt)
 * @returns {Promise<void>}
 */
async function describeImage (addon, imageFilePath, prompt = 'Describe the image briefly in one sentence.') {
  const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))
  await addon.append({ type: 'media', input: imageBytes })

  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', type: 'media', content: '' },
    { role: 'user', content: prompt }
  ]

  await addon.append({ type: 'text', input: JSON.stringify(messages) })
  await addon.append({ type: 'end of job' })
  await addon.activate()
}

/**
 * Checks if keywords appear in text as whole words
 * @param {string} text - Text to search in
 * @param {string[]} keywords - Array of keywords to search for
 * @returns {Object} - {foundKeywords: string[], hasMatch: boolean}
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
  test(`llama addon can recognize ${testCase.name} in an image`, { timeout: 900_000 }, async t => {
    const collector = makeOutputCollector(t)
    const { onOutput } = collector

    const { addon } = await setupMultimodalAddon(t, onOutput)

    const imageFilePath = getMediaPath(testCase.imageFile)
    t.ok(fs.existsSync(imageFilePath), `${testCase.imageFile} image file should exist`)

    const prompt = 'Describe the image briefly in one sentence.'
    await describeImage(addon, imageFilePath, prompt)

    await waitForJobCompletion(addon, collector)

    t.comment(JSON.stringify(collector.outputText, null, 2))
    t.comment('Generated text: ' + collector.generatedText)

    t.ok(collector.jobCompleted, 'Job should complete')
    t.ok(collector.generatedText.length > 0, 'Should generate some text output for the image')

    const { foundKeywords, hasMatch } = checkKeywordsInText(collector.generatedText, testCase.keywords)

    t.ok(hasMatch,
      `Output should contain at least one ${testCase.keywordType} word as a whole word. ` +
      `Found keywords: ${foundKeywords.join(', ') || 'none'}. ` +
      `Full output: "${collector.generatedText}"`)
  })
}
