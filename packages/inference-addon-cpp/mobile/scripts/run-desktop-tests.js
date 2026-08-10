#!/usr/bin/env node
'use strict'

// Runs every generated on-device test entry locally under `bare`, so the ported
// suite can be exercised on a desktop machine before it ever reaches Device Farm.
// Entries are enumerated from the desktop suites (never a hand-maintained list),
// so this stays correct as tests are added upstream.

const { spawnSync } = require('child_process')
const path = require('path')

const { mobileRoot, expectedEntries } = require('./lib/desktop-suites.js')

const entries = expectedEntries()
if (entries.length === 0) {
  console.error('No test entries found — run npm run test:mobile:generate first')
  process.exit(1)
}

let failed = 0
for (const entry of entries) {
  const rel = path.join('test', 'integration', entry.relPath)
  console.log(`\n=== ${rel} ===`)
  const result = spawnSync('bare', [rel], { cwd: mobileRoot, stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`FAILED: ${rel}`)
    failed++
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${entries.length} test file(s) failed`)
  process.exit(1)
}
console.log(`\nAll ${entries.length} test file(s) passed`)
