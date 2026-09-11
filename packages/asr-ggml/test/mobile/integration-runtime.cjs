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
// record every failure, and force a non-zero exit on drain so CI sees it.
//
// The exit code is only half of it: the harness reports per-runner results, so
// runIntegrationModule below must also fail the runner the error happened in.
const _integrationFatalErrors = []
if (typeof Bare !== 'undefined' && typeof Bare.on === 'function') {
  Bare.on('unhandledRejection', (reason) => {
    _integrationFatalErrors.push(reason || new Error('unhandledRejection'))
    console.error('[integration-runner] Unhandled rejection:', reason instanceof Error ? reason.stack : reason)
  })
  Bare.on('uncaughtException', (err) => {
    _integrationFatalErrors.push(err || new Error('uncaughtException'))
    console.error('[integration-runner] Uncaught exception:', err instanceof Error ? err.stack : err)
  })
  Bare.on('beforeExit', () => {
    if (_integrationFatalErrors.length === 0) return
    console.error('[integration-runner] FATAL: failing run due to an earlier unhandled error.')
    if (typeof Bare.exit === 'function') Bare.exit(1)
    else if (typeof process !== 'undefined' && process.exit) process.exit(1)
  })
}

async function runIntegrationModule (relativeModulePath, options = {}) {
  const modulePath = path.join(__dirname, relativeModulePath)

  if (!fs.existsSync(modulePath)) {
    console.warn(`[integration-runner] Missing module: ${relativeModulePath}`)
    return 'missing'
  }

  const fatalMark = _integrationFatalErrors.length
  const moduleUrl = pathToFileURL(modulePath).href
  await import(moduleUrl)

  // Yield once so a rejection raised in the module's final tick reaches the
  // handler, then surface it the same way an import failure already is: by
  // throwing. Returning normally is what let a failed model load report PASS.
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (_integrationFatalErrors.length > fatalMark) {
    throw _integrationFatalErrors[fatalMark]
  }
  return modulePath
}

global.runIntegrationModule = runIntegrationModule

console.log('[integration-runtime] Mobile integration tests initialized')
