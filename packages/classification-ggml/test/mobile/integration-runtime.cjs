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
