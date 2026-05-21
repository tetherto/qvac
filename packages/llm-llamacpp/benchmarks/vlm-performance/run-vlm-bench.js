#!/usr/bin/env node
'use strict'

// Orchestrator. Sequence:
//   1. Parse CLI args + load config.
//   2. Make sure models are present (calls prepare-models.js if needed).
//   3. Resolve sources (candidate + baseline).
//   4. For each (source, backend), spawn `bare case-runner.js` once,
//      capture the per-cell JSON, aggregate.
//   5. Write reports (full matrix + delta MD, plus raw JSON).
//
// Backends are picked from --backends or fall back to a sensible
// platform default. The platform list itself is V1-fixed to "the
// machine you're running on" when triggered locally; CI matrix overrides
// platforms via the workflow.

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const config = require('./vlm-bench.config')
const { parseArgs, csvOrArray } = require('./utils')
const { resolveSources } = require('./source-resolver')
const { buildSummary, writeReports } = require('./reporters')
const { parseStdoutMetrics } = require('./stdout-parser')

const SCRIPT_DIR = __dirname
const RESOLVED_MODELS_PATH = path.join(SCRIPT_DIR, 'resolved-models.json')

function log (...args) { console.log('[run-vlm-bench]', ...args) }

function parseBooleanFlag (raw) {
  if (raw === true) return true
  if (raw === false) return false
  if (raw == null) return null
  const s = String(raw).trim().toLowerCase()
  if (['on', 'true', 'yes', '1', 'enabled', 'enable'].includes(s)) return true
  if (['off', 'false', 'no', '0', 'disabled', 'disable'].includes(s)) return false
  return null
}

function resolveThinkingFlag (args, cfg) {
  // CLI surface: any one of these works.
  //   --thinking=on / --thinking=off
  //   --enable-thinking      (force on)
  //   --disable-thinking     (force off)
  // Falls back to cfg.thinking.enabled (default: false).
  if ('enable-thinking' in args && args['enable-thinking'] !== false) return true
  if ('disable-thinking' in args && args['disable-thinking'] !== false) return false
  if ('thinking' in args) {
    const parsed = parseBooleanFlag(args.thinking)
    if (parsed != null) return parsed
    throw new Error(`Invalid --thinking value: ${args.thinking}. Use on/off.`)
  }
  return Boolean(cfg.thinking && cfg.thinking.enabled)
}

function detectPlatformKey () {
  const p = os.platform()
  const a = os.arch()
  if (p === 'darwin' && a === 'arm64') return 'macos-arm64'
  if (p === 'win32' && a === 'x64') return 'windows-x64'
  if (p === 'linux' && a === 'x64') return 'linux-x64'
  // Mobile platforms aren't reached locally; CI builds drop us into
  // the right context directly.
  return `${p}-${a}`
}

function pickBackends (args, platformKey) {
  const fromCli = csvOrArray(args.backends || args.backend)
  if (fromCli.length) return fromCli
  const platform = config.platforms[platformKey]
  if (platform && Array.isArray(platform.backends)) return platform.backends.slice()
  return ['gpu']
}

function ensureModelsResolved (args) {
  if (fs.existsSync(RESOLVED_MODELS_PATH) && !args['force-prepare']) {
    return JSON.parse(fs.readFileSync(RESOLVED_MODELS_PATH, 'utf8'))
  }
  log('models not resolved yet — running prepare-models.js')
  const passThrough = []
  if (args['local-model']) passThrough.push('--local-model', args['local-model'])
  if (args['local-mmproj']) passThrough.push('--local-mmproj', args['local-mmproj'])
  const r = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'prepare-models.js'), ...passThrough], {
    cwd: SCRIPT_DIR,
    stdio: 'inherit',
    env: process.env
  })
  if (r.status !== 0) {
    throw new Error(`prepare-models.js failed with status ${r.status}`)
  }
  return JSON.parse(fs.readFileSync(RESOLVED_MODELS_PATH, 'utf8'))
}

function buildCaseSpec ({ source, backend, resolved, imagePath, runArgs }) {
  return {
    sourceKey: source.key,
    sourceLabel: source.label,
    addonRequirePath: source.addonPath || 'local',
    backend,
    llmPath: resolved.llmPath,
    mmprojPath: resolved.mmprojPath,
    imagePath,
    prompt: config.case.prompt,
    ctxSize: config.model.ctxSize,
    nPredict: config.model.nPredict,
    temperature: config.sampling.temperature,
    seed: config.sampling.seed,
    thinkingEnabled: runArgs.thinkingEnabled,
    warmupRuns: runArgs.warmupRuns,
    measuredRuns: runArgs.measuredRuns,
    cooldownMs: runArgs.cooldownMs,
    groundTruth: config.case.groundTruth,
    answerTruncChars: config.reporting.answerTruncChars
  }
}

function resolveLocalBare () {
  // Prefer the package-local `bare` (installed as a dep) over a global
  // install — global -g bare can be missing or stale on dev hosts and
  // requires a separate setup step, but `npm install` here gives us a
  // known-good version pinned in package.json.
  const localBin = path.join(SCRIPT_DIR, 'node_modules', 'bare', 'bin', 'bare')
  if (fs.existsSync(localBin)) return localBin
  return null
}

function runOneCell (spec, resultsDir, cellIdx) {
  const specPath = path.join(resultsDir, `cell-${cellIdx}-spec.json`)
  const resultPath = path.join(resultsDir, `cell-${cellIdx}-result.json`)
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2))

  const env = {
    ...process.env,
    VLM_CASE_SPEC_PATH: specPath,
    VLM_RESULT_PATH: resultPath
  }

  const localBare = resolveLocalBare()
  log(`spawning bare case-runner: ${spec.sourceLabel} / ${spec.backend}`)
  // The local bare entry is a Node.js script (`bin/bare`) without a
  // shebang on Windows — invoke it through node. Falls back to the
  // global `bare` on PATH if no local install is present.
  // stdio captured (not inherited) so the real error message ends up
  // in the cell result on failure, instead of just "exited with 1".
  const stdoutBuf = []
  const stderrBuf = []
  const spawnArgs = localBare
    ? [process.execPath, [localBare, path.join(SCRIPT_DIR, 'case-runner.js')]]
    : ['bare', [path.join(SCRIPT_DIR, 'case-runner.js')]]
  const r = spawnSync(spawnArgs[0], spawnArgs[1], {
    cwd: SCRIPT_DIR,
    env,
    shell: !localBare && process.platform === 'win32',
    encoding: 'utf8'
  })
  if (r.stdout) { stdoutBuf.push(r.stdout); process.stdout.write(r.stdout) }
  if (r.stderr) { stderrBuf.push(r.stderr); process.stderr.write(r.stderr) }
  // Always persist the spawn streams alongside the per-cell JSON. The
  // C++ stdio of the addon (vision-encode / eval-time / load-time
  // lines) goes through the bare process's stderr, not our JS logger;
  // we parse it after the fact and merge metrics into the per-run
  // entries the case-runner wrote.
  const fullLog = stderrBuf.join('') + '\n--- stdout ---\n' + stdoutBuf.join('')
  const logPath = path.join(path.dirname(resultPath), `cell-${cellIdx}-stderr.log`)
  fs.writeFileSync(logPath, fullLog)

  if (r.error) throw new Error(`spawn failed: ${r.error.message}`)
  if (r.status !== 0) {
    const allLines = fullLog.trim().split('\n')
    const errorLines = allLines
      .filter((ln) => /error|fatal|missing|not found|cannot|enoent|module_not_found|throw|throw new|prebuilds?/i.test(ln))
      .slice(-10)
    const tail = errorLines.length ? errorLines.join('\n  ') : allLines.slice(-10).join('\n  ')
    throw new Error(`case-runner exited with status ${r.status} for ${spec.sourceLabel} / ${spec.backend}. Likely error lines:\n  ${tail}\nFull log: ${logPath}`)
  }

  const cell = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
  // Merge host-captured stdout metrics into the run records by index,
  // using BENCH_RUN_BEGIN/END markers the case-runner emits.
  mergeHostStdoutMetrics(cell, fullLog)
  return cell
}

function mergeHostStdoutMetrics (cell, fullLog) {
  // Vision-encode timing is emitted once per session — during model
  // load / warmup, before any [BENCH_RUN_BEGIN] markers. Scrape the
  // full log for it and attach to every measured run.
  const sessionMetrics = parseStdoutMetrics(fullLog)

  // Per-run metrics (prompt eval / decode / total) appear inside the
  // run window when llama.cpp's perf print runs at end-of-inference.
  const segmentRegex = /\[BENCH_RUN_BEGIN (warmup|measured) (\d+)\]([\s\S]*?)\[BENCH_RUN_END \1 \2\]/g
  const perRunMetrics = new Map()
  let m
  while ((m = segmentRegex.exec(fullLog)) !== null) {
    const phase = m[1]
    if (phase !== 'measured') continue
    perRunMetrics.set(Number(m[2]), parseStdoutMetrics(m[3]))
  }

  if (!cell.runs) return
  for (const run of cell.runs) {
    if (!run.ok) continue
    const segmentMetrics = perRunMetrics.get(run.index) || {}
    // Session-scope visionEncodeMs only — keep per-run values from the
    // segment if the addon does emit them in newer versions.
    run.stdoutMetrics = {
      ...(run.stdoutMetrics || {}),
      ...(sessionMetrics.visionEncodeMs != null ? { visionEncodeMs: sessionMetrics.visionEncodeMs } : {}),
      ...segmentMetrics
    }
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))

  const runArgs = {
    warmupRuns: Number(args['warmup-runs'] ?? config.run.warmupRuns),
    measuredRuns: Number(args['measured-runs'] ?? config.run.measuredRuns),
    cooldownMs: Number(args['cooldown-ms'] ?? config.run.cooldownMs),
    thinkingEnabled: resolveThinkingFlag(args, config)
  }

  const resolved = ensureModelsResolved(args)
  const platformKey = detectPlatformKey()
  const backends = pickBackends(args, platformKey)
  const sources = resolveSources(config, args)

  // Skip baseline cells that need a build but have no addon path.
  const runnableSources = sources.filter((s) => {
    if (s.type === 'skip') return false
    if (s.type === 'addon' && s.source === 'commit' && s.requiresBuild && !s.addonPath) {
      log(`skipping baseline (${s.label}): no --baseline-addon-path provided; CI builds the worktree, local runs should pass --skip-baseline or --baseline-addon-path`)
      return false
    }
    return true
  })

  if (runnableSources.length === 0) {
    throw new Error('No runnable sources — candidate must be enabled. Check --skip-baseline isn\'t the only source.')
  }

  const imagePath = path.resolve(SCRIPT_DIR, config.case.image)
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}. Copy seven_objects.jpg into assets/`)
  }

  const resultsDir = path.resolve(SCRIPT_DIR, args['results-dir'] || config.reporting.resultsDir)
  fs.mkdirSync(resultsDir, { recursive: true })

  const cells = []
  let cellIdx = 0
  for (const source of runnableSources) {
    for (const backend of backends) {
      const spec = buildCaseSpec({ source, backend, resolved, imagePath, runArgs })
      try {
        const cell = runOneCell(spec, resultsDir, cellIdx++)
        cells.push(cell)
      } catch (e) {
        log(`cell failed: ${e.message}`)
        cells.push({
          cell: {
            sourceKey: source.key,
            sourceLabel: source.label,
            backend,
            platform: os.platform(),
            arch: os.arch()
          },
          runs: [],
          errors: [{ phase: 'spawn', message: e.message }],
          spec
        })
      }
    }
  }

  const summary = buildSummary(cells)
  const meta = {
    modelId: config.model.id,
    image: config.case.image,
    prompt: config.case.prompt,
    groundTruth: config.case.groundTruth.map((g) => g.canonical),
    groundTruthCount: config.case.groundTruth.length,
    warmupRuns: runArgs.warmupRuns,
    measuredRuns: runArgs.measuredRuns,
    thinkingEnabled: runArgs.thinkingEnabled,
    generatedAt: new Date().toISOString(),
    platformKey,
    backends,
    sources: runnableSources.map((s) => ({ key: s.key, label: s.label, commit: s.commit || null }))
  }
  const written = writeReports({ outputDir: resultsDir, summary, meta })

  log('done.')
  log(`  full matrix: ${written.matrixPath}`)
  log(`  delta:       ${written.deltaPath}`)
  log(`  raw JSON:    ${written.jsonPath}`)
}

main().catch((err) => {
  console.error(`[run-vlm-bench] failed: ${err && err.message ? err.message : String(err)}`)
  process.exit(1)
})
