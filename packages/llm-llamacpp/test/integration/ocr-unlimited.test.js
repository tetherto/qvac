'use strict'
// test/integration/ocr-unlimited.test.js
//
// Unlimited-OCR (baidu/Unlimited-OCR) is a DeepSeek-OCR-derived 3B OCR VLM.
// GGUFs are pulled from the community conversion on HF (vimalnakrani/unlimited-ocr-gguf,
// pinned sha), the same way LightON OCR-2 pulls from noctrex.
// Requires qvac-fabric >= 9840 (deepseek2-ocr engine + deepseekocr clip projector).
const fs = require('bare-fs')
const path = require('bare-path')
const { ensureModel, getMediaPath, safeTest } = require('./utils')
const LlmLlamacpp = require('../../index.js')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const isMobile = platform === 'ios' || platform === 'android'

const useCpuDesktop = isDarwinX64 || isLinuxArm64

const HF_BASE =
  'https://huggingface.co/vimalnakrani/unlimited-ocr-gguf/resolve/45cd66ec6b46a7c4de49f376084ecec2b8d3c59a'

const UNLIMITED_OCR_CONFIG = {
  llmModel: {
    modelName: 'unlimited-ocr-Q4_K_M.gguf',
    downloadUrl: `${HF_BASE}/unlimited-ocr-Q4_K_M.gguf`
  },
  projModel: {
    modelName: 'mmproj-unlimited-ocr-F16.gguf',
    downloadUrl: `${HF_BASE}/mmproj-unlimited-ocr-F16.gguf`
  },
  ctx_size: '8192'
}

const TEST_CONSTANTS = {
  timeout: 1_800_000, // 30 min — download (~2GB) + slow encode on constrained devices
  maxTokens: isMobile ? '768' : '1800'
}

// GPU on mobile: this is a 3B VLM — the LLM layers run on the mobile GPU (the
// vision projector auto-selects GPU on Adreno/iOS, CPU on Mali; see README).
// Only the Intel-mac / linux-arm desktop lanes fall back to CPU.
const DEVICE_CONFIGS = isMobile
  ? [{ id: 'gpu', device: 'gpu' }]
  : useCpuDesktop
    ? [{ id: 'cpu', device: 'cpu' }]
    : [{ id: 'gpu', device: 'gpu' }]

function getConfig(device) {
  return {
    gpu_layers: '98',
    temp: '0',
    verbosity: '2',
    device,
    ctx_size: UNLIMITED_OCR_CONFIG.ctx_size,
    predict: TEST_CONSTANTS.maxTokens
  }
}

async function setupUnlimitedInference(t, device = 'gpu') {
  const [modelName, dirPath] = await ensureModel(UNLIMITED_OCR_CONFIG.llmModel)
  t.ok(fs.existsSync(path.join(dirPath, modelName)), 'LLM model file should exist')

  const [projModelName] = await ensureModel(UNLIMITED_OCR_CONFIG.projModel)
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

async function runOcr(inference, imageFilePath) {
  const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))

  // Unlimited-OCR is prompt-sensitive: 'document parsing.' triggers full-page
  // layout + table parsing. A generic "extract the text" prompt returns near-empty.
  const messages = [
    { role: 'user', type: 'media', content: imageBytes },
    { role: 'user', content: 'document parsing.' }
  ]

  const startTime = Date.now()
  const response = await inference.run(messages)
  const generatedText = []
  let error = null

  response
    .onUpdate((data) => {
      generatedText.push(data)
    })
    .onError((err) => {
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

// Test: Unlimited-OCR parses a scanned medical (CT-scan) report document.
// Runs on desktop (on-pr) and on mobile GPU in the *weekly* ocr group only
// (androidWeekly/iosWeekly) — it is deliberately kept out of the on-pr mobile
// groups so on-pr Device Farm time stays short; the weekly lane carries the
// heavier OCR coverage.
safeTest(
  'Unlimited-OCR can parse text from document image',
  { timeout: TEST_CONSTANTS.timeout },
  async (t) => {
    for (const deviceConfig of DEVICE_CONFIGS) {
      const label = `[${deviceConfig.id.toUpperCase()}]`

      const { inference } = await setupUnlimitedInference(t, deviceConfig.device)

      // Scanned CT-scan report — dense paragraphs + a header form/table
      const imageFilePath = getMediaPath('ct-scan-report.png')
      t.ok(fs.existsSync(imageFilePath), `${label} ct-scan-report.png image file should exist`)

      const { generatedText, startTime, endTime } = await runOcr(inference, imageFilePath)
      const totalTime = endTime - startTime

      t.comment(
        `${label} Generated text (${generatedText.length} chars): ${generatedText.substring(0, 500)}...`
      )
      t.comment(`${label} Total time: ${(totalTime / 1000).toFixed(2)}s`)

      // Assert output is non-empty
      t.ok(generatedText.length > 0, `${label} Should generate OCR output`)

      // Assert key text from the radiology report is present
      const lowerText = generatedText.toLowerCase()
      const expectedKeywords = ['tomography', 'chest', 'abdomen', 'gallbladder', 'pancreas']
      const foundKeywords = expectedKeywords.filter((kw) => lowerText.includes(kw))

      t.ok(
        foundKeywords.length >= 2,
        `${label} OCR output should contain at least two expected keywords. ` +
          `Found: ${foundKeywords.join(', ') || 'none'}. ` +
          `Expected any of: ${expectedKeywords.join(', ')}`
      )
    }
  }
)
