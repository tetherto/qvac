#!/usr/bin/env node
'use strict'

// Staleness check: re-derives the expected output (tests, workers,
// integration.auto.cjs and the ported native sources) from the DESKTOP suites and
// fails if what is on disk differs — a desktop source changed without
// regenerating, a suite added/removed, or a hand-edit. CI always regenerates, so
// this mainly protects local builds. Fix with `npm run test:mobile:generate`.

const fs = require('fs')

const {
  autoFile,
  nativeBindingFile,
  expectedIntegrationFiles,
  expectedEntries,
  expectedAutoCjs,
  expectedNativeFiles,
  expectedNativeBinding,
  listOnDiskIntegrationFiles,
  listOnDiskNativeFiles
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

  // Native side: the ported desktop bindings and the generated unified module.
  const expectedNative = expectedNativeFiles()
  const actualNative = listOnDiskNativeFiles()
  const nativeMissing = [...expectedNative.keys()].filter((k) => !actualNative.has(k)).sort()
  const nativeExtra = [...actualNative.keys()].filter((k) => !expectedNative.has(k)).sort()
  const nativeDrift = [...expectedNative.keys()]
    .filter((k) => actualNative.has(k) && actualNative.get(k) !== expectedNative.get(k))
    .sort()
  if (nativeMissing.length) problems.push(['Missing native port', nativeMissing])
  if (nativeExtra.length) problems.push(['Unexpected native file (no desktop source)', nativeExtra])
  if (nativeDrift.length) problems.push(['Native port drifted from desktop', nativeDrift])

  const actualBinding = fs.existsSync(nativeBindingFile)
    ? fs.readFileSync(nativeBindingFile, 'utf8')
    : null
  if (actualBinding === null) {
    problems.push(['Missing', ['generated/native/binding.cpp']])
  } else if (actualBinding !== expectedNativeBinding()) {
    problems.push(['Stale', ['generated/native/binding.cpp']])
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
