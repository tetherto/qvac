'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const Llm = require('../../index')
const {
  PROMPT_CTX_SIZES,
  PROMPT_BATCH_SIZES,
  shouldFallbackToCpu,
  getCtxBudget,
  getBatchBudget,
  getPromptTokens
} = require('./utils')

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

async function main () {
  const prompts = JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf8'))
  const byId = new Map(prompts.map((p) => [p.id, p]))
  const failures = []
  const minCtxSize = Math.min(...PROMPT_CTX_SIZES)
  const minCtxBudget = getCtxBudget(minCtxSize)

  if (!byId.has('long')) failures.push('Missing base prompt: long')

  const modelPath = path.join(MODEL_DIR, MODEL_NAME)
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Missing tokenizer model at ${modelPath}`)
  }

  let model = null

  try {
    try {
      model = new Llm({
        files: { model: [modelPath] },
        config: FAST_PROBE_RUNTIME,
        opts: { stats: true }
      })
      await model.load()
      console.log('Prompt verification runtime: gpu (fast path)')
    } catch (gpuErr) {
      const msg = gpuErr && gpuErr.message ? String(gpuErr.message) : String(gpuErr)
      if (!shouldFallbackToCpu(gpuErr)) {
        throw gpuErr
      }
      console.warn(`GPU probe init failed; falling back to CPU: ${msg}`)
      if (model) await model.unload().catch(() => {})
      model = new Llm({
        files: { model: [modelPath] },
        config: SAFE_FALLBACK_RUNTIME,
        opts: { stats: true }
      })
      await model.load()
      console.log('Prompt verification runtime: cpu (fallback)')
    }
    {
      const p = byId.get('long')
      if (p) {
        const n = await getPromptTokens(model, p.messages)
        if (n > minCtxBudget) {
          failures.push(`long: ${n} exceeds minimum ctx budget ${minCtxBudget} (ctx=${minCtxSize})`)
        }
        if (Number.isFinite(n) && n < 650) {
          failures.push(`long: ${n} too short; expected a substantial long prompt for n-predict=1024`)
        }
        console.log(`long: tokens=${n} minCtxBudget=${minCtxBudget}`)
      }
    }

    for (const ctx of PROMPT_CTX_SIZES) {
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

    for (const ctx of PROMPT_CTX_SIZES) {
      for (const batch of PROMPT_BATCH_SIZES) {
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
          const minSpan = Math.max(256, Math.min(budget - CTX_SLACK, Number(batch) + 64))
          if (n < minSpan) failures.push(`${id}: ${n} too short to span batches (expected >= ${minSpan})`)
        }
        console.log(`${id}: tokens=${n} budget=${budget}`)
      }
    }
  } finally {
    if (model) await model.unload().catch(() => {})
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
