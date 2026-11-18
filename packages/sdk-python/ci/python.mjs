#!/usr/bin/env node
// sdk-python's PR checks in one .venv from the host's Python 3.10 or newer: typecheck and unit generate the client and
// check it on every change that reaches this package, and format and lint run only when a pull request changed
// packages/sdk-python. Generating exports the SDK contract, which needs the SDK installed and @qvac/inference built.
// The e2e runs the shared catalog through packages/sdk/ci/e2e.mjs.

import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownChanged, prepareSdk } from '../../sdk/ci/clients.mjs'

const pkg = fileURLToPath(new URL('..', import.meta.url))
const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { cwd: pkg, stdio: 'inherit', env: { ...process.env, ...env } })
const host = () => {
  for (const py of ['python3', 'python']) {
    try {
      execFileSync(py, ['-c', 'import sys; assert sys.version_info[:2] >= (3, 10)'], {
        stdio: 'ignore'
      })
      return py
    } catch {}
  }
  throw new Error('need Python 3.10 or newer on PATH')
}
// Windows puts the interpreter under Scripts, every other platform under bin.
const bin = (venv) =>
  [join(pkg, venv, 'bin', 'python'), join(pkg, venv, 'Scripts', 'python.exe')].find(existsSync)

function venv(name, extras) {
  if (!bin(name)) {
    run(host(), ['-m', 'venv', name])
    run(bin(name), ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'])
  }
  if (extras) run(bin(name), ['-m', 'pip', 'install', '--quiet', '-e', `.[${extras}]`])
  return bin(name)
}

const SOURCES = ['src/tetherto/qvac_sdk', 'scripts/', 'tests/', 'examples/']
const step = process.argv[2]
if (['format', 'lint', 'typecheck', 'unit'].includes(step)) {
  if ((step === 'format' || step === 'lint') && !ownChanged('packages/sdk-python')) {
    console.log(`::notice::packages/sdk-python is unchanged in this pull request; skipping ${step}`)
    process.exit(0)
  }
  const py = venv('.venv', 'gen,dev')
  if (step === 'typecheck' || step === 'unit') {
    prepareSdk()
    run(py, ['scripts/generate.py'])
  }
  if (step === 'format') run(py, ['-m', 'black', '--check', ...SOURCES])
  if (step === 'lint') run(py, ['-m', 'ruff', 'check', ...SOURCES])
  if (step === 'typecheck') {
    run(py, ['-m', 'mypy', '-p', 'tetherto.qvac_sdk'])
    run(py, ['-m', 'mypy', 'scripts'])
    run(py, ['-m', 'mypy', 'tests'])
    // mypy cannot follow the package's star re-exports, so names imported from tetherto.qvac_sdk are untyped here.
    run(py, ['-m', 'mypy', 'examples', '--disable-error-code', 'attr-defined'])
  }
  // Mocked unit tests and transport tests; real-worker tests skip themselves with no worker built.
  if (step === 'unit') run(py, ['-m', 'pytest', 'tests/', '-v'])
} else throw new Error('usage: python.mjs format | lint | typecheck | unit')
