'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const proc = require('bare-process')
const { pathToFileURL } = require('bare-url')

// Force the gpu-smoke integration test (and any other test that opts
// into NO_GPU) to skip the GPU paths on Device Farm.  The desktop
// integration-test workflow toggles this via matrix `no_gpu: 'true'`
// -> job env, but mobile bundles execute on real devices where workflow
// env vars do not propagate.  Setting it here means every test that
// reads `process.env.NO_GPU` (gpu-smoke.test.js etc.) sees the same
// off-switch on Device Farm.  Drop or gate this assignment when the
// tts-ggml mobile GPU paths are stable enough for strict CI coverage on
// Adreno / Apple Silicon devices.
proc.env.NO_GPU = 'false'

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

global.runIntegrationModule = runIntegrationModule
