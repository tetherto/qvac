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
    console.error(
      '[integration-runner] Unhandled rejection:',
      reason instanceof Error ? reason.stack : reason
    )
  })
  Bare.on('uncaughtException', (err) => {
    if (!_integrationFatalError) _integrationFatalError = err || new Error('uncaughtException')
    console.error(
      '[integration-runner] Uncaught exception:',
      err instanceof Error ? err.stack : err
    )
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

function tryLoadFilter(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8').trim()
      if (raw) {
        __filterRe = new RegExp(raw)
        console.log('[TestFilter] loaded pattern from ' + filePath + ': ' + raw)
      }
      try {
        fs.unlinkSync(filePath)
      } catch (_) {}
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

function tryLoadPerfConfig(filePath) {
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
    try {
      fs.unlinkSync(filePath)
    } catch (_) {}
    return true
  } catch (e) {
    console.log('[PerfConfig] read error at ' + filePath + ':', e.message)
    return false
  }
}

function loadPerfConfigOnce() {
  if (__perfConfigLoaded) return
  __perfConfigLoaded = true
  const dir = global.testDir
  if (dir && tryLoadPerfConfig(path.join(dir, 'qvacPerfConfig.txt'))) return
  if (os.platform() === 'android') tryLoadPerfConfig('/data/local/tmp/qvacPerfConfig.txt')
}

global.__shouldRunTest = function shouldRunTest(testName) {
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

// ---------------------------------------------------------------------------
// Native log tail.
//
// The addon's C++ logs reach JS through a callback, get printed with
// console.log, and the framework buffers that into bare_console.log on device.
// An abort() in the addon kills the chain before the buffer reaches the file,
// so the lines that say WHY it aborted are lost: bare_console.log simply stops
// mid-test. Verified against the gemma-4 iOS crash — the build that THREW
// produced the Metal OOM lines in full, the build that ABORTED produced none of
// them from the same failure.
//
// Mirror console output here with synchronous appends, so each line is on disk
// before the next is produced and an abort cannot take them with it. The WDIO
// harness pulls native-tail.log alongside bare_console.log (see
// wdio.template.js).
//
// Deliberately NOT installed via addonLogging.setLogger: that is a single
// global sink and the framework already owns it, so replacing it would change
// bare_console.log for every mobile run. Wrapping console leaves existing
// behaviour untouched and only adds the on-disk copy.
//
// Bounded because iOS kills an app that dirties more than 4 GiB in 24h. A whole
// run's console output is ~90 KB, so the cap is a backstop against a
// pathologically verbose run, not an expected limit.
const NATIVE_TAIL_MAX_BYTES = 8 * 1024 * 1024
let _nativeTailPath = null
let _nativeTailBytes = 0
let _nativeTailStopped = false

function _nativeTailWrite(level, args) {
  if (!_nativeTailPath || _nativeTailStopped) return
  let line
  try {
    line =
      '[' +
      new Date().toISOString() +
      '] [' +
      level +
      '] ' +
      args
        .map((a) => {
          if (typeof a === 'string') return a
          if (a instanceof Error) return a.stack || a.message
          try {
            return JSON.stringify(a)
          } catch (_) {
            return String(a)
          }
        })
        .join(' ') +
      '\n'
  } catch (_) {
    return
  }

  if (_nativeTailBytes + line.length > NATIVE_TAIL_MAX_BYTES) {
    _nativeTailStopped = true
    try {
      fs.appendFileSync(_nativeTailPath, '[native-tail] cap reached; further lines omitted\n')
    } catch (_) {}
    return
  }

  try {
    fs.appendFileSync(_nativeTailPath, line)
    _nativeTailBytes += line.length
  } catch (_) {
    // A broken tail must never take the run with it.
    _nativeTailPath = null
  }
}

function initNativeTail() {
  const dir = global.testDir
  if (!dir || _nativeTailPath) return
  const target = path.join(dir, 'native-tail.log')
  try {
    fs.writeFileSync(target, '')
  } catch (_) {
    return
  }
  _nativeTailPath = target

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level]
    if (typeof original !== 'function') continue
    console[level] = function (...args) {
      original.apply(console, args)
      _nativeTailWrite(level.toUpperCase(), args)
    }
  }
  console.log('[native-tail] mirroring console to ' + target)
}

async function runIntegrationModule(relativeModulePath) {
  const modulePath = path.join(__dirname, relativeModulePath)

  initNativeTail()

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
