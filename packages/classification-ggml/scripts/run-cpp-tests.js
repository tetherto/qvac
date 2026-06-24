'use strict'

const path = require('path')
const os = require('os')
const { spawnSync } = require('child_process')

const binary = os.platform() === 'win32' ? 'addon-test.exe' : './addon-test'
const cwd = path.resolve(__dirname, '..', 'build', 'test', 'unit')

const result = spawnSync(binary, ['--gtest_output=xml:cpp-test-results.xml'], {
  cwd,
  stdio: 'inherit',
  shell: false
})

if (result.error) {
  throw result.error
}

process.exit(result.status || 0)
