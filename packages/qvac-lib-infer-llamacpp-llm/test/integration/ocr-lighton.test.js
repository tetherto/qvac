'use strict'
// test/integration/ocr-lighton.test.js
const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const { ensureModel, getMediaPath } = require('./utils')
const LlmLlamacpp = require('../../index.js')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'

const useCpu = isDarwinX64 || isLinuxArm64

const LIGHTON_OCR_CONFIG = {
  llmModel: {
    modelName: 'LightOnOCR-2-1B-ocr-soup-Q4_K_M.gguf',
    downloadUrl: 'https://huggingface.co/noctrex/LightOnOCR-2-1B-ocr-soup-GGUF/resolve/main/LightOnOCR-2-1B-ocr-soup-Q4_K_M.gguf'
  },
  projModel: {
    modelName: 'mmproj-LightOnOCR-2-F16.gguf',
    downloadUrl: 'https://huggingface.co/noctrex/LightOnOCR-2-1B-ocr-soup-GGUF/resolve/main/mmproj-F16.gguf'
  },
  ctx_size: '4096'
}

const TEST_CONSTANTS = {
  timeout: 1_800_000, // 30 minutes — model download (~1.2GB) + slow image encoding on Intel Macs
  maxTokens: '2048'
}

const DEVICE_CONFIGS = (isMobile || useCpu)
  ? [{ id: 'cpu', device: 'cpu' }]
  : [{ id: 'gpu', device: 'gpu' }]

function getConfig (device) {
  return {
    gpu_layers: '98',
    temp: '0.1',
    verbosity: '2',
    device,
    ctx_size: LIGHTON_OCR_CONFIG.ctx_size,
    predict: TEST_CONSTANTS.maxTokens
  }
}

async function setupLightOnInference (t, device = 'gpu') {
  const [modelName, dirPath] = await ensureModel(LIGHTON_OCR_CONFIG.llmModel)
  t.ok(fs.existsSync(path.join(dirPath, modelName)), 'LLM model file should exist')

  const [projModelName] = await ensureModel(LIGHTON_OCR_CONFIG.projModel)
  t.ok(fs.existsSync(path.join(dirPath, projModelName)), 'Projection model file should exist')

  const modelPath = path.join(dirPath, modelName)
  const inference = new LlmLlamacpp({
    files: { model: [modelPath], projectionModel: path.join(dirPath, projModelName) },
    config: getConfig(device),
    logger: console
  })

  t.teardown(async () => {
    await inference.unload()
  })

  await inference.load()

  return { inference }
}

async function runOcr (inference, imageFilePath) {
  const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))

  const messages = [
    { role: 'user', type: 'media', content: imageBytes },
    { role: 'user', content: 'Extract all text from this image and format it as markdown.' }
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

// Test: LightON OCR-2 can extract text from a newspaper document image
test('LightON OCR-2 can extract text from document image', { timeout: TEST_CONSTANTS.timeout }, async t => {
  for (const deviceConfig of DEVICE_CONFIGS) {
    const label = `[${deviceConfig.id.toUpperCase()}]`

    const { inference } = await setupLightOnInference(t, deviceConfig.device)

    // Use the newspaper image — a small document with clear text
    const imageFilePath = getMediaPath('news-paper.jpg')
    t.ok(fs.existsSync(imageFilePath), `${label} news-paper.jpg image file should exist`)

    const { generatedText, startTime, endTime } = await runOcr(inference, imageFilePath)
    const totalTime = endTime - startTime

    t.comment(`${label} Generated text (${generatedText.length} chars): ${generatedText.substring(0, 500)}...`)
    t.comment(`${label} Total time: ${(totalTime / 1000).toFixed(2)}s`)

    // Assert output is non-empty
    t.ok(generatedText.length > 0, `${label} Should generate OCR output`)

    // Assert key text from the newspaper is present (Titanic headline)
    const lowerText = generatedText.toLowerCase()
    const expectedKeywords = ['titanic', 'new york', 'iceberg']
    const foundKeywords = expectedKeywords.filter(kw => lowerText.includes(kw))

    t.ok(
      foundKeywords.length >= 1,
      `${label} OCR output should contain at least one expected keyword. ` +
      `Found: ${foundKeywords.join(', ') || 'none'}. ` +
      `Expected any of: ${expectedKeywords.join(', ')}`
    )
  }
})
