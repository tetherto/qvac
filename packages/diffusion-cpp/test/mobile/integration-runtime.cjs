'use strict'

/* global Bare */

if (typeof Bare !== 'undefined' && typeof Bare.on === 'function') {
  Bare.on('unhandledRejection', (reason) => {
    console.error('[integration-runner] Unhandled rejection:', reason instanceof Error ? reason.stack : reason)
  })
  Bare.on('uncaughtException', (err) => {
    console.error('[integration-runner] Uncaught exception:', err instanceof Error ? err.stack : err)
  })
}

const path = require('bare-path')
const fs = require('bare-fs')
const { pathToFileURL } = require('bare-url')

async function runIntegrationModule (relativeModulePath, options = {}) {
  const modulePath = path.join(__dirname, relativeModulePath)

  if (!fs.existsSync(modulePath)) {
    console.warn(`[integration-runner] Missing module: ${relativeModulePath}`)
    return 'missing'
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
