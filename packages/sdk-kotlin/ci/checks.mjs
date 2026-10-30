#!/usr/bin/env node
// sdk-kotlin's test:unit, main's Kotlin PR checks in one pass, against this commit's built @qvac/sdk and @qvac/inference:
// the contract check, JVM and Android example tests, debug build checks, Maven publications and consumers, and the Kotlin
// e2e app's unit tests. PRs into release-* and dispatches build every runtime profile; other PRs the all-in-one one.

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const kotlin = fileURLToPath(new URL('..', import.meta.url))
const packages = join(kotlin, '..')
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' })
const packFrom = (dir) =>
  execFileSync('npm', ['pack', '--ignore-scripts', '--silent'], { cwd: dir, encoding: 'utf8' })
    .trim()
    .split('\n')
    .pop()

const env = process.env
const profile =
  env.GITHUB_EVENT_NAME === 'workflow_dispatch' ||
  (env.GITHUB_BASE_REF ?? '').startsWith('release-')
    ? ''
    : 'aio'

const sdkTgz = packFrom(join(packages, 'sdk'))
const inferenceTgz = packFrom(join(packages, 'inference'))
// The committed registry pin first, before it is swapped: the Kotlin runtime, its @qvac/sdk pin and the SDK share a version.
run('node', ['scripts/check-version-alignment.mjs'], kotlin)
// Transitive here, so an override may point the worker bundle at this commit's engine.
run('npm', ['pkg', 'set', `overrides.@qvac/inference=file:../inference/${inferenceTgz}`], kotlin)
run(
  'npm',
  ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-package-lock', `../sdk/${sdkTgz}`],
  kotlin
)
// packages/sdk/dist is this commit's, so Gradle skips rebuilding it.
run(
  './gradlew',
  [
    '--no-daemon',
    '--configuration-cache',
    '-x',
    ':android-barekit:buildWorkspaceSdk',
    `-PqvacProfile=${profile}`,
    'checkContract',
    'jvmTest',
    ':android-example:testDebugUnitTest',
    ':android-example:checkDebugBuild',
    ':android-example:compileDebugAndroidTestKotlin',
    'verifyMavenPublications'
  ],
  kotlin
)
run('./scripts/verify-maven-consumers.sh', [`-PqvacProfile=${profile}`], kotlin)
// The Kotlin e2e app against this SDK, so an API break fails here rather than on Device Farm.
run(
  '../../../sdk-kotlin/gradlew',
  [
    '--no-daemon',
    '-PqvacProfile=aio',
    '-x',
    ':sdk-kotlin:android-barekit:buildWorkspaceSdk',
    ':app:testDebugUnitTest'
  ],
  join(packages, 'sdk-e2e', 'runners', 'kotlin')
)
