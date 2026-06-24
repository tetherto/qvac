'use strict'

const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, safeTest } = require('./utils')
const { attachSpecLogger } = require('./spec-logger')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const MODEL = {
  name: 'Llama-3.2-1B-Instruct-Q4_0.gguf',
  url: 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'
}

const UTF8_PROMPT = [
  {
    role: 'system',
    content: 'You are a precise assistant that must follow instructions exactly.'
  },
  {
    role: 'user',
    content: 'Reply with exactly the emoji 😀 and nothing else.'
  }
]

function containsEmoji (text) {
  return /\u{1F600}/u.test(text)
}

safeTest('model returns UTF-8 emoji without truncation', { timeout: 600_000 }, async t => {
  let model = null
  let specLogger = null
  let loggerReleased = false
  const releaseLogger = () => {
    if (loggerReleased) return
    loggerReleased = true
    if (specLogger) specLogger.release()
  }
  try {
    const [modelName, dirPath] = await ensureModel({
      modelName: MODEL.name,
      downloadUrl: MODEL.url
    })

    const modelPath = path.join(dirPath, modelName)
    specLogger = attachSpecLogger({ forwardToConsole: true })

    const config = {
      device: useCpu ? 'cpu' : 'gpu',
      gpu_layers: '999',
      ctx_size: '1024',
      temp: '0',
      top_p: '0.8',
      top_k: '30',
      n_predict: '8',
      seed: '42',
      verbosity: '2'
    }

    model = new LlmLlamacpp({
      files: { model: [modelPath] },
      config,
      logger: console,
      opts: { stats: true }
    })

    let output = ''
    await model.load()
    const response = await model.run(UTF8_PROMPT)
    await response
      .onUpdate(data => {
        output += data
      })
      .await()

    const normalized = output.trim()
    t.ok(normalized.length > 0, 'generated some output')
    t.ok(containsEmoji(normalized), 'output contains emoji')
    t.is(Buffer.from(normalized, 'utf8').toString('utf8'), normalized, 'utf8 encoding round-trip succeeds')
    t.is(normalized, '😀', 'model respected exact emoji instruction')
    t.ok(response.stats.generatedTokens > 0, 'token stats recorded')
  } finally {
    if (model) await model.unload().catch(() => {})
    releaseLogger()
  }
})
