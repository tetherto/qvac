#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const { validateTestGroups, generatedRunnerNames } = require('./lib/validate-test-groups.js')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileAutoFile = path.join(repoRoot, 'test', 'mobile', 'integration.auto.cjs')
const groupsFile = path.join(repoRoot, 'test', 'mobile', 'test-groups.json')

// The OS families that must schedule every generated runner. Pinned rather than
// inferred from the file's shape: test-groups.json also holds top-level
// `iosWeekly`/`androidWeekly` maps, which are schedules pooled into their family
// (see lib/validate-test-groups.js), not platforms owing coverage of their own.
const REQUIRED_PLATFORMS = ['ios', 'android']

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

  // Device Farm shard coverage. This lives here rather than in the generator so
  // that a mobile scheduling mistake can never abort `npm run test:integration`
  // and take desktop CI down with it.
  if (!fs.existsSync(groupsFile)) {
    console.log('✅ Mobile integration tests are up to date (no test-groups.json — single-spec)')
    process.exit(0)
  }

  const groups = JSON.parse(fs.readFileSync(groupsFile, 'utf8'))
  const runners = generatedRunnerNames(mobileAutoContent)
  const problems = validateTestGroups(groups, runners, { platforms: REQUIRED_PLATFORMS })

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
