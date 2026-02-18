'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const FilesystemDL = require('@qvac/dl-filesystem')

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
        : 'Install `@qvac/llm-llamacpp` first for npm source.')
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

function parseArgs (argv) {
  const parsed = {}
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = true
    } else {
      parsed[key] = next
      i++
    }
  }
  return parsed
}

function round (num, digits = 6) {
  if (typeof num !== 'number' || Number.isNaN(num)) return null
  const scale = Math.pow(10, digits)
  return Math.round(num * scale) / scale
}

function average (values) {
  if (!values.length) return null
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

function clamp01 (value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

function parseJudgeScore (rawText) {
  const text = String(rawText || '').trim()
  if (!text) return null
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) {
    return clamp01(Number(text))
  }
  const match = text.match(/[+-]?\d+(\.\d+)?/g)
  if (!match || match.length === 0) return null
  return clamp01(Number(match[0]))
}

function buildJudgeMessages (reference, candidate) {
  return [
    {
      role: 'system',
      content: 'Return only a number between 0 and 1 for semantic agreement.'
    },
    {
      role: 'user',
      content:
        `Reference:\n${String(reference || '')}\n\n` +
        `Candidate:\n${String(candidate || '')}\n\n` +
        'Score rubric: 1=same meaning, 0=completely different. Return only the score.'
    }
  ]
}

function buildConfigObject (runtimeConfig) {
  const config = {}
  for (const [key, value] of Object.entries(runtimeConfig)) {
    if (value === null || value === undefined) continue
    if (key === 'no-mmap' || key === 'no-kv-offload') {
      if (value === true) config[key] = ''
    } else if (key === 'flash-attn') {
      config[key] = String(value)
    } else {
      config[key] = String(value)
    }
  }
  return config
}

function findLatestSweepJsonl (resultsDir) {
  const files = fs.readdirSync(resultsDir)
  const candidates = files
    .filter((name) => /^llm-parameter-sweep-\d{8}-\d{6}\.jsonl$/.test(name))
    .sort()
  if (candidates.length === 0) {
    throw new Error(`No sweep jsonl files found in ${resultsDir}`)
  }
  return path.join(resultsDir, candidates[candidates.length - 1])
}

function readJsonlRecords (jsonlPath) {
  const text = fs.readFileSync(jsonlPath, 'utf8')
  const lines = text.split('\n').filter(Boolean)
  return lines.map((line, idx) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`Invalid JSONL at ${jsonlPath}:${idx + 1} -> ${error.message || String(error)}`)
    }
  })
}

function trimForJudge (value, maxChars) {
  const s = String(value || '')
  if (s.length <= maxChars) return s
  return `${s.slice(0, maxChars)}\n...[truncated for judge]...`
}

function stableHash32 (text) {
  const s = String(text || '')
  let hash = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16)
}

function pairKey (reference, candidate) {
  const ref = String(reference || '')
  const cand = String(candidate || '')
  return `${ref.length}:${stableHash32(ref)}|${cand.length}:${stableHash32(cand)}`
}

class JudgeRuntimeManager {
  constructor (opts) {
    this.AddonCtor = opts.AddonCtor
    this.modelDef = opts.modelDef
    this.modelName = opts.modelName
    this.runtimeConfig = opts.runtimeConfig
    this.debug = opts.debug
    this.model = null
    this.loader = null
    this.cache = new Map()
    this.maxChars = 6000
  }

  async init () {
    if (this.model) return
    this.loader = new FilesystemDL({ dirPath: this.modelDef.modelDir })
    const config = buildConfigObject(this.runtimeConfig)
    this.model = new this.AddonCtor({
      modelName: this.modelName,
      loader: this.loader,
      diskPath: this.modelDef.modelDir,
      opts: { stats: true },
      logger: createAddonRuntimeLogger(this.debug)
    }, config)
    await this.model.load()
  }

  async preflight (reference, candidate) {
    await this.score(reference, candidate)
  }

  async score (reference, candidate) {
    if (reference == null || candidate == null) return null
    const ref = String(reference)
    const cand = String(candidate)
    if (ref === cand) return 1.0

    const cacheKey = pairKey(ref, cand)
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey)

    let charLimit = this.maxChars
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const refTrimmed = trimForJudge(ref, charLimit)
        const candTrimmed = trimForJudge(cand, charLimit)
        const response = await this.model.run(buildJudgeMessages(refTrimmed, candTrimmed))
        const chunks = []
        await response.onUpdate((data) => {
          chunks.push(data)
        }).await()
        const parsed = parseJudgeScore(chunks.join(''))
        this.cache.set(cacheKey, parsed)
        return parsed
      } catch (error) {
        const message = String(error && error.message ? error.message : error).toLowerCase()
        if (message.includes('context') || message.includes('overflow')) {
          charLimit = Math.max(500, Math.floor(charLimit / 2))
          continue
        }
        throw error
      }
    }
    return null
  }

  async close () {
    if (this.model) {
      await this.model.unload().catch(() => {})
      this.model = null
    }
    if (this.loader) {
      await this.loader.close().catch(() => {})
      this.loader = null
    }
  }
}

const {
  DEFAULT_RESULTS_DIR,
  MODELS
} = require('./llm-parameter-sweep.config')

async function main () {
  const args = parseArgs(process.argv)
  const debug = Boolean(args.debug)
  const addonSource = parseAddonSource(args['addon-source'])
  const AddonCtor = resolveAddonCtor(addonSource)
  const resultsDir = args['results-dir'] ? path.resolve(args['results-dir']) : DEFAULT_RESULTS_DIR
  const inputJsonl = args.input ? path.resolve(args.input) : findLatestSweepJsonl(resultsDir)
  const outputJsonl = args.output
    ? path.resolve(args.output)
    : inputJsonl.replace(/\.jsonl$/, '.judged.jsonl')

  const records = readJsonlRecords(inputJsonl)
  if (records.length === 0) throw new Error(`No records in ${inputJsonl}`)

  const baselineByModelPrompt = new Map()
  for (const record of records) {
    if (!record || !record.isBaseline) continue
    const modelId = String(record.modelId || '')
    const promptResults = Array.isArray(record.promptResults) ? record.promptResults : []
    for (const prompt of promptResults) {
      const promptId = prompt && prompt.promptId ? String(prompt.promptId) : ''
      const outputText = prompt && typeof prompt.outputText === 'string' ? prompt.outputText : null
      if (!modelId || !promptId || outputText == null) continue
      baselineByModelPrompt.set(`${modelId}::${promptId}`, outputText)
    }
  }

  const judgeModelId = String(args['judge-model'] || MODELS[0].id)
  const judgeModelDef = MODELS.find((m) => m.id === judgeModelId)
  if (!judgeModelDef) throw new Error(`Unknown --judge-model: ${judgeModelId}`)
  const judgeQuant = String(args['judge-quantization'] || judgeModelDef.defaultQuantization || 'Q4_0')
  const judgeModelName = judgeModelDef.quantizationFiles[judgeQuant]
  if (!judgeModelName) throw new Error(`Judge quantization "${judgeQuant}" not found for model "${judgeModelId}"`)

  const judgeRuntimeConfig = {
    ...judgeModelDef.defaults,
    device: String(args['judge-device'] || judgeModelDef.defaults.device || 'gpu'),
    'ctx-size': String(args['judge-ctx-size'] || '8192'),
    'batch-size': String(args['judge-batch-size'] || '512'),
    'ubatch-size': String(args['judge-ubatch-size'] || '128'),
    'n-predict': String(args['judge-n-predict'] || '16'),
    temp: '0',
    seed: '42',
    'flash-attn': 'off',
    verbosity: '0'
  }

  const forceRescore = Boolean(args.force)
  const scoreTasks = new Map()
  let longestReference = ''
  let longestCandidate = ''
  let reusedCount = 0

  for (const record of records) {
    const modelId = String(record.modelId || '')
    if (record.isBaseline) continue
    const prompts = Array.isArray(record.promptResults) ? record.promptResults : []
    for (const p of prompts) {
      if (!p || p.error) continue
      if (p.qualityMatch === 1.0) continue
      if (!forceRescore && p.qualityJudge != null) {
        reusedCount++
        continue
      }
      const promptId = p.promptId ? String(p.promptId) : ''
      const candidate = typeof p.outputText === 'string' ? p.outputText : null
      const baseline = baselineByModelPrompt.get(`${modelId}::${promptId}`) || null
      if (baseline == null || candidate == null) continue
      const key = pairKey(baseline, candidate)
      if (!scoreTasks.has(key)) {
        scoreTasks.set(key, { baseline, candidate })
        if (baseline.length > longestReference.length) longestReference = baseline
        if (candidate.length > longestCandidate.length) longestCandidate = candidate
      }
    }
  }

  const scoredPairs = new Map()
  let judge = null

  if (scoreTasks.size > 0) {
    judge = new JudgeRuntimeManager({
      AddonCtor,
      modelDef: judgeModelDef,
      modelName: judgeModelName,
      runtimeConfig: judgeRuntimeConfig,
      debug
    })
    await judge.init()
    try {
      // Fail fast before full scoring pass.
      await judge.preflight(longestReference, longestCandidate)
      for (const [key, task] of scoreTasks) {
        const score = await judge.score(task.baseline, task.candidate)
        scoredPairs.set(key, score)
      }
    } finally {
      await judge.close()
    }
  }

  const outFd = fs.openSync(outputJsonl, 'w')
  try {
    for (const record of records) {
      const modelId = String(record.modelId || '')
      const prompts = Array.isArray(record.promptResults) ? record.promptResults : []
      const judgedPrompts = []

      for (const p of prompts) {
        const promptId = p && p.promptId ? String(p.promptId) : ''
        const candidate = p && typeof p.outputText === 'string' ? p.outputText : null
        const baseline = baselineByModelPrompt.get(`${modelId}::${promptId}`) || null
        let qualityJudge = p && p.qualityJudge != null && !forceRescore ? p.qualityJudge : null

        if (record.isBaseline || (p && p.qualityMatch === 1.0)) {
          qualityJudge = 1.0
        } else if (p && p.error) {
          qualityJudge = null
        } else if (qualityJudge == null && baseline != null && candidate != null) {
          qualityJudge = scoredPairs.get(pairKey(baseline, candidate)) ?? null
        }

        judgedPrompts.push({
          ...p,
          baselineReference: baseline,
          qualityJudge
        })
      }

      const promptScores = judgedPrompts
        .filter((p) => !p.error && p.qualityJudge != null)
        .map((p) => p.qualityJudge)
      const qualityJudge = round(average(promptScores), 6)

      const judgedRecord = {
        ...record,
        qualityJudge,
        promptResults: judgedPrompts
      }
      fs.writeSync(outFd, `${JSON.stringify(judgedRecord)}\n`)
    }
  } finally {
    fs.closeSync(outFd)
  }

  console.log(`Judge scoring complete.`)
  console.log(`Input: ${inputJsonl}`)
  console.log(`Output: ${outputJsonl}`)
  console.log(`Judge model: ${judgeModelId} (${judgeQuant})`)
  console.log(`Unique scored pairs: ${scoreTasks.size}`)
  console.log(`Reused existing judge scores: ${reusedCount}`)
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(1)
})
