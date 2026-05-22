#!/usr/bin/env node
'use strict'

const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const { ensureUnitTestModels } = require('./download-unit-test-models')

function parseArgs (argv) {
  const coverage = argv.includes('--coverage')
  const gtestArgs = argv.filter(arg => arg !== '--coverage')
  return { coverage, gtestArgs }
}

async function main () {
  await ensureUnitTestModels()

  const { coverage, gtestArgs } = parseArgs(process.argv.slice(2))
  const binary = os.platform() === 'win32' ? 'addon-test.exe' : './addon-test'
  const cwd = path.resolve(__dirname, '..', 'build', 'test', 'unit')

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

  process.exit(result.status || 0)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
