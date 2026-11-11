#!/usr/bin/env node
// sdk-kotlin's linux-x64-conformance: the shared cross-client corpus against the bare-stow worker, as main ran it; the
// reports land in jvm-barekit/build/reports/tests/test.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const kotlin = fileURLToPath(new URL('..', import.meta.url))
const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { cwd: kotlin, stdio: 'inherit', env: { ...process.env, ...env } })

run('./gradlew', ['--no-daemon', ':jvm-barekit:test', '--tests', '*WorkerConformanceTest', '--rerun-tasks'], {
  QVAC_RUN_CONFORMANCE: '1'
})
