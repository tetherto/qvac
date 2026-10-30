#!/usr/bin/env node
// cli's benchmark, main's serve OpenAI provider comparison: `live` sweeps (BENCHMARK_ARGS smoke or full) on the
// benchmark-live Mac, whose runner-local config and manifest BENCHMARK_CONFIG_PATH and BENCHMARK_ENVIRONMENT_PATH name;
// `report` writes the provider-free coverage preview. Both install the CLI with npm, as main did.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { isAbsolute, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('..', import.meta.url))
const bench = join(cli, 'benchmarks', 'serve-openai-providers')
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })

// The run tests the exact commit it was dispatched for: a full SHA, and the checkout at it.
const sha = (process.env.GITHUB_SHA ?? '').toLowerCase()
if (process.env.GITHUB_ACTIONS) {
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('GITHUB_SHA must be a full 40-character commit SHA')
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: cli, encoding: 'utf8' }).trim()
  if (head !== sha) throw new Error(`checked out SHA ${head} does not match the run's ${sha}`)
}

// Runner-local files only: a protected environment variable naming an absolute path outside the workspace.
function external(name) {
  const value = process.env[name] ?? ''
  if (!value) {
    throw new Error(`${name} is unset. Define it as a benchmark-live environment variable.`)
  }
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`)
  if (/[\r\n]/.test(value)) throw new Error(`${name} must not contain line breaks.`)
  if (!existsSync(value) || !statSync(value).isFile()) {
    throw new Error(`${name} is missing or unreadable.`)
  }
  const resolved = realpathSync(value)
  const workspace = realpathSync(process.env.GITHUB_WORKSPACE ?? cli)
  if (resolved === workspace || resolved.startsWith(workspace + sep)) {
    throw new Error(`${name} resolves inside GITHUB_WORKSPACE.`)
  }
  return resolved
}

const mode = process.argv[2]
rmSync(join(cli, 'node_modules'), { recursive: true, force: true })
if (mode === 'live') {
  const args = (process.env.BENCHMARK_ARGS ?? '').trim()
  if (!['smoke', 'full'].includes(args)) {
    throw new Error(`BENCHMARK_ARGS must be smoke or full for the live sweep, got '${args}'`)
  }
  const config = external('BENCHMARK_CONFIG_PATH')
  const environment = external('BENCHMARK_ENVIRONMENT_PATH')
  run('npm', ['install', '--include=dev', '--no-fund', '--no-audit', '--ignore-scripts'], cli)
  try {
    run('npx', ['tsx', 'benchmark.ts', args, '--config', config], bench)
  } finally {
    // As main uploaded them: a full sweep's results with the environment manifest, under the contract's results dir.
    if (args === 'full') {
      mkdirSync(join(bench, 'results'), { recursive: true })
      copyFileSync(environment, join(bench, 'results', 'environment.md'))
      cpSync(join(bench, 'results'), join(cli, 'benchmarks', 'results'), { recursive: true })
    }
  }
} else if (mode === 'report') {
  run('npm', ['install', '--include=dev', '--no-fund', '--no-audit', '--ignore-scripts'], cli)
  run(
    'npx',
    [
      'tsx',
      'benchmarks/serve-openai-providers/coverage-preview.ts',
      '--out-dir',
      'benchmarks/report'
    ],
    cli
  )
} else throw new Error('usage: benchmark.mjs live | report')
