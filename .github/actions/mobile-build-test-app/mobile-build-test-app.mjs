#!/usr/bin/env node
// Builds the test framework's JS app around a package, before any native project exists.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const INSTALLER = fileURLToPath(
  new URL(
    '../run-mobile-integration-tests/build-mobile-app/install-platform-packages.mjs',
    import.meta.url
  )
)
const LINK_OUT = {
  Android: ['android', 'node_modules/react-native-bare-kit/android/src/main/addons'],
  iOS: ['ios', 'node_modules/react-native-bare-kit/ios/addons']
}

export function checkMobileTests(addonDir) {
  const dir = join(addonDir, 'test/mobile')
  if (!existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith('.cjs')))
    throw new Error(`no .cjs tests in ${dir}`)
}

// The generator writes a 20 minute ceiling per test.
export function extendTimeout(text, minutes) {
  if (!(Number(minutes) > 0))
    throw new Error(`per-test timeout must be a positive number of minutes, got '${minutes}'`)
  const out = text
    .replaceAll('timeout: 1200000,', `timeout: ${minutes * 60000},`)
    .replaceAll('did not complete within 20 minutes', `did not complete within ${minutes} minutes`)
  if (out === text) throw new Error('no generated per-test timeout matched (timeout: 1200000)')
  return out
}

export function installerArgs(appDir, addonDir, dependencyPrebuilds) {
  const args = [INSTALLER, '--app-dir', appDir, '--addon-dir', addonDir]
  for (const line of dependencyPrebuilds
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean))
    args.push('--prebuilds', line)
  return args
}

export function build({
  platform,
  appDir,
  addonDir,
  npmName,
  dependencyPrebuilds = '',
  timeoutMinutes = '',
  run
}) {
  checkMobileTests(addonDir)
  run('npm', ['install'], { cwd: addonDir })
  mkdirSync(join(addonDir, 'dist'), { recursive: true })
  run('npm', ['pack', '--pack-destination', 'dist'], { cwd: addonDir })
  // react-native-bare-kit 0.16 no longer links a worklet's native addons, so bare-link does.
  run(
    'npm',
    [
      'pkg',
      'set',
      'dependencies.react-native-bare-kit=^0.16.0',
      'devDependencies.bare-link=^4.0.1'
    ],
    { cwd: appDir }
  )
  run('npm', ['install'], { cwd: appDir })
  run('node', installerArgs('.', addonDir, dependencyPrebuilds), {
    cwd: appDir
  })
  run('npm', ['run', 'build', addonDir, join(addonDir, 'test/mobile')], {
    cwd: appDir
  })
  if (!existsSync(join(appDir, 'backend/backend.cjs')))
    throw new Error('backend/backend.cjs was not generated')
  const [preset, out] = LINK_OUT[platform]
  run(
    'npx',
    ['--no-install', 'bare-link', '--preset', preset, '--out', out, 'backend/backend.cjs'],
    { cwd: appDir }
  )
  // A second pass so the package's own backends win over a dependency's same-named copies.
  if (existsSync(join(appDir, 'node_modules', npmName, 'package.json'))) {
    writeFileSync(
      join(appDir, 'link-addon-under-test.cjs'),
      `require(${JSON.stringify(npmName)})\n`
    )
    run(
      'npx',
      ['--no-install', 'bare-link', '--preset', preset, '--out', out, 'link-addon-under-test.cjs'],
      { cwd: appDir }
    )
    rmSync(join(appDir, 'link-addon-under-test.cjs'))
  }
  if (timeoutMinutes) {
    const file = join(appDir, 'e2e/tests/app.test.js')
    writeFileSync(file, extendTimeout(readFileSync(file, 'utf8'), Number(timeoutMinutes)))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env
  if (!LINK_OUT[env.PLATFORM])
    throw new Error(`platform must be Android or iOS, got '${env.PLATFORM}'`)
  const run = (cmd, args, opts) => execFileSync(cmd, args, { stdio: 'inherit', ...opts })
  // The test app is an Expo app; its CLI is what builds it.
  run('npm', ['install', '-g', '--force', '@expo/cli@latest'])
  build({
    platform: env.PLATFORM,
    appDir: resolve(env.APP_DIR),
    addonDir: resolve(env.ADDON_DIR),
    npmName: env.NPM_NAME,
    dependencyPrebuilds: env.DEPENDENCY_PREBUILDS || '',
    timeoutMinutes: env.TIMEOUT_MINUTES || '',
    run
  })
}
