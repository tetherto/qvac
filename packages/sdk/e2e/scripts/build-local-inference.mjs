#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  clearConsumerInferencePin,
  pinConsumerInference,
  reportConsumerInferencePin
} from './pin-consumer-inference.mjs'
import { resetInstallState } from './reconcile-e2e-inference.mjs'

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SDK_DIR = path.resolve(E2E_DIR, '..')
const INFERENCE_DIR = path.resolve(SDK_DIR, '..', 'inference')
const ARTIFACT_DIR = path.join(E2E_DIR, '.sdk-e2e', 'inference')
const SDK_MANIFEST = path.join(SDK_DIR, 'package.json')
const DEPENDENCY = '@qvac/inference'
// 128 + signal number.
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }

function run(command, args, cwd, capture = false) {
  return execFileSync(command, args, {
    cwd,
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8'
  })
}

function step(message) {
  console.log(`\n[36m▶ ${message}[0m`)
}

// Mirrors .github/actions/sdk-e2e-prepare-inference/prepare.mjs, win32 branch
// included, so local and CI manifests carry the same spec.
function toLocalTarballSpec(tarballPath) {
  if (process.platform === 'win32') {
    return path.win32.resolve(tarballPath).replaceAll('\\', '/')
  }
  return pathToFileURL(path.resolve(tarballPath)).href
}

// Every local form this script — or an older revision of it — could leave
// behind. A published range never starts this way.
function isLocalPathSpec(spec) {
  return (
    spec.startsWith('file:') ||
    spec.startsWith('/') ||
    spec.startsWith('.') ||
    /^[a-zA-Z]:[\\/]/.test(spec)
  )
}

function packInference() {
  step('Building and packing packages/inference')
  // The pin names a tarball in ARTIFACT_DIR, which is about to be deleted.
  clearConsumerInferencePin()
  fs.rmSync(ARTIFACT_DIR, { recursive: true, force: true })
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true })
  run('bun', ['install', '--ignore-scripts'], INFERENCE_DIR)
  run('bun', ['run', 'build'], INFERENCE_DIR)
  const output = run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', ARTIFACT_DIR],
    INFERENCE_DIR,
    true
  )
  const filename = JSON.parse(output)?.[0]?.filename
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error(`npm pack produced no inference tarball: ${output}`)
  }
  return path.join(ARTIFACT_DIR, filename)
}

const originalManifest = fs.readFileSync(SDK_MANIFEST, 'utf8')
const manifest = JSON.parse(originalManifest)
const previousSpec = manifest.dependencies?.[DEPENDENCY]

if (previousSpec === undefined) {
  throw new Error(`packages/sdk/package.json has no ${DEPENDENCY} dependency to override`)
}
// Left unchecked, a leftover becomes the "original" restoreManifest() writes
// back, cementing it for every later run.
if (isLocalPathSpec(previousSpec)) {
  throw new Error(
    `packages/sdk/package.json already points ${DEPENDENCY} at a local path (${previousSpec}).\n` +
      'That is a leftover from an interrupted run. Restore it before rebuilding:\n' +
      '  git checkout -- packages/sdk/package.json'
  )
}

let manifestRestored = false

function restoreManifest() {
  if (manifestRestored) return
  manifestRestored = true
  fs.writeFileSync(SDK_MANIFEST, originalManifest)
  console.log(`\n↩️  Restored ${DEPENDENCY} in packages/sdk/package.json`)
}

for (const [signal, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => {
    restoreManifest()
    process.exit(exitCode)
  })
}

let consumerPin

try {
  const tarball = packInference()

  manifest.dependencies[DEPENDENCY] = toLocalTarballSpec(tarball)
  fs.writeFileSync(SDK_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`\n📦 ${DEPENDENCY}: ${previousSpec} -> ${path.relative(E2E_DIR, tarball)}`)

  step('Building packages/sdk')
  run('bun', ['install'], SDK_DIR)
  run('bun', ['run', 'build'], SDK_DIR)

  step('Installing and building e2e')
  // npm install alone won't notice the manifest swap above; see reconcile-e2e-inference.mjs.
  resetInstallState()
  run('npm', ['run', 'clean:sdk-snapshot'], E2E_DIR)
  run(
    'npm',
    [
      'install',
      '--install-links',
      '--fetch-retries=5',
      '--fetch-retry-mintimeout=20000',
      '--fetch-retry-maxtimeout=120000'
    ],
    E2E_DIR
  )
  run('npm', ['run', 'build'], E2E_DIR)
  run('npm', ['run', 'bundle:sdk'], E2E_DIR)

  // Must run after the e2e install above, which regenerates node_modules/@qvac/test-suite.
  step('Pinning mobile consumers to the local inference')
  consumerPin = pinConsumerInference(tarball)
} finally {
  restoreManifest()
}

console.log('\n[32m✔ Local inference, SDK and e2e are built.[0m')
reportConsumerInferencePin(consumerPin)
console.log(`
  Desktop:  npx qvac-test run:local:desktop --filter <testId-prefix|category>
  Electron: npx qvac-test run:local:electron --filter <testId-prefix|category>
  Android:  npx qvac-test run:local:android --filter <testId-prefix|category>
  iOS:      npx qvac-test run:local:ios --filter <testId-prefix|category>`)
