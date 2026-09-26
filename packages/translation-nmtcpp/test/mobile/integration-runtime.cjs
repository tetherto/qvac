'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const { pathToFileURL } = require('bare-url')

// A dlopen failure (or any unhandled error) MUST fail the run, not just get
// logged: Bare surfaces addon-load failures (e.g. a ggml backend symbol that
// only fails to resolve once several ggml addons are co-loaded) as an
// unhandledRejection on the worklet thread. Without a hard exit the run can
// SIGABRT (ambiguous timeout) or a log-only handler would falsely pass. Catch,
// record every failure, and force a non-zero exit on drain.
//
// The exit code is only half of it: the harness reports per-runner results, so
// runIntegrationModule below must also fail the runner the error happened in.
const _integrationFatalErrors = []
const _bareHost = typeof globalThis !== 'undefined' ? globalThis.Bare : undefined
if (_bareHost && typeof _bareHost.on === 'function') {
  _bareHost.on('unhandledRejection', (reason) => {
    _integrationFatalErrors.push(reason || new Error('unhandledRejection'))
    console.error(
      '[integration-runner] Unhandled rejection:',
      reason instanceof Error ? reason.stack : reason
    )
  })
  _bareHost.on('uncaughtException', (err) => {
    _integrationFatalErrors.push(err || new Error('uncaughtException'))
    console.error(
      '[integration-runner] Uncaught exception:',
      err instanceof Error ? err.stack : err
    )
  })
  _bareHost.on('beforeExit', () => {
    if (_integrationFatalErrors.length === 0) return
    console.error('[integration-runner] FATAL: failing run due to an earlier unhandled error.')
    if (typeof _bareHost.exit === 'function') _bareHost.exit(1)
    else if (typeof globalThis.process !== 'undefined' && globalThis.process.exit)
      globalThis.process.exit(1)
  })
}

const GC_PAUSE_MS = 3000

async function runIntegrationModule(relativeModulePath, options = {}) {
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

  if (global.gc) {
    global.gc()
    console.log(`[integration-runner] GC triggered after ${relativeModulePath}`)
  }
  await new Promise((resolve) => setTimeout(resolve, GC_PAUSE_MS))
  console.log(`[integration-runner] ${GC_PAUSE_MS}ms cooldown complete`)

  return modulePath
}

global.runIntegrationModule = runIntegrationModule
