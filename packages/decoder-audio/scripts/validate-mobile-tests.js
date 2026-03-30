#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const integrationDir = path.join(repoRoot, 'test', 'integration')
const mobileAutoFile = path.join(repoRoot, 'test', 'mobile', 'integration.auto.cjs')

try {
  // Get all integration test files
  const integrationFiles = fs.readdirSync(integrationDir)
    .filter(f => f.endsWith('.test.js'))
    .map(f => path.join(integrationDir, f))

  if (integrationFiles.length === 0) {
    console.log('No integration tests found')
    process.exit(0)
  }

  // Get last modified time of integration tests
  const latestIntegrationTime = Math.max(
    ...integrationFiles.map(f => fs.statSync(f).mtimeMs)
  )

  // Get last modified time of generated mobile file
  if (!fs.existsSync(mobileAutoFile)) {
    console.error('❌ Mobile integration tests not generated!')
    console.error('   Run: npm run test:mobile:generate')
    process.exit(1)
  }

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
