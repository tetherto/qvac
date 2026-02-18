'use strict'

const {
  N_PREDICT_RESERVE,
  PROMPT_OVERHEAD_RESERVE
} = require('./sweep-shared-constants')

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

module.exports = {
  shouldFallbackToCpu,
  getCtxBudget,
  getBatchBudget,
  getPromptTokens
}
