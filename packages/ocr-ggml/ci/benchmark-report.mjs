#!/usr/bin/env node
// One summary over every host's evaluation results in benchmarks/results, into the step summary and benchmarks/report.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { options } from './benchmark.mjs'

const PKG = fileURLToPath(new URL('..', import.meta.url))
const results = join(PKG, 'benchmarks/results')
if (!existsSync(results)) {
  console.log('No benchmark results to summarize')
  process.exit(0)
}
const o = options((process.env.BENCHMARK_ARGS ?? '').split(/\s+/).filter(Boolean), [])
// render_summary names each host after its directory; the run uploads ocr-ggml-benchmark-<configuration>.
const PREFIX = 'ocr-ggml-benchmark-'
const hosts = mkdtempSync(join(tmpdir(), 'ocr-hosts-'))
for (const dir of readdirSync(results).filter((d) => d.startsWith(PREFIX)))
  symlinkSync(join(results, dir), join(hosts, dir.slice(PREFIX.length)))
const summary = execFileSync(
  'python3',
  [
    join(PKG, 'benchmarks/quality_eval/render_summary.py'),
    '--results',
    hosts,
    '--pipeline',
    o.pipeline,
    '--tasks',
    o.tasks.join(','),
    '--limit',
    o.limit
  ],
  { encoding: 'utf8' }
)
mkdirSync(join(PKG, 'benchmarks/report'), { recursive: true })
writeFileSync(join(PKG, 'benchmarks/report/summary.md'), summary)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
