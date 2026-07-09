'use strict'

/* global Bare */

const path = require('bare-path')
const fs = require('bare-fs')
const os = require('bare-os')
const { pathToFileURL } = require('bare-url')

// A dlopen failure (or any other unhandled error) MUST fail the run, not just
// get logged. Bare surfaces addon-load failures -- e.g. the
// @qvac/tts-ggml@0.2.1 ggml_backend_is_cpu dlopen crash -- as an
// unhandledRejection on the worklet thread; a log-only handler turned that
// into a false-green Device Farm run. Catch to avoid the abrupt SIGABRT,
// record the first failure, and force a non-zero exit on drain so CI sees it.
let _integrationFatalError = null
if (typeof Bare !== 'undefined' && typeof Bare.on === 'function') {
  Bare.on('unhandledRejection', (reason) => {
    if (!_integrationFatalError) _integrationFatalError = reason || new Error('unhandledRejection')
    console.error('[integration-runner] Unhandled rejection:', reason instanceof Error ? reason.stack : reason)
  })
  Bare.on('uncaughtException', (err) => {
    if (!_integrationFatalError) _integrationFatalError = err || new Error('uncaughtException')
    console.error('[integration-runner] Uncaught exception:', err instanceof Error ? err.stack : err)
  })
  Bare.on('beforeExit', () => {
    if (!_integrationFatalError) return
    console.error('[integration-runner] FATAL: failing run due to an earlier unhandled error.')
    if (typeof Bare.exit === 'function') Bare.exit(1)
    else if (typeof process !== 'undefined' && process.exit) process.exit(1)
  })
}

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
  try {
    await import(moduleUrl)
  } catch (error) {
    console.error(`[integration-runner] Module failed to load or run: ${error.message}`)
    return {
      modulePath,
      summary: {
        total: 1,
        passed: 0,
        failed: 1,
        error: {
          message: error.message,
          code: error.code,
          stack: error.stack
        }
      }
    }
  }
  return { modulePath, summary: null }
}

global.runIntegrationModule = runIntegrationModule
