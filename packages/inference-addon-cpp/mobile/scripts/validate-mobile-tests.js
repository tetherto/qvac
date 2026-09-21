#!/usr/bin/env node
'use strict'

// Staleness check: re-derives EVERY generated artefact from the DESKTOP suites —
// tests and workers, integration.auto.cjs, test-groups.json, the ported native
// sources, binding.cpp and sources.cmake — and fails if what is on disk differs (a
// desktop source changed without regenerating, a suite added/removed, or a
// hand-edit). CI always regenerates, so this mainly protects local builds. Fix with
// `npm run test:mobile:generate`.

const fs = require('fs')

const {
  autoFile,
  groupsFile,
  nativeBindingFile,
  nativeSourcesCmake,
  expectedIntegrationFiles,
  expectedEntries,
  expectedAutoCjs,
  expectedTestGroups,
  expectedNativeFiles,
  expectedNativeBinding,
  expectedNativeSourcesCmake,
  listOnDiskIntegrationFiles,
  listOnDiskNativeFiles
} = require('./lib/desktop-suites.js')

// Compare one generated file against what the generator would emit now.
function checkGenerated(problems, file, label, expected) {
  const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  if (actual === null) problems.push(['Missing', [label]])
  else if (actual !== expected) problems.push(['Stale', [label]])
}

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

  const entries = expectedEntries()

  checkGenerated(problems, autoFile, 'test/mobile/integration.auto.cjs', expectedAutoCjs(entries))

  // test-groups.json decides which runners execute: sharded mode never runs an entry
  // that is absent from every group, so a stale map silently DROPS tests rather than
  // failing. Worth validating for exactly that reason.
  checkGenerated(problems, groupsFile, 'test/mobile/test-groups.json', expectedTestGroups(entries))

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

  checkGenerated(
    problems,
    nativeBindingFile,
    'generated/native/binding.cpp',
    expectedNativeBinding()
  )

  // sources.cmake is the build's source list (CMake can't glob files that may not
  // exist at configure time), so a stale list silently omits a ported binding.
  checkGenerated(
    problems,
    nativeSourcesCmake,
    'generated/native/sources.cmake',
    expectedNativeSourcesCmake()
  )

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
      `${entries.length} on-device runner(s))`
  )
}

try {
  main()
} catch (error) {
  console.error('Error validating mobile tests:', error.message)
  process.exit(1)
}
