'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const {
  DEFAULT_RESULTS_DIR,
  DEFAULT_REPEATS,
  DEFAULT_INPUTS_FILE,
  MODELS,
  PARAMETER_SWEEP
} = require('./embed-parameter-sweep.config')
const { createProgressReporter } = require('./progress')
const { tsFileStamp, toMarkdown, toJsonLines } = require('./reporters')
const { buildCases, runModelCases } = require('./case-runner')

function loadLocalEmbedAddon () {
  return require('../../index')
}

function loadNpmEmbedAddon () {
  return require('@qvac/embed-llamacpp')
}

function createDebugLogger (enabled) {
  return {
    log: (...msgs) => {
      if (enabled) console.log(...msgs)
    },
    warn: (...msgs) => {
      if (enabled) console.warn(...msgs)
    }
  }
}

function parseAddonSource (value) {
  const normalized = String(value || 'local').trim().toLowerCase()
  if (normalized === 'local' || normalized === 'npm') return normalized
  throw new Error(`Invalid --addon-source value "${value}". Expected "local" or "npm".`)
}

function resolveAddonCtor (addonSource) {
  try {
    return addonSource === 'npm' ? loadNpmEmbedAddon() : loadLocalEmbedAddon()
  } catch (error) {
    const message = error.message || String(error)
    throw new Error(
      `Failed to load addon source "${addonSource}": ${message}. ` +
      (addonSource === 'local'
        ? 'Run `npm run build` for local addon artifacts.'
        : 'Run `npm run performance:install` to install npm addon package.')
    )
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

function parseRepeats (value) {
  if (value == null) return DEFAULT_REPEATS
  const repeats = Number(value)
  if (!Number.isInteger(repeats) || repeats <= 0) {
    throw new Error(`Invalid --repeats value "${value}". Expected a positive integer.`)
  }
  return repeats
}

async function main () {
  const args = parseArgs(process.argv)
  const debugEnabled = Boolean(args.debug)
  const debugLogger = createDebugLogger(debugEnabled)
  const addonSource = parseAddonSource(args['addon-source'])
  const AddonCtor = resolveAddonCtor(addonSource)
  const repeats = parseRepeats(args.repeats)
  const resultsDir = DEFAULT_RESULTS_DIR
  const inputsFilePath = DEFAULT_INPUTS_FILE
  if (!fs.existsSync(inputsFilePath)) {
    throw new Error(
      `Missing inputs file: ${inputsFilePath}. ` +
      'Place a JSON object { "<batchSize>": string[5], ... } at benchmarks/performance/inputs.json.'
    )
  }
  const inputsByBatchSize = JSON.parse(fs.readFileSync(inputsFilePath, 'utf8'))
  const selectedModels = MODELS

  fs.mkdirSync(resultsDir, { recursive: true })
  const report = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    repeats,
    models: []
  }

  const plannedRunsByModel = selectedModels.map((modelDef) => {
    const cases = buildCases(modelDef, PARAMETER_SWEEP)
    return { modelDef, cases }
  })
  const totalPlannedRuns = plannedRunsByModel.reduce((acc, item) => acc + (item.cases.length * repeats), 0)
  const progress = createProgressReporter(totalPlannedRuns)

  debugLogger.log(`Running full-grid parameter sweep for: ${selectedModels.map((m) => m.id).join(', ')}`)
  debugLogger.log(`Addon source: ${addonSource}`)
  debugLogger.log(`Repeats per case: ${repeats}`)
  debugLogger.log(`Total planned runs: ${totalPlannedRuns}`)
  progress.start()

  for (const plan of plannedRunsByModel) {
    const modelResult = await runModelCases({
      AddonCtor,
      repeats,
      debugEnabled,
      debugLogger,
      modelDef: plan.modelDef,
      cases: plan.cases,
      inputsByBatchSize,
      progress
    })
    report.models.push(modelResult)
  }

  report.finishedAt = new Date().toISOString()
  const stamp = tsFileStamp()
  const jsonlPath = path.join(resultsDir, `embed-parameter-sweep-${stamp}.jsonl`)
  const mdPath = path.join(resultsDir, `embed-parameter-sweep-${stamp}.md`)
  fs.writeFileSync(jsonlPath, toJsonLines(report))
  fs.writeFileSync(mdPath, toMarkdown(report))
  debugLogger.log('\nDone.')
}

main().catch((error) => {
  console.error('Parameter sweep failed:')
  console.error(error.stack || String(error))
  process.exit(1)
})
