#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const { validateTestGroups, generatedRunnerNames } = require('./lib/validate-test-groups.js')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileAutoFile = path.join(repoRoot, 'test', 'mobile', 'integration.auto.cjs')
const groupsFile = path.join(repoRoot, 'test', 'mobile', 'test-groups.json')

function getIntegrationTestFiles() {
  if (!fs.existsSync(integrationDir)) {
    throw new Error(`Integration directory not found: ${integrationDir}`)
  }

  return fs
    .readdirSync(integrationDir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
}

function getGeneratedIntegrationRefs(content) {
  const references = new Set()
  const referencePattern = /runIntegrationModule\('\.\.\/integration\/([^']+)'(?:,\s*options)?\)/g
  let match = referencePattern.exec(content)

  while (match !== null) {
    references.add(match[1])
    match = referencePattern.exec(content)
  }

  return references
}

function setDiff(left, right) {
  return [...left].filter((item) => !right.has(item)).sort()
}

function printMismatchDetails(label, items) {
  console.error(`   ${label}:`)
  items.forEach((item) => console.error(`     - ${item}`))
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

  // There is deliberately no mtime comparison here. `buildFileContents`
  // (generate-mobile-integration-tests.js) derives integration.auto.cjs from the
  // sorted *filenames* under test/integration/ and never opens a test file, so
  // editing a test's body cannot make the generated file stale. A timestamp
  // check can therefore only produce false positives — and since this script now
  // runs as part of `npm run test:unit`, each one would be a hard failure telling
  // the author to regenerate a byte-identical file.
  //
  // The reference diff above covers the staleness that matters day to day: a
  // test file added, renamed or removed. It does not cover a change to the
  // generator's own template (the `__shouldRunTest` guard, the header comments),
  // since it compares only the `runIntegrationModule` paths — that still needs a
  // manual `npm run test:mobile:generate`. The mtime check did not catch that
  // either: it compared test-file timestamps, not the generator's.

  // Device Farm shard coverage. This lives here rather than in the generator so
  // that a mobile scheduling mistake can never abort `npm run test:integration`
  // and take desktop CI down with it.
  if (!fs.existsSync(groupsFile)) {
    console.log('✅ Mobile integration tests are up to date (no test-groups.json — single-spec)')
    process.exit(0)
  }

  const groups = JSON.parse(fs.readFileSync(groupsFile, 'utf8'))
  const runners = generatedRunnerNames(mobileAutoContent)
  const problems = validateTestGroups(groups, runners)

  if (problems.length > 0) {
    console.error('❌ test-groups.json does not cover every mobile runner\n')
    problems.forEach((problem) => console.error(`   ${problem}\n`))
    process.exit(1)
  }

  console.log(
    `✅ Mobile integration tests are up to date (${runners.length} runner(s), group coverage OK)`
  )
  process.exit(0)
} catch (error) {
  console.error('Error validating mobile tests:', error.message)
  process.exit(1)
}
