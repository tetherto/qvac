'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const FilesystemDL = require('@qvac/dl-filesystem')
const Llm = require('../../index')
const {
  CTX_SIZES,
  BATCH_SIZES,
  N_PREDICT_RESERVE,
  PROMPT_OVERHEAD_RESERVE
} = require('./sweep-shared-constants')

const PROMPTS_PATH = path.resolve(__dirname, 'test-prompts.json')
const MODEL_DIR = path.resolve(__dirname, 'models')
const MODEL_NAME = 'Qwen3-1.7B-Q4_0.gguf'

const CTX_SLACK = 24

const FAST_PROBE_RUNTIME = {
  device: 'gpu',
  'gpu-layers': '99',
  'ctx-size': '8192',
  'batch-size': '8192',
  'ubatch-size': '1024',
  'flash-attn': 'on',
  temp: '0.1',
  seed: '42',
  'n-predict': '1',
  verbosity: '0'
}

const SAFE_FALLBACK_RUNTIME = {
  device: 'cpu',
  'ctx-size': '8192',
  'batch-size': '2048',
  'ubatch-size': '512',
  temp: '0.1',
  seed: '42',
  'n-predict': '1',
  verbosity: '0'
}

function shouldFallbackToCpu (err) {
  const msg = err && err.message ? String(err.message) : String(err)
  return /vram|gpu|metal|cuda|opencl|failed to create context|unabletoloadmodel|failed to initialize model|device/i.test(msg)
}

function getCtxBudget (ctxSize) {
  return Math.max(256, Number(ctxSize) - N_PREDICT_RESERVE - PROMPT_OVERHEAD_RESERVE)
}

function getBatchBudget (ctxSize, batchSize) {
  const desired = Math.max(512, Number(batchSize) * 3)
  return Math.max(256, Math.min(getCtxBudget(ctxSize), desired))
}

async function getPromptTokens (model, messages) {
  try {
    const response = await model.run(messages)
    await response.onUpdate(() => {}).await()
    const n = response && response.stats ? Number(response.stats.promptTokens) : NaN
    if (!Number.isFinite(n)) throw new Error('promptTokens missing from addon stats')
    return n
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err)
    if (/context|ctx[- ]?size|overflow/i.test(msg)) return Infinity
    throw err
  }
}

async function main () {
  const prompts = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8'))
  const byId = new Map(prompts.map((p) => [p.id, p]))
  const failures = []

  for (const id of ['short', 'medium', 'long']) {
    if (!byId.has(id)) failures.push(`Missing base prompt: ${id}`)
  }

  if (!fs.existsSync(path.join(MODEL_DIR, MODEL_NAME))) {
    throw new Error(`Missing tokenizer model at ${path.join(MODEL_DIR, MODEL_NAME)}`)
  }

  const loader = new FilesystemDL({ dirPath: MODEL_DIR })
  let model = null

  try {
    try {
      model = new Llm(
        {
          modelName: MODEL_NAME,
          loader,
          diskPath: MODEL_DIR,
          opts: { stats: true }
        },
        FAST_PROBE_RUNTIME
      )
      await model.load()
      console.log('Prompt verification runtime: gpu (fast path)')
    } catch (gpuErr) {
      const msg = gpuErr && gpuErr.message ? String(gpuErr.message) : String(gpuErr)
      if (!shouldFallbackToCpu(gpuErr)) {
        throw gpuErr
      }
      console.warn(`GPU probe init failed; falling back to CPU: ${msg}`)
      if (model) await model.unload().catch(() => {})
      model = new Llm(
        {
          modelName: MODEL_NAME,
          loader,
          diskPath: MODEL_DIR,
          opts: { stats: true }
        },
        SAFE_FALLBACK_RUNTIME
      )
      await model.load()
      console.log('Prompt verification runtime: cpu (fallback)')
    }
    for (const ctx of CTX_SIZES) {
      const id = `ctx-filling__ctx=${ctx}`
      const p = byId.get(id)
      if (!p) {
        failures.push(`Missing prompt: ${id}`)
        continue
      }
      const n = await getPromptTokens(model, p.messages)
      const budget = getCtxBudget(ctx)
      if (n > budget) failures.push(`${id}: ${n} exceeds budget ${budget}`)
      if (n < (budget - CTX_SLACK)) failures.push(`${id}: ${n} does not fill context enough (target near ${budget})`)
      console.log(`${id}: tokens=${n} budget=${budget}`)
    }

    for (const ctx of CTX_SIZES) {
      for (const batch of BATCH_SIZES) {
        const id = `batch-spanning__ctx=${ctx}__bs=${batch}`
        const p = byId.get(id)
        if (!p) {
          failures.push(`Missing prompt: ${id}`)
          continue
        }
        const n = await getPromptTokens(model, p.messages)
        const budget = getBatchBudget(ctx, batch)
        if (n > budget) failures.push(`${id}: ${n} exceeds budget ${budget}`)
        if (Number(batch) <= Number(ctx)) {
          const minSpan = Math.min(budget, Number(batch) + 64)
          if (n < minSpan) failures.push(`${id}: ${n} too short to span batches (expected >= ${minSpan})`)
        }
        console.log(`${id}: tokens=${n} budget=${budget}`)
      }
    }
  } finally {
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
  }

  if (failures.length) {
    console.error('Prompt verification failed:')
    for (const f of failures) console.error(`- ${f}`)
    process.exit(1)
  }
  console.log('Prompt verification passed.')
}

main().catch((err) => {
  console.error(`verify-prompts.js failed: ${err && err.message ? err.message : String(err)}`)
  process.exit(1)
})
