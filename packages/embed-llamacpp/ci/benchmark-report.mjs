#!/usr/bin/env node
// The asked suite's report over every host's and device's results in benchmarks/results, into the step summary and
// benchmarks/report: the latest quality summary or the sweep's unified report.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dispatch } from './benchmark.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const results = join(PKG, 'benchmarks/results')
const report = join(PKG, 'benchmarks/report')
mkdirSync(report, { recursive: true })
const suite = dispatch((process.env.BENCHMARK_ARGS ?? '').split(/\s+/).filter(Boolean))
const summary = (md) =>
  process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, md)
const files = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => join(e.parentPath, e.name))
    : []

if (suite.name === 'quality') {
  const latest = files(results)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  if (latest) summary(readFileSync(latest, 'utf8'))
} else if (suite.name === 'sweep') {
  // The run meta the renderer checks shards against: this addon version and the shards the matrix expects.
  const matrix = (await import(join(PKG, 'test/integration/_benchmark-matrix.js'))).default
  const version = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version
  mkdirSync(join(results, 'benchmark-run-meta'), { recursive: true })
  writeFileSync(
    join(results, 'benchmark-run-meta/run-meta.json'),
    JSON.stringify({
      addonVersion: `@qvac/embed-llamacpp@${version}`,
      expectedShards: matrix.matrix().map(matrix.mobileShardKey)
    }) + '\n'
  )
  execFileSync(
    'node',
    [
      join(PKG, 'benchmarks/performance/render-report.js'),
      '--dir',
      results,
      '--output',
      join(report, 'embed-benchmark-findings.md'),
      '--html',
      join(report, 'embed-benchmark-charts.html'),
      '--charts-url',
      "the run's benchmark-report artifact",
      '--addon-version',
      version
    ],
    { stdio: 'inherit' }
  )
  summary(readFileSync(join(report, 'embed-benchmark-findings.md'), 'utf8'))
}
