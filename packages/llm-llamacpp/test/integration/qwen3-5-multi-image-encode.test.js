'use strict'
// Regression for adjacent equal-size still images being temporally merged as
// video frames by mtmd (fabric < b10549), which aborted the process inside
// clip encoding. Two separate identical images must encode as two chunks and
// complete normally. Tile mode is disabled so each image is exactly one
// encode chunk; the merge happens at bitmap grouping, before preprocessing,
// so the regression is still exercised.

const test = require('brittle')
const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, getMediaPath } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const MODEL = {
  modelName: 'Qwen3.5-0.8B-Q8_0.gguf',
  downloadUrl:
    'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
}
const PROJ_MODEL = {
  modelName: 'mmproj-Qwen3.5-0.8B-F16.gguf',
  downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf'
}

function createLogger() {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

test(
  'multi-image: two identical still images encode as separate tiles and complete',
  { timeout: 1_800_000 },
  async (t) => {
    const [modelName, dirPath] = await ensureModel(MODEL)
    const [projModelName] = await ensureModel(PROJ_MODEL)
    const modelPath = path.join(dirPath, modelName)
    const projectionModelPath = path.join(dirPath, projModelName)

    const imageFilePath = getMediaPath('fruitPlate.png')
    t.ok(fs.existsSync(imageFilePath), 'fruitPlate.png image file should exist')
    const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))

    const config = {
      device: useCpu ? 'cpu' : 'gpu',
      gpu_layers: '98',
      ctx_size: '8192',
      temp: '0',
      seed: '42',
      'reasoning-budget': '0',
      verbosity: '2',
      image_tile_mode: 'disabled'
    }

    async function run(imageCount) {
      const inference = new LlmLlamacpp({
        files: { model: [modelPath], projectionModel: projectionModelPath },
        config,
        logger: createLogger(),
        opts: { stats: true }
      })
      await inference.load()
      try {
        const messages = []
        for (let i = 0; i < imageCount; i++) {
          messages.push({ role: 'user', type: 'media', content: imageBytes })
        }
        messages.push({ role: 'user', content: 'Describe the image briefly in one sentence.' })
        const response = await inference.run(messages)
        const chunks = []
        response.onUpdate((data) => {
          chunks.push(data)
        })
        await response.await()
        return {
          promptTokens: response.stats?.promptTokens ?? 0,
          visionEncodeTiles: response.stats?.visionEncodeTiles ?? 0,
          output: chunks.join('')
        }
      } finally {
        await inference.unload().catch(() => {})
      }
    }

    const one = await run(1)
    t.comment(`one image: promptTokens=${one.promptTokens} tiles=${one.visionEncodeTiles}`)

    const two = await run(2)
    t.comment(`two images: promptTokens=${two.promptTokens} tiles=${two.visionEncodeTiles}`)

    t.is(one.visionEncodeTiles, 1, 'a single still image should encode as one chunk')
    t.is(
      two.visionEncodeTiles,
      2,
      'two separate identical still images should encode as two chunks, not merge as video frames'
    )
    t.ok(
      two.promptTokens > one.promptTokens,
      `two images (${two.promptTokens}) should use more prompt tokens than one (${one.promptTokens})`
    )
    t.ok(one.output.length > 0, 'one-image request produced output')
    t.ok(two.output.length > 0, 'two-image request produced output')
  }
)

setImmediate(() => {
  setTimeout(() => {}, 500)
})
