#!/usr/bin/env node
// Mobile builds its own npm tree later, from packages/sdk/package.json already
// restored to the published range, so the swap in build-local-inference.mjs never
// reaches it. Pin @qvac/inference here instead, in the consumer template.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT_DIR = path.join(E2E_DIR, '.sdk-e2e', 'inference')
const TEMPLATE = path.join(
  E2E_DIR,
  'node_modules',
  '@qvac',
  'test-suite',
  'templates',
  'mobile-consumer',
  'package.json.template'
)
const DEPENDENCY = '@qvac/inference'

function findLocalInferenceTarball() {
  if (!fs.existsSync(ARTIFACT_DIR)) return undefined
  const tarballs = fs.readdirSync(ARTIFACT_DIR).filter(function (entry) {
    return entry.endsWith('.tgz')
  })
  if (tarballs.length === 0) return undefined
  if (tarballs.length > 1) {
    throw new Error(
      `${path.relative(E2E_DIR, ARTIFACT_DIR)} holds ${tarballs.length} tarballs; expected exactly one. ` +
        'Delete the stale ones, or re-run "npm run install:build:full".'
    )
  }
  return path.join(ARTIFACT_DIR, tarballs[0])
}

function writeOverride(spec) {
  const template = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8'))
  const overrides = { ...(template.overrides ?? {}) }

  if (spec === undefined) {
    delete overrides[DEPENDENCY]
  } else {
    overrides[DEPENDENCY] = spec
  }

  if (Object.keys(overrides).length > 0) {
    template.overrides = overrides
  } else {
    delete template.overrides
  }
  fs.writeFileSync(TEMPLATE, `${JSON.stringify(template, null, 2)}\n`)

  const written = JSON.parse(fs.readFileSync(TEMPLATE, 'utf8')).overrides?.[DEPENDENCY]
  if (written !== spec) {
    throw new Error(
      `Failed to pin ${DEPENDENCY} in the mobile consumer template: expected ${spec ?? '<unset>'}, found ${written ?? '<unset>'}.`
    )
  }
  return written
}

export function pinConsumerInference(tarball) {
  if (!fs.existsSync(TEMPLATE)) {
    throw new Error(
      `Mobile consumer template not found at ${path.relative(E2E_DIR, TEMPLATE)}.\n` +
        'Install the e2e dependencies first ("npm install --install-links"). If @qvac/test-suite ' +
        'moved its templates, fix this script rather than skipping it: without the pin the mobile ' +
        `bundle silently embeds the published ${DEPENDENCY} and crashes at bootstrap.`
    )
  }
  return writeOverride(pathToFileURL(tarball).href)
}

// Tolerant where pinning is strict: this runs from clean:build and before the
// tarball is rebuilt, on trees that may not have node_modules yet.
export function clearConsumerInferencePin() {
  if (!fs.existsSync(TEMPLATE)) return undefined
  return writeOverride(undefined)
}

export function reportConsumerInferencePin(spec) {
  if (spec === undefined) {
    console.log(
      `\n📍 Mobile consumers: no local ${DEPENDENCY} pin (they will use the published range)`
    )
    return
  }
  console.log(`\n📍 Mobile consumers pinned to local ${DEPENDENCY}:`)
  console.log(`   ${path.relative(E2E_DIR, fileURLToPath(spec))}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--clear')) {
    reportConsumerInferencePin(clearConsumerInferencePin())
  } else {
    const tarball = findLocalInferenceTarball()
    if (tarball === undefined) {
      throw new Error(
        `No ${DEPENDENCY} tarball in ${path.relative(E2E_DIR, ARTIFACT_DIR)}. ` +
          'Run "npm run install:build:full" to build and pack it, or pass --clear to drop the pin.'
      )
    }
    reportConsumerInferencePin(pinConsumerInference(tarball))
  }
}
