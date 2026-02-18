'use strict'

const test = require('brittle')
const os = require('bare-os')
const FilesystemDL = require('@qvac/dl-filesystem')

const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const BITNET_MODEL = {
  name: 'bitnet_b1_58-large-TQ2_0.gguf',
  url: 'https://huggingface.co/gianni-cor/bitnet_b1_58-large-TQ2_0/resolve/main/bitnet_b1_58-large-TQ2_0.gguf'
}

const PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'what is bitcoin?' }
]

function getConfig () {
  return {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '1024',
    n_predict: '32',
    verbosity: '2',
    preferAdrenoOpenCl: 'false',
    flash_attn: 'off',
    seed: '42'
  }
}

async function collectResponse (response) {
  const chunks = []
  await response
    .onUpdate(data => {
      chunks.push(data)
    })
    .await()
  return chunks.join('').trim()
}

test('bitnet model runs simple inference', { timeout: 1_800_000 }, async t => {
  const [modelName, dirPath] = await ensureModel({
    modelName: BITNET_MODEL.name,
    downloadUrl: BITNET_MODEL.url
  })

  const loader = new FilesystemDL({ dirPath })
  const addon = new LlmLlamacpp({
    loader,
    modelName,
    diskPath: dirPath,
    logger: console,
    opts: { stats: true }
  }, getConfig())

  try {
    await addon.load()
    const response = await addon.run(PROMPT)
    const output = await collectResponse(response)

    t.comment(`bitnet response: ${output}`)
    t.ok(output.length > 0, 'bitnet model should produce non-empty output')
  } finally {
    await addon.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
})

