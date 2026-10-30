#!/usr/bin/env node
// sdk-kotlin's linux-x64-conformance: the shared cross-client corpus against the workspace worker Python builds, as
// main's on-pr-sdk-kotlin-e2e.yml ran it; the reports land in build/reports/tests/jvmTest.

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const kotlin = fileURLToPath(new URL('..', import.meta.url))
const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { cwd: kotlin, stdio: 'inherit', env: { ...process.env, ...env } })

run('python3', ['../sdk-python/scripts/build_worker.py', '--force'])
run('./gradlew', ['--no-daemon', 'jvmTest', '--tests', '*WorkerConformanceTest', '--rerun-tasks'], {
  QVAC_RUN_CONFORMANCE: '1'
})
