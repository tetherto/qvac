'use strict'

// MTP speculative decoding through the multimodal (mtmd) context path.
//
// The Qwen3.5-0.8B-MTP GGUF ships both an mmproj and the next-n / MTP head, so
// loading it with a projectionModel builds an MtmdLlmContext that can draft.
// Text turns draft; image turns fall back to non-speculative decoding because
// the vision prefill bypasses the draft context.

const test = require('brittle')
const fs = require('bare-fs')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel, getMediaPath } = require('./utils')
const os = require('bare-os')

const platform = os.platform()
const arch = os.arch()
const isDarwinX64 = platform === 'darwin' && arch === 'x64'
const isLinuxArm64 = platform === 'linux' && arch === 'arm64'
const useCpu = isDarwinX64 || isLinuxArm64

const MODEL = {
  name: 'Qwen3.5-0.8B-MTP-Q8_0.gguf',
  url: 'https://huggingface.co/prithivMLmods/Qwen3.5-0.8B-MTP-GGUF/resolve/main/Qwen3.5-0.8B.Q8_0.gguf'
}
const MMPROJ = {
  name: 'Qwen3.5-0.8B-MTP-mmproj-q8_0.gguf',
  url: 'https://huggingface.co/prithivMLmods/Qwen3.5-0.8B-MTP-GGUF/resolve/main/Qwen3.5-0.8B.mmproj-q8_0.gguf'
}

const TEXT_PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is the capital of France? Answer in one complete sentence.' }
]

function createLogger() {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

async function collectResponse(response) {
  const chunks = []
  const ticker = setInterval(() => {}, 50)
  try {
    await response
      .onUpdate((data) => {
        chunks.push(data)
      })
      .await()
  } finally {
    clearInterval(ticker)
  }
  return chunks.join('').trim()
}

async function loadMtmdMtp() {
  const [modelName, dirPath] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })
  const [projName] = await ensureModel({
    modelName: MMPROJ.name,
    downloadUrl: MMPROJ.url
  })
  const addon = new LlmLlamacpp({
    files: {
      model: [path.join(dirPath, modelName)],
      projectionModel: path.join(dirPath, projName)
    },
    config: {
      device: useCpu ? 'cpu' : 'gpu',
      gpu_layers: '999',
      ctx_size: '4096',
      n_predict: '48',
      temp: '0',
      seed: '42',
      'reasoning-budget': '0',
      'spec-type': 'draft-mtp',
      verbosity: '2'
    },
    logger: createLogger(),
    opts: { stats: true }
  })
  await addon.load()
  return addon
}

test('mtmd context: text turn drafts through the MTP head', { timeout: 600_000 }, async (t) => {
  const addon = await loadMtmdMtp()
  try {
    const response = await addon.run(TEXT_PROMPT)
    const output = await collectResponse(response)
    const stats = response.stats
    t.ok(output.length > 0, `text turn produced output (${output.length} chars)`)
    console.log(`  text output: "${output.slice(0, 200)}"`)
    t.ok(/paris/i.test(output), 'text output names the capital (Paris)')
    console.log(`  draftAccepted=${stats.draftAccepted} draftTotal=${stats.draftTotal}`)
    // The real signal: a text-only turn through the mtmd context drafts.
    t.ok(stats.draftTotal > 0, `MTP head drafted on a text turn (draftTotal=${stats.draftTotal})`)
    t.ok(
      stats.draftAccepted > 0,
      `target accepted MTP drafts on a text turn (draftAccepted=${stats.draftAccepted})`
    )
  } finally {
    await addon.unload().catch(() => {})
  }
})

test(
  'mtmd context: image turn falls back to non-speculative decoding',
  { timeout: 600_000 },
  async (t) => {
    const addon = await loadMtmdMtp()
    try {
      const imageBytes = new Uint8Array(fs.readFileSync(getMediaPath('elephant.jpg')))
      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', type: 'media', content: imageBytes },
        { role: 'user', content: 'Describe this image in one sentence.' }
      ]
      const response = await addon.run(messages)
      const output = await collectResponse(response)
      const stats = response.stats
      t.ok(output.length > 0, `image turn produced output (${output.length} chars)`)
      console.log(`  image output: "${output.slice(0, 200)}"`)
      console.log(`  draftAccepted=${stats.draftAccepted} draftTotal=${stats.draftTotal}`)
      // The vision prefill bypasses the draft context, so the image turn must
      // fall back to normal decoding: no drafting at all.
      t.is(stats.draftTotal, 0, 'image turn does not draft (fell back to normal decode)')
      t.is(stats.draftAccepted, 0, 'image turn accepted no drafts')
    } finally {
      await addon.unload().catch(() => {})
    }
  }
)
