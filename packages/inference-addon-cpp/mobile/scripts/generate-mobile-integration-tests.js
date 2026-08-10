#!/usr/bin/env node
'use strict'

// Regenerates everything the on-device suite needs, from the DESKTOP suites:
//
//   test/integration/<suite>/*        the tests + their workers
//   test/mobile/integration.auto.cjs  one run<Name>Test wrapper per test entry
//   test/mobile/test-groups.json      one Device Farm group per suite
//   generated/native/**               ported bindings + the unified module
//
// No mobile-only tests or bindings are authored: every on-device test IS a desktop
// test. Output is gitignored and regenerated in CI, so run this after changing
// anything under tests/integration_js/ — and before building locally.

const fs = require('fs')
const path = require('path')

const {
  integrationDir,
  autoFile,
  groupsFile,
  mobileDir,
  nativeDir,
  nativeBindingFile,
  nativeSourcesCmake,
  listSuites,
  expectedIntegrationFiles,
  expectedEntries,
  expectedAutoCjs,
  expectedTestGroups,
  expectedNativeFiles,
  expectedNativeBinding,
  expectedNativeSourcesCmake
} = require('./lib/desktop-suites.js')

function main() {
  const suites = listSuites()
  if (suites.length === 0) {
    throw new Error('No desktop suites found under tests/integration_js/')
  }

  // Rebuild the tree from scratch so files deleted upstream don't linger.
  fs.rmSync(integrationDir, { recursive: true, force: true })
  fs.mkdirSync(integrationDir, { recursive: true })

  const files = expectedIntegrationFiles()
  for (const [relPath, contents] of files) {
    const target = path.join(integrationDir, relPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents, 'utf8')
  }

  const entries = expectedEntries()
  if (entries.length === 0) {
    throw new Error('No test entries (test.js / *.test.js) found in the desktop suites')
  }
  fs.mkdirSync(mobileDir, { recursive: true })
  fs.writeFileSync(autoFile, expectedAutoCjs(entries), 'utf8')
  // One Device Farm group per suite, so each suite gets its own app process (see
  // expectedTestGroups: the on-device run otherwise shares a JsLogger singleton).
  fs.writeFileSync(groupsFile, expectedTestGroups(entries), 'utf8')

  console.log(`Ported ${files.size} file(s) from ${suites.length} desktop suite(s):`)
  for (const suite of suites) console.log(`  - ${suite}`)
  console.log(
    `Generated ${path.relative(process.cwd(), autoFile)} with ${entries.length} runner(s):`
  )
  for (const entry of entries) console.log(`  - ${entry.fnName}  <-  ${entry.relPath}`)
  console.log(
    `Generated ${path.relative(process.cwd(), groupsFile)} with ${suites.length} isolated group(s)`
  )

  // ---- native side: port the desktop bindings + emit the unified module ----
  fs.rmSync(nativeDir, { recursive: true, force: true })
  fs.mkdirSync(nativeDir, { recursive: true })

  const nativeFiles = expectedNativeFiles()
  for (const [relPath, contents] of nativeFiles) {
    const target = path.join(nativeDir, relPath)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, contents, 'utf8')
  }
  fs.writeFileSync(nativeBindingFile, expectedNativeBinding(), 'utf8')
  fs.writeFileSync(nativeSourcesCmake, expectedNativeSourcesCmake(), 'utf8')

  console.log(
    `Ported ${nativeFiles.size} native file(s) + generated the unified binding into ` +
      `${path.relative(process.cwd(), nativeDir)}`
  )
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`Error generating mobile tests: ${error.message}`)
    process.exit(1)
  }
}
