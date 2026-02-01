'use strict'

const test = require('brittle')
const os = require('bare-os')
const FilesystemDL = require('@qvac/dl-filesystem')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isMobile = platform === 'ios' || platform === 'android'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const MODEL = {
  name: 'dolphin-mixtral-2x7b-dop-Q2_K.gguf',
  url: 'https://huggingface.co/jmb95/laser-dolphin-mixtral-2x7b-dpo-GGUF/resolve/main/dolphin-mixtral-2x7b-dop-Q2_K.gguf'
}

const CONFIG = {
  device: useCpu ? 'cpu' : 'gpu',
  gpu_layers: '99',
  ctx_size: '2048',
  predict: '128',
  verbosity: '2'
}

const PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello, say something brief.' }
]

test('llm addon can run MoE models [dolphin-mixtral-2x7b]', { timeout: 1_800_000, skip: isDarwinX64 || isMobile }, async t => {
  const [modelName, dirPath] = await ensureModel({ modelName: MODEL.name, downloadUrl: MODEL.url })

  const loader = new FilesystemDL({ dirPath })
  const specLogger = attachSpecLogger({ forwardToConsole: true })
  const inference = new LlmLlamacpp({
    modelName,
    loader,
    logger: console,
    diskPath: dirPath,
    opts: { stats: true }
  }, CONFIG)

  try {
    await inference.load()
    const response = await inference.run(PROMPT)
    const text = await response._finishPromise

    t.ok(text.length > 0, 'should generate text output')
    t.ok(response.stats.TPS > 0, 'should have TPS stats')
  } finally {
    specLogger.release()
    await inference.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})
