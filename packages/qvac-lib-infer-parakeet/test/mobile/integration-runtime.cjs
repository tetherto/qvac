'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const { pathToFileURL } = require('bare-url')

if (typeof Bare !== 'undefined' && typeof Bare.on === 'function') {
  Bare.on('unhandledRejection', (reason) => {
    console.error('[integration-runner] Unhandled rejection:', reason)
  })
  Bare.on('uncaughtException', (err) => {
    console.error('[integration-runner] Uncaught exception:', err)
  })
}

async function runIntegrationModule (relativeModulePath, options = {}) {
  const modulePath = path.join(__dirname, relativeModulePath)

  if (!fs.existsSync(modulePath)) {
    console.warn(`[integration-runner] Missing module: ${relativeModulePath}`)
    return 'missing'
  }

  const moduleUrl = pathToFileURL(modulePath).href
  await import(moduleUrl)
  return modulePath
}

function readMobileTestFilter () {
  const candidates = []

  if (global.testDir) {
    candidates.push(path.join(global.testDir, 'testFilter.txt'))
  }

  candidates.push('/data/local/tmp/testFilter.txt')

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const raw = fs.readFileSync(candidate, 'utf8').trim()
      if (!raw) continue
      return raw
        .split('|')
        .map(value => value.trim())
        .filter(Boolean)
    } catch (error) {
      console.warn(`[integration-runner] Failed to read test filter from ${candidate}: ${error.message}`)
    }
  }

  return null
}

function shouldRunMobileTest (testName) {
  const filter = readMobileTestFilter()
  if (!filter || filter.length === 0) return true
  return filter.includes(testName)
}

function createSkippedMobileTestResult (testName) {
  console.log(`[integration-runner] Skipping filtered test: ${testName}`)
  return {
    skipped: true,
    testName,
    summary: {
      total: 0,
      passed: 0,
      failed: 0
    }
  }
}

global.runIntegrationModule = runIntegrationModule
global.shouldRunMobileTest = shouldRunMobileTest
global.createSkippedMobileTestResult = createSkippedMobileTestResult

