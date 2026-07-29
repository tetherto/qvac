#!/usr/bin/env node
'use strict'

// Regenerates the mobile test tree from the DESKTOP integration suites:
//
//   test/integration/<suite>/*        copied from tests/integration_js/<suite>/*
//                                     with `require('.')` repointed at the
//                                     unified mobile addon
//   test/mobile/integration.auto.cjs  one run<Name>Test wrapper per test entry
//
// No mobile-only tests are authored: every on-device test IS a desktop test.
// Run this after changing anything under tests/integration_js/, then commit the
// result (the harness bundles these committed files into the app).

const fs = require('fs')
const path = require('path')

const {
  integrationDir,
  autoFile,
  groupsFile,
  mobileDir,
  listSuites,
  expectedIntegrationFiles,
  expectedEntries,
  expectedAutoCjs,
  expectedTestGroups
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
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(`Error generating mobile tests: ${error.message}`)
    process.exit(1)
  }
}
