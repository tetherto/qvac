#!/usr/bin/env node
// sdk-python's targets, each in the package's .venv, created once from the host's Python 3.10 or newer.
//   python.mjs generated | format | lint | typecheck | unit     main's pr-checks-sdk-python.yml steps
//   python.mjs e2e                                             the suite CI_SUITE names: fast, full or wheel
// fast and full are main's real-worker legs; wheel builds the fat wheel for --platform <tag> and tests it installed.

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

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

const SOURCES = ['src/tetherto/qvac_sdk', 'scripts/', 'tests/']
const step = process.argv[2]
if (['generated', 'format', 'lint', 'typecheck', 'unit'].includes(step)) {
  const py = venv('.venv', 'gen,dev')
  if (step === 'generated') run(py, ['scripts/generate.py', '--check'])
  if (step === 'format') run(py, ['-m', 'black', '--check', ...SOURCES])
  if (step === 'lint') run(py, ['-m', 'ruff', 'check', ...SOURCES])
  if (step === 'typecheck') {
    run(py, ['-m', 'mypy', '-p', 'tetherto.qvac_sdk'])
    run(py, ['-m', 'mypy', 'scripts'])
    run(py, ['-m', 'mypy', 'tests'])
  }
  // Mocked unit tests and transport tests; real-worker tests skip themselves with no worker built.
  if (step === 'unit') run(py, ['-m', 'pytest', 'tests/', '-v'])
} else if (step === 'e2e') {
  const suite = process.env.CI_SUITE
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: { platform: { type: 'string' } }
  })
  // The worker keeps its models here, as main's full and wheel legs pointed it.
  const cache = join(process.env.GITHUB_WORKSPACE ?? pkg, '.qvac-cache')
  mkdirSync(cache, { recursive: true })
  const env = { QVAC_CACHE_DIR: cache }
  if (suite === 'fast' || suite === 'full') {
    const py = venv('.venv', 'gen,dev,vla,notebook')
    run(py, ['scripts/build_worker.py'])
    // fast: the CLI-set minimal models; the heavy parakeet and BCI streaming tests run in full.
    if (suite === 'fast') run(py, ['-m', 'pytest', '-m', 'not heavy', 'tests/', '-v'])
    else run(py, ['-m', 'pytest', 'tests/', '-v'], env)
  } else if (suite === 'wheel') {
    if (!values.platform) throw new Error('the wheel suite needs --platform <wheel platform tag>')
    const py = venv('.venv')
    run(py, ['-m', 'pip', 'install', '--upgrade', 'pip', 'build'])
    run(py, ['scripts/build_worker.py'])
    run(py, ['scripts/build_wheel.py', '--out-dir', 'dist', '--platform', values.platform])
    const test = venv('.venv-wheel')
    const wheel = readdirSync(join(pkg, 'dist')).find((f) => f.endsWith('.whl'))
    console.log(`installing dist/${wheel}`)
    run(test, ['-m', 'pip', 'install', `dist/${wheel}[gen,dev,vla,notebook]`])
    // The bundle under test is the installed wheel's, not the source tree's.
    run(test, [
      '-c',
      'import sys; sys.path.insert(0, "tests"); import _worker_env as w, tetherto.qvac_sdk as pkg; assert "site-packages" in pkg.__file__, pkg.__file__; assert "_bundle" in w.WORKER_PATH and "_bundle" in w.BARE_BIN, (w.WORKER_PATH, w.BARE_BIN); assert w.WORKER_AVAILABLE; print("OK bundle under test:", w.WORKER_PATH)'
    ])
    run(test, ['-m', 'pytest', 'tests/', '-o', 'pythonpath=tests', '-v'], env)
  } else throw new Error(`CI_SUITE must be fast, full or wheel, got '${suite ?? ''}'`)
} else throw new Error('usage: python.mjs generated | format | lint | typecheck | unit | e2e')
