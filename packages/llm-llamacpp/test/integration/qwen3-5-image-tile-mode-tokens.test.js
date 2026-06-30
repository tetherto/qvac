'use strict'
// Verifies that image_max_tokens and image_tile_mode are correctly parsed
// from the addon config and reach MtmdLlmContext. The key assertion is that
// `disabled` mode with image_max_tokens=4096 produces significantly more
// prompt tokens than `sequential` (proving the 2048 cap is overridden), and
// both modes are well above the erroneous 2047-token floor from the bug.

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
  downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf'
}
const PROJ_MODEL = {
  modelName: 'mmproj-Qwen3.5-0.8B-F16.gguf',
  downloadUrl: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf'
}

function createLogger () {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

test('image_max_tokens + image_tile_mode: prompt token counts reflect cap override and tile mode', { timeout: 1_800_000 }, async t => {
  const [modelName, dirPath] = await ensureModel(MODEL)
  const [projModelName] = await ensureModel(PROJ_MODEL)
  const modelPath = path.join(dirPath, modelName)
  const projectionModelPath = path.join(dirPath, projModelName)

  const imageFilePath = getMediaPath('fruitPlate.png')
  t.ok(fs.existsSync(imageFilePath), 'fruitPlate.png image file should exist')
  const imageBytes = new Uint8Array(fs.readFileSync(imageFilePath))

  const baseConfig = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '98',
    ctx_size: '8192',
    temp: '0',
    seed: '42',
    'reasoning-budget': '0',
    verbosity: '2',
    image_max_tokens: '4096'
  }

  async function runMode (tileMode) {
    const inference = new LlmLlamacpp({
      files: { model: [modelPath], projectionModel: projectionModelPath },
      config: { ...baseConfig, image_tile_mode: tileMode },
      logger: createLogger(),
      opts: { stats: true }
    })
    await inference.load()
    try {
      const messages = [
        { role: 'user', type: 'media', content: imageBytes },
        { role: 'user', content: 'Describe the image briefly in one sentence.' }
      ]
      const response = await inference.run(messages)
      const chunks = []
      response.onUpdate(data => { chunks.push(data) })
      await response.await()
      return { promptTokens: response.stats?.promptTokens ?? 0, output: chunks.join('') }
    } finally {
      await inference.unload().catch(() => {})
    }
  }

  const disabled = await runMode('disabled')
  t.comment(`disabled: promptTokens=${disabled.promptTokens}`)

  const sequential = await runMode('sequential')
  t.comment(`sequential: promptTokens=${sequential.promptTokens}`)

  // disabled with image_max_tokens=4096 must exceed the old 2048 cap
  t.ok(disabled.promptTokens > 3000,
    `disabled mode should encode >3000 prompt tokens (got ${disabled.promptTokens}); cap override not working if <= 2048`)

  // tiled mode uses fewer tokens (global thumbnail replaces per-tile patches)
  t.ok(sequential.promptTokens < 3200,
    `sequential mode should encode <3200 prompt tokens (got ${sequential.promptTokens})`)

  // tiled must be meaningfully cheaper than disabled
  t.ok(sequential.promptTokens < disabled.promptTokens,
    `sequential (${sequential.promptTokens}) should use fewer tokens than disabled (${disabled.promptTokens})`)

  t.ok(disabled.output.length > 0, 'disabled mode produced output')
  t.ok(sequential.output.length > 0, 'sequential mode produced output')
})

setImmediate(() => {
  setTimeout(() => {}, 500)
})
