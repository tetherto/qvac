'use strict'

const { round, average } = require('./math')

// --- Constants (formerly sweep-shared-constants.js) ---

const DEFAULT_SWEEP_CTX_SIZES = [2048]
const DEFAULT_SWEEP_BATCH_SIZES = [512, 2048]

const PROMPT_CTX_SIZES = [2048, 4096, 8192]
const PROMPT_BATCH_SIZES = [512, 2048, 4096, 8192]
const N_PREDICT_RESERVE = 1024
const PROMPT_OVERHEAD_RESERVE = 128

// --- Prompt helpers (formerly prompt-shared-utils.js) ---

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

// --- Addon shared helpers (extracted from sweep / judge) ---

function loadLocalLlmAddon () {
  return require('../../index')
}

function loadNpmLlmAddon () {
  return require('@qvac/llm-llamacpp')
}

function parseAddonSource (value) {
  const normalized = String(value || 'local').trim().toLowerCase()
  if (normalized === 'local' || normalized === 'npm') return normalized
  throw new Error(`Invalid --addon-source value "${value}". Expected "local" or "npm".`)
}

function resolveAddonCtor (addonSource) {
  try {
    return addonSource === 'npm' ? loadNpmLlmAddon() : loadLocalLlmAddon()
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    throw new Error(
      `Failed to load addon source "${addonSource}": ${message}. ` +
      (addonSource === 'local'
        ? 'Run `npm run build` for local addon artifacts.'
        : 'Run `npm run performance:install` to install npm addon package.')
    )
  }
}

function createAddonRuntimeLogger (debugEnabled) {
  if (!debugEnabled) {
    return {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {}
    }
  }
  return {
    error: (...msgs) => console.error(...msgs),
    warn: (...msgs) => console.warn(...msgs),
    info: (...msgs) => console.log(...msgs),
    debug: (...msgs) => console.debug(...msgs)
  }
}

function stripSurroundingQuotes (value) {
  const s = String(value)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

function normalizeArgValue (value) {
  if (value === true || value == null) return value
  let normalized = String(value).trim()
  if (normalized.startsWith('=')) {
    normalized = normalized.slice(1).trim()
  }
  normalized = stripSurroundingQuotes(normalized).trim()
  return normalized
}

function parseArgs (argv) {
  const parsed = {}
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const inlineEqIndex = token.indexOf('=')
    if (inlineEqIndex !== -1) {
      const key = token.slice(2, inlineEqIndex)
      const value = normalizeArgValue(token.slice(inlineEqIndex + 1))
      parsed[key] = value
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = normalizeArgValue(next)
      i++
    }
  }
  return parsed
}

// Resident-memory sample. `rss` comes from bare-os so it matches the counter
// calibrate-model-fit.ts and asr-ggml's memory-usage.js already use and the
// figures stay comparable across packages.
//
// rss alone cannot rank load modes. A mapped load keeps the weights file-backed
// and evictable while the CPU backend additionally repacks them into its own
// buffers, so on linux `mmap` reads HIGHER total rss than `none` while costing
// LESS anonymous memory — the opposite ranking, on the number that actually has
// to be found under pressure. So anon/file are split out where the OS exposes
// them (/proc, i.e. linux and android). Elsewhere they are null: an absent
// reading, not a zero.
function readMemorySample () {
  let rss = null
  try {
    const usage = require('bare-os').memoryUsage()
    if (usage && usage.rss > 0) rss = usage.rss
  } catch { /* counter unavailable; recorded as null */ }

  let anon = null
  let file = null
  let locked = null
  try {
    const status = require('bare-fs').readFileSync('/proc/self/status', 'utf8').split('\n')
    const readKb = (key) => {
      const line = status.find((l) => l.startsWith(key))
      if (!line) return null
      const value = Number(line.replace(/[^0-9]/g, ''))
      return Number.isFinite(value) ? value * 1024 : null
    }
    anon = readKb('RssAnon:')
    file = readKb('RssFile:')
    locked = readKb('VmLck:')
  } catch { /* not a /proc platform; anon/file stay null */ }

  return { rss, anon, file, locked }
}

function diffMemorySamples (before, after) {
  const delta = (a, b) => (a == null || b == null ? null : b - a)
  return {
    rssBytes: delta(before.rss, after.rss),
    rssAnonBytes: delta(before.anon, after.anon),
    rssFileBytes: delta(before.file, after.file),
    lockedBytes: after.locked
  }
}

function buildConfigObject (runtimeConfig) {
  const config = {}
  for (const [key, value] of Object.entries(runtimeConfig)) {
    if (value === null || value === undefined) continue
    if (key === 'flash-attn') {
      if (value === true) {
        config[key] = 'on'
      } else if (value === false) {
        config[key] = 'off'
      } else {
        config[key] = String(value)
      }
    } else {
      config[key] = String(value)
    }
  }
  return config
}

module.exports = {
  DEFAULT_SWEEP_CTX_SIZES,
  DEFAULT_SWEEP_BATCH_SIZES,
  PROMPT_CTX_SIZES,
  PROMPT_BATCH_SIZES,
  N_PREDICT_RESERVE,
  PROMPT_OVERHEAD_RESERVE,
  shouldFallbackToCpu,
  getCtxBudget,
  getBatchBudget,
  getPromptTokens,
  loadLocalLlmAddon,
  loadNpmLlmAddon,
  parseAddonSource,
  resolveAddonCtor,
  createAddonRuntimeLogger,
  readMemorySample,
  diffMemorySamples,
  stripSurroundingQuotes,
  normalizeArgValue,
  parseArgs,
  round,
  average,
  buildConfigObject
}
