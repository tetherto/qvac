#!/usr/bin/env node
// The mobile check that the speech addons a test app installs record one ggml-speech build, for a package's
// ci/prepare-mobile.mjs. It installs what the app would take from the package (the package and its production
// dependencies) into a scratch directory, then applies build-mobile-app's check to that tree.
//
//   node scripts/ci/check-speech-ggml-builds.mjs [--package <dir>] [--modules-dir <dir>]

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

import {
  SPEECH_ADDONS,
  checkSpeechAddons,
  findSpeechAddons,
  summarizeSpeechAddons
} from '../../.github/actions/run-mobile-integration-tests/build-mobile-app/check-speech-ggml-builds.mjs'

// The speech addons in an installed tree, plus the package itself when it is one, as the app holds it.
export function speechAddons(modulesDir, pkg = null) {
  const found = findSpeechAddons(modulesDir)
  if (!pkg || !SPEECH_ADDONS.includes(pkg.name)) return found
  return [
    { id: `${pkg.name}@${pkg.version}`, ggmlSpeech: pkg.qvac?.['ggml-speech'] ?? null },
    ...found
  ]
}

// The package's production dependencies, installed without scripts into a scratch app.
export function installDependencies(pkg) {
  const app = mkdtempSync(join(tmpdir(), 'speech-ggml-app-'))
  const deps = { name: 'speech-ggml-check', private: true, dependencies: pkg.dependencies ?? {} }
  writeFileSync(join(app, 'package.json'), JSON.stringify(deps))
  execFileSync(
    'npm',
    [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false'
    ],
    { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' }
  )
  return join(app, 'node_modules')
}

// Fails the process when the addons record different builds; an unrecorded one only warns.
export function check(addons, log = console) {
  log.log(summarizeSpeechAddons(addons))
  const { errors, warnings } = checkSpeechAddons(addons)
  const prefix = (level) => (process.env.GITHUB_ACTIONS ? `::${level}::` : `${level}: `)
  for (const w of warnings) log.error(`${prefix('warning')}${w}`)
  for (const e of errors) log.error(`${prefix('error')}${e}`)
  return errors.length === 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { package: { type: 'string' }, 'modules-dir': { type: 'string' } },
    strict: true
  })
  const pkg = values.package
    ? JSON.parse(readFileSync(join(resolve(values.package), 'package.json'), 'utf8'))
    : null
  const modules = values['modules-dir'] ? resolve(values['modules-dir']) : installDependencies(pkg)
  if (!check(speechAddons(modules, pkg))) {
    console.error('Install speech addon releases that record the same ggml-speech build.')
    process.exit(1)
  }
}
