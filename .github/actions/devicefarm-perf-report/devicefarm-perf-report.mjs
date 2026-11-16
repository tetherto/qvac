#!/usr/bin/env node
// Builds a package's perf report from Device Farm logs with the repo's perf-report scripts.

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The scripts come from the same checkout as this action, not the package under test.
const SCRIPTS = fileURLToPath(new URL('../../../scripts/perf-report/', import.meta.url))

export function extractArgs({ logDir, outDir, runNumber, filter, merge }) {
  return [
    join(SCRIPTS, 'extract-from-log.js'),
    logDir,
    join(outDir, 'performance-report.json'),
    '--run-number',
    runNumber,
    ...(filter ? ['--filter', filter] : []),
    ...(merge ? ['--merge'] : [])
  ]
}

// One report, or one per device directory; a title ending in ")" takes the device inside it.
export function reports(outDir, title) {
  if (existsSync(join(outDir, 'performance-report.json')))
    return [[join(outDir, 'performance-report.json'), title]]
  return readdirSync(outDir)
    .filter(
      (d) =>
        statSync(join(outDir, d)).isDirectory() &&
        existsSync(join(outDir, d, 'performance-report.json'))
    )
    .map((d) => {
      const dev = basename(d).replace(/_/g, ' ')
      return [
        join(outDir, d, 'performance-report.json'),
        title.endsWith(')') ? `${title.slice(0, -1)} · ${dev})` : `${title} · ${dev}`
      ]
    })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  mkdirSync(env.OUT_DIR, { recursive: true })
  const node = (args) => {
    try {
      execFileSync('node', args, { stdio: 'inherit' })
    } catch {
      console.log(`::warning::${basename(args[0])} failed`)
    }
  }
  if (existsSync(env.LOG_DIR))
    node(
      extractArgs({
        logDir: env.LOG_DIR,
        outDir: env.OUT_DIR,
        runNumber: env.GITHUB_RUN_NUMBER,
        filter: env.FILTER,
        merge: env.MERGE === 'true'
      })
    )
  const found = readdirSync(env.OUT_DIR, { recursive: true }).some(
    (f) =>
      String(f).endsWith('performance-report.json') &&
      statSync(join(env.OUT_DIR, String(f))).size > 0
  )
  if (found) {
    node([
      join(SCRIPTS, 'aggregate.js'),
      '--dir',
      env.OUT_DIR,
      '--output-html',
      join(env.OUT_DIR, 'performance-report.html'),
      '--output-json',
      join(env.OUT_DIR, 'performance-summary.json'),
      '--output',
      join(env.OUT_DIR, 'performance-report.md')
    ])
    if (env.TITLE)
      for (const [report, title] of reports(env.OUT_DIR, env.TITLE))
        node([
          join(SCRIPTS, 'render-step-summary.js'),
          report,
          env.GITHUB_STEP_SUMMARY,
          '--title',
          title
        ])
  } else console.log(`::warning::no performance report in ${env.LOG_DIR}`)
  appendFileSync(env.GITHUB_OUTPUT, `extracted=${found}\n`)
}
