'use strict'

// Node-side validator for the mobile test layout.
// Used by CI to fail early if the generator hasn't been run, the mobile runtime
// helper is missing, or test-groups.json does not schedule every generated
// runner on every platform.
//
// The group-coverage half of this used to live inside
// scripts/generate-mobile-integration-tests.js, which `npm run test:integration`
// chains — so editing this Device Farm scheduling file aborted desktop
// integration tests on every platform. It runs here instead, off the
// test:integration path, over the pure rules in lib/validate-test-groups.js.

const fs = require('fs')
const path = require('path')
const process = require('process')

const { validateTestGroups, generatedRunnerNames } = require('./lib/validate-test-groups.js')

const repoRoot = path.resolve(__dirname, '..')
const mobileDir = path.join(repoRoot, 'test', 'mobile')
const autoFile = path.join(mobileDir, 'integration.auto.cjs')
const runtimeFile = path.join(mobileDir, 'integration-runtime.cjs')
const testGroupsFile = path.join(mobileDir, 'test-groups.json')

function main() {
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

  if (!fs.existsSync(testGroupsFile)) {
    errors.push(`Test groups file not found: ${testGroupsFile}`)
  }

  if (errors.length > 0) {
    console.error('Mobile test validation failed:')
    errors.forEach((err) => console.error('  -', err))
    process.exit(1)
  }

  // The generated `async function run<Name>` declarations are the authoritative
  // runner list. Zero of them would make every coverage rule below vacuously
  // pass, so an empty extraction is an error rather than a clean run — that is
  // what a change to the generator's template would look like from here.
  const runners = generatedRunnerNames(fs.readFileSync(autoFile, 'utf8'))
  if (runners.length === 0) {
    console.error('Mobile test validation failed:')
    console.error(`  - No 'async function run<Name>' declarations found in ${autoFile}`)
    console.error('    Run `npm run test:mobile:generate` to regenerate it')
    process.exit(1)
  }

  const groups = JSON.parse(fs.readFileSync(testGroupsFile, 'utf8'))
  const problems = validateTestGroups(groups, runners)

  if (problems.length > 0) {
    console.error('test-groups.json does not schedule every mobile runner:\n')
    problems.forEach((problem) => console.error(`  ${problem}\n`))
    process.exit(1)
  }

  console.log(
    `Mobile test structure is valid (${runners.length} runner(s), group coverage OK per platform)`
  )
}

if (require.main === module) {
  main()
}
