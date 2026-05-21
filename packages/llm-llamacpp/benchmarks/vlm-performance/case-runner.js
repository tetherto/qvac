'use strict'

// Bare entrypoint. Loads the addon, runs warmup + measured iterations
// for ONE (source, backend) cell, and writes a per-cell JSON with raw
// per-run metrics. The orchestrator (run-vlm-bench.js) spawns this once
// per cell and aggregates across cells.
//
// Why one-process-per-cell: keeps the addon's internal state (Metal
// shaders, model load, etc.) isolated; matches how the existing
// integration-test perf path is structured.
//
// Inputs come via env (so we can keep the bare CLI surface tiny):
//   VLM_CASE_SPEC_PATH  — JSON file with one CaseSpec (see below)
//   VLM_RESULT_PATH     — where to write the per-cell JSON
//
// CaseSpec = {
//   sourceLabel, sourceKey,           // e.g. 'addon@candidate'
//   addonRequirePath,                 // module spec or absolute path
//   backend,                          // 'cpu' | 'gpu' | 'auto'
//   llmPath, mmprojPath, imagePath,
//   prompt, ctxSize, nPredict, temperature, seed,
//   warmupRuns, measuredRuns, cooldownMs,
//   groundTruth, answerTruncChars
// }

const fs = require('bare-fs')
const path = require('bare-path')
const process = require('bare-process')
const os = require('bare-os')

const { scoreAnswer } = require('./accuracy')
const { parseStdoutMetrics } = require('./stdout-parser')
const { truncate } = require('./utils')

function getEnv (key) {
  if (typeof os.getEnv === 'function') return os.getEnv(key) || ''
  return (typeof process !== 'undefined' && process.env && process.env[key]) || ''
}

function readSpec (specPath) {
  const raw = fs.readFileSync(specPath, 'utf8')
  return JSON.parse(raw)
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function loadAddon (addonRequirePath) {
  // 'local' / 'npm' both go through `require('@qvac/llm-llamacpp')`.
  // The npm tarball ships per-platform prebuilds, so a plain
  // `npm install` in this package's directory drops a working addon
  // into node_modules — no workspace build required. To test a
  // candidate built from the working tree, link the workspace into
  // node_modules (e.g. `npm install ../../`) before running.
  // <path> = absolute/relative path to a separately-built addon tree
  //          (used for baseline-from-commit on the CI path).
  if (!addonRequirePath || addonRequirePath === 'local' || addonRequirePath === 'npm') {
    return require('@qvac/llm-llamacpp')
  }
  return require(addonRequirePath)
}

// Captures everything the addon writes to stdout/stderr during one
// inference. Bare doesn't expose a clean way to swap process.stdout
// the way Node does, so we tee via Console + a side-buffer. The addon
// itself emits the timings we care about via the JS logger we pass in.
function createLogTap () {
  const lines = []
  const logger = {
    error: (...args) => { lines.push(args.map(String).join(' ')); console.error(...args) },
    warn: (...args) => { lines.push(args.map(String).join(' ')); console.warn(...args) },
    info: (...args) => { lines.push(args.map(String).join(' ')); console.log(...args) },
    debug: (...args) => { lines.push(args.map(String).join(' ')); console.debug(...args) }
  }
  return {
    logger,
    text: () => lines.join('\n'),
    clear: () => { lines.length = 0 }
  }
}

async function runOnce ({ inference, imagePath, prompt }) {
  const imageBytes = new Uint8Array(fs.readFileSync(imagePath))
  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', type: 'media', content: imageBytes },
    { role: 'user', content: prompt }
  ]

  const t0 = Date.now()
  const response = await inference.run(messages)
  const generated = []
  let error = null
  response.onUpdate((data) => { generated.push(data) })
    .onError((err) => { error = err })

  await response.await()
  const t1 = Date.now()
  if (error) throw new Error(`Inference error: ${error}`)

  return {
    text: generated.join(''),
    wallMs: t1 - t0,
    stats: response.stats || null
  }
}

async function main () {
  const specPath = getEnv('VLM_CASE_SPEC_PATH')
  const resultPath = getEnv('VLM_RESULT_PATH')
  if (!specPath || !resultPath) {
    console.error('VLM_CASE_SPEC_PATH and VLM_RESULT_PATH env vars are required')
    process.exit(2)
  }
  const spec = readSpec(specPath)

  const Addon = loadAddon(spec.addonRequirePath)
  const tap = createLogTap()
  // reasoning-budget=0 sets `enable_thinking=false` in the jinja chat
  // template inputs, which signals Qwen3/Qwen3.5 templates to skip the
  // <think> opener after the assistant turn. -1 means unrestricted
  // (model decides when to stop thinking). Mirrors the addon's load-time
  // config knob — see packages/llm-llamacpp/CHANGELOG.md.
  const reasoningBudget = spec.thinkingEnabled ? '-1' : '0'
  const inference = new Addon({
    files: { model: [spec.llmPath], projectionModel: spec.mmprojPath },
    config: {
      gpu_layers: spec.backend === 'cpu' ? '0' : '98',
      temp: String(spec.temperature ?? 0),
      seed: String(spec.seed ?? 42),
      verbosity: '2',         // surfaces image-encoded / eval-time lines
      device: spec.backend === 'cpu' ? 'cpu' : 'gpu',
      ctx_size: String(spec.ctxSize),
      n_predict: String(spec.nPredict),
      'reasoning-budget': reasoningBudget
    },
    logger: tap.logger,
    opts: { stats: true }
  })

  const cellStartedAt = new Date().toISOString()
  const errors = []
  let runs = []

  try {
    await inference.load()

    // Emit a marker before each run so the orchestrator can split the
    // captured bare process stdout/stderr per-run. llama.cpp's C++
    // stdio (where `image slice encoded in N ms`, `eval time = ...`,
    // and `load time = ...` are printed) bypasses our JS logger; the
    // orchestrator regex-parses the captured stream and attaches the
    // results to the matching run by index.
    for (let i = 0; i < (spec.warmupRuns || 0); i++) {
      console.log(`[BENCH_RUN_BEGIN warmup ${i}]`)
      tap.clear()
      try {
        await runOnce({ inference, imagePath: spec.imagePath, prompt: spec.prompt })
      } catch (e) {
        errors.push({ phase: 'warmup', index: i, message: String(e && e.message || e) })
      }
      console.log(`[BENCH_RUN_END warmup ${i}]`)
      if (spec.cooldownMs) await sleep(spec.cooldownMs)
    }

    for (let i = 0; i < (spec.measuredRuns || 0); i++) {
      console.log(`[BENCH_RUN_BEGIN measured ${i}]`)
      tap.clear()
      try {
        const r = await runOnce({ inference, imagePath: spec.imagePath, prompt: spec.prompt, thinkingEnabled: spec.thinkingEnabled })
        const stdoutMetricsJs = parseStdoutMetrics(tap.text())
        const accuracy = scoreAnswer(r.text, spec.groundTruth)
        runs.push({
          index: i,
          ok: true,
          wallMs: r.wallMs,
          stats: r.stats,
          stdoutMetricsJs,           // metrics seen via the JS logger (usually empty)
          stdoutMetrics: stdoutMetricsJs, // filled in by orchestrator from captured host stderr
          accuracy,
          fullAnswer: truncate(r.text, spec.answerTruncChars || 8000)
        })
      } catch (e) {
        runs.push({ index: i, ok: false, error: String(e && e.message || e) })
      }
      console.log(`[BENCH_RUN_END measured ${i}]`)
      if (spec.cooldownMs) await sleep(spec.cooldownMs)
    }
  } finally {
    try { await inference.unload() } catch (e) { errors.push({ phase: 'unload', message: String(e && e.message || e) }) }
  }

  const out = {
    cell: {
      sourceKey: spec.sourceKey,
      sourceLabel: spec.sourceLabel,
      backend: spec.backend,
      platform: os.platform(),
      arch: os.arch()
    },
    startedAt: cellStartedAt,
    finishedAt: new Date().toISOString(),
    runs,
    errors,
    spec
  }
  fs.writeFileSync(resultPath, JSON.stringify(out, null, 2))
  console.log(`[case-runner] wrote ${resultPath}`)
}

main().catch((err) => {
  console.error(`[case-runner] fatal: ${err && err.message ? err.message : String(err)}`)
  process.exit(1)
})
