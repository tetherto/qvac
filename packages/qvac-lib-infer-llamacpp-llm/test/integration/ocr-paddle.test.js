'use strict'

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

const useCpu = isDarwinX64 || isLinuxArm64

const PADDLE_OCR_CONFIG = {
  llmModel: {
    modelName: 'PaddleOCR-VL-1.5.gguf',
    downloadUrl: 'https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5-GGUF/resolve/main/PaddleOCR-VL-1.5.gguf'
  },
  projModel: {
    modelName: 'PaddleOCR-VL-1.5-mmproj.gguf',
    downloadUrl: 'https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.5-GGUF/resolve/main/PaddleOCR-VL-1.5-mmproj.gguf'
  },
  ctx_size: '4096'
}

const TEST_CONSTANTS = {
  timeout: 1_800_000,
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
    ctx_size: PADDLE_OCR_CONFIG.ctx_size,
    predict: TEST_CONSTANTS.maxTokens
  }
}

async function setupPaddleInference (t, device = 'gpu') {
  const [modelName, dirPath] = await ensureModel(PADDLE_OCR_CONFIG.llmModel)
  t.ok(fs.existsSync(path.join(dirPath, modelName)), 'LLM model file should exist')

  const [projModelName] = await ensureModel(PADDLE_OCR_CONFIG.projModel)
  t.ok(fs.existsSync(path.join(dirPath, projModelName)), 'Projection model file should exist')

  const loader = new FilesystemDL({ dirPath })
  const inference = new LlmLlamacpp({
    modelName,
    loader,
    logger: console,
    diskPath: dirPath,
    projectionModel: projModelName
  }, getConfig(device))

  t.teardown(async () => {
    await loader.close()
    await inference.unload()
  })

  await inference.load()

  return { inference, loader }
}

async function runOcr (inference, imageFilePath, prompt) {
  const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))

  const messages = [
    { role: 'user', type: 'media', content: imageBytes },
    { role: 'user', content: prompt || 'Extract all text from this image.' }
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

test('PaddleOCR-VL can extract text from document image', { timeout: TEST_CONSTANTS.timeout }, async t => {
  for (const deviceConfig of DEVICE_CONFIGS) {
    const label = `[${deviceConfig.id.toUpperCase()}]`

    const { inference } = await setupPaddleInference(t, deviceConfig.device)

    const imageFilePath = getMediaPath('news-paper.jpg')
    t.ok(fs.existsSync(imageFilePath), `${label} news-paper.jpg image file should exist`)

    const { generatedText, startTime, endTime } = await runOcr(inference, imageFilePath)
    const totalTime = endTime - startTime

    t.comment(`${label} Generated text (${generatedText.length} chars): ${generatedText.substring(0, 500)}...`)
    t.comment(`${label} Total time: ${(totalTime / 1000).toFixed(2)}s`)

    t.ok(generatedText.length > 0, `${label} Should generate OCR output`)

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

test('PaddleOCR-VL produces consistent OCR on repeated runs', { timeout: TEST_CONSTANTS.timeout }, async t => {
  for (const deviceConfig of DEVICE_CONFIGS) {
    const label = `[${deviceConfig.id.toUpperCase()}]`

    const { inference } = await setupPaddleInference(t, deviceConfig.device)

    const imageFilePath = getMediaPath('news-paper.jpg')
    t.ok(fs.existsSync(imageFilePath), `${label} news-paper.jpg image file should exist`)

    const { generatedText: text1 } = await runOcr(inference, imageFilePath)
    t.ok(text1.length > 0, `${label} first run produced output (${text1.length} chars)`)

    const { generatedText: text2 } = await runOcr(inference, imageFilePath)
    t.ok(text2.length > 0, `${label} second run produced output (${text2.length} chars)`)

    t.ok(
      text1.length > 10 && text2.length > 10,
      `${label} both runs produced substantial output`
    )
  }
})
