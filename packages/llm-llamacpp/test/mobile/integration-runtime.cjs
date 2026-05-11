'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const { pathToFileURL } = require('bare-url')

// ---------------------------------------------------------------------------
// Test filter – allows CI to restrict which tests actually execute.
//
// The WDIO before-hook pushes a testFilter.txt file (containing a regex
// pattern) via Appium pushFile *before* clicking "Run Automated Tests".
//
// iOS:     pushed to @bundleId:documents/  → lands in global.testDir
// Android: pushed to /data/local/tmp/      → release APKs can't use
//          @package/ (needs debuggable), so we use the shared tmp dir
//          which is readable by all apps.
//
// Each run*Test wrapper consults __shouldRunTest(); when the test name
// doesn't match the pattern the wrapper returns a zero-count summary
// instantly – no model is loaded, no inference runs, zero resource cost.
// ---------------------------------------------------------------------------
let __filterLoaded = false
let __filterRe = null

function tryLoadFilter (filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8').trim()
      if (raw) {
        __filterRe = new RegExp(raw)
        console.log('[TestFilter] loaded pattern from ' + filePath + ': ' + raw)
      }
      try { fs.unlinkSync(filePath) } catch (_) {}
      return true
    }
  } catch (e) {
    console.log('[TestFilter] read error at ' + filePath + ':', e.message)
  }
  return false
}

global.__shouldRunTest = function shouldRunTest (testName) {
  if (!__filterLoaded) {
    __filterLoaded = true

    const dir = global.testDir
    if (dir) tryLoadFilter(path.join(dir, 'testFilter.txt'))

    if (!__filterRe && os.platform() === 'android') {
      tryLoadFilter('/data/local/tmp/testFilter.txt')
    }
  }
  if (!__filterRe) return true
  return __filterRe.test(testName)
}

async function runIntegrationModule (relativeModulePath, options = {}) {
  const modulePath = path.join(__dirname, relativeModulePath)

  if (!fs.existsSync(modulePath)) {
    console.warn(`[integration-runner] Missing module: ${relativeModulePath}`)
    return { modulePath: 'missing', summary: { total: 0, passed: 0, failed: 0 } }
  }

  const moduleUrl = pathToFileURL(modulePath).href
  await import(moduleUrl)
  return { modulePath, summary: null }
}

global.runIntegrationModule = runIntegrationModule
