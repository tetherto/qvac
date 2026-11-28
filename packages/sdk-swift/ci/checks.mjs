#!/usr/bin/env node
// sdk-swift's PR checks on macOS, against this commit's @qvac/sdk and @qvac/inference, on every change that reaches this
// package. typecheck generates the client, builds the package, and builds the iOS example for the simulator with a worker
// bundled from this checkout. unit runs the client's unit tests against a fake worker. Generating exports the SDK contract,
// which needs the SDK installed and @qvac/inference built; bundling the example's worker also needs the SDK built.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSdk } from '../../sdk/ci/clients.mjs'

const swift = fileURLToPath(new URL('..', import.meta.url))
const sdk = join(swift, '..', 'sdk')
const run = (cmd, args, cwd = swift) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
const simulatorArch = process.arch === 'arm64' ? 'arm64' : 'x86_64'

function generate() {
  prepareSdk()
  run('python3', ['scripts/generate.py'])
}

// The simulator's platform packages the bundle installs go into packages/sdk's package.json, which this run restores.
function bundleExampleWorker() {
  const manifest = join(sdk, 'package.json')
  const original = readFileSync(manifest, 'utf8')
  const host = `ios-${process.arch === 'arm64' ? 'arm64' : 'x64'}-simulator`
  try {
    run('node', ['scripts/prepare-worker.mjs', 'ios-example', host, '--install-missing-prebuilds'])
  } finally {
    writeFileSync(manifest, original)
  }
}

const step = process.argv[2]
if (step === 'typecheck') {
  generate()
  run('swift', ['build'])
  if (process.env.CI) {
    run(join(sdk, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json'], sdk)
    run('npm', ['run', 'postcompile:aliases'], sdk)
  }
  bundleExampleWorker()
  run('xcodebuild', [
    '-project',
    'ios-example/QvacExample.xcodeproj',
    '-scheme',
    'QvacExample',
    '-destination',
    'generic/platform=iOS Simulator',
    '-derivedDataPath',
    'ios-example/build',
    '-quiet',
    'build',
    `ARCHS=${simulatorArch}`,
    'CODE_SIGNING_ALLOWED=NO'
  ])
} else if (step === 'unit') {
  generate()
  run('swift', ['test'])
} else throw new Error('usage: checks.mjs typecheck | unit')
