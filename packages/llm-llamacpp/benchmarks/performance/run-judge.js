'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const {
  parseAddonSource,
  resolveAddonCtor,
  createAddonRuntimeLogger,
  parseArgs,
  buildConfigObject
} = require('./utils')
const { round, average } = require('./math')

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

function createJudgeRuntimeManager (opts) {
  let model = null
  const cache = new Map()
  const maxChars = 6000

  return {
    async init () {
      if (model) return
      const config = buildConfigObject(opts.runtimeConfig)
      const AddonCtor = opts.AddonCtor
      model = new AddonCtor({
        files: { model: [path.join(opts.modelDef.modelDir, opts.modelName)] },
        config,
        opts: { stats: true },
        logger: createAddonRuntimeLogger(opts.debug)
      })
      await model.load()
    },

    async preflight (reference, candidate) {
      await this.score(reference, candidate)
    },

    async score (reference, candidate) {
      if (reference == null || candidate == null) return null
      const ref = String(reference)
      const cand = String(candidate)
      if (ref === cand) return 1.0

      const cacheKey = pairKey(ref, cand)
      if (cache.has(cacheKey)) return cache.get(cacheKey)

      let charLimit = maxChars
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const refTrimmed = trimForJudge(ref, charLimit)
          const candTrimmed = trimForJudge(cand, charLimit)
          const response = await model.run(buildJudgeMessages(refTrimmed, candTrimmed))
          const chunks = []
          await response.onUpdate((data) => {
            chunks.push(data)
          }).await()
          const parsed = parseJudgeScore(chunks.join(''))
          cache.set(cacheKey, parsed)
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
    },

    async close () {
      if (model) {
        await model.unload().catch(() => {})
        model = null
      }
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
  const judgeQuant = String(
    args['judge-quantization'] ||
    (Array.isArray(judgeModelDef.quantizations) ? judgeModelDef.quantizations[0] : null) ||
    'Q4_0'
  )
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
      const baselineKey = `${modelId}::${promptId}`
      const baseline = baselineByModelPrompt.has(baselineKey)
        ? baselineByModelPrompt.get(baselineKey)
        : null
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
    judge = createJudgeRuntimeManager({
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
        const baselineKey = `${modelId}::${promptId}`
        const baseline = baselineByModelPrompt.has(baselineKey)
          ? baselineByModelPrompt.get(baselineKey)
          : null
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

  console.log('Judge scoring complete.')
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
