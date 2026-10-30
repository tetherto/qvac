'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const proc = require('bare-process')
const { pathToFileURL } = require('bare-url')

// Device Farm bundles do not inherit workflow matrix env vars, so set
// NO_GPU here for every test that reads process.env.NO_GPU (gpu.test.js,
// parakeet-gpu-smoke.test.js, and both mobile-perf runners). false keeps
// those suites enabled so CI exercises dynamic ggml backend dlopen /
// discovery on real hardware. On Android, C++ still forces useGPU=false and
// parakeet-gpu-smoke.test.js passes early — inference stays on CPU while
// backend .so loading is covered. iOS may run Metal when mobile-perf-*-gpu
// passes useGPU: true. Revisit when Android GPU inference is re-enabled.
proc.env.NO_GPU = 'false'

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

// Mirrors console to native-tail.log with sync writes so C++ lines survive an addon abort().
// Capped well under iOS's 4 GiB/day per-app write limit; a full run is ~90 KB.
const NATIVE_TAIL_MAX_BYTES = 8 * 1024 * 1024
let _nativeTailPath = null
let _nativeTailBytes = 0
let _nativeTailStopped = false
let _nativeTailWarnedNoDir = false
let _nativeTailWarnedWrite = false

function _nativeTailWrite (level, args) {
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
    // A broken tail must never take the run with it, nor be re-armed (that would truncate it).
    _nativeTailStopped = true
  }
}

function initNativeTail () {
  if (_nativeTailPath || _nativeTailStopped) return
  const dir = global.testDir
  // Say why on every bail-out, so a run never looks instrumented when it isn't.
  if (!dir) {
    if (!_nativeTailWarnedNoDir) {
      _nativeTailWarnedNoDir = true
      console.log('[native-tail] not started: global.testDir is not set')
    }
    return
  }
  const target = path.join(dir, 'native-tail.log')
  try {
    fs.writeFileSync(target, '')
  } catch (err) {
    if (!_nativeTailWarnedWrite) {
      _nativeTailWarnedWrite = true
      console.log('[native-tail] not started: cannot write ' + target + ': ' + err.message)
    }
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

async function runIntegrationModule (relativeModulePath, options = {}) {
  const modulePath = path.join(__dirname, relativeModulePath)

  initNativeTail()

  if (!fs.existsSync(modulePath)) {
    console.warn(`[integration-runner] Missing module: ${relativeModulePath}`)
    return 'missing'
  }

  const moduleUrl = pathToFileURL(modulePath).href
  await import(moduleUrl)
  return modulePath
}

global.runIntegrationModule = runIntegrationModule

// Module scope: the framework may import test modules itself rather than
// through runIntegrationModule, so do not rely on that being reached.
initNativeTail()

console.log('[integration-runtime] Mobile integration tests initialized')
