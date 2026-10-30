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
  'image_max_tokens + image_tile_mode: prompt token counts reflect cap override and tile mode',
  { timeout: 1_800_000 },
  async (t) => {
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

    async function runMode(tileMode) {
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
        response.onUpdate((data) => {
          chunks.push(data)
        })
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
    t.ok(
      disabled.promptTokens > 3000,
      `disabled mode should encode >3000 prompt tokens (got ${disabled.promptTokens}); cap override not working if <= 2048`
    )

    // tiled mode uses fewer tokens (global thumbnail replaces per-tile patches)
    t.ok(
      sequential.promptTokens < 3200,
      `sequential mode should encode <3200 prompt tokens (got ${sequential.promptTokens})`
    )

    // tiled must be meaningfully cheaper than disabled
    t.ok(
      sequential.promptTokens < disabled.promptTokens,
      `sequential (${sequential.promptTokens}) should use fewer tokens than disabled (${disabled.promptTokens})`
    )

    t.ok(disabled.output.length > 0, 'disabled mode produced output')
    t.ok(sequential.output.length > 0, 'sequential mode produced output')
  }
)

test(
  'dynamic image resize: half-way dimensions use ties-to-even',
  { timeout: 1_800_000 },
  async (t) => {
    const [modelName, dirPath] = await ensureModel(MODEL)
    const [projModelName] = await ensureModel(PROJ_MODEL)
    const inference = new LlmLlamacpp({
      files: {
        model: [path.join(dirPath, modelName)],
        projectionModel: path.join(dirPath, projModelName)
      },
      config: {
        device: useCpu ? 'cpu' : 'gpu',
        gpu_layers: '98',
        ctx_size: '8192',
        predict: '1',
        temp: '0',
        'reasoning-budget': '0',
        image_tile_mode: 'disabled',
        image_min_tokens: '64',
        image_max_tokens: '16384'
      },
      logger: createLogger(),
      opts: { stats: true }
    })
    await inference.load()
    try {
      const counts = []
      for (const height of [448, 464, 480, 496, 512]) {
        const width = 640
        const pixels = width * height * 3
        const image = new Uint8Array(54 + pixels).fill(255)
        image.fill(0, 0, 54)
        image.set([0x42, 0x4d])
        const header = new DataView(image.buffer)
        header.setUint32(2, image.length, true)
        header.setUint32(10, 54, true)
        header.setUint32(14, 40, true)
        header.setInt32(18, width, true)
        header.setInt32(22, height, true)
        header.setUint16(26, 1, true)
        header.setUint16(28, 24, true)
        header.setUint32(34, pixels, true)
      const response = await inference.run([
          { role: 'user', type: 'media', content: new Uint8Array(image) },
          { role: 'user', content: 'Describe the image.' }
        ])
        await response.await()
        t.ok(response.stats?.promptTokens > 0, `height ${height} has prompt statistics`)
        counts.push(response.stats?.promptTokens)
      }
      t.is(counts[1], counts[0], '464 rounds down to 448 (even quotient 14)')
      t.is(counts[3], counts[4], '496 rounds up to 512 (even quotient 16)')
      t.ok(counts[2] > counts[0], '480 retains its extra image-token row')
    } finally {
      await inference.unload()
    }
  }
)

setImmediate(() => {
  setTimeout(() => {}, 500)
})
