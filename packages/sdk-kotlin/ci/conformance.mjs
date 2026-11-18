#!/usr/bin/env node
// sdk-kotlin's linux-x64-conformance: the shared cross-client corpus against the bare-stow worker, as main ran it; the
// reports land in jvm-barekit/build/reports/tests/test.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const kotlin = fileURLToPath(new URL('..', import.meta.url))
const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { cwd: kotlin, stdio: 'inherit', env: { ...process.env, ...env } })

// As main: this commit's @qvac/sdk and @qvac/inference in place of the registry's, since a release PR pins an @qvac/sdk
// that is not on npm yet, and Gradle skips the SDK build the script already did. The pin swap is for this run only.
process.on('exit', () => execFileSync('git', ['checkout', '--', 'package.json'], { cwd: kotlin }))
run('./scripts/install-workspace-sdk.sh', [])
run(
  './gradlew',
  [
    '--no-daemon',
    ':jvm-barekit:test',
    '--tests',
    '*WorkerConformanceTest',
    '--rerun-tasks',
    '-x',
    ':android-barekit:buildWorkspaceSdk'
  ],
  { QVAC_RUN_CONFORMANCE: '1' }
)
