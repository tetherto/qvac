'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const {
  DEFAULT_RESULTS_DIR,
  DEFAULT_REPEATS,
  MODELS,
  PARAMETER_SWEEP
} = require('./embed-parameter-sweep.config')
const { createProgressReporter } = require('./progress')
const { tsFileStamp, toMarkdown, toReportJson, toJsonLines } = require('./reporters')
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
      parsed[key] = normalizeArgValue(token.slice(inlineEqIndex + 1))
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

// --models <comma-list> limits the sweep to those manifest ids (used for a
// quick CI plumbing check); empty runs the full manifest. Unknown ids fail
// loudly rather than silently running a smaller grid than intended.
function selectModels (allModels, value) {
  const ids = String(value || '').split(',').map((x) => x.trim()).filter(Boolean)
  if (ids.length === 0) return allModels
  const missing = ids.filter((id) => !allModels.some((m) => m.id === id))
  if (missing.length) {
    throw new Error(
      `Unknown model id(s) in --models: ${missing.join(', ')}. ` +
      `Available: ${allModels.map((m) => m.id).join(', ')}`
    )
  }
  return allModels.filter((m) => ids.includes(m.id))
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
  const selectedModels = selectModels(MODELS, args.models)

  fs.mkdirSync(resultsDir, { recursive: true })
  // Record what this run actually covered so the renderer can flag a narrowed
  // run (a --models subset or reduced --repeats, used for quick plumbing checks)
  // instead of letting it read as the full official sweep.
  const requestedModelIds = selectedModels.map((m) => m.id)
  const manifestModelIds = MODELS.map((m) => m.id)
  const report = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    repeats,
    coverage: {
      requestedModelIds,
      manifestModelIds,
      repeats,
      defaultRepeats: DEFAULT_REPEATS,
      narrowed: requestedModelIds.length < manifestModelIds.length || repeats !== DEFAULT_REPEATS
    },
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
      progress
    })
    report.models.push(modelResult)
  }

  report.finishedAt = new Date().toISOString()

  isShuttingDown = true

  const stamp = tsFileStamp()
  const jsonPath = path.join(resultsDir, `embed-parameter-sweep-${stamp}.json`)
  const jsonlPath = path.join(resultsDir, `embed-parameter-sweep-${stamp}.jsonl`)
  const mdPath = path.join(resultsDir, `embed-parameter-sweep-${stamp}.md`)
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(toReportJson(report), null, 2))
    fs.writeFileSync(jsonlPath, toJsonLines(report))
    fs.writeFileSync(mdPath, toMarkdown(report))
    debugLogger.log('\nDone.')
    debugLogger.log(`JSON: ${jsonPath}`)
    debugLogger.log(`JSONL: ${jsonlPath}`)
    debugLogger.log(`MD:   ${mdPath}`)
  } catch (writeError) {
    console.error('Failed to write report files:', writeError)
  }
}

let isShuttingDown = false

process.on('uncaughtException', (error) => {
  if (isShuttingDown) {
    return
  }
  console.error('Uncaught exception in parameter sweep:')
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(130)
})

process.on('unhandledRejection', (reason) => {
  if (isShuttingDown) {
    return
  }
  console.error('Unhandled rejection in parameter sweep:')
  console.error(reason && reason.stack ? reason.stack : String(reason))
  process.exit(130)
})

main().catch((error) => {
  isShuttingDown = true
  console.error('Parameter sweep failed:')
  console.error(error && error.stack ? error.stack : String(error))
  process.exit(130)
})
