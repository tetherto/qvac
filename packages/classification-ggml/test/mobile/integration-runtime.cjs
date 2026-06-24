'use strict'

// Shared mobile integration runtime. The qvac-test-addon-mobile framework
// loads the sibling `integration.auto.cjs` on-device, which calls back
// into `runIntegrationModule(...)` to execute one integration test module
// at a time. Between modules we force a GC (if exposed by the runtime)
// and sleep briefly so native resources allocated by libggml / bare-stream
// are reclaimed before the next module begins.

const path = require('bare-path')
const fs = require('bare-fs')
const { pathToFileURL } = require('bare-url')

// A dlopen failure (or any unhandled error) MUST fail the run, not just get
// logged: Bare surfaces addon-load failures (e.g. a ggml backend symbol that
// only fails to resolve once several ggml addons are co-loaded) as an
// unhandledRejection on the worklet thread. Without a hard exit the run can
// SIGABRT (ambiguous timeout) or a log-only handler would falsely pass. Catch,
// record the first failure, and force a non-zero exit on drain.
let _integrationFatalError = null
const _bareHost = typeof globalThis !== 'undefined' ? globalThis.Bare : undefined
if (_bareHost && typeof _bareHost.on === 'function') {
  _bareHost.on('unhandledRejection', (reason) => {
    if (!_integrationFatalError) _integrationFatalError = reason || new Error('unhandledRejection')
    console.error('[integration-runner] Unhandled rejection:', reason instanceof Error ? reason.stack : reason)
  })
  _bareHost.on('uncaughtException', (err) => {
    if (!_integrationFatalError) _integrationFatalError = err || new Error('uncaughtException')
    console.error('[integration-runner] Uncaught exception:', err instanceof Error ? err.stack : err)
  })
  _bareHost.on('beforeExit', () => {
    if (!_integrationFatalError) return
    console.error('[integration-runner] FATAL: failing run due to an earlier unhandled error.')
    if (typeof _bareHost.exit === 'function') _bareHost.exit(1)
    else if (typeof globalThis.process !== 'undefined' && globalThis.process.exit) globalThis.process.exit(1)
  })
}

const GC_PAUSE_MS = 3000

async function runIntegrationModule (relativeModulePath, options = {}) {
  const modulePath = path.join(__dirname, relativeModulePath)

  if (!fs.existsSync(modulePath)) {
    console.warn(`[integration-runner] Missing module: ${relativeModulePath}`)
    return 'missing'
  }

  const moduleUrl = pathToFileURL(modulePath).href
  await import(moduleUrl)

  if (global.gc) {
    global.gc()
    console.log(`[integration-runner] GC triggered after ${relativeModulePath}`)
  }
  await new Promise(resolve => setTimeout(resolve, options.gcPauseMs || GC_PAUSE_MS))
  console.log(`[integration-runner] ${GC_PAUSE_MS}ms cooldown complete`)

  return modulePath
}

global.runIntegrationModule = runIntegrationModule
