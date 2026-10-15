#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileAutoFile = path.join(repoRoot, 'test', 'mobile', 'integration.auto.cjs')
// The mobile test app replaces these package-root files with shims that
// require '<package>/<name>.js', and bare-pack resolves those requires even
// in desktop-only tests, so each one a test imports must be exported.
const shimmedRequirePattern =
  /require\(\s*['"]\.\.\/\.\.\/(binding|addon|addonLogging)(?:\.js)?['"]\s*\)/g

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

function getUnexportedShimImports() {
  const { exports = {} } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const missing = new Set()

  for (const file of fs.readdirSync(integrationDir).filter((f) => f.endsWith('.js'))) {
    const content = fs.readFileSync(path.join(integrationDir, file), 'utf8')
    for (const match of content.matchAll(shimmedRequirePattern)) {
      const subpath = `./${match[1]}.js`
      if (!(subpath in exports)) {
        missing.add(`${file} requires ../../${match[1]}: export "${subpath}"`)
      }
    }
  }

  return [...missing].sort()
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

  const unexportedShimImports = getUnexportedShimImports()
  if (unexportedShimImports.length > 0) {
    console.error(
      '❌ Mobile test bundle cannot resolve package files that integration tests import'
    )
    printMismatchDetails('Add to package.json "exports"', unexportedShimImports)
    process.exit(1)
  }

  if (integrationFiles.length === 0) {
    console.log('✅ Mobile integration tests are up to date (no integration tests found)')
    process.exit(0)
  }

  console.log('✅ Mobile integration tests are up to date')
  process.exit(0)
} catch (error) {
  console.error('Error validating mobile tests:', error.message)
  process.exit(1)
}
