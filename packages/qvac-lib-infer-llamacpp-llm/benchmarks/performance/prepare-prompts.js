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

const OUTPUT_PATH = path.resolve(__dirname, 'test-prompts.json')
const MODEL_DIR = path.resolve(__dirname, 'models')
const MODEL_NAME = 'Qwen3-1.7B-Q4_0.gguf'

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

function cloneMessages (messages) {
  return messages.map((m) => ({ role: m.role, content: String(m.content) }))
}

function buildMessagesFromWords (templateMessages, wordCount) {
  const out = cloneMessages(templateMessages)
  let userIndex = -1
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === 'user') {
      userIndex = i
      break
    }
  }
  if (userIndex === -1) return out
  const words = String(out[userIndex].content || '').split(/\s+/).filter(Boolean)
  out[userIndex].content = words.slice(0, Math.max(1, Math.min(words.length, wordCount))).join(' ')
  return out
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

async function tuneToBudget (model, templateMessages, budget) {
  const words = String(templateMessages[templateMessages.length - 1].content || '').split(/\s+/).filter(Boolean)
  if (words.length === 0) throw new Error('Template has no user words to tune')

  // Start with a safe calibration probe to estimate words->tokens for this template/model.
  const probeWords = Math.min(words.length, 200)
  const probeTokens = await getPromptTokens(model, buildMessagesFromWords(templateMessages, probeWords))
  if (!Number.isFinite(probeTokens) || probeTokens <= 0) {
    throw new Error(`Calibration probe failed (words=${probeWords}, tokens=${probeTokens})`)
  }

  let currentWords = Math.max(1, Math.min(words.length, Math.floor((budget / probeTokens) * probeWords * 0.9)))
  let currentTokens = await getPromptTokens(model, buildMessagesFromWords(templateMessages, currentWords))
  if (!Number.isFinite(currentTokens)) {
    throw new Error('Initial calibrated prompt overflowed unexpectedly; reduce template density')
  }

  // Keep closest under-budget prompt as winner.
  let bestWords = currentWords
  let bestTokens = currentTokens <= budget ? currentTokens : -1

  // Bounded monotonic growth near budget to avoid large overflow jumps that can destabilize runtime.
  let safety = 0
  while (currentTokens < budget && safety < 400) {
    safety += 1
    const gap = budget - currentTokens
    const step = gap > 512 ? 48 : (gap > 128 ? 16 : 4)
    const nextWords = Math.min(words.length, currentWords + step)
    if (nextWords === currentWords) break
    const nextTokens = await getPromptTokens(model, buildMessagesFromWords(templateMessages, nextWords))
    if (!Number.isFinite(nextTokens)) break
    currentWords = nextWords
    currentTokens = nextTokens
    if (currentTokens <= budget && currentTokens > bestTokens) {
      bestWords = currentWords
      bestTokens = currentTokens
    }
  }

  if (bestTokens < 0) {
    // Fallback: find smallest safe prompt by shrinking from currentWords.
    let shrinkWords = Math.max(1, Math.floor(currentWords / 2))
    let shrinkTokens = await getPromptTokens(model, buildMessagesFromWords(templateMessages, shrinkWords))
    while ((!Number.isFinite(shrinkTokens) || shrinkTokens > budget) && shrinkWords > 1) {
      shrinkWords = Math.max(1, Math.floor(shrinkWords / 2))
      shrinkTokens = await getPromptTokens(model, buildMessagesFromWords(templateMessages, shrinkWords))
    }
    if (!Number.isFinite(shrinkTokens) || shrinkTokens > budget) {
      throw new Error(`Unable to build safe prompt under budget=${budget}`)
    }
    bestWords = shrinkWords
    bestTokens = shrinkTokens
  }

  return {
    messages: buildMessagesFromWords(templateMessages, bestWords),
    promptTokens: bestTokens
  }
}

function basePrompts () {
  return [
    {
      id: 'long',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        {
          role: 'user',
          content: (
            'You are reviewing an incident report. Write a detailed narrative with sections for timeline, ' +
            'root cause, impact, mitigations, and follow-up actions. Target a long answer close to 1000 tokens, ' +
            'include concrete checkpoints, and avoid bullet points unless needed for clarity. '
          ).repeat(15)
        }
      ]
    }
  ]
}

function ctxTemplateMessages () {
  return [
    { role: 'system', content: 'You are a helpful assistant. Be detailed and exhaustive.' },
    {
      role: 'user',
      content: (
        'Analyze this policy in depth. Provide section-by-section findings, risks, mitigations, ' +
        'constraints, assumptions, trade-offs, and an actionable rollout plan. '
      ).repeat(1200)
    }
  ]
}

function batchTemplateMessages () {
  return [
    { role: 'system', content: 'You are a helpful assistant. Analyze thoroughly.' },
    {
      role: 'user',
      content: (
        'Read the technical specification and produce architecture notes, implementation details, ' +
        'operational risks, and deployment guidance with concrete examples. '
      ).repeat(1200)
    }
  ]
}

function getCtxBudget (ctxSize) {
  return Math.max(256, Number(ctxSize) - N_PREDICT_RESERVE - PROMPT_OVERHEAD_RESERVE)
}

function getBatchBudget (ctxSize, batchSize) {
  const desired = Math.max(512, Number(batchSize) * 3)
  return Math.max(256, Math.min(getCtxBudget(ctxSize), desired))
}

async function main () {
  if (!fs.existsSync(path.join(MODEL_DIR, MODEL_NAME))) {
    throw new Error(`Missing tokenizer model at ${path.join(MODEL_DIR, MODEL_NAME)}. Run model prep first.`)
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
      console.log('Prompt calibration runtime: gpu (fast path)')
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
      console.log('Prompt calibration runtime: cpu (fallback)')
    }
    const prompts = basePrompts()
    const ctxTemplate = ctxTemplateMessages()
    const batchTemplate = batchTemplateMessages()

    for (const ctx of CTX_SIZES) {
      const target = getCtxBudget(ctx)
      const tuned = await tuneToBudget(model, ctxTemplate, target)
      prompts.push({
        id: `ctx-filling__ctx=${ctx}`,
        messages: tuned.messages,
        meta: {
          targetPromptTokens: target,
          actualPromptTokens: tuned.promptTokens,
          note: 'maximizes context fill while preserving generation headroom'
        }
      })
      console.log(`ctx-filling__ctx=${ctx}: target=${target} actual=${tuned.promptTokens}`)
    }

    for (const ctx of CTX_SIZES) {
      for (const batch of BATCH_SIZES) {
        const target = getBatchBudget(ctx, batch)
        const tuned = await tuneToBudget(model, batchTemplate, target)
        const note = Number(batch) > Number(ctx)
          ? 'batch-size exceeds ctx-size; uses longest safe prompt under ctx budget'
          : 'targets long prompt to span multiple prefill batches where feasible'
        prompts.push({
          id: `batch-spanning__ctx=${ctx}__bs=${batch}`,
          messages: tuned.messages,
          meta: {
            targetPromptTokens: target,
            actualPromptTokens: tuned.promptTokens,
            note
          }
        })
        console.log(`batch-spanning__ctx=${ctx}__bs=${batch}: target=${target} actual=${tuned.promptTokens}`)
      }
    }

    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(prompts, null, 2)}\n`)
    console.log(`Wrote ${prompts.length} prompts to ${OUTPUT_PATH}`)
  } finally {
    await model.unload().catch(() => {})
    await loader.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error(`prepare-prompts.js failed: ${err && err.message ? err.message : String(err)}`)
  process.exit(1)
})
