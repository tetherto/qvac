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

// As main's Kotlin PR checks: a pull request runs them only when a path the Kotlin SDK builds from changed, diffing the
// commits the selection compared. A dispatch, a release train or a failed fetch runs everything.
const KOTLIN_PATHS = [
  'packages/sdk-kotlin/',
  'packages/inference/package.json',
  'packages/inference/src/schemas/',
  'packages/sdk/src/worker/',
  'packages/sdk-e2e/catalog/conformance/',
  'packages/sdk-e2e/runners/kotlin/',
  'packages/sdk/contract/',
  'packages/sdk/package.json',
  '.github/workflows/sdk-checks.yml',
  '.github/workflows/publish-kotlin.yml',
  '.github/workflows/sdk-e2e.yml'
]
function kotlinChanged() {
  const pr = ['pull_request', 'pull_request_target'].includes(env.GITHUB_EVENT_NAME)
  if (!pr || env.SOURCE !== 'self' || !env.BASE_SHA || !env.HEAD_SHA) return true
  try {
    const repo = `https://github.com/${env.GITHUB_REPOSITORY}.git`
    run(
      'git',
      ['fetch', '--no-tags', '--filter=blob:none', repo, env.BASE_SHA, env.HEAD_SHA],
      kotlin
    )
    const files = execFileSync('git', ['diff', '--name-only', env.BASE_SHA, env.HEAD_SHA], {
      cwd: kotlin,
      encoding: 'utf8'
    }).split('\n')
    return files.some((f) => KOTLIN_PATHS.some((p) => f.startsWith(p)))
  } catch (e) {
    console.log(
      `::warning::could not diff the pull request, running the Kotlin checks: ${e.message}`
    )
    return true
  }
}
if (!kotlinChanged()) {
  console.log(
    '::notice::No Kotlin-relevant change in this pull request; skipping the Kotlin checks'
  )
  process.exit(0)
}

const profile =
  env.GITHUB_EVENT_NAME === 'workflow_dispatch' ||
  (env.GITHUB_BASE_REF ?? '').startsWith('release-')
    ? ''
    : 'aio'

// As main: build the SDK against the in-repo engine in npm's layout, which the mobile bundle needs, then restore the
// published range so the tarball is self-contained. sdk-source:workspace also installs and builds packages/inference.
const sdk = join(packages, 'sdk')
run('npm', ['run', 'sdk-source:workspace'], sdk)
run('npx', ['tsc', '--project', 'tsconfig.json'], sdk)
run('npm', ['run', 'postcompile:aliases'], sdk)
run('git', ['checkout', '--', 'package.json'], sdk)
const sdkTgz = packFrom(sdk)
const inferenceTgz = packFrom(join(packages, 'inference'))
// The committed registry pin first, before it is swapped: the Kotlin runtime, its @qvac/sdk pin and the SDK share a version.
run('node', ['scripts/check-version-alignment.mjs'], kotlin)
// The pin swap below is for this run only; verify:generated reads the committed manifest after it.
process.on('exit', () => execFileSync('git', ['checkout', '--', 'package.json'], { cwd: kotlin }))
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
