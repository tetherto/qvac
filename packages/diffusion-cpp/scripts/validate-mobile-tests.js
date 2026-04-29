#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileAutoFile = path.join(repoRoot, 'test', 'mobile', 'integration.auto.cjs')

function getIntegrationTestFiles () {
  if (!fs.existsSync(integrationDir)) {
    throw new Error(`Integration directory not found: ${integrationDir}`)
  }

  return fs.readdirSync(integrationDir)
    .filter(f => f.endsWith('.test.js'))
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
  const rightSet = right instanceof Set ? right : new Set(right)
  return [...left].filter(item => !rightSet.has(item)).sort((a, b) => a - b)
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

  // Keep timestamp validation as a fast stale-content signal for edited tests.
  const latestIntegrationTime = Math.max(
    ...integrationFiles.map(f => fs.statSync(path.join(integrationDir, f)).mtimeMs)
  )
  const mobileAutoTime = fs.statSync(mobileAutoFile).mtimeMs

  if (latestIntegrationTime > mobileAutoTime) {
    console.error('❌ Mobile integration tests are out of date!')
    console.error('   Integration tests modified after mobile tests were generated.')
    console.error('   Run: npm run test:mobile:generate')
    process.exit(1)
  }

  console.log('✅ Mobile integration tests are up to date')
  process.exit(0)
} catch (error) {
  console.error('Error validating mobile tests:', error.message)
  process.exit(1)
}
