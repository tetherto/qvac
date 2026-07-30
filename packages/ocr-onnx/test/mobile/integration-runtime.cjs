'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const { pathToFileURL } = require('bare-url')

// A dlopen failure (or any unhandled error) MUST fail the run, not just get
// logged: Bare surfaces addon-load failures as an unhandledRejection on the
// worklet thread. Without a hard exit the run can SIGABRT (ambiguous timeout)
// or a log-only handler would falsely pass. Catch, record the first failure,
// and force a non-zero exit on drain.
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

global.runIntegrationModule = runIntegrationModule
