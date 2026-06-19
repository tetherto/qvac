'use strict'

// MTP (Multi-Token Prediction) speculative-decoding integration test.
//
// Uses a Qwen3.5-0.8B GGUF that BUNDLES the next-n / MTP head (blk.24.nextn.*),
// so spec-type=draft-mtp builds a real LLAMA_CONTEXT_TYPE_MTP draft context over
// the same model and the draft/verify/accept loop actually fires. The standard
// unsloth Qwen3.5 GGUF omits the MTP head, which is why a draft-mtp run against
// it is silently inert — this test guards against that by asserting a real
// speculative signal (stats.draftAccepted > 0), not just coherent output.

const test = require('brittle')
const path = require('bare-path')
const LlmLlamacpp = require('../../index.js')
const { ensureModel } = require('./utils')
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

const PROMPT = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'What is the capital of France? Answer in one word.' }
]

function createLogger () {
  return {
    info: (...args) => console.info(...args),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
    debug: (...args) => console.debug(...args)
  }
}

async function collectResponse (response) {
  const chunks = []
  const ticker = setInterval(() => {}, 50)
  try {
    await response.onUpdate(data => { chunks.push(data) }).await()
  } finally {
    clearInterval(ticker)
  }
  return chunks.join('').trim()
}

async function runOnce ({ withSpec }) {
  const [modelName, dirPath] = await ensureModel({
    modelName: MODEL.name,
    downloadUrl: MODEL.url
  })
  const modelPath = path.join(dirPath, modelName)

  const config = {
    device: useCpu ? 'cpu' : 'gpu',
    gpu_layers: '999',
    ctx_size: '1024',
    n_predict: '64',
    temp: '0',
    seed: '42',
    'reasoning-budget': '0',
    verbosity: '2'
  }
  if (withSpec) {
    config['spec-type'] = 'draft-mtp'
  }

  const addon = new LlmLlamacpp({
    files: { model: [modelPath] },
    config,
    logger: createLogger(),
    opts: { stats: true }
  })

  try {
    await addon.load()
    const response = await addon.run(PROMPT)
    const output = await collectResponse(response)
    return { output, stats: response.stats }
  } finally {
    await addon.unload().catch(() => {})
  }
}

test('Qwen3.5-0.8B with spec-type=draft-mtp drafts + accepts', {
  timeout: 600_000
}, async t => {
  const { output, stats } = await runOnce({ withSpec: true })
  t.ok(output.length > 0, `spec run produced output (${output.length} chars)`)
  console.log(`  spec output: "${output.slice(0, 200)}"`)
  t.ok(stats, 'spec run has response.stats')
  t.ok(
    /paris/i.test(output),
    'spec output names the capital (Paris) in the reply'
  )
  // The real speculative signal: the MTP head must have drafted tokens that the
  // target model verified and accepted. Without this assertion the test would
  // pass even if draft-mtp were inert (no draft context, no acceptance).
  console.log(
    `  draftAccepted=${stats.draftAccepted} draftTotal=${stats.draftTotal}`
  )
  t.ok(
    stats.draftTotal > 0,
    `MTP head produced draft tokens (draftTotal=${stats.draftTotal})`
  )
  t.ok(
    stats.draftAccepted > 0,
    `target accepted MTP draft tokens (draftAccepted=${stats.draftAccepted})`
  )
})

test('Qwen3.5-0.8B without spec-type', {
  timeout: 600_000
}, async t => {
  // Sentinel: confirms the addon's existing single-context path still works,
  // proving the MTP code added to TextLlmContext is correctly gated behind
  // the `spec-type` config check and doesn't fire for default-config loads.
  const { output, stats } = await runOnce({ withSpec: false })
  t.ok(output.length > 0, `non-spec run produced output (${output.length} chars)`)
  t.ok(stats, 'non-spec run has stats')
  t.ok(
    /paris/i.test(output),
    'non-spec output names the capital (Paris) in the reply'
  )
  t.is(
    stats.draftAccepted, 0,
    'non-spec run performs no speculative drafting (draftAccepted=0)'
  )
})
