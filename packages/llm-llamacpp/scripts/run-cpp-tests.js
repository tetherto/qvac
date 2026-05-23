#!/usr/bin/env node
'use strict'

const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const { ensureUnitTestModels } = require('./download-unit-test-models')

function parseArgs (argv) {
  const flags = new Set(['--coverage', '--ci'])
  const coverage = argv.includes('--coverage')
  const ciOnly = argv.includes('--ci')
  const gtestArgs = argv.filter(arg => !flags.has(arg))
  return { coverage, ciOnly, gtestArgs }
}

async function main () {
  const { coverage, ciOnly, gtestArgs } = parseArgs(process.argv.slice(2))

  await ensureUnitTestModels({ ciOnly })

  const cwd = path.resolve(__dirname, '..', 'build', 'test', 'unit')
  const binaryName = os.platform() === 'win32' ? 'addon-test.exe' : 'addon-test'
  const binary = path.join(cwd, binaryName)

  const env = { ...process.env }
  if (coverage) {
    // Same as pre-refactor: run from build/test/unit with default.profraw
    env.LLVM_PROFILE_FILE = env.LLVM_PROFILE_FILE || 'default.profraw'
  }

  const result = spawnSync(binary, [
    '--gtest_output=xml:cpp-test-results.xml',
    ...gtestArgs
  ], {
    cwd,
    stdio: 'inherit',
    shell: false,
    env
  })

  if (result.error) {
    throw result.error
  }

  if (result.signal) {
    console.error(`addon-test killed by signal ${result.signal}`)
    process.exit(1)
  }

  process.exit(result.status ?? 1)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
