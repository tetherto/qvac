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

// ---------------------------------------------------------------------------
// Perf config – allows the dedicated `Benchmark Performance (LLM)`
// workflow_dispatch to crank up QVAC_PERF_RUNS / QVAC_PERF_WARMUP_RUNS
// on mobile so we get mean ± std numbers instead of the cheap PR
// default (1 warmup + 1 counted).
//
// Desktop runners pick these up directly from `env:` in the
// integration-test-...yml workflow. On mobile the WDIO before-hook
// pushes a `qvacPerfConfig.txt` file (KEY=VALUE per line) via Appium
// pushFile *before* clicking "Run Automated Tests" — same paths the
// testFilter.txt logic above uses. We inject each KEY into bare-os via
// os.setEnv() so the existing os.getEnv() lookups in
// _image-common.js / bitnet.test.js / tool-calling.test.js pick them
// up at their own module init time.
//
// Important: must run *before* runIntegrationModule() dynamically
// imports any test file. We piggy-back on __shouldRunTest's first call
// (which fires before runIntegrationModule on every test wrapper in
// integration.auto.cjs) so global.testDir is guaranteed set by then.
// Empty file / missing file is a no-op → PR default.
// ---------------------------------------------------------------------------
let __perfConfigLoaded = false

function tryLoadPerfConfig (filePath) {
  try {
    if (!fs.existsSync(filePath)) return false
    // The mobile WDIO before-hook builds the file content via JS string
    // concat ("KEY=val" + "\\n" + ...). Because the JS source itself is
    // wrapped in a YAML single-quoted env value, the JS sees "\\n" (one
    // literal backslash + n) at runtime, not a real newline — so the
    // pushed file contains literal "\n" between entries. Normalise both
    // literal "\n" and real newlines before parsing so we don't depend
    // on which encoding the workflow happens to use.
    const raw = fs.readFileSync(filePath, 'utf-8').replace(/\\n/g, '\n')
    let injected = 0
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      const value = trimmed.slice(eq + 1).trim()
      if (!key || !value) continue
      try {
        os.setEnv(key, value)
        injected++
      } catch (e) {
        console.log('[PerfConfig] setEnv failed for ' + key + ': ' + e.message)
      }
    }
    console.log('[PerfConfig] loaded ' + injected + ' override(s) from ' + filePath)
    try { fs.unlinkSync(filePath) } catch (_) {}
    return true
  } catch (e) {
    console.log('[PerfConfig] read error at ' + filePath + ':', e.message)
    return false
  }
}

function loadPerfConfigOnce () {
  if (__perfConfigLoaded) return
  __perfConfigLoaded = true
  const dir = global.testDir
  if (dir && tryLoadPerfConfig(path.join(dir, 'qvacPerfConfig.txt'))) return
  if (os.platform() === 'android') tryLoadPerfConfig('/data/local/tmp/qvacPerfConfig.txt')
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

  // Inject perf overrides before the wrapped test module is imported by
  // runIntegrationModule(). Cheap (no-op after first call) and ordering
  // guarantees os.getEnv() inside the test's module init sees the
  // dispatched value.
  loadPerfConfigOnce()

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
