'use strict'

// Node-side validator for the mobile layout and test-group coverage. Scheduling
// policy lives here so it cannot abort desktop integration-test generation.

const fs = require('fs')
const path = require('path')
const process = require('process')
const {
  REQUIRED_PLATFORMS,
  generatedRunnerNames,
  validateTestGroups
} = require('./lib/validate-test-groups')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileDir = path.join(repoRoot, 'test', 'mobile')
const autoFile = path.join(mobileDir, 'integration.auto.cjs')
const runtimeFile = path.join(mobileDir, 'integration-runtime.cjs')
const testGroupsFile = path.join(mobileDir, 'test-groups.json')

function getIntegrationTestFiles() {
  if (!fs.existsSync(integrationDir)) {
    throw new Error(`Integration directory not found: ${integrationDir}`)
  }

  return fs
    .readdirSync(integrationDir)
    .filter((file) => file.endsWith('.test.js'))
    .sort()
}

function getGeneratedIntegrationRefs(content) {
  const references = new Set()
  const pattern = /runIntegrationModule\('\.\.\/integration\/([^']+)'(?:,\s*options)?\)/g
  let match = pattern.exec(content)

  while (match !== null) {
    references.add(match[1])
    match = pattern.exec(content)
  }

  return references
}

function setDiff(left, right) {
  return [...left].filter((item) => !right.has(item)).sort()
}

function printMismatchDetails(label, items) {
  console.error(`  ${label}:`)
  items.forEach((item) => console.error(`    - ${item}`))
}

function main() {
  const errors = []

  if (!fs.existsSync(mobileDir)) {
    errors.push(`Mobile test directory not found: ${mobileDir}`)
  }

  if (!fs.existsSync(autoFile)) {
    errors.push(`Auto-generated file not found: ${autoFile}`)
    errors.push('Run `npm run test:mobile:generate` to create it')
  }

  if (!fs.existsSync(runtimeFile)) {
    errors.push(`Runtime file not found: ${runtimeFile}`)
  }

  if (!fs.existsSync(testGroupsFile)) {
    errors.push(`Test groups file not found: ${testGroupsFile}`)
  }

  if (errors.length > 0) {
    console.error('Mobile test validation failed:')
    errors.forEach((err) => console.error('  -', err))
    process.exit(1)
  }

  const integrationFiles = getIntegrationTestFiles()
  const autoContent = fs.readFileSync(autoFile, 'utf8')
  const generatedIntegrationRefs = getGeneratedIntegrationRefs(autoContent)
  const missingFromGenerated = setDiff(new Set(integrationFiles), generatedIntegrationRefs)
  const staleInGenerated = setDiff(generatedIntegrationRefs, new Set(integrationFiles))

  if (missingFromGenerated.length > 0 || staleInGenerated.length > 0) {
    console.error('Mobile integration tests are out of sync with test/integration:')
    if (missingFromGenerated.length > 0) {
      printMismatchDetails('Missing from integration.auto.cjs', missingFromGenerated)
    }
    if (staleInGenerated.length > 0) {
      printMismatchDetails('Stale references in integration.auto.cjs', staleInGenerated)
    }
    console.error('  Run: npm run test:mobile:generate')
    process.exit(1)
  }

  const runners = generatedRunnerNames(autoContent)
  if (runners.length === 0) {
    console.error('Mobile test validation failed:')
    console.error(`  - No 'async function run<Name>' declarations found in ${autoFile}`)
    process.exit(1)
  }

  const groups = JSON.parse(fs.readFileSync(testGroupsFile, 'utf8'))
  const problems = validateTestGroups(groups, runners, { platforms: REQUIRED_PLATFORMS })
  if (problems.length > 0) {
    console.error('Mobile test validation failed:')
    problems.forEach((problem) => console.error(`  - ${problem}`))
    process.exit(1)
  }

  console.log(
    `Mobile test structure is valid (${runners.length} runner(s), group coverage OK per platform)`
  )
}

if (require.main === module) {
  main()
}

module.exports = { getGeneratedIntegrationRefs }
