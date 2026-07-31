#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const { DESKTOP_ONLY } = require('./lib/mobile-test-policy.js')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileAutoFile = path.join(repoRoot, 'test', 'mobile', 'integration.auto.cjs')
const perfTestsFile = path.join(repoRoot, 'test', 'mobile', 'perf-tests.json')
const manifestGeneratorFile = path.join(repoRoot, 'scripts', 'generate-mobile-model-manifest.js')

// Mirrors scripts/generate-mobile-integration-tests.js so both agree on the
// runner name emitted for a given test/integration file.
function toFunctionName (fileName) {
  const base = fileName.replace(/\.js$/, '')
  const parts = base.split(/[^a-zA-Z0-9]+/).filter(Boolean)
  const suffix = parts.map(part => part.charAt(0).toUpperCase() + part.slice(1)).join('')
  return `run${suffix}`
}

// test/mobile/perf-tests.json is the on-device benchmark registry. It is read
// by two consumers, both of which fail hard (not warn) when a name is wrong:
//   - .github/workflows/integration-mobile-test-asr-ggml.yml derives the Mocha
//     grep for a benchmark matrix row from it, and
//   - .github/actions/run-mobile-integration-tests/upload-to-devicefarm uses it
//     as the perf-only filter.
// Keep it in exact sync with the mobile-perf runners: every mobile-perf test
// file must be listed, and every listed name must exist.
function validatePerfTests (integrationFiles) {
  if (!fs.existsSync(perfTestsFile)) {
    console.error('❌ test/mobile/perf-tests.json is missing!')
    console.error('   The mobile benchmark lane resolves its Mocha grep from this file.')
    return false
  }

  let listed
  try {
    listed = JSON.parse(fs.readFileSync(perfTestsFile, 'utf8'))
  } catch (error) {
    console.error(`❌ test/mobile/perf-tests.json is not valid JSON: ${error.message}`)
    return false
  }

  if (!Array.isArray(listed) || listed.some(entry => typeof entry !== 'string')) {
    console.error('❌ test/mobile/perf-tests.json must be a flat array of runner names')
    return false
  }

  const perfRunners = new Set(
    integrationFiles
      .filter(file => file.includes('mobile-perf'))
      .map(toFunctionName)
  )
  const listedSet = new Set(listed)

  const missing = setDiff(perfRunners, listedSet)
  const unknown = setDiff(listedSet, perfRunners)

  if (missing.length > 0 || unknown.length > 0) {
    console.error('❌ test/mobile/perf-tests.json is out of sync with the mobile-perf tests')
    if (missing.length > 0) {
      printMismatchDetails('Missing from perf-tests.json', missing)
    }
    if (unknown.length > 0) {
      printMismatchDetails('Listed but not a mobile-perf runner', unknown)
    }
    return false
  }

  return true
}

// scripts/generate-mobile-model-manifest.js keys its manifest by mobile runner
// function name; generate-prestage-block.js then looks the deployed shard's
// Mocha grep up in that manifest. A key that is not an exported runner stages
// zero models for that shard, which shows up only as a slow on-device download
// (or a timeout) on Device Farm — so validate the keys statically here.
function validateManifestKeys (integrationFiles) {
  if (!fs.existsSync(manifestGeneratorFile)) {
    console.error(`❌ Missing ${path.relative(repoRoot, manifestGeneratorFile)}`)
    return false
  }

  const source = fs.readFileSync(manifestGeneratorFile, 'utf8')
  const block = source.match(/const TEST_MODELS = \{([\s\S]*?)\n\}/)
  if (!block) {
    console.error('❌ Could not find the TEST_MODELS map in generate-mobile-model-manifest.js')
    return false
  }

  const keys = [...block[1].matchAll(/^\s{2}(\w+):/gm)].map(match => match[1])
  if (keys.length === 0) {
    console.error('❌ TEST_MODELS in generate-mobile-model-manifest.js is empty')
    return false
  }

  const runners = new Set(integrationFiles.map(toFunctionName))
  const unknown = setDiff(new Set(keys), runners)

  if (unknown.length > 0) {
    console.error('❌ generate-mobile-model-manifest.js keys tests that do not exist')
    printMismatchDetails('Unknown runner names in TEST_MODELS', unknown)
    console.error('   Keys must match the runners exported by test/mobile/integration.auto.cjs.')
    return false
  }

  return true
}

function getIntegrationTestFiles () {
  if (!fs.existsSync(integrationDir)) {
    throw new Error(`Integration directory not found: ${integrationDir}`)
  }

  return fs.readdirSync(integrationDir)
    .filter(f => f.endsWith('.test.js'))
    .filter(f => !DESKTOP_ONLY.has(f))
    .sort()
}

function getGeneratedIntegrationRefs (content) {
  const references = new Set()
  const referencePattern = /runIntegrationModule\('\.\.\/integration\/([^']+)'(?:,\s*options)?\)/g
  let match = referencePattern.exec(content)

  while (match !== null) {
    references.add(match[1])
    match = referencePattern.exec(content)
  }

  return references
}

function setDiff (left, right) {
  return [...left].filter(item => !right.has(item)).sort()
}

function printMismatchDetails (label, items) {
  console.error(`   ${label}:`)
  items.forEach(item => console.error(`     - ${item}`))
}

try {
  const integrationFiles = getIntegrationTestFiles()
  if (!fs.existsSync(mobileAutoFile)) {
    console.error('❌ Mobile integration tests not generated!')
    console.error('   Run: npm run test:mobile:generate')
    process.exit(1)
  }

  const expectedSet = new Set(integrationFiles)
  const mobileAutoContent = fs.readFileSync(mobileAutoFile, 'utf8')
  const generatedSet = getGeneratedIntegrationRefs(mobileAutoContent)

  const missingFromGenerated = setDiff(expectedSet, generatedSet)
  const staleInGenerated = setDiff(generatedSet, expectedSet)

  if (missingFromGenerated.length > 0 || staleInGenerated.length > 0) {
    console.error('❌ Mobile integration tests are out of sync with test/integration')
    if (missingFromGenerated.length > 0) {
      printMismatchDetails('Missing from integration.auto.cjs', missingFromGenerated)
    }
    if (staleInGenerated.length > 0) {
      printMismatchDetails('Stale references in integration.auto.cjs', staleInGenerated)
    }
    console.error('   Run: npm run test:mobile:generate')
    process.exit(1)
  }

  if (integrationFiles.length === 0) {
    console.log('✅ Mobile integration tests are up to date (no integration tests found)')
    process.exit(0)
  }

  if (!validatePerfTests(integrationFiles) || !validateManifestKeys(integrationFiles)) {
    process.exit(1)
  }

  console.log('✅ Mobile integration tests are up to date')
  process.exit(0)
} catch (error) {
  console.error('Error validating mobile tests:', error.message)
  process.exit(1)
}
