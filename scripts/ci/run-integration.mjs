#!/usr/bin/env node
// Runs a package's `npm run test:integration` from its directory, as main's integration-test-nx did, then renders its
// performance reports into the step summary. Used by test:integration targets of packages on the CI contract.
//
//   node ../../scripts/ci/run-integration.mjs [--suffix] [--log] [--env NAME=path]... [--set NAME=value]...
//
// --suffix appends <platform>-<arch>; --log keeps a copy in integration-test.log; --env points NAME at a path inside the
// package unless the environment already sets it; --set sets NAME to a literal.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { constants } from 'node:os'
import { pathToFileURL } from 'node:url'

export function parse(argv, cwd, env) {
  const opts = { suffix: false, log: false, env: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--suffix') opts.suffix = true
    else if (a === '--log') opts.log = true
    else if (a === '--env' || a === '--set') {
      const [name, ...rest] = (argv[++i] ?? '').split('=')
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !rest.length)
        throw new Error(`${a} takes NAME=value, got '${argv[i]}'`)
      const value = rest.join('=')
      if (a === '--set') opts.env[name] = value
      else if (env[name] === undefined) opts.env[name] = resolve(cwd, value)
    } else throw new Error(`unknown argument '${a}'`)
  }
  return opts
}

function run(args, { cwd, env, logFile }) {
  return new Promise((ok) => {
    const child = spawn('npm', args, { cwd, env, shell: process.platform === 'win32' })
    let log = ''
    for (const [from, to] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ]) {
      from.on('data', (d) => {
        if (logFile) log += d
        to.write(d)
      })
    }
    child.on('close', (code, signal) => {
      if (logFile) writeFileSync(logFile, log)
      // A signal reads as 128 + its number, as a shell reports it.
      ok(code ?? 128 + (constants.signals[signal] ?? 0))
    })
  })
}

// The suite's performance reports, named for this host when the suite left the device unnamed so the PR report groups
// them by platform, then into the run's step summary, passing or not.
function renderPerfSummary(cwd) {
  const dir = join(cwd, 'test/results')
  const reports = existsSync(dir)
    ? readdirSync(dir).filter((f) => /^performance-report.*\.json$/.test(f))
    : []
  for (const report of reports) {
    const file = join(dir, report)
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data.device?.name) continue
    data.device = { ...data.device, name: `${process.platform}-${process.arch}` }
    writeFileSync(file, JSON.stringify(data, null, 2))
  }
  if (!process.env.GITHUB_STEP_SUMMARY) return
  const renderer = join(cwd, '../../scripts/perf-report/render-step-summary.js')
  for (const report of reports)
    execFileSync('node', [renderer, join(dir, report), process.env.GITHUB_STEP_SUMMARY], {
      stdio: 'inherit'
    })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwd = process.cwd()
  const opts = parse(process.argv.slice(2), cwd, process.env)
  const args = ['run', 'test:integration']
  if (opts.suffix) args.push(`${process.platform}-${process.arch}`)
  const code = await run(args, {
    cwd,
    env: { ...process.env, ...opts.env },
    logFile: opts.log ? join(cwd, 'integration-test.log') : null
  })
  renderPerfSummary(cwd)
  process.exit(code)
}
