'use strict'

const path = require('bare-path')
const fs = require('bare-fs')
const proc = require('bare-process')
const { pathToFileURL } = require('bare-url')

// Device Farm bundles do not inherit workflow matrix env vars, so set
// NO_GPU here for every test that reads process.env.NO_GPU
// (gpu-smoke.test.js, mobile-perf-runner.js). false keeps those suites
// enabled so CI exercises dynamic ggml backend dlopen / discovery on
// real hardware. On Android, C++ still forces useGPU=false and
// gpu-smoke.test.js passes early — inference stays on CPU while backend
// .so loading is covered. iOS may run Metal when mobile-perf-*-gpu
// passes useGPU: true. Revisit when Android GPU inference is re-enabled.
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

