'use strict'

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
  await new Promise(resolve => setTimeout(resolve, GC_PAUSE_MS))
  console.log(`[integration-runner] ${GC_PAUSE_MS}ms cooldown complete`)

  return modulePath
}

global.runIntegrationModule = runIntegrationModule
