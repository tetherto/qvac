#!/usr/bin/env node
'use strict'

// Drift check: re-derives the expected mobile test tree from the DESKTOP suites
// and compares it against what is committed. Fails if anything differs, so:
//
//   * a desktop test/worker changed but the mobile copy wasn't regenerated,
//   * a desktop test/suite was added or removed,
//   * someone hand-edited a file under test/integration/, or
//   * integration.auto.cjs is stale,
//
// all surface as a hard failure instead of the on-device suite silently drifting
// from what desktop asserts. Fix by running `npm run test:mobile:generate`.

const fs = require('fs')

const {
  autoFile,
  expectedIntegrationFiles,
  expectedEntries,
  expectedAutoCjs,
  listOnDiskIntegrationFiles
} = require('./lib/desktop-suites.js')

function main() {
  const expected = expectedIntegrationFiles()
  const actual = listOnDiskIntegrationFiles()

  const missing = [...expected.keys()].filter((k) => !actual.has(k)).sort()
  const extra = [...actual.keys()].filter((k) => !expected.has(k)).sort()
  const differing = [...expected.keys()]
    .filter((k) => actual.has(k) && actual.get(k) !== expected.get(k))
    .sort()

  const problems = []
  if (missing.length) problems.push(['Missing (desktop test not ported)', missing])
  if (extra.length) problems.push(['Unexpected (no desktop source — mobile-only?)', extra])
  if (differing.length) problems.push(['Drifted from desktop source', differing])

  const expectedAuto = expectedAutoCjs(expectedEntries())
  const actualAuto = fs.existsSync(autoFile) ? fs.readFileSync(autoFile, 'utf8') : null
  if (actualAuto === null) {
    problems.push(['Missing', ['test/mobile/integration.auto.cjs']])
  } else if (actualAuto !== expectedAuto) {
    problems.push(['Stale', ['test/mobile/integration.auto.cjs']])
  }

  if (problems.length) {
    console.error('❌ Mobile tests are out of sync with the desktop suite\n')
    for (const [label, items] of problems) {
      console.error(`   ${label}:`)
      for (const item of items) console.error(`     - ${item}`)
    }
    console.error('\n   Run: npm run test:mobile:generate')
    process.exit(1)
  }

  console.log(
    `✅ Mobile tests match the desktop suite (${expected.size} file(s), ` +
      `${expectedEntries().length} on-device runner(s))`
  )
}

try {
  main()
} catch (error) {
  console.error('Error validating mobile tests:', error.message)
  process.exit(1)
}
