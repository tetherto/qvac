#!/usr/bin/env node
// One quality table over every host's results, as benchmark-translation-nmtcpp.yml's summary rendered it.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const results = join(PKG, 'benchmarks/results')
if (!existsSync(results)) {
  console.log('No benchmark results to summarize')
  process.exit(0)
}

const args = {
  pairs: 'en-it',
  translators: 'qvac_bergamot',
  datasets: 'flores-devtest',
  metrics: 'chrfpp,comet'
}
for (const word of (process.env.BENCHMARK_ARGS ?? '').split(/\s+/).filter(Boolean)) {
  const [key, value] = word.split('=')
  if (key in args) args[key] = value
}

// The summarizer reads results-<pair>-...-<platform> directories at its top level, as main's artifacts landed.
const staged = mkdtempSync(join(tmpdir(), 'nmt-results-'))
const platforms = new Set()
for (const host of readdirSync(results))
  for (const dir of existsSync(join(results, host)) ? readdirSync(join(results, host)) : [])
    if (dir.startsWith('results-')) {
      symlinkSync(join(results, host, dir), join(staged, dir))
      platforms.add(dir.split('-').slice(-2).join('-'))
    }

const report = join(PKG, 'benchmarks/report')
mkdirSync(report, { recursive: true })
execFileSync(
  'node',
  [
    join(PKG, '../../scripts/perf-report/summarize-nmt-quality.js'),
    '--dir',
    staged,
    '--pairs',
    args.pairs,
    '--translators',
    args.translators,
    '--datasets',
    args.datasets,
    '--metrics',
    args.metrics,
    '--device',
    'cpu',
    '--platforms',
    [...platforms].sort().join(','),
    '--output',
    join(report, 'nmt-benchmark-summary.md'),
    '--output-json',
    join(report, 'nmt-benchmark-summary.json')
  ],
  { stdio: 'inherit' }
)
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    readFileSync(join(report, 'nmt-benchmark-summary.md'))
  )
