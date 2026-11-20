#!/usr/bin/env node
// sdk-kotlin's PR checks, against this commit's @qvac/sdk and @qvac/inference, on every change that reaches this
// package. typecheck generates the client and compiles it for the JVM. unit runs the generator and wire-literal checks,
// the release gate test and the JVM unit tests. Generating exports the SDK contract, which needs the SDK installed and
// @qvac/inference built.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { prepareSdk } from '../../sdk/ci/clients.mjs'

const kotlin = fileURLToPath(new URL('..', import.meta.url))
const run = (cmd, args) => execFileSync(cmd, args, { cwd: kotlin, stdio: 'inherit' })
const gradle = (tasks) => run('./gradlew', ['--no-daemon', '--configuration-cache', ...tasks])

const step = process.argv[2]
if (step === 'typecheck') {
  prepareSdk()
  run('node', ['scripts/check-version-alignment.mjs'])
  gradle(['compileKotlinJvm'])
} else if (step === 'unit') {
  prepareSdk()
  gradle(['testContractGenerator', 'checkWireLiterals', 'testReleaseGate', 'jvmTest'])
} else throw new Error('usage: checks.mjs typecheck | unit')
