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
const { buildSummary, writeReports } = require('./reporters')
const { parseStdoutMetrics } = require('./stdout-parser')
const { detectAll, hasUsableGpu } = require('./hardware')

// Software provenance: what version of @qvac/llm-llamacpp was loaded,
// where its prebuild lives on disk, which bare CLI we spawned, plus
// git info for this checkout. All of it gets stamped into the per-
// platform JSON so the consolidated report can render an exact
// "what produced this row" footprint.
function safeExecStr (cmd, args) {
  try { return require('child_process').execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null }
}

function safeReadJson (filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { return null }
}

function detectAddonProvenance () {
  // Look at the npm-installed addon in our package's node_modules.
  const pkgPath = path.join(SCRIPT_DIR, 'node_modules', '@qvac', 'llm-llamacpp', 'package.json')
  const pkg = safeReadJson(pkgPath)
  if (!pkg) return null
  const addonRoot = path.dirname(pkgPath)
  // Find the platform-matching prebuild binary actually used by the
  // addon. Naming: prebuilds/<platform>-<arch>/qvac__llm-llamacpp.bare
  const prebuildDir = path.join(addonRoot, 'prebuilds', `${process.platform}-${process.arch}`)
  let prebuildFile = null
  let prebuildSize = null
  if (fs.existsSync(prebuildDir)) {
    for (const f of fs.readdirSync(prebuildDir)) {
      if (f.endsWith('.bare') || f.endsWith('.node')) {
        const full = path.join(prebuildDir, f)
        try {
          const s = fs.statSync(full)
          if (!prebuildSize || s.size > prebuildSize) {
            prebuildFile = full
            prebuildSize = s.size
          }
        } catch {}
      }
    }
  }
  return {
    name: pkg.name,
    version: pkg.version,
    installedAt: addonRoot,
    prebuildFile,
    prebuildSizeMb: prebuildSize ? Math.round((prebuildSize / (1024 * 1024)) * 100) / 100 : null
  }
}

function detectBareProvenance () {
  // Prefer the version of the local bare we invoke (set up in
  // resolveLocalBare); fall back to a global bare on PATH.
  const localBareBin = path.join(SCRIPT_DIR, 'node_modules', 'bare', 'bin', 'bare')
  if (fs.existsSync(localBareBin)) {
    const ver = safeExecStr(process.execPath, [localBareBin, '--version'])
    return { source: 'local', binary: localBareBin, version: ver }
  }
  const ver = safeExecStr('bare', ['--version'])
  return { source: 'global', binary: 'bare', version: ver }
}

function detectGitProvenance () {
  // Best-effort — the script may run from a worktree without git, or
  // from a sparse-checkout. Any field can come back null.
  const sha = safeExecStr('git', ['-C', SCRIPT_DIR, 'rev-parse', 'HEAD'])
  if (!sha) return null
  return {
    sha,
    shortSha: sha.slice(0, 8),
    branch: safeExecStr('git', ['-C', SCRIPT_DIR, 'rev-parse', '--abbrev-ref', 'HEAD']),
    title: safeExecStr('git', ['-C', SCRIPT_DIR, 'log', '-1', '--pretty=%s']),
    date: safeExecStr('git', ['-C', SCRIPT_DIR, 'log', '-1', '--pretty=%cI'])
  }
}

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

function pickBackends (args, platformKey, hardwareInfo) {
  const fromCli = csvOrArray(args.backends || args.backend)
  let backends
  if (fromCli.length) {
    backends = fromCli
  } else {
    const platform = config.platforms[platformKey]
    backends = platform && Array.isArray(platform.backends) ? platform.backends.slice() : ['gpu']
  }
  // Drop the 'gpu' row when the runner clearly has no real GPU
  // (CI runners that don't expose dedicated hardware). The addon would
  // silently fall back to CPU and produce a row that's identical to
  // the 'cpu' row, which is misleading. Override with --force-gpu-row
  // when you specifically want to surface that fallback behaviour.
  if (!args['force-gpu-row'] && !hasUsableGpu(hardwareInfo)) {
    backends = backends.filter((b) => b !== 'gpu')
  }
  return backends
}

function ensureModelsResolved (args, compareBaseline) {
  // Re-run prepare-models when (a) no resolved-models.json exists,
  // (b) --force-prepare is set, or (c) compare-baseline is on but the
  // existing resolution didn't include a baseline.
  let cached = null
  if (fs.existsSync(RESOLVED_MODELS_PATH)) {
    try { cached = JSON.parse(fs.readFileSync(RESOLVED_MODELS_PATH, 'utf8')) } catch {}
  }
  const needsRerun = !cached || args['force-prepare'] || (compareBaseline && !cached.baseline)
  if (!needsRerun) return cached

  log('running prepare-models.js' + (compareBaseline ? ' (with --compare-baseline)' : ''))
  const passThrough = []
  if (compareBaseline) passThrough.push('--compare-baseline')
  if (args['local-candidate-model']) passThrough.push('--local-candidate-model', args['local-candidate-model'])
  if (args['local-candidate-mmproj']) passThrough.push('--local-candidate-mmproj', args['local-candidate-mmproj'])
  if (args['local-baseline-model']) passThrough.push('--local-baseline-model', args['local-baseline-model'])
  if (args['local-baseline-mmproj']) passThrough.push('--local-baseline-mmproj', args['local-baseline-mmproj'])
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

function buildCaseSpec ({ source, backend, modelSrc, imagePath, runArgs }) {
  return {
    sourceKey: source.key,                       // 'candidate' or 'baseline'
    sourceLabel: source.label,                   // 'model@hf' / 'model@registry'
    addonRequirePath: source.addonPath || 'local',
    backend,
    llmPath: modelSrc.llmPath,
    mmprojPath: modelSrc.mmprojPath,
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

  const compareBaseline = Boolean(args['compare-baseline'])
  const resolved = ensureModelsResolved(args, compareBaseline)
  const platformKey = detectPlatformKey()
  const hardwareInfo = detectAll()
  log(`hardware: cpu="${hardwareInfo.cpu.model}" cores=${hardwareInfo.cpu.cores} ram=${hardwareInfo.ram.totalGb}GB gpus=${hardwareInfo.gpus.length}`)
  for (const g of hardwareInfo.gpus) log(`  GPU: ${g.vendor || ''} ${g.model || '?'} ${g.memoryMb ? `(${g.memoryMb}MB)` : ''}`)
  const backends = pickBackends(args, platformKey, hardwareInfo)
  if (backends.length === 0) {
    throw new Error('No backends resolved for this host (--force-gpu-row may help if you specifically want to surface the GPU-fallback-to-CPU case).')
  }
  log(`backends to run: ${backends.join(', ')}`)

  // Model sources: candidate is always run; baseline is only run when
  // --compare-baseline was passed AND prepare-models successfully
  // resolved it.
  const modelSources = [
    { key: 'candidate', label: `model@${resolved.candidate.label}`, model: resolved.candidate }
  ]
  if (compareBaseline) {
    if (resolved.baseline) {
      modelSources.push({ key: 'baseline', label: `model@${resolved.baseline.label}`, model: resolved.baseline })
    } else {
      log('--compare-baseline was set but no baseline was resolved; candidate-only run')
    }
  }
  log(`model sources: ${modelSources.map((s) => s.label).join(', ')}`)

  // Addon source is uniform — we always use the npm-installed
  // @qvac/llm-llamacpp. The candidate vs baseline split now happens
  // along the *model* axis.
  const addonSource = { key: 'addon', label: 'addon@npm', addonPath: null }

  const imagePath = path.resolve(SCRIPT_DIR, config.case.image)
  if (!fs.existsSync(imagePath)) {
    throw new Error(`Image not found: ${imagePath}. Copy seven_objects.jpg into assets/`)
  }

  const resultsDir = path.resolve(SCRIPT_DIR, args['results-dir'] || config.reporting.resultsDir)
  fs.mkdirSync(resultsDir, { recursive: true })

  // For each backend × model-source pair, spawn one bare case-runner.
  const cells = []
  let cellIdx = 0
  for (const modelSrc of modelSources) {
    for (const backend of backends) {
      const source = { ...addonSource, key: modelSrc.key, label: modelSrc.label }
      const spec = buildCaseSpec({ source, backend, modelSrc: modelSrc.model, imagePath, runArgs })
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
    hardware: hardwareInfo,
    modelSources: modelSources.map((s) => ({
      key: s.key,
      label: s.label,
      quant: s.model.quant || null,
      hfRepo: s.model.hfRepo || null,
      hfRevision: s.model.hfRevision || null,
      provenance: s.model.provenance || null
    })),
    software: {
      addon: detectAddonProvenance(),
      bare: detectBareProvenance(),
      git: detectGitProvenance(),
      node: process.version
    }
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
