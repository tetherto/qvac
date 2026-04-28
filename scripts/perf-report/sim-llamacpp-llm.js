#!/usr/bin/env node
'use strict'

/**
 * QVAC-17830: local simulator for the llamacpp-llm combined perf
 * report. Generates synthetic per-device performance-report.json
 * files mirroring what desktop matrix legs and Device Farm groups
 * would produce, then runs the real `aggregate.js` against them
 * with the same flags the umbrella workflow uses
 * (`--html-device-details`). Lets us iterate on report shape without
 * waiting for a full CI cycle.
 *
 * Usage:
 *   node scripts/perf-report/sim-llamacpp-llm.js
 *   node scripts/perf-report/sim-llamacpp-llm.js --keep   # don't wipe outputs
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

const repoRoot = execSync('git rev-parse --show-toplevel', {
  encoding: 'utf-8'
}).trim()

const args = process.argv.slice(2)
const keep = args.includes('--keep')

const outRoot = path.join(repoRoot, 'tmp', 'perf-sim-llamacpp-llm')
const reportsDir = path.join(outRoot, 'combined-reports')
const outputDir = path.join(outRoot, 'combined-output')

// PERF_RUNS=3 mirrors the real image tests; bitnet / tool-calling
// each emit a single counted row per cell so the std stays at 0
// until multiple CI runs accumulate.
const PERF_RUNS_IMAGE = 3

function jitter (base, pct) {
  const delta = base * pct
  return base + (Math.random() * 2 - 1) * delta
}

function makeImageRow (testName, ep, backend, platform, baseTotal, baseTtft, baseTps) {
  return {
    test: testName,
    scenario: 'image',
    execution_provider: ep,
    metrics: {
      backend,
      platform,
      total_time_ms: Math.round(jitter(baseTotal, 0.05)),
      prefill_time_ms: Math.round(jitter(baseTtft, 0.08)),
      decode_time_ms: Math.round(jitter(baseTotal - baseTtft, 0.06)),
      vision_encode_time_ms: null,
      ttft_ms: Math.round(jitter(baseTtft, 0.08)),
      generated_tokens: 50,
      prompt_tokens: 1024,
      tps: Number(jitter(baseTps, 0.05).toFixed(2))
    }
  }
}

function makeRow (testName, scenario, ep, backend, platform, baseTotal, baseTtft, baseTps, genTokens, promptTokens) {
  return {
    test: testName,
    scenario,
    execution_provider: ep,
    metrics: {
      backend,
      platform,
      total_time_ms: Math.round(jitter(baseTotal, 0.04)),
      prefill_time_ms: Math.round(jitter(baseTtft, 0.06)),
      decode_time_ms: Math.round(jitter(baseTotal - baseTtft, 0.05)),
      vision_encode_time_ms: null,
      ttft_ms: Math.round(jitter(baseTtft, 0.06)),
      generated_tokens: genTokens,
      prompt_tokens: promptTokens,
      tps: Number(jitter(baseTps, 0.05).toFixed(2))
    }
  }
}

function buildReport (deviceMeta, runNumber, results) {
  return {
    schema_version: '1.0',
    addon: 'llamacpp-llm',
    addon_type: 'vision',
    timestamp: new Date().toISOString(),
    run_id: '99999999',
    run_number: runNumber,
    workflow: 'On PR Trigger (LLM)',
    ref: 'refs/heads/feature-qvac-17830-vlm-perf-metrics',
    sha: 'sim',
    device: deviceMeta,
    results
  }
}

const RUN_NUMBER = 9999

function deviceMeta (name, platform, arch, gpu, runner) {
  return {
    name,
    platform,
    os_version: '',
    arch,
    gpu,
    runner
  }
}

const DEVICES = [
  // Desktop matrix legs.
  {
    folder: 'perf-report-llamacpp-llm-linux-x64',
    meta: deviceMeta('linux-x64', 'linux', 'x64', 'NVIDIA Tesla T4', 'github-actions'),
    backendCpu: 'cpu',
    backendGpu: 'vulkan',
    cpuTotal: 4500,
    gpuTotal: 600,
    cpuTtft: 800,
    gpuTtft: 25,
    cpuTps: 12,
    gpuTps: 65
  },
  {
    folder: 'perf-report-llamacpp-llm-linux-arm64',
    meta: deviceMeta('linux-arm64', 'linux', 'arm64', null, 'github-actions'),
    backendCpu: 'cpu',
    cpuTotal: 6800,
    cpuTtft: 1100,
    cpuTps: 8 // CPU-only (no GPU on linux-arm64)
  },
  {
    folder: 'perf-report-llamacpp-llm-darwin-arm64',
    meta: deviceMeta('darwin-arm64', 'darwin', 'arm64', 'Apple M2 Max', 'github-actions'),
    backendCpu: 'cpu',
    backendGpu: 'metal',
    cpuTotal: 2200,
    gpuTotal: 800,
    cpuTtft: 380,
    gpuTtft: 35,
    cpuTps: 28,
    gpuTps: 55
  },
  {
    folder: 'perf-report-llamacpp-llm-win32-x64',
    meta: deviceMeta('win32-x64', 'win32', 'x64', 'NVIDIA RTX A5000', 'github-actions'),
    backendCpu: 'cpu',
    backendGpu: 'vulkan',
    cpuTotal: 4200,
    gpuTotal: 480,
    cpuTtft: 720,
    gpuTtft: 18,
    cpuTps: 14,
    gpuTps: 75
  },
  // Mobile (Device Farm) — GPU label null, surfaces device name only.
  {
    folder: 'perf-report-llamacpp-llm-android',
    meta: deviceMeta('Samsung Galaxy S24', 'android', 'arm64', null, 'device-farm'),
    backendGpu: 'vulkan',
    gpuTotal: 1800,
    gpuTtft: 90,
    gpuTps: 22
  },
  {
    folder: 'perf-report-llamacpp-llm-ios-iphone-17-pro',
    meta: deviceMeta('iPhone 17 Pro', 'ios', 'arm64', null, 'device-farm'),
    backendGpu: 'metal',
    gpuTotal: 1400,
    gpuTtft: 65,
    gpuTps: 28
  }
]

function buildResultsForDevice (d) {
  const results = []
  const platformLabel = `${d.meta.platform}-${d.meta.arch}`

  // image scenario — per-image x backend, PERF_RUNS_IMAGE iterations each.
  const images = [
    {
      name: 'elephant',
      total: 1,
      ttft: 1,
      tps: 1
    },
    {
      name: 'fruit plate',
      total: 1.4,
      ttft: 1.2,
      tps: 0.85
    },
    {
      name: 'aurora',
      total: 1.6,
      ttft: 1.3,
      tps: 0.9
    }
  ]

  for (const img of images) {
    if (d.cpuTotal != null) {
      for (let i = 0; i < PERF_RUNS_IMAGE; i++) {
        results.push(makeImageRow(
          `[${img.name}] [CPU]`, 'cpu', d.backendCpu, platformLabel,
          d.cpuTotal * img.total, d.cpuTtft * img.ttft, d.cpuTps * img.tps
        ))
      }
    }
    if (d.gpuTotal != null) {
      for (let i = 0; i < PERF_RUNS_IMAGE; i++) {
        results.push(makeImageRow(
          `[${img.name}] [GPU]`, 'gpu', d.backendGpu, platformLabel,
          d.gpuTotal * img.total, d.gpuTtft * img.ttft, d.gpuTps * img.tps
        ))
      }
    }
  }

  // bitnet scenario — Android-only single counted row in real life;
  // sim it on every device with a GPU path so the squashed summary
  // shows multi-device coverage.
  if (d.gpuTotal != null && d.meta.platform !== 'ios') {
    results.push(makeRow(
      '[bitnet] [GPU]', 'bitnet', 'gpu', d.backendGpu, platformLabel,
      d.gpuTotal * 0.4, d.gpuTtft * 0.5, d.gpuTps * 1.1, 32, 24
    ))
  }

  // tool-calling scenario — desktop/Android excluding macOS-x64 and iOS;
  // emit two rows per model variant (cold prompt + warm follow-up).
  if (d.meta.platform !== 'darwin' || d.meta.arch !== 'x64') {
    if (d.meta.platform !== 'ios') {
      const ep = d.gpuTotal != null ? 'gpu' : 'cpu'
      const tag = ep.toUpperCase()
      const backend = ep === 'gpu' ? d.backendGpu : d.backendCpu
      const total = ep === 'gpu' ? d.gpuTotal : d.cpuTotal
      const ttft = ep === 'gpu' ? d.gpuTtft : d.cpuTtft
      const tps = ep === 'gpu' ? d.gpuTps : d.cpuTps

      results.push(makeRow(
        `[tools batch] [qwen3-1.7b] [${tag}]`, 'tool-calling', ep, backend, platformLabel,
        total * 4, ttft * 2.5, tps * 0.95, 256, 1100
      ))
      results.push(makeRow(
        `[tools followup] [qwen3-1.7b] [${tag}]`, 'tool-calling', ep, backend, platformLabel,
        total * 1.8, ttft * 0.6, tps * 1.05, 80, 1280
      ))

      // Desktop also runs medgemma-4b-it.
      if (d.meta.platform !== 'android') {
        results.push(makeRow(
          `[tools batch] [medgemma-4b-it] [${tag}]`, 'tool-calling', ep, backend, platformLabel,
          total * 6.5, ttft * 3.5, tps * 0.9, 256, 1100
        ))
        results.push(makeRow(
          `[tools followup] [medgemma-4b-it] [${tag}]`, 'tool-calling', ep, backend, platformLabel,
          total * 2.5, ttft * 0.75, tps * 1.0, 80, 1280
        ))
      }
    }
  }

  return results
}

if (!keep) {
  fs.rmSync(outRoot, { recursive: true, force: true })
}
fs.mkdirSync(reportsDir, { recursive: true })
fs.mkdirSync(outputDir, { recursive: true })

for (const d of DEVICES) {
  const dir = path.join(reportsDir, d.folder)
  fs.mkdirSync(dir, { recursive: true })
  const reportPath = path.join(dir, 'performance-report.json')
  const report = buildReport(d.meta, RUN_NUMBER, buildResultsForDevice(d))
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(`wrote ${reportPath} (${report.results.length} rows, gpu=${d.meta.gpu || 'null'})`)
}

console.log()
console.log('Running aggregate.js (matching umbrella workflow flags)...')
const aggBin = path.join(repoRoot, 'scripts', 'perf-report', 'aggregate.js')
execSync([
  'node', aggBin,
  '--dir', reportsDir,
  '--addon-type', 'vision',
  '--device-details',
  '--output-html', path.join(outputDir, 'performance-report-combined.html'),
  '--output-json', path.join(outputDir, 'performance-summary-combined.json'),
  '--output', path.join(outputDir, 'performance-report-combined.md')
].map(a => `'${a}'`).join(' '), { stdio: 'inherit' })

console.log()
console.log('--- combined markdown (what would go to GITHUB_STEP_SUMMARY) ---')
console.log()
console.log(fs.readFileSync(path.join(outputDir, 'performance-report-combined.md'), 'utf-8'))

console.log()
console.log(`HTML artifact: ${path.join(outputDir, 'performance-report-combined.html')}`)
console.log(`JSON summary : ${path.join(outputDir, 'performance-summary-combined.json')}`)
