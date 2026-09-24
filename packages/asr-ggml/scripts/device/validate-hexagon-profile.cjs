'use strict'

// Host-side verifier for a combined stdout/stderr capture from hexagon-ctc.cjs.
const fs = require('node:fs')
const { validateProfileCapture } = require('./hexagon-validation.cjs')

try {
  if (process.argv.length !== 3) {
    throw new Error('Usage: node validate-hexagon-profile.cjs profile.log')
  }
  const result = validateProfileCapture(fs.readFileSync(process.argv[2], 'utf8'))
  console.log('HEXAGON_CTC_PROFILE_VERIFIED ' + JSON.stringify(result))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
