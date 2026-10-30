#!/usr/bin/env node
// asr's benchmark report over every result benchmarks.yml downloaded into benchmarks/results: the RTF report across
// desktop, mobile and the checked-in manual rows, and the accuracy summary of a suite=accuracy run.

import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dispatch } from './benchmark.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const RESULTS = join(PKG, 'benchmarks/results')
const REPORT = join(PKG, 'benchmarks/report')
const ACCURACY = join(RESULTS, 'asr-ggml-benchmark-linux-x64-accuracy')
const sh = (cmd, args, cwd = PKG) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
const summary = (file) => {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, readFileSync(file))
}

mkdirSync(REPORT, { recursive: true })
const d = dispatch((process.env.BENCHMARK_ARGS ?? '').split(/\s+/).filter(Boolean))
if (d.suite === 'rtf') {
  const md = join(REPORT, 'asr-ggml-performance-findings.md')
  sh('node', [
    '../../scripts/perf-report/aggregate-asr-ggml-rtf.js',
    '--dir',
    RESULTS,
    '--manual-dir',
    join(PKG, 'benchmarks/manual-results'),
    '--output',
    md,
    '--output-json',
    join(REPORT, 'asr-ggml-performance-findings.json')
  ])
  summary(md)
} else if (existsSync(ACCURACY)) {
  // The client's summary reads benchmarks/results/<model>/, as main's merged download laid it out.
  for (const dir of readdirSync(ACCURACY))
    cpSync(join(ACCURACY, dir), join(RESULTS, dir), { recursive: true })
  const client = join(PKG, 'benchmarks/client')
  execFileSync(
    'bash',
    [
      '-c',
      'command -v poetry > /dev/null || curl -sSL https://install.python-poetry.org | python3 -'
    ],
    { stdio: 'inherit' }
  )
  process.env.PATH = `${process.env.HOME}/.local/bin:${process.env.PATH}`
  sh('poetry', ['install', '--no-cache'], client)
  sh(
    'poetry',
    [
      'run',
      'python',
      '-c',
      `from src.${d.engine === 'parakeet' ? 'parakeet' : 'whisper'}.utils import generate_summary; generate_summary()`
    ],
    client
  )
  cpSync(join(RESULTS, 'results_summary.md'), join(REPORT, 'results_summary.md'))
  summary(join(RESULTS, 'results_summary.md'))
} else {
  console.log('No accuracy results to summarize')
}
