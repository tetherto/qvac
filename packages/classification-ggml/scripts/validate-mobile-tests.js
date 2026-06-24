'use strict'

// Node-side (not Bare) structural validator for the mobile test layout.
// Used by CI to fail early if the generator hasn't been run or the mobile
// runtime helper is missing. Mirrors the pattern used by the other QVAC
// inference addons (nmtcpp, diffusion, llamacpp-*).

const fs = require('fs')
const path = require('path')
const process = require('process')

const repoRoot = path.resolve(__dirname, '..')
const mobileDir = path.join(repoRoot, 'test', 'mobile')
const autoFile = path.join(mobileDir, 'integration.auto.cjs')
const runtimeFile = path.join(mobileDir, 'integration-runtime.cjs')

function main () {
  const errors = []

  if (!fs.existsSync(mobileDir)) {
    errors.push(`Mobile test directory not found: ${mobileDir}`)
  }

  if (!fs.existsSync(autoFile)) {
    errors.push(`Auto-generated file not found: ${autoFile}`)
    errors.push('Run `npm run test:mobile:generate` to create it')
  }

  if (!fs.existsSync(runtimeFile)) {
    errors.push(`Runtime file not found: ${runtimeFile}`)
  }

  if (errors.length > 0) {
    console.error('Mobile test validation failed:')
    errors.forEach(err => console.error('  -', err))
    process.exit(1)
  }

  console.log('Mobile test structure is valid')
}

if (require.main === module) {
  main()
}
