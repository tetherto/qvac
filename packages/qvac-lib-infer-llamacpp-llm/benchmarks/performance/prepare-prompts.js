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

async function tuneToBudget (model, templateMessages, budget) {
  const words = String(templateMessages[templateMessages.length - 1].content || '').split(/\s+/).filter(Boolean)
  if (words.length === 0) throw new Error('Template has no user words to tune')

  // Start with a safe calibration probe to estimate words->tokens for this template/model.
  const probeWords = Math.min(words.length, 200)
  const probeTokens = await getPromptTokens(model, buildMessagesFromWords(templateMessages, probeWords))
  if (!Number.isFinite(probeTokens) || probeTokens <= 0) {
    throw new Error(`Calibration probe failed (words=${probeWords}, tokens=${probeTokens})`)
  }

  const tokenByWords = new Map()
  async function tokensForWords (wordCount) {
    const w = Math.max(1, Math.min(words.length, Number(wordCount)))
    if (tokenByWords.has(w)) return tokenByWords.get(w)
    const tokenCount = await getPromptTokens(model, buildMessagesFromWords(templateMessages, w))
    tokenByWords.set(w, tokenCount)
    return tokenCount
  }

  // Keep closest under-budget prompt as winner.
  let bestWords = 1
  let bestTokens = -1

  // Initial guess close to target.
  const guessWords = Math.max(1, Math.min(words.length, Math.floor((budget / probeTokens) * probeWords * 0.95)))
  const guessTokens = await tokensForWords(guessWords)
  if (Number.isFinite(guessTokens) && guessTokens <= budget) {
    bestWords = guessWords
    bestTokens = guessTokens
  }

  // Establish [low, high] bounds where low is safe and high is overflow/over-budget if possible.
  let lowWords = Number.isFinite(guessTokens) && guessTokens <= budget ? guessWords : 1
  let highWords = guessWords
  if (!(Number.isFinite(guessTokens) && guessTokens > budget)) {
    let stepWords = Math.max(8, Math.floor(guessWords * 0.3))
    let safety = 0
    while (highWords < words.length && safety < 24) {
      safety += 1
      const nextWords = Math.min(words.length, highWords + stepWords)
      if (nextWords === highWords) break
      const nextTokens = await tokensForWords(nextWords)
      if (Number.isFinite(nextTokens) && nextTokens <= budget) {
        lowWords = nextWords
        if (nextTokens > bestTokens) {
          bestWords = nextWords
          bestTokens = nextTokens
        }
        highWords = nextWords
        stepWords = Math.max(8, Math.floor(stepWords * 1.5))
      } else {
        highWords = nextWords
        break
      }
    }
  }

  // Binary search the upper boundary to maximize safe tokens quickly.
  let left = lowWords
  let right = highWords
  if (right <= left) right = Math.min(words.length, left + 1)
  let iter = 0
  while (left <= right && iter < 28) {
    iter += 1
    const mid = Math.floor((left + right) / 2)
    const midTokens = await tokensForWords(mid)
    if (Number.isFinite(midTokens) && midTokens <= budget) {
      if (midTokens > bestTokens) {
        bestWords = mid
        bestTokens = midTokens
      }
      left = mid + 1
    } else {
      right = mid - 1
    }
  }

  if (bestTokens < 0) {
    const minTokens = await tokensForWords(1)
    if (!Number.isFinite(minTokens) || minTokens > budget) {
      throw new Error(`Unable to build safe prompt under budget=${budget}`)
    }
    bestWords = 1
    bestTokens = minTokens
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

async function main () {
  const modelPath = path.join(MODEL_DIR, MODEL_NAME)
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Missing tokenizer model at ${modelPath}. Run model prep first.`)
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
      console.log('Prompt calibration runtime: gpu (fast path)')
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
      console.log('Prompt calibration runtime: cpu (fallback)')
    }
    const prompts = basePrompts()
    const ctxTemplate = ctxTemplateMessages()
    const batchTemplate = batchTemplateMessages()

    for (const ctx of PROMPT_CTX_SIZES) {
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

    for (const ctx of PROMPT_CTX_SIZES) {
      for (const batch of PROMPT_BATCH_SIZES) {
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
    if (model) await model.unload().catch(() => {})
  }
}

main().catch((err) => {
  console.error(`prepare-prompts.js failed: ${err && err.message ? err.message : String(err)}`)
  process.exit(1)
})
